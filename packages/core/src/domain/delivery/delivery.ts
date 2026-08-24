import { SENDING_LIMITS } from "@core/domain/delivery/sending-limits";
import type { EmailAddress } from "@core/domain/email-address";
import { DomainError, invalidArgument } from "@core/domain/errors";
import type { AccountId } from "@core/domain/identity/account-id";
import type { Ulid } from "@core/domain/ulid";

export type DeliveryStatus =
  | "draft"
  | "pending_approval"
  | "queued"
  | "dispatching"
  | "dispatched"
  | "deferred"
  | "delivered"
  | "bounced"
  | "complained"
  | "failed"
  | "rejected";

/**
 * Who authored the send. A `console` delivery came from a human in the
 * dashboard, so it never enters the approval queue — the person sending is the
 * person who would approve it.
 */
export type DeliverySource = "agent" | "console";

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
 *
 * `deferred` carries the same outbound edges as `dispatched` because it IS a
 * dispatched message the provider has not finished with. Its two extra edges are
 * not hypothetical: the provider retries a deferred message, so a later attempt
 * can still draw a `rejected`, and a `complained` can arrive for a message whose
 * `delivered` event we never saw — queues are at-least-once and unordered, so
 * "we missed the success and only heard about the complaint" is a normal Tuesday
 * rather than a corruption. Leaving those out stranded such a delivery in
 * `deferred` forever, since every event that could move it was refused.
 */
const TRANSITIONS: Readonly<Record<DeliveryStatus, readonly DeliveryStatus[]>> = {
  draft: ["pending_approval", "queued", "rejected"],
  pending_approval: ["queued", "rejected"],
  queued: ["dispatching", "failed", "rejected"],
  dispatching: ["queued", "dispatched", "failed", "rejected"],
  dispatched: ["delivered", "deferred", "bounced", "complained", "failed", "rejected"],
  deferred: ["dispatched", "delivered", "bounced", "complained", "failed", "rejected"],
  delivered: ["complained"],
  bounced: [],
  complained: [],
  failed: [],
  rejected: [],
};

const TERMINAL: ReadonlySet<DeliveryStatus> = new Set<DeliveryStatus>([
  "bounced",
  "complained",
  "failed",
  "rejected",
]);

/**
 * One delivery send attempt and everything we know about its fate.
 *
 * The message body itself is NOT here — it lives in the blob store under
 * `payloadKey`. This aggregate is the part we query, count against quota, and
 * transition, so keeping it small keeps those cheap.
 */
export interface Delivery {
  readonly id: Ulid;
  readonly accountId: AccountId;
  readonly inboxId: Ulid | null;
  /** The agent identity that authored it — the unit SendPolicy meters. */
  readonly identityId: Ulid | null;
  /** Set once the sent copy has been written to the message store. */
  readonly messageId: Ulid | null;
  readonly idempotencyKey: string | null;
  /**
   * Caller-defined key/value pairs, opaque to us, carried on every webhook
   * event about this delivery.
   *
   * It lives on the aggregate rather than in the payload blob because that is
   * where it has to be readable from: a bounce arriving three days later is
   * handled by `recordEvent`, which loads the delivery row and never touches
   * the payload. Metadata that could only be read by fetching a blob from R2
   * would be metadata nobody could afford to put on an event.
   */
  readonly metadata: Readonly<Record<string, string>>;
  readonly source: DeliverySource;

