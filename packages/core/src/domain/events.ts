import type { DeliveryEventType, DeliveryStatus } from "@core/domain/delivery/delivery";
import type { EmailAddress } from "@core/domain/email-address";
import type { AccountId } from "@core/domain/identity/account-id";
import type { UnroutableReason } from "@core/domain/ingestion/address-resolution-policy";
import type { ThreadId } from "@core/domain/mailbox/message-id";
import type { Ulid } from "@core/domain/ulid";

/**
 * Things that happened, as facts. Published through `EventBus`, which fans
 * them out to webhooks, to the realtime hub, to whoever is blocked in `wait`,
 * and to the audit log.
 *
 * The in-memory bus used in tests records these, so a use-case test can assert
 * on what the system *decided* rather than only on what it stored. That is most
 * of the value of having an event type at all.
 *
 * `type` strings are part of the public webhook contract — additive changes
 * only, never a rename.
 */
interface EventBase {
  readonly accountId: AccountId;
  readonly occurredAt: Date;
}

export type DomainEvent =
  | (EventBase & {
      readonly type: "inbox.created";
      readonly inboxId: Ulid;
      readonly address: EmailAddress;
      readonly expiresAt: Date | null;
    })
  | (EventBase & {
      readonly type: "inbox.expired";
      readonly inboxId: Ulid;
      readonly address: EmailAddress;
    })
  | (EventBase & {
      readonly type: "message.received";
      readonly messageId: Ulid;
      readonly inboxId: Ulid;
      readonly threadId: ThreadId;
      readonly from: EmailAddress | null;
      readonly subject: string;
      readonly trusted: boolean;
      readonly injectionRisk: boolean;
    })
  | (EventBase & {
      /** Stored a duplicate we already had. Useful when debugging retries. */
      readonly type: "message.duplicate";
      readonly rfcMessageId: string;
      readonly inboxId: Ulid;
    })
  | (EventBase & {
      readonly type: "message.unroutable";
      readonly recipient: EmailAddress;
      readonly reason: UnroutableReason;
    })
  | (EventBase & {
      readonly type: "delivery.queued";
      readonly deliveryId: Ulid;
      readonly recipients: readonly EmailAddress[];
    })
  | (EventBase & {
      readonly type: "delivery.approval_requested";
      readonly deliveryId: Ulid;
      readonly reason: string;
    })
  | (EventBase & {
      readonly type: "delivery.rejected";
      readonly deliveryId: Ulid | null;
      readonly reason: string;
      readonly code: string;
    })
  | (EventBase & {
      readonly type: "delivery.dispatched";
      readonly deliveryId: Ulid;
      readonly providerMessageId: string | null;
    })
  | (EventBase & {
      readonly type: "delivery.status_changed";
      readonly deliveryId: Ulid;
      readonly from: DeliveryStatus;
      readonly to: DeliveryStatus;
      readonly deliveryEvent: DeliveryEventType;
      readonly recipient: EmailAddress | null;
    })
  | (EventBase & {
      readonly type: "suppression.added";
      readonly address: EmailAddress;
      readonly reason: string;
    });

export type DomainEventType = DomainEvent["type"];

/** Narrow a heterogeneous event list, e.g. in tests or a webhook filter. */
export function eventsOfType<T extends DomainEventType>(
  events: readonly DomainEvent[],
  type: T,
): Extract<DomainEvent, { type: T }>[] {
  return events.filter(
    (event): event is Extract<DomainEvent, { type: T }> => event.type === type,
  );
}
