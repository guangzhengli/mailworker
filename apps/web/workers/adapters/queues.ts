import type { Caller, DispatchQueue, DomainEvent, EventBus, Ulid } from "@mailworker/core";

/**
 * The dispatch queue over Cloudflare Queues.
 *
 * The id only, not the payload. The payload is already in R2 and the decision
 * is already a row, so putting them on the queue too would mean a retry could
 * send something other than what was approved — and would put recipient
 * addresses and message bodies in a second place with its own retention.
 *
 * Retries and the dead-letter queue are Cloudflare's, configured in
 * wrangler.jsonc rather than written here: backoff is exactly the sort of thing
 * that looks like thirty lines and turns into a thundering herd.
 */
export class QueueDispatch implements DispatchQueue {
  constructor(private readonly queue: Queue<string>) {}

  async enqueue(_ctx: Caller, deliveryId: Ulid): Promise<void> {
    await this.queue.send(deliveryId);
  }
}

/**
 * The dispatch queue on a deployment that has none.
 *
 * It throws, unlike `UnconfiguredTransport` which answers a failure — and the
 * asymmetry is the point. A transport failure is an outcome the `Delivery`
 * state machine has a state for, so it gets recorded and shows up in
 * `mailworker status`. There is no state for "we told you it was queued and
 * then dropped it", so the send must not be reported as accepted. Throwing
 * turns it into a 500 with a code, which is a truthful answer to `POST /v1/send`
 * where a cheerful `202` would not be.
 */
export class UnavailableDispatchQueue implements DispatchQueue {
  async enqueue(_ctx: Caller, _deliveryId: Ulid): Promise<void> {
    throw new Error(
      "No dispatch queue is bound. Run `mailworker deploy` to create it, or " +
        "`mailworker doctor` to see what else is missing.",
    );
  }
}

/**
 * Domain events as structured log lines.
 *
 * `observability` is on in wrangler.jsonc, so these are queryable in the
 * dashboard and visible in `wrangler tail` — which is what they are for until
 * something subscribes. "Why did this message get filed as untrusted" is
 * answerable without a webhook subscriber existing yet.
 *
 * M3 replaces this with a Queues producer, once there is something on the other
 * end: webhook fan-out with retries. Producing to a queue nobody consumes would
 * be a binding to provision, a consumer to deploy and a dead-letter queue to
 * watch, in exchange for nothing.
 *
 * `wait` deliberately does not come through here. A waiter is notified by the
 * ingest path directly, after the row is committed, because a caller blocked on
 * a message needs it to be readable the moment they are handed it — and a bus
 * that fans out asynchronously cannot promise that.
 */
export class LoggingEventBus implements EventBus {
  async publish(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      console.log(JSON.stringify({ ...event, occurredAt: event.occurredAt.toISOString() }));
    }
  }
}
