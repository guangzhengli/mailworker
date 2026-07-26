import type {
  AgentIdentity,
  AuthContext,
  EmailAddress,
  OutboundMessage,
  RfcMessageId,
} from "../domain/index.ts";
import {
  AuthContext as AuthContextVO,
  DomainError,
  EmailAddress as EmailAddressVO,
  invalidArgument,
  LoopBreakerPolicy,
  OutboundMessage as OutboundVO,
  SendPolicy,
  Ulid,
} from "../domain/index.ts";
import { BlobKeys } from "../ports/index.ts";
import type { Deps, Operation } from "./deps.ts";

export interface SendMessageRequest {
  readonly from: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly replyTo?: string;
  /** Reply into an existing thread by our message ULID. */
  readonly inReplyToMessageId?: string;
  readonly headers?: Record<string, string>;
  /** Repeat submissions with the same key return the original send. */
  readonly idempotencyKey?: string;
  /** True when a machine triggered this. Drives loop breaking and `Auto-Submitted`. */
  readonly automated?: boolean;
}

export type SendResult =
  | { readonly outcome: "queued"; readonly outbound: OutboundMessage }
  | { readonly outcome: "pending_approval"; readonly outbound: OutboundMessage }
  | { readonly outcome: "duplicate"; readonly outbound: OutboundMessage };

/** What `dispatch-outbound` reads back out of the blob store. */
export interface OutboundPayload {
  readonly from: EmailAddress;
  readonly to: readonly EmailAddress[];
  readonly cc: readonly EmailAddress[];
  readonly bcc: readonly EmailAddress[];
  readonly replyTo: EmailAddress | null;
  readonly subject: string;
  readonly text: string | null;
  readonly html: string | null;
  readonly messageId: RfcMessageId;
  readonly inReplyTo: RfcMessageId | null;
  readonly references: readonly RfcMessageId[];
  readonly headers: Record<string, string>;
}

type Needs =
  | "clock"
  | "ids"
  | "inboxes"
  | "messages"
  | "outbound"
  | "identities"
  | "suppressions"
  | "blobs"
  | "events";

/**
 * Everything between "an agent wants to send" and "it is safe to hand to a
 * transport". Ends at `queued`; `dispatchOutbound` does the network call.
 *
 * Splitting there is what makes the send path retryable. The policy decision,
 * the audit row and the payload are durable before anything leaves, so a failed
 * dispatch is a retry against a recorded decision rather than a re-litigation of
 * whether the send was allowed — and a crash mid-send cannot lose the fact that
 * we accepted it.
 */
