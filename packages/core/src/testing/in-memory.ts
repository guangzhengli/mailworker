/**
 * In-memory implementations of every port.
 *
 * These are a deliverable, not test scaffolding. A project that sells email
 * testing has to be able to test its own mail handling, and requiring miniflare
 * (or a real Cloudflare account) to exercise a policy decision would make the
 * suite slow enough that people stop running it. Everything here is
 * synchronous-fast and deterministic: ids count up, the clock only moves when a
 * test moves it, and `wait` never actually waits.
 */
import type {
  Account,
  AccountId,
  AgentIdentity,
  ApiKey,
  Caller,
  Delivery,
  DomainEvent,
  DomainRouting,
  Inbox,
  MessageSummary,
  Page,
  ProjectId,
  SuppressionEntry,
  ThreadId,
  Ulid,
  WebhookSubscription,
} from "@core/domain";
import {
  CROCKFORD,
  clampLimit,
  EmailAddress,
  Message,
  RfcMessageId,
  SenderAuth,
  WaitCriteria,
} from "@core/domain";
import type {
  AccountRepository,
  ApiKeyRepository,
  BlobMeta,
  BlobStore,
  BuildMimeSpec,
  Clock,
  ContentHasher,
  DeliveryEvent,
  DeliveryRepository,
  DispatchQueue,
  DispatchRequest,
  DispatchResult,
  DnsResolver,
  DomainRepository,
  EventBus,
  IdentityRepository,
  IdGenerator,
  InboxRepository,
  ListDeliveriesQuery,
  ListInboxesQuery,
  ListMessagesQuery,
  LoopbackMessage,
  LoopbackSink,
  MailTransport,
  MessageRepository,
  MimeBuilder,
  MimeParser,
  ParsedAttachment,
  ParsedInbound,
  Secrets,
  SuppressionList,
  Waiter,
  WebhookRepository,
  WebhookRequest,
  WebhookSender,
} from "@core/domain/ports";

export class FakeClock implements Clock {
  constructor(private current: Date = new Date("2026-07-01T12:00:00.000Z")) {}

  now(): Date {
    return new Date(this.current);
  }

