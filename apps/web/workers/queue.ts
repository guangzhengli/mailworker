import type { DeliveryEventType, DomainEvent, ProviderDeliveryEvent } from "@mailworker/core";
import { AccountId, EmailAddress } from "@mailworker/core";
import type { QueuedEvent } from "@web/workers/adapters";
import { toQueuedDispatch } from "@web/workers/adapters";
import { createContainer } from "@web/workers/container";
import { systemCaller } from "@web/workers/environment";

/**
 * The three queues, one consumer.
 *
 * `mailworker-dispatch` is ours: `send` ends at `queued` with the decision and
 * the payload already durable, and this is where the network call happens. That
 * split is what makes sending retryable — a failed dispatch retries against a
 * recorded decision instead of re-litigating whether the send was allowed.
 *
 * `mailworker-events` is Cloudflare's: the six `cf.email.sending.message.*`
 * event types from the subscription on the sending domain (DESIGN §2.3). They
 * are what turns a send from fire-and-forget into something with a timeline,
 * and they arrive minutes to days after the handoff.
 *
 * `mailworker-webhooks` is the fan-out to whoever subscribed. Separate from the
 * other two because the failure modes are unrelated: someone else's server
 * being down must not delay anyone's mail.
 *
 * One handler for all three because a Worker gets exactly one `queue` export;
 * the queue name is the discriminator, and each branch is three lines.
 */
export async function queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  const container = createContainer(env);
  const { services } = container;

  for (const message of batch.messages) {
    try {
      if (batch.queue.endsWith("webhooks")) {
        const queued = message.body as QueuedEvent;
        // Domain events carry the environment that produced them. Using the
        // deployment default here would deliver sandbox/dev message metadata to
        // production's webhook subscribers.
        const eventAccount = AccountId.parse(String(queued.event["accountId"]));
        const ctx = await systemCaller(container, eventAccount, "system:queue");
        await services.delivery.fanOut(ctx, reviveEvent(queued.event), queued.id);
      } else if (batch.queue.endsWith("events")) {
        const event = toProviderEvent(message.body);
        // An unrecognised payload is acked, not retried. Cloudflare may add
        // event types, and a message we will never understand would otherwise
        // cycle through every retry and land in the DLQ on every deploy.
        if (event !== null) {
          // The provider event names no environment, so the delivery it refers
          // to is what decides which one it belongs to. An unmatched event is
          // still recorded — under the default environment, where a human
          // looking for it will think to check.
          const accountId =
            (await container.deliveries.resolveAccount(event.providerMessageId)) ??
            (await container.domains.resolveAccount(event.sourceDomain)) ??
            container.defaultAccountId;
          const ctx = await systemCaller(container, accountId, "system:queue");
          await services.delivery.recordEvent(ctx, event);
        }
      } else {
        const queued = toQueuedDispatch(message.body, container.defaultAccountId);
        const ctx = await systemCaller(
          container,
          queued.accountId as AccountId,
          "system:queue",
        );
        await services.delivery.dispatch(ctx, { deliveryId: queued.deliveryId });
      }
      message.ack();
    } catch (error) {
      // Explicit rather than by throwing: a throw fails the whole batch, so one
      // poisonous message would drag its nineteen healthy neighbours through
      // the retry with it.
      console.error(`${batch.queue} ${message.id}`, error);
      message.retry();
    }
  }
}

/**
 * Undo the one thing JSON loses on the way through a queue.
 *
 * `occurredAt` is a `Date` in the domain and a string on the wire, and the
 * webhook payload states it as an ISO timestamp — so it has to come back as a
 * `Date` here, or the signature would be computed over `[object Object]` and
 * every receiver would reject it for reasons nobody could see from either end.
 */
function reviveEvent(raw: Record<string, unknown>): DomainEvent {
  return { ...raw, occurredAt: new Date(String(raw["occurredAt"])) } as unknown as DomainEvent;
}

/** The six types the subscription publishes, mapped onto our status vocabulary. */
const EVENT_TYPES: Readonly<Record<string, DeliveryEventType>> = {
  "cf.email.sending.message.delivered": "delivered",
  "cf.email.sending.message.deferred": "deferred",
  "cf.email.sending.message.bounced": "bounced",
  "cf.email.sending.message.failed": "failed",
  "cf.email.sending.message.rejected": "rejected",
  "cf.email.sending.message.complained": "complained",
};

/**
 * Cloudflare's envelope, flattened into the shape the domain named.
 *
 * Defensive about every field, because this is the one input we neither
 * generate nor validate at a schema boundary — it arrives from a subscription
 * that can gain fields, and a `TypeError` in a queue consumer becomes an
 * infinite retry rather than a stack trace anybody reads.
 *
 * The whole original payload is kept verbatim on the row. When a delivery
 * argument comes down to what the provider actually said, a reconstruction of
 * it is not evidence.
 */
