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

/**
 * Every event about a send carries the caller's metadata back to them.
 *
 * This is the half of the feature that makes it worth having. A `metadata` you
 * can only read by fetching the delivery is a convenience; one that rides along
 * on the bounce webhook three days later is what lets a subscriber route that
 * bounce to the right tenant without a lookup — which is the only reason to have
 * attached it at send time.
 */
interface DeliveryEventBase extends EventBase {
  readonly metadata: Readonly<Record<string, string>>;
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
  | (DeliveryEventBase & {
      readonly type: "delivery.queued";
      readonly deliveryId: Ulid;
      readonly recipients: readonly EmailAddress[];
    })
  | (DeliveryEventBase & {
      readonly type: "delivery.approval_requested";
      readonly deliveryId: Ulid;
      readonly reason: string;
    })
  | (DeliveryEventBase & {
      readonly type: "delivery.rejected";
      readonly deliveryId: Ulid | null;
      readonly reason: string;
      readonly code: string;
    })
  | (DeliveryEventBase & {
      readonly type: "delivery.dispatched";
      readonly deliveryId: Ulid;
      readonly providerMessageId: string | null;
    })
  | (DeliveryEventBase & {
      readonly type: "delivery.status_changed";
      readonly deliveryId: Ulid;
      readonly from: DeliveryStatus;
      readonly to: DeliveryStatus;
      /**
       * The provider event that caused this, or null when we moved it
       * ourselves — an approval releasing a held send is a status change with
       * nothing from the provider behind it. A subscriber filtering on bounces
       * needs to be able to tell those apart.
       */
      readonly deliveryEvent: DeliveryEventType | null;
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
