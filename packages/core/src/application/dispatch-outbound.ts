import type { AuthContext, Message, OutboundMessage, ThreadId } from "../domain/index.ts";
import {
  DomainError,
  Message as MessageVO,
  OutboundMessage as OutboundVO,
  ThreadingPolicy,
  Ulid,
} from "../domain/index.ts";
import { BlobKeys } from "../ports/index.ts";
import type { Deps, Operation } from "./deps.ts";
import { decodePayload } from "./send-message.ts";

export interface DispatchOutboundRequest {
  readonly outboundId: string;
}

export type DispatchOutcome =
  | {
      readonly outcome: "dispatched";
      readonly outbound: OutboundMessage;
      readonly sentCopy: Message;
    }
  | { readonly outcome: "failed"; readonly outbound: OutboundMessage; readonly error: string }
  | { readonly outcome: "skipped"; readonly reason: string };

type Needs =
  | "clock"
  | "ids"
  | "outbound"
  | "messages"
  | "blobs"
  | "transport"
  | "mimeBuilder"
  | "events";

/**
 * Hand a queued message to the transport, then archive our own copy.
 *
 * Runs in the Queues consumer, which shapes the error handling: a retryable
 * transport failure THROWS, because that is how the queue is told to retry. A
 * permanent failure does not throw — it records `failed` and returns, since
 * retrying a rejected recipient just burns quota.
 *
 * The sent copy is stored after a successful dispatch rather than before. If the
 * order were reversed, a failed send would leave a message in the mailbox that
 * was never actually sent, which is the one lie a mail log must not tell.
 */
export function dispatchOutbound(
  deps: Pick<Deps, Needs>,
): Operation<DispatchOutboundRequest, DispatchOutcome> {
  return async (ctx: AuthContext, input: DispatchOutboundRequest): Promise<DispatchOutcome> => {
    const now = deps.clock.now();
    const outbound = await deps.outbound.findById(ctx, Ulid.parse(input.outboundId));
    if (outbound === null) {
      throw new DomainError("message_not_found", `No outbound message ${input.outboundId}.`, {
        outboundId: input.outboundId,
      });
    }

    // A queue can deliver the same job twice; anything not queued is already
    // handled and must not be sent again.
    if (outbound.status !== "queued") {
      return { outcome: "skipped", reason: `status is ${outbound.status}` };
    }
    // sendMessage guarantees both of these; a violation means the row was written
    // by something else, and fabricating a value would attach the sent copy to an
    // inbox that does not exist.
    if (outbound.inboxId === null) {
      const reason = "outbound message has no originating inbox";
      const failed = OutboundVO.fail(outbound, reason, now);
      await deps.outbound.update(ctx, failed);
      return { outcome: "failed", outbound: failed, error: reason };
    }
    if (outbound.payloadKey === null) {
      const failed = OutboundVO.fail(outbound, "payload missing", now);
      await deps.outbound.update(ctx, failed);
      return { outcome: "failed", outbound: failed, error: "payload missing" };
    }

    const bytes = await deps.blobs.get(ctx, outbound.payloadKey);
    if (bytes === null) {
      const failed = OutboundVO.fail(outbound, "payload blob not found", now);
      await deps.outbound.update(ctx, failed);
      return { outcome: "failed", outbound: failed, error: "payload blob not found" };
    }
    const payload = decodePayload(bytes);

    const result = await deps.transport.dispatch(ctx, {
      from: payload.from,
      fromName: null,
      to: payload.to,
      cc: payload.cc,
      bcc: payload.bcc,
      replyTo: payload.replyTo,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
      messageId: payload.messageId,
      inReplyTo: payload.inReplyTo,
      references: payload.references,
      headers: payload.headers,
      attachments: [],
    });

    if (!result.ok) {
      if (result.retryable) {
        // Stay `queued` and let the queue redeliver. Throwing is the signal.
        throw new DomainError("send_rejected", `Transport error: ${result.error}`, {
          outboundId: outbound.id,
          retryable: true,
        });
      }
      const failed = OutboundVO.fail(outbound, result.error, now);
      await deps.outbound.update(ctx, failed);
      await deps.events.publish([
        {
          type: "outbound.rejected",
          accountId: ctx.accountId,
          occurredAt: now,
          outboundId: failed.id,
          reason: result.error,
          code: "send_rejected",
        },
      ]);
      return { outcome: "failed", outbound: failed, error: result.error };
    }

    let dispatched = OutboundVO.markDispatched(outbound, result.providerMessageId, now);

    // Archive our copy, threaded alongside the message it replies to.
    const candidates = ThreadingPolicy.candidateIds(payload.inReplyTo, payload.references);
    const known =
      candidates.length > 0
        ? await deps.messages.findThreadIds(ctx, candidates)
        : new Map<string, ThreadId>();
    const thread = ThreadingPolicy.resolve({
      ownMessageId: payload.messageId,
      inReplyTo: payload.inReplyTo,
      references: payload.references,
      known,
    });

    const messageId = deps.ids.ulid();
    const raw = await deps.mimeBuilder.build({
      from: payload.from,
      fromName: null,
      to: payload.to,
      cc: payload.cc,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
      messageId: payload.messageId,
      inReplyTo: payload.inReplyTo,
      references: payload.references,
      date: now,
      headers: payload.headers,
    });
    const rawKey = BlobKeys.rawMessage(ctx.accountId, messageId);
    await deps.blobs.put(ctx, rawKey, raw, { contentType: "message/rfc822" });

    const sentCopy = MessageVO.create({
      id: messageId,
      accountId: ctx.accountId,
      inboxId: outbound.inboxId,
      rfcMessageId: payload.messageId,
      threadId: thread.threadId,
      direction: "outbound",
      fromHeader: payload.from,
      from: payload.from,
      toHeader: payload.to.join(", "),
      to: payload.to,
      cc: payload.cc,
      bcc: payload.bcc,
      replyTo: payload.replyTo,
      subject: payload.subject,
      bodyText: payload.text,
      bodyHtml: payload.html,
      inReplyTo: payload.inReplyTo,
      references: payload.references,
      autoSubmitted: payload.headers["Auto-Submitted"] ?? null,
      rawKey,
      size: raw.byteLength,
      sentAt: now,
      receivedAt: now,
    });
    await deps.messages.insert(ctx, sentCopy);

    dispatched = OutboundVO.attachSentCopy(dispatched, sentCopy.id, now);
    await deps.outbound.update(ctx, dispatched);
    await deps.events.publish([
      {
        type: "outbound.dispatched",
        accountId: ctx.accountId,
        occurredAt: now,
        outboundId: dispatched.id,
        providerMessageId: result.providerMessageId,
      },
    ]);

    return { outcome: "dispatched", outbound: dispatched, sentCopy };
  };
}