export function toProviderEvent(body: unknown): ProviderDeliveryEvent | null {
  if (!isRecord(body)) return null;
  const envelope = body;

  const type = EVENT_TYPES[String(envelope["type"])];
  if (type === undefined) return null;

  const source = envelope["source"];
  const payload = envelope["payload"];
  const metadata = envelope["metadata"];
  if (!isRecord(source) || !isRecord(payload) || !isRecord(metadata)) return null;

  const sourceType = requiredString(source, "type");
  const sourceZoneId = requiredString(source, "zoneId");
  const sourceDomain = requiredString(source, "domain");
  const eventId = requiredString(payload, "eventId");
  const providerMessageId = requiredString(payload, "messageId");
  const sender = requiredString(payload, "sender");
  const recipientText = requiredString(payload, "recipient");
  const occurredAtText = requiredString(metadata, "eventTimestamp");
  const delivery = payload["delivery"];
  if (
    sourceType !== "email.sending" ||
    sourceZoneId === null ||
    sourceDomain === null ||
    eventId === null ||
    providerMessageId === null ||
    sender === null ||
    EmailAddress.tryParse(sender) === null ||
    recipientText === null ||
    !isRecord(delivery) ||
    requiredString(delivery, "status") !== type ||
    typeof payload["terminal"] !== "boolean" ||
    occurredAtText === null ||
    requiredString(metadata, "accountId") === null ||
    requiredString(metadata, "eventSubscriptionId") === null ||
    metadata["eventSchemaVersion"] !== 1
  ) {
    return null;
  }

  const recipient = EmailAddress.tryParse(recipientText);
  const occurredAt = parseDate(occurredAtText);
  if (recipient === null || occurredAt === null) return null;

  // The known v1 fields are type-checked even when Mailworker does not promote
  // them into columns yet. Unknown additive fields remain allowed so a harmless
  // provider extension does not poison the queue.
  if (
    !optionalString(payload, "subject") ||
    !optionalString(delivery, "provider") ||
    !optionalString(delivery, "smtpStatusCode") ||
    !optionalString(delivery, "smtpEnhancedStatusCode") ||
    !optionalString(delivery, "smtpResponse") ||
    !optionalNonNegativeNumber(delivery, "deliveryTimeMs")
  ) {
    return null;
  }

  const terminal = payload["terminal"];
  if (
    (type === "deferred" && terminal) ||
    (type !== "deferred" && type !== "failed" && !terminal)
  ) {
    return null;
  }

  const bounce = parseBounce(payload["bounce"]);
  if ((type === "deferred" || type === "bounced") && bounce === null) return null;
  if (payload["bounce"] !== undefined && bounce === null) return null;
  if (type === "failed" && !hasRequiredStrings(payload["failure"], ["reason"])) return null;
  if (
    type === "rejected" &&
    !hasRequiredStrings(payload["rejection"], ["reason", "party", "detail"])
  ) {
    return null;
  }
  if (type === "complained" && !hasRequiredStrings(payload["complaint"], ["type"])) {
    return null;
  }

  return {
    eventId,
    type,
    providerMessageId,
    recipient,
    sourceDomain,
    sourceZoneId,
    occurredAt,
    terminal,
    smtpCode: stringValue(delivery, "smtpStatusCode"),
    smtpEnhancedCode: stringValue(delivery, "smtpEnhancedStatusCode"),
    smtpResponse: stringValue(delivery, "smtpResponse"),
    bounceType: bounce?.type ?? null,
    bounceClassification: bounce?.classification ?? null,
    bounceReason: bounce?.reason ?? null,
    raw: JSON.stringify(body),
  };
}

interface BounceFields {
  readonly type: "hard" | "soft";
  readonly classification: string;
  readonly reason: string;
}

function parseBounce(value: unknown): BounceFields | null {
  if (!isRecord(value)) return null;
  const type = value["type"];
  const classification = requiredString(value, "classification");
  const reason = requiredString(value, "reason");
  if ((type !== "hard" && type !== "soft") || classification === null || reason === null) {
    return null;
  }
  return { type, classification, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringValue(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function optionalString(source: Record<string, unknown>, key: string): boolean {
  const value = source[key];
  return value === undefined || typeof value === "string";
}

function optionalNonNegativeNumber(source: Record<string, unknown>, key: string): boolean {
  const value = source[key];
  return (
    value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}

function hasRequiredStrings(value: unknown, keys: readonly string[]): boolean {
  return isRecord(value) && keys.every((key) => requiredString(value, key) !== null);
}

function parseDate(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
