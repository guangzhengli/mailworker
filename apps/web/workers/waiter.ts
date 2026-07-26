import { DurableObject } from "cloudflare:workers";
import type { Caller, Message, MessageRepository, Waiter } from "@mailworker/core";
import { WaitCriteria } from "@mailworker/core";

/**
 * How far back a wait looks through already-stored messages.
 *
 * A wait is a question about recent mail, so this is a window rather than a
 * scan. It only matters when a caller waits for something that arrived before
 * they asked; the forward half — the part that makes `wait` feel instant — has
 * no bound at all.
 */
const LOOKBACK_LIMIT = 50;

/**
 * The rendezvous point for `wait`, one Durable Object per account.
 *
 * A long poll needs somewhere with an addressable identity that the ingest path
 * can notify. The alternative — polling D1 in a loop — would put load on the
 * database proportional to the number of idle waiters and add up to a poll
 * interval of latency to the one operation whose entire value is being fast.
 *
 * One instance per account, not per inbox: a wait with no `inboxId` has to see
 * every message in the account, so there is no sharding key that works for the
 * general case. The instance does nothing but hold promises and run a handful of
 * string comparisons per delivery, so this stays cheap far past the point where
 * anything else here needs attention.
 *
 * Nothing is persisted. A waiter is a live caller holding an open request; if
 * this object is evicted, that request is already gone too, and a `wait` that
 * survived its own caller would be waiting for nobody.
 */
export class MessageWaiter extends DurableObject<Env> {
  readonly #pending = new Map<string, Pending>();

  /**
   * Hold until a matching message is notified, or `timeoutMs` elapses.
   *
   * The caller supplies the id so it can cancel: it races this against a
   * look-back over stored messages, and whichever answers first wins.
   */
  async listen(
    waitId: string,
    criteria: WaitCriteria,
    timeoutMs: number,
  ): Promise<Message | null> {
    return await new Promise<Message | null>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(waitId);
        resolve(null);
      }, timeoutMs);
      this.#pending.set(waitId, { criteria, resolve, timer });
    });
  }

  /** Give up on a wait whose answer came from somewhere else. Idempotent. */
  async cancel(waitId: string): Promise<void> {
    const pending = this.#pending.get(waitId);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pending.delete(waitId);
    pending.resolve(null);
  }

  /**
   * Called by the ingest path once a message is durably stored.
   *
   * After storage, never before: a waiter that learned about a message the
   * database does not have yet would hand its caller an id that a follow-up
   * `GET /v1/messages/:id` could not find.
   *
   * Every matching waiter is woken, not just the first. Two agents waiting on
   * the same inbox are both entitled to the answer, and picking one would make
   * the other time out for no reason it could observe.
   */
  async notify(message: Message): Promise<void> {
    for (const [waitId, pending] of this.#pending) {
      if (!WaitCriteria.matches(message, pending.criteria)) continue;
      clearTimeout(pending.timer);
      this.#pending.delete(waitId);
      pending.resolve(message);
    }
  }

  /** How many callers are currently blocked here. For diagnostics and tests. */
  async pendingCount(): Promise<number> {
    return this.#pending.size;
  }
}

interface Pending {
  readonly criteria: WaitCriteria;
  readonly resolve: (message: Message | null) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * The `Waiter` port over the Durable Object above.
 *
 * A wait is two questions at once — "has it already arrived?" and "will it
 * arrive?" — and the order matters. Listening is started BEFORE the look-back
 * query runs, so a message landing in between is caught by the listener instead
 * of falling into the gap; the look-back then answers the first question, and
 * the loser of the race is cancelled.
 */
export class DurableWaiter implements Waiter {
  constructor(
    private readonly namespace: DurableObjectNamespace<MessageWaiter>,
    private readonly messages: MessageRepository,
  ) {}

  async wait(ctx: Caller, criteria: WaitCriteria, timeoutMs: number): Promise<Message | null> {
    const stub = this.stubFor(ctx);
    const waitId = crypto.randomUUID();

    // Attached now, not later: if the look-back wins the race we return without
    // awaiting this, and an unobserved rejection would surface as an unhandled
    // error in the isolate rather than anywhere a caller could act on it.
    const listening = stub.listen(waitId, criteria, timeoutMs).catch(() => null);

    const stored = await this.lookBack(ctx, criteria);
    if (stored !== null) {
      await stub.cancel(waitId).catch(() => undefined);
      return stored;
    }

    return await listening;
  }

  async notify(ctx: Caller, message: Message): Promise<void> {
    await this.stubFor(ctx).notify(message);
  }

  private stubFor(ctx: Caller): DurableObjectStub<MessageWaiter> {
    return this.namespace.get(this.namespace.idFromName(ctx.accountId));
  }

  /**
   * The newest already-stored message matching the criteria, if any.
   *
   * Two phases, because a summary has no body: the query narrows by the fields
   * D1 can filter on, `couldMatch` drops the rest, and only a surviving
   * candidate is loaded in full so `match` can be tested against its text. In
   * the ordinary case — a wait that is answered by the message that just
   * arrived — that is one list query and one load.
   */
  private async lookBack(ctx: Caller, criteria: WaitCriteria): Promise<Message | null> {
    const page = await this.messages.list(ctx, {
      direction: "inbound",
      limit: LOOKBACK_LIMIT,
      order: "desc",
      ...(criteria.inboxId === undefined ? {} : { inboxId: criteria.inboxId }),
      ...(criteria.from === undefined ? {} : { from: criteria.from }),
      ...(criteria.after === undefined ? {} : { after: criteria.after }),
    });

    for (const summary of page.items) {
      if (!WaitCriteria.couldMatch(summary, criteria)) continue;
      const message = await this.messages.findById(ctx, summary.id);
      if (message !== null && WaitCriteria.matches(message, criteria)) return message;
    }
    return null;
  }
}
