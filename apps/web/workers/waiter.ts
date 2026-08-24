import { DurableObject } from "cloudflare:workers";
import type { AccountId, Caller, Message, MessageRepository, Waiter } from "@mailworker/core";
import { DomainError, WaitCriteria } from "@mailworker/core";

/**
 * How far back a wait looks through already-stored messages.
 *
 * A wait is a question about recent mail, so this is a window rather than a
 * scan. It only matters when a caller waits for something that arrived before
 * they asked; the forward half — the part that makes `wait` feel instant — has
 * no bound at all.
 */
const LOOKBACK_LIMIT = 50;
const MAX_PENDING_WAITS = 50;

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
 *
 * The dashboard's live connection attaches here too, for the reason that made
 * this object worth having in the first place: `notify` is already the one call
 * that happens exactly once per stored message, so a socket hanging off it
 * cannot drift out of step with `wait`. A second mechanism — its own DO, its own
 * subscription to the event bus — would be a second answer to "has mail
 * arrived?", and the two would disagree the first time one of them is changed.
 */
export class MessageWaiter extends DurableObject<Env> {
  readonly #pending = new Map<string, Pending>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    /**
     * Answered by the runtime while this object stays hibernated. A browser
     * cannot send a protocol-level ping frame, so an idle dashboard tab has to
     * keep its connection alive with an ordinary message — and without this,
     * every one of those would wake the object up to say nothing.
     */
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /**
   * Accept a dashboard's live connection. Reached only through
   * `workers/http/events.ts`, which has already established who is asking.
   *
   * `acceptWebSocket` rather than `server.accept()`: the hibernatable form lets
   * the object be evicted while the socket stays open, so a tab left open
   * overnight costs storage of the socket rather than duration of an isolate.
   * The inbox and identity filters ride along in the socket's attachment for
   * the same reason — instance fields do not survive hibernation, and a filter
   * that silently emptied itself would turn one identity's page into a
   * firehose.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }

    const url = new URL(request.url);
    const visibility = url.searchParams.get("visibility");
    const inboxId = url.searchParams.get("inbox");
    const identity = url.searchParams.get("identity");
    if (
      (visibility !== "account" && visibility !== "identity") ||
      (visibility === "identity" && identity === null) ||
      (visibility === "account" && identity !== null)
    ) {
      // The DO is reached through an internal binding, but rolling deployments
      // can briefly pair this new code with an old forwarding Worker. Missing
      // provenance must never be interpreted as account-wide visibility.
      return new Response("Missing authenticated visibility marker.", { status: 403 });
    }
    const identityId = visibility === "identity" ? identity : null;
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ inboxId, identityId } satisfies SocketFilter);

    return new Response(null, { status: 101, webSocket: client });
  }

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
    if (this.#pending.size >= MAX_PENDING_WAITS && !this.#pending.has(waitId)) {
      throw new Error(`Too many concurrent waits (maximum ${MAX_PENDING_WAITS}).`);
    }
    return await new Promise<Message | null>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(waitId);
        resolve(null);
      }, timeoutMs);
      this.#pending.set(waitId, { criteria, resolve, timer });
    });
  }

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
    this.#broadcast(message);
  }

  /**
   * Tell every watching dashboard that something landed.
   *
   * Deliberately not the message: the event carries only enough to decide
   * whether this page is affected, and the page answers "and what does it look
   * like now" by re-running its loader. Pushing the row itself would mean the
   * client re-implementing the loader's filters — the search query, the page
   * cursor, the caller's scopes — to know where to put it, and a second
   * implementation of a filter is a second set of bugs.
   *
   * A `send` on a socket the client has already abandoned throws, and one dead
   * tab must not stop the live ones from being told.
   */
  #broadcast(message: Message): void {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;

    const event: LiveEvent = {
      type: "message.received",
      id: message.id,
      inboxId: message.inboxId,
      receivedAt: message.receivedAt.toISOString(),
    };
    const payload = JSON.stringify(event);

    for (const socket of sockets) {
      const filter = socket.deserializeAttachment() as SocketFilter | null;
      // A socket accepted by a pre-identity-filter deployment has no marker
      // proving its visibility. Fail closed across a rolling deploy instead of
      // treating that old attachment as account-wide.
      if (filter === null || !("identityId" in filter)) {
        socket.close(1012, "Reconnect to refresh authorization.");
        continue;
      }
      if (filter.identityId !== null && filter.identityId !== message.identityId) continue;
      if (filter?.inboxId != null && filter.inboxId !== message.inboxId) continue;
      try {
        socket.send(payload);
      } catch {
        // Already gone. `webSocketClose` will not fire for it either.
      }
    }
  }

  async pendingCount(): Promise<number> {
    return this.#pending.size;
  }
}

interface Pending {
  readonly criteria: WaitCriteria;
  readonly resolve: (message: Message | null) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** What a socket asked to hear about, kept where hibernation cannot lose it. */
interface SocketFilter {
  readonly inboxId: string | null;
  readonly identityId: string | null;
}

/**
 * The one thing the live connection ever says. Named and exported because the
 * browser half parses it (`app/live.ts`), and an ad-hoc object here plus an
 * ad-hoc cast there is how the two stop agreeing.
 */
export interface LiveEvent {
  readonly type: "message.received";
  readonly id: string;
  readonly inboxId: string;
  readonly receivedAt: string;
}

/**
 * The waiter instance for an account.
 *
 * One function rather than two call sites doing `idFromName`, because "one
 * instance per account" is the invariant the whole object depends on: a second
 * naming scheme would put the dashboard's socket on a different instance from
 * the `notify` that is supposed to reach it, and nothing would error.
 */
export function waiterFor(
  namespace: DurableObjectNamespace<MessageWaiter>,
  accountId: AccountId,
): DurableObjectStub<MessageWaiter> {
  return namespace.get(namespace.idFromName(accountId));
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

    if ((await stub.pendingCount()) >= MAX_PENDING_WAITS) {
      throw new DomainError(
        "wait_capacity_exceeded",
        `This environment already has ${MAX_PENDING_WAITS} concurrent waits.`,
        { maximum: MAX_PENDING_WAITS },
      );
    }

    // Attached now, not later: if the look-back wins the race we return without
    // awaiting this, and an unobserved rejection would surface as an unhandled
    // error in the isolate rather than anywhere a caller could act on it.
    const listening = stub.listen(waitId, criteria, timeoutMs).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    const stored = await this.lookBack(ctx, criteria);
    if (stored !== null) {
      await stub.cancel(waitId).catch(() => undefined);
      return stored;
    }

    const notified = await listening;
    if (!notified.ok) throw notified.error;
    if (notified.value !== null) return notified.value;
    // Close the insert→notify failure window: if the DO RPC was lost after D1
    // committed, the listener can time out even though the answer exists.
    return await this.lookBack(ctx, criteria);
  }

  async notify(ctx: Caller, message: Message): Promise<void> {
    await this.stubFor(ctx).notify(message);
  }

  private stubFor(ctx: Caller): DurableObjectStub<MessageWaiter> {
    return waiterFor(this.namespace, ctx.accountId);
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
      ...(criteria.identityId === undefined ? {} : { identityId: criteria.identityId }),
    });

    for (const summary of page.items) {
      if (!WaitCriteria.couldMatch(summary, criteria)) continue;
      const message = await this.messages.findById(ctx, summary.id);
      if (message !== null && WaitCriteria.matches(message, criteria)) return message;
    }
    return null;
  }
}
