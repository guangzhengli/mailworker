import type { DeliveryEventType, ProviderDeliveryEvent } from "@mailworker/core";
import { Caller, EmailAddress } from "@mailworker/core";
import { createContainer } from "@web/workers/container";

/**
 * The two queues, one consumer.
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
 * One handler for both because a Worker gets exactly one `queue` export; the
 * queue name is the discriminator, and each branch is three lines.
 */
export async function queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  const { services, accountId } = createContainer(env);
  const ctx = Caller.system(accountId, "system:queue");

  for (const message of batch.messages) {
    try {
      if (batch.queue.endsWith("events")) {
        const event = toProviderEvent(message.body);
        // An unrecognised payload is acked, not retried. Cloudflare may add
        // event types, and a message we will never understand would otherwise
        // cycle through every retry and land in the DLQ on every deploy.
        if (event !== null) await services.delivery.recordEvent(ctx, event);
      } else {
        await services.delivery.dispatch(ctx, { deliveryId: String(message.body) });
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
  if (typeof body !== "object" || body === null) return null;
  const envelope = body as Record<string, unknown>;

  const type = EVENT_TYPES[String(envelope["type"])];
  if (type === undefined) return null;

  const payload = (envelope["payload"] ?? envelope) as Record<string, unknown>;
  const providerMessageId = firstString(payload, ["messageId", "message_id", "id"]);
  if (providerMessageId === null) return null;

  const recipient = firstString(payload, ["recipient", "to", "rcptTo"]);
  const occurredAt = firstString(payload, ["occurredAt", "timestamp", "time"]);

  return {
    type,
    providerMessageId,
    recipient: recipient === null ? null : EmailAddress.tryParse(recipient),
    occurredAt: occurredAt === null ? new Date() : parseDate(occurredAt),
    // `delivered`, `bounced`, `complained` and `rejected` end the story;
    // `deferred` and `failed` may still be followed by another attempt. We
    // decide this rather than trusting a flag, because the state machine has to
    // agree with itself even when the payload omits it.
    terminal: type !== "deferred" && type !== "failed",
    smtpCode: firstString(payload, ["smtpCode", "smtp_code", "code"]),
    smtpResponse: firstString(payload, ["smtpResponse", "smtp_response", "response"]),
    raw: JSON.stringify(body),
  };
}

function firstString(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
  }
  return null;
}

function parseDate(value: string): Date {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}
