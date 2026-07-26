import type { AccountId } from "@core/domain/account-id.ts";
import type { EmailAddress } from "@core/domain/address.ts";
import { DomainError, invalidArgument } from "@core/domain/errors.ts";
import type { Ulid } from "@core/domain/ulid.ts";

export type OutboundStatus =
  | "draft"
  | "pending_approval"
  | "queued"
  | "dispatched"
  | "deferred"
  | "delivered"
  | "bounced"
  | "complained"
  | "failed"
  | "rejected";

/** The six event types Cloudflare Email Sending publishes to a queue. */
export type DeliveryEventType =
  | "delivered"
  | "deferred"
  | "bounced"
  | "failed"
  | "rejected"
  | "complained";

/**
 * Legal transitions. Anything absent here is a bug, not a runtime condition.
 *
 * `delivered -> complained` is the one non-obvious edge: a spam complaint
 * legitimately arrives minutes or days AFTER successful delivery, so `delivered`
 * is terminal for the delivery attempt but not for the message's fate.
 */
const TRANSITIONS: Readonly<Record<OutboundStatus, readonly OutboundStatus[]>> = {
  draft: ["pending_approval", "queued", "rejected"],
  pending_approval: ["queued", "rejected"],
  queued: ["dispatched", "failed", "rejected"],
  dispatched: ["delivered", "deferred", "bounced", "complained", "failed", "rejected"],
  deferred: ["dispatched", "delivered", "bounced", "failed"],
  delivered: ["complained"],
  bounced: [],
  complained: [],
  failed: [],
  rejected: [],
};

const TERMINAL: ReadonlySet<OutboundStatus> = new Set<OutboundStatus>([
  "bounced",
  "complained",
  "failed",
  "rejected",
]);

/**
 * One outbound send attempt and everything we know about its fate.
 *
 * The message body itself is NOT here — it lives in the blob store under
 * `payloadKey`. This aggregate is the part we query, count against quota, and
 * transition, so keeping it small keeps those cheap.
 */
export interface OutboundMessage {
  readonly id: Ulid;
  readonly accountId: AccountId;
  /** The inbox this was sent from. */
  readonly inboxId: Ulid | null;
  /** The agent identity that authored it — the unit SendPolicy meters. */
  readonly identityId: Ulid | null;
  /** Set once the sent copy has been written to the message store. */
  readonly messageId: Ulid | null;
  readonly idempotencyKey: string | null;

  readonly status: OutboundStatus;
  readonly attempts: number;
  readonly recipients: readonly EmailAddress[];
  readonly payloadKey: string | null;
  /** Provider-side id, used to correlate incoming delivery events. */
  readonly providerMessageId: string | null;

  readonly rejectReason: string | null;
  readonly lastError: string | null;
  readonly approvedBy: string | null;
  readonly approvedAt: Date | null;

  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** When `status` last changed. Used to discard out-of-order events. */
  readonly statusChangedAt: Date;
}

export interface CreateOutboundInput {
  readonly id: Ulid;
  readonly accountId: AccountId;
  readonly recipients: readonly EmailAddress[];
  readonly now: Date;
  readonly inboxId?: Ulid | null;
  readonly identityId?: Ulid | null;
  readonly idempotencyKey?: string | null;
  readonly payloadKey?: string | null;
}

/** Cloudflare Email Sending caps recipients at 50 across to + cc + bcc. */
export const MAX_RECIPIENTS = 50;