  set(value: Date): void {
    this.current = value;
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class FakeContentHasher implements ContentHasher {
  async sha256(content: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(content));
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
}

/**
 * Counter-based ids. Still valid, still monotonic — so ULID ordering and keyset
 * pagination behave exactly as in production — but a test can predict them.
 */
export class DeterministicIds implements IdGenerator {
  private counter = 0;

  constructor(private readonly epochMs = Date.UTC(2026, 0, 1)) {}

  ulid(): Ulid {
    this.counter += 1;
    return `${encodeCrockford(this.epochMs, 10)}${encodeCrockford(this.counter, 16)}` as Ulid;
  }

  rfcMessageId(domain: string): RfcMessageId {
    return RfcMessageId.parse(`${this.ulid()}@${domain}`);
  }
}

function encodeCrockford(value: number, length: number): string {
  let remaining = value;
  let out = "";
  for (let i = 0; i < length; i++) {
    out = CROCKFORD[remaining % 32]! + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

/**
 * Not a real digest, and a counter instead of entropy. Tests only.
 *
 * Still lowercase hex of exactly the requested length, though — that part is
 * not cosmetic. `ApiKeyToken.PATTERN` only accepts hex, so a fake that minted
 * `s1000…` would produce tokens the real parser rejects, and every in-memory
 * authentication test would be exercising a token shape that cannot exist.
 */
export class FakeSecrets implements Secrets {
  private counter = 0;

  generate(byteLength = 16): string {
    this.counter += 1;
    return this.counter.toString(16).padStart(byteLength * 2, "0");
  }

  async hash(plaintext: string): Promise<string> {
    return `fake:${plaintext}`;
  }

  async verify(plaintext: string, hash: string): Promise<boolean> {
    return hash === `fake:${plaintext}`;
  }
}

/** Every store keys by account first, mirroring the `account_id`-leading indexes. */
function scoped<T>(map: Map<string, T[]>, ctx: Caller): T[] {
  const existing = map.get(ctx.accountId);
  if (existing !== undefined) return existing;
  const created: T[] = [];
  map.set(ctx.accountId, created);
  return created;
}

function paginate<T extends { id: Ulid }>(
  rows: readonly T[],
  query: { limit?: number; cursor?: Ulid; order?: "asc" | "desc" },
): Page<T> {
  const order = query.order ?? "desc";
  const sorted = [...rows].sort((a, b) =>
    order === "desc" ? (a.id < b.id ? 1 : -1) : a.id < b.id ? -1 : 1,
  );
  const start =
    query.cursor === undefined
      ? sorted
      : sorted.filter((row) =>
          order === "desc" ? row.id < query.cursor! : row.id > query.cursor!,
        );
  const limit = clampLimit(query.limit);
  const items = start.slice(0, limit);
  return {
    items,
    cursor: items.length === limit && items.length > 0 ? items[items.length - 1]!.id : null,
  };
}

export class InMemoryInboxes implements InboxRepository {
  readonly rows = new Map<string, Inbox[]>();

  async findById(ctx: Caller, id: Ulid): Promise<Inbox | null> {
    return scoped(this.rows, ctx).find((row) => row.id === id) ?? null;
  }

  async findByAddress(ctx: Caller, address: EmailAddress): Promise<Inbox | null> {
    return (
      scoped(this.rows, ctx).find((row) => row.address === address && row.deletedAt === null) ??
      null
    );
  }

  async insert(ctx: Caller, inbox: Inbox): Promise<{ stored: boolean }> {
    const rows = scoped(this.rows, ctx);
    // Mirrors UNIQUE(account_id, address) as D1 declares it — the index does not
    // include `deleted_at`, so a soft-deleted row still holds its address.
    if (rows.some((row) => row.address === inbox.address)) {
      return { stored: false };
    }
    rows.push(inbox);
    return { stored: true };
  }

  async update(ctx: Caller, inbox: Inbox): Promise<void> {
    const rows = scoped(this.rows, ctx);
    const index = rows.findIndex((row) => row.id === inbox.id);
    if (index >= 0) rows[index] = inbox;
  }

  async list(ctx: Caller, query: ListInboxesQuery): Promise<Page<Inbox>> {
    let rows = scoped(this.rows, ctx).filter((row) => row.deletedAt === null);
    if (query.kind !== undefined) rows = rows.filter((row) => row.kind === query.kind);
    if (query.domain !== undefined) rows = rows.filter((row) => row.domain === query.domain);
    if (query.identityId !== undefined) {
      rows = rows.filter((row) => row.identityId === query.identityId);
    }
    if (query.activeAt !== undefined) {
      const at = query.activeAt.getTime();
      rows = rows.filter((row) => row.expiresAt === null || row.expiresAt.getTime() > at);
    }
    return paginate(rows, query);
  }

  async findExpired(ctx: Caller, expiredBefore: Date, limit: number): Promise<Inbox[]> {
    return (
      scoped(this.rows, ctx)
        .filter(
          (row) => row.expiresAt !== null && row.expiresAt.getTime() <= expiredBefore.getTime(),
        )
        // Oldest expiry first, as the port promises. Without the sort a sweep
        // capped by `limit` would revisit the same recent rows and never reach the
        // oldest ones — the backlog it exists to drain.
        .sort((a, b) => a.expiresAt!.getTime() - b.expiresAt!.getTime())
        .slice(0, limit)
    );
  }

  async deleteById(ctx: Caller, id: Ulid): Promise<void> {
    const rows = scoped(this.rows, ctx);
    const index = rows.findIndex((row) => row.id === id);
    if (index >= 0) rows.splice(index, 1);
  }
}

export class InMemoryMessages implements MessageRepository {
  readonly rows = new Map<string, Message[]>();
  private readonly bodyKeys = new Map<string, string>();

  async insert(
    ctx: Caller,
    message: Message,
    options: { readonly bodyKey?: string | null } = {},
  ): Promise<{ stored: boolean }> {
    const rows = scoped(this.rows, ctx);
    // Mirrors UNIQUE(account_id, inbox_id, envelope_recipient, rfc_message_id)
    // in D1: two routes into one catch-all inbox are distinct placements, while
    // an at-least-once retry to the same RCPT TO is one.
    if (
      rows.some(
        (row) =>
          row.inboxId === message.inboxId &&
          row.envelopeRecipient === message.envelopeRecipient &&
          row.rfcMessageId === message.rfcMessageId,
      )
    ) {
      return { stored: false };
    }
    rows.push(message);
    if (options.bodyKey != null) {
      this.bodyKeys.set(`${ctx.accountId}/${message.id}`, options.bodyKey);
    }
    return { stored: true };
  }

  async findById(ctx: Caller, id: Ulid): Promise<Message | null> {
    return scoped(this.rows, ctx).find((row) => row.id === id) ?? null;
  }

  async findByRfcMessageId(ctx: Caller, rfcId: RfcMessageId): Promise<Message | null> {
    return scoped(this.rows, ctx).find((row) => row.rfcMessageId === rfcId) ?? null;
  }

  async findPlacement(
    ctx: Caller,
    inboxId: Ulid,
    envelopeRecipient: EmailAddress | null,
    rfcId: RfcMessageId,
  ): Promise<Message | null> {
    return (
      scoped(this.rows, ctx).find(
        (row) =>
          row.inboxId === inboxId &&
          row.envelopeRecipient === envelopeRecipient &&
          row.rfcMessageId === rfcId,
      ) ?? null
    );
  }

  async findThreadIds(
    ctx: Caller,
    rfcIds: readonly RfcMessageId[],
    inboxId?: Ulid,
  ): Promise<ReadonlyMap<string, ThreadId>> {
    const wanted = new Set<string>(rfcIds);
    const found = new Map<string, ThreadId>();
    for (const row of scoped(this.rows, ctx)) {
      if (wanted.has(row.rfcMessageId) && (inboxId === undefined || row.inboxId === inboxId)) {
        found.set(row.rfcMessageId, row.threadId);
      }
    }
    return found;
  }

  async list(ctx: Caller, query: ListMessagesQuery): Promise<Page<MessageSummary>> {
    let rows = scoped(this.rows, ctx);
    if (query.identityId !== undefined) {
      rows = rows.filter((row) => row.identityId === query.identityId);
    }
    if (query.inboxId !== undefined) rows = rows.filter((row) => row.inboxId === query.inboxId);
    if (query.threadId !== undefined)
      rows = rows.filter((row) => row.threadId === query.threadId);
    if (query.direction !== undefined) {
      rows = rows.filter((row) => row.direction === query.direction);
    }
    if (query.from !== undefined) rows = rows.filter((row) => row.from === query.from);
    if (query.seen !== undefined) rows = rows.filter((row) => row.seen === query.seen);
    if (query.after !== undefined) rows = rows.filter((row) => row.id > query.after!);
    if (query.q !== undefined) {
      const wanted = tokenize(query.q);
      rows =
        wanted.length === 0
          ? []
          : rows.filter((row) => {
              const found = new Set([
                ...tokenize(row.subject),
                ...tokenize(row.bodyText ?? ""),
              ]);
              return wanted.every((token) => found.has(token));
            });
    }
    const page = paginate(rows, query);
    return { items: page.items.map((row) => Message.summarize(row)), cursor: page.cursor };
  }

  async listThread(ctx: Caller, threadId: ThreadId): Promise<Message[]> {
    return scoped(this.rows, ctx)
      .filter((row) => row.threadId === threadId)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  async setSeen(ctx: Caller, id: Ulid, seen: boolean): Promise<void> {
    const rows = scoped(this.rows, ctx);
    const index = rows.findIndex((row) => row.id === id);
    if (index >= 0) rows[index] = Message.markSeen(rows[index]!, seen);
  }

  async countSentBetween(
    ctx: Caller,
    from: EmailAddress,
    to: EmailAddress,
    since: Date,
  ): Promise<number> {
    return scoped(this.rows, ctx).filter(
      (row) =>
        row.direction === "outbound" &&
        row.from === from &&
        row.to.includes(to) &&
        row.receivedAt.getTime() >= since.getTime(),
    ).length;
  }

  async deleteByInbox(ctx: Caller, inboxId: Ulid): Promise<{ storageKeys: string[] }> {
    const rows = scoped(this.rows, ctx);
    const doomed = rows.filter((row) => row.inboxId === inboxId);
    const keys = doomed.flatMap((row) => [
      ...(row.rawKey === null ? [] : [row.rawKey]),
      ...(this.bodyKeys.get(`${ctx.accountId}/${row.id}`) === undefined
        ? []
        : [this.bodyKeys.get(`${ctx.accountId}/${row.id}`)!]),
      ...row.attachments.map((attachment) => attachment.storageKey),
    ]);
    for (const row of doomed) this.bodyKeys.delete(`${ctx.accountId}/${row.id}`);
    this.rows.set(
      ctx.accountId,
      rows.filter((row) => row.inboxId !== inboxId),
    );
    return { storageKeys: keys };
  }
}

export class InMemoryDeliveries implements DeliveryRepository {
  readonly rows = new Map<string, Delivery[]>();
  readonly events = new Map<string, DeliveryEvent[]>();
  readonly eventClaims = new Map<string, { status: "processing" | "processed"; at: Date }>();
  readonly dispatchOutbox = new Map<string, Map<Ulid, Date>>();

  async resolveAccount(providerId: string): Promise<AccountId | null> {
    for (const [accountId, rows] of this.rows) {
      if (rows.some((row) => row.providerMessageId === providerId)) {
        return accountId as AccountId;
      }
    }
    return null;
  }

  async insert(
    ctx: Caller,
    delivery: Delivery,
    options: import("@core/domain/ports").DeliveryInsertOptions = {},
  ): Promise<import("@core/domain/ports").DeliveryInsertResult> {
    const rows = scoped(this.rows, ctx);
    if (
      delivery.idempotencyKey !== null &&
      rows.some(
        (row) =>
          row.idempotencyKey === delivery.idempotencyKey &&
          row.identityId === delivery.identityId,
      )
    ) {
      return "duplicate";
    }
    if (
      options.quota !== undefined &&
      rows.filter(
        (row) =>
          row.identityId === options.quota!.identityId &&
          row.createdAt.getTime() >= options.quota!.since.getTime() &&
          row.status !== "rejected",
      ).length >= options.quota.maximum
    ) {
      return "quota_exceeded";
    }
    if (options.exchange !== undefined) {
      const prior = rows.filter(
        (row) =>
          row.createdAt.getTime() >= options.exchange!.since.getTime() &&
          row.status !== "rejected" &&
          row.inboxId === delivery.inboxId,
      );
      if (
        options.exchange.recipients.some(
          (recipient) =>
            prior.filter((row) => row.recipients.includes(recipient)).length >=
            options.exchange!.maximum,
        )
      ) {
        return "exchange_limit_exceeded";
      }
    }
    rows.push(delivery);
    if (options.stageDispatch === true) {
      await this.stageDispatch(ctx, delivery.id, delivery.createdAt);
    }
    return "inserted";
  }

  async update(ctx: Caller, delivery: Delivery): Promise<void> {
    const rows = scoped(this.rows, ctx);
    const index = rows.findIndex((row) => row.id === delivery.id);
    if (index >= 0) rows[index] = delivery;
  }

  async attachMessageId(
    ctx: Caller,
    deliveryId: Ulid,
    messageId: Ulid,
    at: Date,
  ): Promise<void> {
    const rows = scoped(this.rows, ctx);
    const index = rows.findIndex((row) => row.id === deliveryId);
    if (index >= 0) rows[index] = { ...rows[index]!, messageId, updatedAt: at };
  }

  async updateIfStatus(
    ctx: Caller,
    delivery: Delivery,
    expected: Delivery["status"],
  ): Promise<boolean> {
    const rows = scoped(this.rows, ctx);
    const index = rows.findIndex((row) => row.id === delivery.id && row.status === expected);
    if (index < 0) return false;
    rows[index] = delivery;
    return true;
  }

  async approveAndStage(ctx: Caller, delivery: Delivery): Promise<boolean> {
    const updated = await this.updateIfStatus(ctx, delivery, "pending_approval");
    if (updated) await this.stageDispatch(ctx, delivery.id, delivery.updatedAt);
    return updated;
  }

  async findById(ctx: Caller, id: Ulid): Promise<Delivery | null> {
    return scoped(this.rows, ctx).find((row) => row.id === id) ?? null;
  }

  async findByIdempotencyKey(
    ctx: Caller,
    key: string,
    identityId?: Ulid | null,
  ): Promise<Delivery | null> {
    return (
      scoped(this.rows, ctx).find(
        (row) =>
          row.idempotencyKey === key &&
          (identityId === undefined || row.identityId === identityId),
      ) ?? null
    );
  }

  async findByProviderMessageId(ctx: Caller, providerId: string): Promise<Delivery | null> {
    return scoped(this.rows, ctx).find((row) => row.providerMessageId === providerId) ?? null;
  }

  async list(ctx: Caller, query: ListDeliveriesQuery): Promise<Page<Delivery>> {
    let rows = scoped(this.rows, ctx);
    if (query.status !== undefined) rows = rows.filter((row) => row.status === query.status);
    if (query.identityId !== undefined) {
      rows = rows.filter((row) => row.identityId === query.identityId);
    }
    return paginate(rows, query);
  }

  async countSince(ctx: Caller, identityId: Ulid | null, since: Date): Promise<number> {
    return scoped(this.rows, ctx).filter(
      (row) =>
        row.identityId === identityId &&
        row.createdAt.getTime() >= since.getTime() &&
        row.status !== "rejected",
    ).length;
  }

  async stageDispatch(ctx: Caller, deliveryId: Ulid, now: Date): Promise<boolean> {
    let rows = this.dispatchOutbox.get(ctx.accountId);
    if (rows === undefined) {
      rows = new Map();
      this.dispatchOutbox.set(ctx.accountId, rows);
    }
    if (rows.has(deliveryId)) return false;
    rows.set(deliveryId, now);
    return true;
  }

  async listStagedDispatches(
    ctx: Caller,
    limit: number,
  ): Promise<Array<{ deliveryId: Ulid; createdAt: Date }>> {
    return [...(this.dispatchOutbox.get(ctx.accountId) ?? new Map()).entries()]
      .sort((a, b) => a[1].getTime() - b[1].getTime())
      .slice(0, limit)
      .map(([deliveryId, createdAt]) => ({ deliveryId, createdAt }));
  }

  async unstageDispatch(ctx: Caller, deliveryId: Ulid): Promise<void> {
    this.dispatchOutbox.get(ctx.accountId)?.delete(deliveryId);
  }

  async appendDeliveryEvent(ctx: Caller, event: DeliveryEvent): Promise<boolean> {
    if (
      event.eventId !== null &&
      [...this.events.values()].some((rows) =>
        rows.some((row) => row.eventId === event.eventId),
      )
    ) {
      return false;
    }
    scoped(this.events, ctx).push(event);
    return true;
  }

  async claimDeliveryEvent(
    _ctx: Caller,
    eventId: string,
    now: Date,
    staleBefore: Date,
  ): Promise<"claimed" | "processed" | "busy"> {
    const current = this.eventClaims.get(eventId);
    if (current?.status === "processed") return "processed";
    if (current?.status === "processing" && current.at.getTime() >= staleBefore.getTime()) {
      return "busy";
    }
    this.eventClaims.set(eventId, { status: "processing", at: now });
    return "claimed";
  }

  async completeDeliveryEvent(_ctx: Caller, eventId: string, _at: Date): Promise<void> {
    this.eventClaims.set(eventId, { status: "processed", at: _at });
  }

  async releaseDeliveryEvent(_ctx: Caller, eventId: string): Promise<void> {
    if (this.eventClaims.get(eventId)?.status === "processing")
      this.eventClaims.delete(eventId);
  }

  async listDeliveryEvents(ctx: Caller, deliveryId: Ulid): Promise<DeliveryEvent[]> {
    return scoped(this.events, ctx)
      .filter((row) => row.deliveryId === deliveryId)
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }
}

export class InMemoryIdentities implements IdentityRepository {
  readonly rows = new Map<string, AgentIdentity[]>();

  async findById(ctx: Caller, id: Ulid): Promise<AgentIdentity | null> {
    return scoped(this.rows, ctx).find((row) => row.id === id) ?? null;
  }

  async findByName(ctx: Caller, name: string): Promise<AgentIdentity | null> {
    return scoped(this.rows, ctx).find((row) => row.name === name) ?? null;
  }

  async insert(ctx: Caller, identity: AgentIdentity): Promise<void> {
    scoped(this.rows, ctx).push(identity);
  }

  async list(ctx: Caller): Promise<AgentIdentity[]> {
    return [...scoped(this.rows, ctx)];
  }
}

export class InMemoryApiKeys implements ApiKeyRepository {
  readonly rows: ApiKey[] = [];

  async findByPrefix(prefix: string): Promise<ApiKey | null> {
    return this.rows.find((row) => row.prefix === prefix) ?? null;
  }

  async insert(_ctx: Caller, key: ApiKey): Promise<void> {
    this.rows.push(key);
  }

  async update(_ctx: Caller, key: ApiKey): Promise<void> {
    const index = this.rows.findIndex((row) => row.id === key.id);
    if (index >= 0) this.rows[index] = key;
  }

  async touchLastUsed(ctx: Caller, keyId: Ulid, at: Date): Promise<void> {
    const index = this.rows.findIndex(
      (row) => row.accountId === ctx.accountId && row.id === keyId,
    );
    if (index < 0) return;
    const current = this.rows[index]!;
    const cutoff = at.getTime() - 5 * 60 * 1000;
    if (current.lastUsedAt === null || current.lastUsedAt.getTime() <= cutoff) {
      this.rows[index] = { ...current, lastUsedAt: at };
    }
  }

  async list(ctx: Caller): Promise<ApiKey[]> {
    return this.rows.filter((row) => row.accountId === ctx.accountId);
  }
}

export class InMemoryDomains implements DomainRepository {
  readonly owners = new Map<string, AccountId>();

  constructor(public routings: DomainRouting[] = []) {}

  async findRouting(_ctx: Caller, domain: string): Promise<DomainRouting | null> {
    return this.routings.find((row) => row.domain === domain.toLowerCase()) ?? null;
  }

  async list(_ctx: Caller): Promise<DomainRouting[]> {
    return [...this.routings];
  }

  async resolveAccount(domain: string): Promise<AccountId | null> {
    return this.owners.get(domain.toLowerCase()) ?? null;
  }

  async insert(ctx: Caller, routing: DomainRouting): Promise<void> {
    this.routings.push(routing);
    this.owners.set(routing.domain.toLowerCase(), ctx.accountId);
  }
}

/** Records what a sandbox send looped back, so a test can assert it never left. */
export class RecordingLoopback implements LoopbackSink {
  readonly delivered: { ctx: Caller; message: LoopbackMessage }[] = [];

  async deliver(ctx: Caller, message: LoopbackMessage): Promise<void> {
    this.delivered.push({ ctx, message });
  }
}

export class InMemoryAccounts implements AccountRepository {
  readonly rows = new Map<string, Account>();

  async findById(id: AccountId): Promise<Account | null> {
    return this.rows.get(id) ?? null;
  }

  async listByProject(projectId: ProjectId): Promise<Account[]> {
    return [...this.rows.values()].filter((row) => row.projectId === projectId);
  }

  async insert(account: Account): Promise<void> {
    this.rows.set(account.id, account);
  }
}

export class InMemoryBlobs implements BlobStore {
  readonly objects = new Map<string, { body: Uint8Array; meta: BlobMeta | undefined }>();

  async put(ctx: Caller, key: string, body: Uint8Array, meta?: BlobMeta): Promise<void> {
    assertOwned(ctx, key);
    this.objects.set(key, { body, meta });
  }

  async get(ctx: Caller, key: string): Promise<Uint8Array | null> {
    assertOwned(ctx, key);
    return this.objects.get(key)?.body ?? null;
  }

  async delete(ctx: Caller, keys: readonly string[]): Promise<void> {
    // Filters rather than throwing: a retention sweep hands over whatever keys
    // it collected and should remove the ones it may.
    for (const key of keys) if (isOwned(ctx, key)) this.objects.delete(key);
  }
}

/** `raw|body|att|out/{account}/…` — see `BlobKeys`. */
function isOwned(ctx: Caller, key: string): boolean {
  return key.split("/")[1] === ctx.accountId;
}

/**
 * Blob keys are assembled from ids that arrive in requests, so a key naming
 * another account is the shape a path traversal would take. Enforced here as
 * well as in the R2 adapter because it is a contract of the port, not a detail
 * of R2 — a fake that skipped it would let this exact bug pass the fast suite.
 */
function assertOwned(ctx: Caller, key: string): void {
  if (!isOwned(ctx, key)) {
    throw new Error(`Blob key ${key} does not belong to account ${ctx.accountId}.`);
  }
}

export class InMemorySuppressions implements SuppressionList {
  readonly entries = new Map<string, SuppressionEntry[]>();

  async filterSuppressed(
    ctx: Caller,
    addresses: readonly EmailAddress[],
  ): Promise<EmailAddress[]> {
    const listed = new Set(scoped(this.entries, ctx).map((entry) => entry.address));
    return addresses.filter((address) => listed.has(address));
  }

  async add(ctx: Caller, entry: SuppressionEntry): Promise<void> {
    const rows = scoped(this.entries, ctx);
    if (!rows.some((row) => row.address === entry.address)) rows.push(entry);
  }

  async remove(ctx: Caller, address: EmailAddress): Promise<void> {
    this.entries.set(
      ctx.accountId,
      scoped(this.entries, ctx).filter((row) => row.address !== address),
    );
  }

  async list(ctx: Caller): Promise<SuppressionEntry[]> {
    return [...scoped(this.entries, ctx)];
  }
}

/**
 * Records what would have been sent. This is the adapter that lets the entire
 * send path — gates, state machine, sent copy, events — run in a unit test.
 */
export class MemoryTransport implements MailTransport {
  readonly sent: DispatchRequest[] = [];
  nextResult: DispatchResult | null = null;
  private counter = 0;

  async dispatch(_ctx: Caller, message: DispatchRequest): Promise<DispatchResult> {
    this.sent.push(message);
    if (this.nextResult !== null) {
      const result = this.nextResult;
      this.nextResult = null;
      return result;
    }
    this.counter += 1;
    return {
      ok: true,
      providerMessageId: `prov-${this.counter}`,
      accepted: [...message.to],
      queued: [],
      rejected: [],
    };
  }
}

/**
 * The dispatch queue as a list of ids.
 *
 * `drain()` rather than an automatic dispatch, because the split between "we
 * accepted this send" and "we handed it to the network" is exactly what the
 * send tests are about. A fake that dispatched on enqueue would erase the
 * boundary the design exists to draw, and `pending_approval` would silently
 * behave like `queued`.
 */
export class MemoryDispatchQueue implements DispatchQueue {
  readonly enqueued: Ulid[] = [];
  failure: Error | null = null;

  async enqueue(_ctx: Caller, deliveryId: Ulid): Promise<void> {
    if (this.failure !== null) throw this.failure;
    this.enqueued.push(deliveryId);
  }

  drain(): Ulid[] {
    return this.enqueued.splice(0, this.enqueued.length);
  }
}

/**
 * DNS as a map, for testing `doctor`.
 *
 * The point of `DomainHealthPolicy` being pure is that "two SPF records is
 * worse than none" can be asserted against two strings rather than against
 * whatever the internet is serving today. This is the other half of that: a
 * name with no entry answers empty, which is what a real resolver reports for
 * NXDOMAIN.
 */
export class StaticDns implements DnsResolver {
  constructor(
    readonly records: { txt?: Record<string, string[]>; mx?: Record<string, string[]> } = {},
  ) {}

  async txt(name: string): Promise<string[]> {
    return this.records.txt?.[name] ?? [];
  }

  async mx(name: string): Promise<string[]> {
    return this.records.mx?.[name] ?? [];
  }
}

export class InMemoryWebhooks implements WebhookRepository {
  readonly rows = new Map<string, WebhookSubscription[]>();

  async insert(ctx: Caller, subscription: WebhookSubscription): Promise<void> {
    scoped(this.rows, ctx).push(subscription);
  }

  async update(ctx: Caller, subscription: WebhookSubscription): Promise<void> {
    const rows = scoped(this.rows, ctx);
    const index = rows.findIndex((row) => row.id === subscription.id);
    if (index >= 0) rows[index] = subscription;
  }

  async findById(ctx: Caller, id: Ulid): Promise<WebhookSubscription | null> {
    return scoped(this.rows, ctx).find((row) => row.id === id) ?? null;
  }

  async list(ctx: Caller): Promise<WebhookSubscription[]> {
    return [...scoped(this.rows, ctx)];
  }

  async deleteById(ctx: Caller, id: Ulid): Promise<void> {
    const rows = scoped(this.rows, ctx);
    const index = rows.findIndex((row) => row.id === id);
    if (index >= 0) rows.splice(index, 1);
  }
}

/**
 * Records deliveries instead of making them, and can be told to fail.
 *
 * `failFor` exists because the interesting assertion about fan-out is not that
 * it delivers — it is that one subscriber being down does not stop the others
 * being told, which needs a fake that can be down.
 */
export class RecordingWebhookSender implements WebhookSender {
  readonly delivered: WebhookRequest[] = [];
  readonly failFor = new Set<string>();

  async deliver(request: WebhookRequest): Promise<void> {
    if (this.failFor.has(request.url)) {
      throw new Error(`refusing ${request.url}`);
    }
    this.delivered.push(request);
  }
}

export class RecordingEventBus implements EventBus {
  readonly published: DomainEvent[] = [];
  failure: Error | null = null;

  async publish(events: readonly DomainEvent[]): Promise<void> {
    if (this.failure !== null) throw this.failure;
    this.published.push(...events);
  }
}

/**
 * Matches against messages already notified and returns immediately.
 *
 * It never blocks on purpose: a suite that actually slept for timeouts would be
 * unusable, and the behaviour under test is the MATCHING, not the waiting. The
 * Durable Object implementation is where real blocking belongs.
 */
export class MemoryWaiter implements Waiter {
  readonly notified: Message[] = [];

  async wait(
    _ctx: Caller,
    criteria: WaitCriteria,
    _timeoutMs: number,
  ): Promise<Message | null> {
    // Newest match, not oldest. The Durable Object waiter looks back through
    // stored messages newest-first, and a fake that answered "the oldest
    // message that ever matched" would disagree with it the first time two
    // messages matched the same criteria.
    return this.notified.findLast((message) => WaitCriteria.matches(message, criteria)) ?? null;
  }

  async notify(_ctx: Caller, message: Message): Promise<void> {
    this.notified.push(message);
  }
}

/**
 * Whole-word matching, approximating SQLite's FTS5 `unicode61` tokenizer, which
 * is what the D1 store searches with.
 *
 * A substring `includes()` would have been simpler and would have made this fake
 * disagree with production on the first search anyone ran — `q=ell` finding
 * "hello" here and nothing there. Splitting on non-alphanumerics matches how
 * FTS5 splits, so the two agree on ordinary queries.
 *
 * They still part company at the edges: unicode61 folds diacritics by default,
 * so `cafe` finds `café` in D1 and not here. That is documented rather than
 * emulated, and the conformance suite asserts only what both truly guarantee.
 */
function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

/**
 * A single-part RFC 5322 parser: unfolds headers, splits on the first blank
 * line. Enough to exercise the ingest path end to end; `packages/mime` will do
 * the real job (multipart, encodings, attachments) with postal-mime.
 */
export class SimpleMimeParser implements MimeParser {
  async parse(raw: Uint8Array): Promise<ParsedInbound> {
    const text = new TextDecoder().decode(raw);
    const separator = /\r?\n\r?\n/.exec(text);
    const headerBlock = separator === null ? text : text.slice(0, separator.index);
    const body = separator === null ? "" : text.slice(separator.index + separator[0].length);

    const headers: Record<string, string> = {};
    // Unfold: a line starting with whitespace continues the previous header.
    const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, " ");
    for (const line of unfolded.split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }

    const references = headers["references"];
    const dateHeader = headers["date"];
    const attachments: ParsedAttachment[] = [];

    return {
      rfcMessageId: RfcMessageId.tryParse(headers["message-id"] ?? ""),
      fromHeader: headers["from"] ?? "",
      from: EmailAddress.fromHeader(headers["from"] ?? ""),
      toHeader: headers["to"] ?? "",
      to: EmailAddress.listFromHeader(headers["to"] ?? ""),
      cc: EmailAddress.listFromHeader(headers["cc"] ?? ""),
      replyTo: EmailAddress.fromHeader(headers["reply-to"] ?? ""),
      subject: headers["subject"] ?? "",
      bodyText: body === "" ? null : body,
      bodyHtml: null,
      inReplyTo: RfcMessageId.tryParse(headers["in-reply-to"] ?? ""),
      references: references === undefined ? [] : RfcMessageId.parseReferences(references),
      auth: SenderAuth.fromHeader(headers["authentication-results"] ?? null),
      sentAt: dateHeader === undefined ? null : safeDate(dateHeader),
      autoSubmitted: headers["auto-submitted"] ?? null,
      headers,
      attachments,
    };
  }
}

function safeDate(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export class SimpleMimeBuilder implements MimeBuilder {
  /**
   * Every spec it was handed.
   *
   * This builder deliberately renders a flat message — a core test has no
   * business asserting on MIME structure, which is `packages/mime`'s job and is
   * tested there against a real parser. What a core test DOES need to check is
   * that the service passed the right things down, and that is what this
   * records.
   */
  readonly specs: BuildMimeSpec[] = [];
  failure: Error | null = null;

  async build(spec: BuildMimeSpec): Promise<Uint8Array> {
    if (this.failure !== null) throw this.failure;
    this.specs.push(spec);
    const lines = [
      `From: ${spec.fromName === null ? spec.from : `"${spec.fromName}" <${spec.from}>`}`,
      `To: ${spec.to.join(", ")}`,
      ...(spec.cc.length > 0 ? [`Cc: ${spec.cc.join(", ")}`] : []),
      `Subject: ${spec.subject}`,
      `Date: ${spec.date.toUTCString()}`,
      `Message-ID: ${RfcMessageId.toHeader(spec.messageId)}`,
      ...(spec.inReplyTo === null
        ? []
        : [`In-Reply-To: ${RfcMessageId.toHeader(spec.inReplyTo)}`]),
      ...(spec.references.length > 0
        ? [`References: ${RfcMessageId.referencesToHeader(spec.references)}`]
        : []),
      ...Object.entries(spec.headers).map(([key, value]) => `${key}: ${value}`),
      `Content-Type: text/${spec.html === null ? "plain" : "html"}; charset=utf-8`,
      "",
      spec.html ?? spec.text ?? "",
    ];
    return new TextEncoder().encode(lines.join("\r\n"));
  }
}