export function sendMessage(
  deps: Pick<Deps, Needs>,
): Operation<SendMessageRequest, SendResult> {
  return async (ctx: AuthContext, input: SendMessageRequest): Promise<SendResult> => {
    AuthContextVO.require(ctx, "message:send");
    const now = deps.clock.now();

    // Idempotency first: a retried request must not re-run the policy gates,
    // let alone re-send.
    if (input.idempotencyKey !== undefined) {
      const existing = await deps.outbound.findByIdempotencyKey(ctx, input.idempotencyKey);
      if (existing !== null) {
        return { outcome: "duplicate", outbound: existing };
      }
    }

    if (input.text === undefined && input.html === undefined) {
      throw invalidArgument("A message needs `text`, `html`, or both.");
    }

    const from = EmailAddressVO.parse(input.from);
    const to = input.to.map((value) => EmailAddressVO.parse(value));
    const cc = (input.cc ?? []).map((value) => EmailAddressVO.parse(value));
    const bcc = (input.bcc ?? []).map((value) => EmailAddressVO.parse(value));
    const recipients = [...to, ...cc, ...bcc];

    if (recipients.length === 0) {
      throw invalidArgument("A message needs at least one recipient.");
    }

    // The From address must be an inbox we own — otherwise the reply has nowhere
    // to land, and Cloudflare would refuse the send anyway.
    const inbox = await deps.inboxes.findByAddress(ctx, from);
    if (inbox === null) {
      throw new DomainError("inbox_not_found", `No inbox owns ${from}; cannot send as it.`, {
        from,
      });
    }

    const identity = await resolveIdentity(deps, ctx, inbox.identityId);

    // Thread continuation, if this is a reply.
    let inReplyTo: RfcMessageId | null = null;
    let references: RfcMessageId[] = [];
    let inboundAutoSubmitted: string | null = null;
    if (input.inReplyToMessageId !== undefined) {
      const parent = await deps.messages.findById(ctx, Ulid.parse(input.inReplyToMessageId));
      if (parent === null) {
        throw new DomainError("message_not_found", `No message ${input.inReplyToMessageId}.`, {
          messageId: input.inReplyToMessageId,
        });
      }
      inReplyTo = parent.rfcMessageId;
      references = [...parent.references, parent.rfcMessageId];
      inboundAutoSubmitted = parent.autoSubmitted;
    }

    // Gather what the policy needs. Each of these is a read, so they happen here
    // and the policy itself stays a pure function of their results.
    const suppressed = await deps.suppressions.filterSuppressed(ctx, recipients);
    const sentInWindow = await deps.outbound.countSince(
      ctx,
      identity?.id ?? null,
      new Date(now.getTime() - QUOTA_WINDOW_MS),
    );
    const exchangesInWindow = await maxExchanges(deps, ctx, from, to, now);

    const loop = LoopBreakerPolicy.check({
      referencesDepth: references.length,
      exchangesInWindow,
      inboundAutoSubmitted,
      automated: input.automated ?? false,
      selfAddressed: recipients.some((recipient) => recipient === from),
    });

    const decision = SendPolicy.evaluate({
      scopes: ctx.scopes,
      identity,
      from,
      recipients,
      suppressedRecipients: suppressed,
      sentInWindow,
      loop,
    });

    if (decision.kind === "reject") {
      await deps.events.publish([
        {
          type: "outbound.rejected",
          accountId: ctx.accountId,
          occurredAt: now,
          outboundId: null,
          reason: decision.reason,
          code: decision.code,
        },
      ]);
      throw SendPolicy.toError(decision);
    }

    const outboundId = deps.ids.ulid();
    const rfcMessageId = deps.ids.rfcMessageId(EmailAddressVO.domain(from));
    const payload: OutboundPayload = {
      from,
      to,
      cc,
      bcc,
      replyTo: input.replyTo === undefined ? null : EmailAddressVO.parse(input.replyTo),
      subject: input.subject,
      text: input.text ?? null,
      html: input.html ?? null,
      messageId: rfcMessageId,
      inReplyTo,
      references,
      headers: {
        ...input.headers,
        // Always announce automation, so a well-behaved peer can break the loop
        // from its side too (RFC 3834).
        "Auto-Submitted": LoopBreakerPolicy.autoSubmittedHeader(input.automated ?? false),
      },
    };

    const payloadKey = BlobKeys.outboundPayload(ctx.accountId, outboundId);
    await deps.blobs.put(ctx, payloadKey, encodePayload(payload), {
      contentType: "application/json",
    });

    let outbound = OutboundVO.create({
      id: outboundId,
      accountId: ctx.accountId,
      recipients,
      inboxId: inbox.id,
      identityId: identity?.id ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      payloadKey,
      now,
    });

    if (decision.kind === "require_approval") {
      outbound = OutboundVO.requireApproval(outbound, decision.reason, now);
      await deps.outbound.insert(ctx, outbound);
      await deps.events.publish([
        {
          type: "outbound.approval_requested",
          accountId: ctx.accountId,
          occurredAt: now,
          outboundId: outbound.id,
          reason: decision.reason,
        },
      ]);
      return { outcome: "pending_approval", outbound };
    }

    outbound = OutboundVO.enqueue(outbound, now);
    await deps.outbound.insert(ctx, outbound);
    await deps.events.publish([
      {
        type: "outbound.queued",
        accountId: ctx.accountId,
        occurredAt: now,
        outboundId: outbound.id,
        recipients,
      },
    ]);

    return { outcome: "queued", outbound };
  };
}

export const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Encode/decode kept next to the type so the two cannot drift. */
export function encodePayload(payload: OutboundPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

export function decodePayload(bytes: Uint8Array): OutboundPayload {
  return JSON.parse(new TextDecoder().decode(bytes)) as OutboundPayload;
}

async function resolveIdentity(
  deps: Pick<Deps, "identities">,
  ctx: AuthContext,
  inboxIdentityId: Ulid | null,
): Promise<AgentIdentity | null> {
  // The credential's own identity wins over the inbox's: a key bound to an
  // identity must not be able to widen its limits by sending from a
  // less-restricted inbox.
  const id = ctx.identityId ?? inboxIdentityId;
  return id === null ? null : await deps.identities.findById(ctx, id);
}

/**
 * The loop breaker meters per counterparty, so a message to five recipients is
 * checked against the busiest of them rather than their sum — otherwise one
 * chatty peer would throttle sends to everyone else.
 */
async function maxExchanges(
  deps: Pick<Deps, "messages">,
  ctx: AuthContext,
  from: EmailAddress,
  to: readonly EmailAddress[],
  now: Date,
): Promise<number> {
  const since = new Date(now.getTime() - LoopBreakerPolicy.EXCHANGE_WINDOW_MS);
  const counts = await Promise.all(
    to.map((recipient) => deps.messages.countSentBetween(ctx, from, recipient, since)),
  );
  return counts.length === 0 ? 0 : Math.max(...counts);
}