export const OutboundMessage = {
  MAX_RECIPIENTS,

  create(input: CreateOutboundInput): OutboundMessage {
    if (input.recipients.length === 0) {
      throw invalidArgument("An outbound message needs at least one recipient.");
    }
    if (input.recipients.length > MAX_RECIPIENTS) {
      throw invalidArgument(
        `Too many recipients: ${input.recipients.length} (max ${MAX_RECIPIENTS}).`,
        { count: input.recipients.length, max: MAX_RECIPIENTS },
      );
    }
    return {
      id: input.id,
      accountId: input.accountId,
      inboxId: input.inboxId ?? null,
      identityId: input.identityId ?? null,
      messageId: null,
      idempotencyKey: input.idempotencyKey ?? null,
      status: "draft",
      attempts: 0,
      recipients: [...input.recipients],
      payloadKey: input.payloadKey ?? null,
      providerMessageId: null,
      rejectReason: null,
      lastError: null,
      approvedBy: null,
      approvedAt: null,
      createdAt: input.now,
      updatedAt: input.now,
      statusChangedAt: input.now,
    };
  },

  canTransition(from: OutboundStatus, to: OutboundStatus): boolean {
    return TRANSITIONS[from].includes(to);
  },

  isTerminal(status: OutboundStatus): boolean {
    return TERMINAL.has(status);
  },

  /** Low-level transition. Prefer the intention-revealing helpers below. */
  transitionTo(
    outbound: OutboundMessage,
    to: OutboundStatus,
    now: Date,
    patch: Partial<
      Pick<
        OutboundMessage,
        | "attempts"
        | "providerMessageId"
        | "rejectReason"
        | "lastError"
        | "approvedBy"
        | "approvedAt"
        | "messageId"
        | "payloadKey"
      >
    > = {},
  ): OutboundMessage {
    if (!OutboundMessage.canTransition(outbound.status, to)) {
      throw new DomainError(
        "invalid_state_transition",
        `Cannot move outbound message from ${outbound.status} to ${to}.`,
        { outboundId: outbound.id, from: outbound.status, to },
      );
    }
    return {
      ...outbound,
      ...patch,
      status: to,
      updatedAt: now,
      statusChangedAt: now,
    };
  },

  requireApproval(outbound: OutboundMessage, reason: string, now: Date): OutboundMessage {
    return OutboundMessage.transitionTo(outbound, "pending_approval", now, {
      rejectReason: null,
      lastError: reason,
    });
  },

  approve(outbound: OutboundMessage, approvedBy: string, now: Date): OutboundMessage {
    if (outbound.status !== "pending_approval") {
      throw new DomainError(
        "invalid_state_transition",
        `Only a pending_approval message can be approved (was ${outbound.status}).`,
        { outboundId: outbound.id, status: outbound.status },
      );
    }
    return OutboundMessage.transitionTo(outbound, "queued", now, {
      approvedBy,
      approvedAt: now,
      lastError: null,
    });
  },

  enqueue(outbound: OutboundMessage, now: Date, payloadKey?: string): OutboundMessage {
    return OutboundMessage.transitionTo(
      outbound,
      "queued",
      now,
      payloadKey === undefined ? {} : { payloadKey },
    );
  },

  markDispatched(
    outbound: OutboundMessage,
    providerMessageId: string | null,
    now: Date,
  ): OutboundMessage {
    return OutboundMessage.transitionTo(outbound, "dispatched", now, {
      providerMessageId,
      attempts: outbound.attempts + 1,
      lastError: null,
    });
  },

  reject(outbound: OutboundMessage, reason: string, now: Date): OutboundMessage {
    return OutboundMessage.transitionTo(outbound, "rejected", now, { rejectReason: reason });
  },

  fail(outbound: OutboundMessage, error: string, now: Date): OutboundMessage {
    return OutboundMessage.transitionTo(outbound, "failed", now, { lastError: error });
  },

  attachSentCopy(outbound: OutboundMessage, messageId: Ulid, now: Date): OutboundMessage {
    return { ...outbound, messageId, updatedAt: now };
  },

  /**
   * Fold in a provider delivery event.
   *
   * Deliberately does NOT throw on a stale or illegal event: this runs in a
   * Queues consumer, where throwing means retry, and retrying an
   * out-of-order event would retry forever. Unapplicable events are reported
   * and dropped.
   */
  applyDeliveryEvent(
    outbound: OutboundMessage,
    event: { type: DeliveryEventType; occurredAt: Date; detail?: string | null },
  ): ApplyEventResult {
    if (event.occurredAt.getTime() < outbound.statusChangedAt.getTime()) {
      return {
        applied: false,
        outbound,
        reason: "stale_event",
      };
    }
    const to: OutboundStatus = event.type;
    if (!OutboundMessage.canTransition(outbound.status, to)) {
      return {
        applied: false,
        outbound,
        reason: OutboundMessage.isTerminal(outbound.status)
          ? "already_terminal"
          : "illegal_transition",
      };
    }
    const detail = event.detail ?? null;
    return {
      applied: true,
      outbound: OutboundMessage.transitionTo(outbound, to, event.occurredAt, {
        ...(to === "rejected" ? { rejectReason: detail } : { lastError: detail }),
      }),
    };
  },
} as const;

export type ApplyEventResult =
  | { readonly applied: true; readonly outbound: OutboundMessage }
  | {
      readonly applied: false;
      readonly outbound: OutboundMessage;
      readonly reason: "stale_event" | "already_terminal" | "illegal_transition";
    };
