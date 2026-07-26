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
 * Domain events: logged, and queued for webhook fan-out.
 *
 * Both, not either. The log line is what makes "why did this message get filed
 * as untrusted" answerable in `wrangler tail` with no subscriber configured,
 * and `observability` is on so it stays queryable afterwards. The queue is what
 * gets it to someone else's server, with Cloudflare owning the retries.
 *
 * Publishing to the queue never fails the caller. An event is a fact about
 * something that already happened — the message is stored, the send is queued —
 * so a queue hiccup must not roll back the operation that produced it. It is
 * logged loudly instead, which is the honest trade: at-most-once fan-out for
 * work that has already succeeded, rather than failing a send because a webhook
 * queue was briefly unavailable.
 *
 * `wait` deliberately does not come through here. A waiter is notified by the
 * ingest path directly, after the row is committed, because a caller blocked on
 * a message needs it to be readable the moment they are handed it — and a bus
 * that fans out asynchronously cannot promise that.
 */
export class LoggingEventBus implements EventBus {
  constructor(private readonly queue?: Queue<QueuedEvent>) {}

  async publish(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      console.log(JSON.stringify({ ...event, occurredAt: event.occurredAt.toISOString() }));
    }

    if (this.queue === undefined || events.length === 0) return;
    try {
      await this.queue.sendBatch(
        events.map((event) => ({
          body: {
            // A stable id per event, so a subscriber retried by the queue can
            // recognise the redelivery rather than counting it twice.
            id: crypto.randomUUID(),
            event: { ...event, occurredAt: event.occurredAt.toISOString() },
          },
        })),
      );
    } catch (error) {
      console.error("webhook fan-out could not be queued", error);
    }
  }
}

export interface QueuedEvent {
  readonly id: string;
  /** The event with its `Date` serialized; the consumer revives it. */
  readonly event: Record<string, unknown>;
}