  readonly status: DeliveryStatus;
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

export interface CreateDeliveryInput {
  readonly id: Ulid;
  readonly accountId: AccountId;
  readonly recipients: readonly EmailAddress[];
  readonly now: Date;
  readonly inboxId?: Ulid | null;
  readonly identityId?: Ulid | null;
  readonly idempotencyKey?: string | null;
  readonly payloadKey?: string | null;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly source?: DeliverySource;
}

export const Delivery = {
  MAX_RECIPIENTS: SENDING_LIMITS.MAX_RECIPIENTS,

  create(input: CreateDeliveryInput): Delivery {
    if (input.recipients.length === 0) {
      throw invalidArgument("An delivery message needs at least one recipient.");
    }
    if (input.recipients.length > SENDING_LIMITS.MAX_RECIPIENTS) {
      throw invalidArgument(
        `Too many recipients: ${input.recipients.length} (max ${SENDING_LIMITS.MAX_RECIPIENTS}).`,
        { count: input.recipients.length, max: SENDING_LIMITS.MAX_RECIPIENTS },
      );
    }
    return {
      id: input.id,
      accountId: input.accountId,
      inboxId: input.inboxId ?? null,
      identityId: input.identityId ?? null,
      messageId: null,
      idempotencyKey: input.idempotencyKey ?? null,
      metadata: Object.freeze({ ...input.metadata }),
      source: input.source ?? "agent",
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

  canTransition(from: DeliveryStatus, to: DeliveryStatus): boolean {
    return TRANSITIONS[from].includes(to);
  },

  isTerminal(status: DeliveryStatus): boolean {
    return TERMINAL.has(status);
  },

  transitionTo(
    delivery: Delivery,
    to: DeliveryStatus,
    now: Date,
    patch: Partial<
      Pick<
        Delivery,
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
  ): Delivery {
    if (!Delivery.canTransition(delivery.status, to)) {
      throw new DomainError(
        "invalid_state_transition",
        `Cannot move delivery message from ${delivery.status} to ${to}.`,
        { deliveryId: delivery.id, from: delivery.status, to },
      );
    }
    return {
      ...delivery,
      ...patch,
      status: to,
      updatedAt: now,
      statusChangedAt: now,
    };
  },

  requireApproval(delivery: Delivery, reason: string, now: Date): Delivery {
    return Delivery.transitionTo(delivery, "pending_approval", now, {
      rejectReason: null,
      lastError: reason,
    });
  },

  approve(delivery: Delivery, approvedBy: string, now: Date): Delivery {
    if (delivery.status !== "pending_approval") {
      throw new DomainError(
        "invalid_state_transition",
        `Only a pending_approval message can be approved (was ${delivery.status}).`,
        { deliveryId: delivery.id, status: delivery.status },
      );
    }
    return Delivery.transitionTo(delivery, "queued", now, {
      approvedBy,
      approvedAt: now,
      lastError: null,
    });
  },

  enqueue(delivery: Delivery, now: Date, payloadKey?: string): Delivery {
    return Delivery.transitionTo(
      delivery,
      "queued",
      now,
      payloadKey === undefined ? {} : { payloadKey },
    );
  },

  markDispatched(delivery: Delivery, providerMessageId: string | null, now: Date): Delivery {
    return Delivery.transitionTo(delivery, "dispatched", now, {
      providerMessageId,
      lastError: null,
    });
  },

  beginDispatch(delivery: Delivery, now: Date): Delivery {
    return Delivery.transitionTo(delivery, "dispatching", now, {
      attempts: delivery.attempts + 1,
      lastError: null,
    });
  },

  retryDispatch(delivery: Delivery, error: string, now: Date): Delivery {
    return Delivery.transitionTo(delivery, "queued", now, { lastError: error });
  },

  reject(delivery: Delivery, reason: string, now: Date): Delivery {
    return Delivery.transitionTo(delivery, "rejected", now, { rejectReason: reason });
  },

  fail(delivery: Delivery, error: string, now: Date): Delivery {
    return Delivery.transitionTo(delivery, "failed", now, { lastError: error });
  },

  attachSentCopy(delivery: Delivery, messageId: Ulid, now: Date): Delivery {
    return { ...delivery, messageId, updatedAt: now };
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
    delivery: Delivery,
    event: { type: DeliveryEventType; occurredAt: Date; detail?: string | null },
  ): ApplyEventResult {
    if (event.occurredAt.getTime() < delivery.statusChangedAt.getTime()) {
      return {
        applied: false,
        delivery,
        reason: "stale_event",
      };
    }
    const to: DeliveryStatus = event.type;
    if (!Delivery.canTransition(delivery.status, to)) {
      return {
        applied: false,
        delivery,
        reason: Delivery.isTerminal(delivery.status)
          ? "already_terminal"
          : "illegal_transition",
      };
    }
    const detail = event.detail ?? null;
    return {
      applied: true,
      delivery: Delivery.transitionTo(delivery, to, event.occurredAt, {
        ...(to === "rejected" ? { rejectReason: detail } : { lastError: detail }),
      }),
    };
  },
} as const;

export type ApplyEventResult =
  | { readonly applied: true; readonly delivery: Delivery }
  | {
      readonly applied: false;
      readonly delivery: Delivery;
      readonly reason: "stale_event" | "already_terminal" | "illegal_transition";
    };
