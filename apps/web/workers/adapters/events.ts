import type { DomainEvent, EventBus } from "@mailworker/core";

/**
 * Domain events as structured log lines.
 *
 * `observability` is on in wrangler.jsonc, so these are queryable in the
 * dashboard and visible in `wrangler tail` — which through M1 is exactly what
 * they are for. "Why did this message get filed as untrusted" is answerable
 * without a webhook subscriber existing yet.
 *
 * M3 replaces this with a Queues producer, once there is something on the other
 * end: webhook fan-out with retries and the realtime hub. Producing to a queue
 * that nobody consumes would be a binding to provision, a consumer to deploy and
 * a dead-letter queue to watch, in exchange for nothing.
 *
 * `wait` deliberately does not come through here. A waiter is notified by the
 * ingest path directly, after the row is committed, because a caller blocked on
 * a message needs it to be readable the moment they are handed it — and a bus
 * that fans out asynchronously cannot promise that.
 */
export class LoggingEventBus implements EventBus {
  async publish(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      console.log(
        JSON.stringify({
          ...event,
          occurredAt: event.occurredAt.toISOString(),
        }),
      );
    }
  }
}
