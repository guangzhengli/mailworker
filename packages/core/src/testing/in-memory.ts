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
  AgentIdentity,
  ApiKey,
  AuthContext,
  DomainEvent,
  DomainRouting,
  EmailAddress,
  Inbox,
  Message,
  MessageSummary,
  OutboundMessage,
  Page,
  RfcMessageId,
  ThreadId,
  Ulid,
} from "../domain/index.ts";
import {
  AuthVerdict,
  CROCKFORD,
  clampLimit,
  EmailAddress as EmailAddressVO,
  Message as MessageVO,
  RfcMessageId as RfcMessageIdVO,
} from "../domain/index.ts";
import type {
  ApiKeyRepositoryPort,
  BlobMeta,
  BlobStorePort,
  BuildMimeSpec,
  ClockPort,
  DispatchRequest,
  DispatchResult,
  DomainRepositoryPort,
  EventBusPort,
  IdentityRepositoryPort,
  IdGeneratorPort,
  InboxRepositoryPort,
  ListInboxesQuery,
  ListMessagesQuery,
  ListOutboundQuery,
  MailTransportPort,
  MessageRepositoryPort,
  MimeBuilderPort,
  MimeParserPort,
  OutboundRepositoryPort,
  ParsedAttachment,
  ParsedInbound,
  StoredDeliveryEvent,
  SuppressionEntry,
  SuppressionListPort,
  TokenHasherPort,
  WaitCriteria,
  WaiterPort,
} from "../ports/index.ts";

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export class FakeClock implements ClockPort {
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

/**
 * Counter-based ids. Still valid, still monotonic — so ULID ordering and keyset
 * pagination behave exactly as in production — but a test can predict them.
 */
export class DeterministicIds implements IdGeneratorPort {
  private counter = 0;
  private secretCounter = 0;

  constructor(private readonly epochMs = Date.UTC(2026, 0, 1)) {}

  ulid(): Ulid {
    this.counter += 1;
    return `${encodeCrockford(this.epochMs, 10)}${encodeCrockford(this.counter, 16)}` as Ulid;
  }

  rfcMessageId(domain: string): RfcMessageId {
    return RfcMessageIdVO.parse(`${this.ulid()}@${domain}`);
  }

  secret(byteLength = 16): string {
    this.secretCounter += 1;
    return `s${this.secretCounter}`.padEnd(byteLength * 2, "0").slice(0, byteLength * 2);
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

/** Not a real digest. Sufficient to prove the plumbing; never ship it. */
export class FakeHasher implements TokenHasherPort {
  async hash(plaintext: string): Promise<string> {
    return `fake:${plaintext}`;
  }

  async verify(plaintext: string, hash: string): Promise<boolean> {
    return hash === `fake:${plaintext}`;
  }
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

/** Every store keys by account first, mirroring the `account_id`-leading indexes. */
function scoped<T>(map: Map<string, T[]>, ctx: AuthContext): T[] {
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

export class InMemoryInboxes implements InboxRepositoryPort {
  readonly rows = new Map<string, Inbox[]>();

  async findById(ctx: AuthContext, id: Ulid): Promise<Inbox | null> {
    return scoped(this.rows, ctx).find((row) => row.id === id) ?? null;
  }

  async findByAddress(ctx: AuthContext, address: EmailAddress): Promise<Inbox | null> {
    return (
      scoped(this.rows, ctx).find((row) => row.address === address && row.deletedAt === null) ??
      null
    );
  }

  async insert(ctx: AuthContext, inbox: Inbox): Promise<void> {
    scoped(this.rows, ctx).push(inbox);
  }

  async update(ctx: AuthContext, inbox: Inbox): Promise<void> {
    const rows = scoped(this.rows, ctx);
    const index = rows.findIndex((row) => row.id === inbox.id);
    if (index >= 0) rows[index] = inbox;
  }

  async list(ctx: AuthContext, query: ListInboxesQuery): Promise<Page<Inbox>> {
    let rows = scoped(this.rows, ctx).filter((row) => row.deletedAt === null);
    if (query.kind !== undefined) rows = rows.filter((row) => row.kind === query.kind);
    if (query.domain !== undefined) rows = rows.filter((row) => row.domain === query.domain);
    return paginate(rows, query);
  }

  async findExpired(ctx: AuthContext, expiredBefore: Date, limit: number): Promise<Inbox[]> {
    return scoped(this.rows, ctx)
      .filter(
        (row) => row.expiresAt !== null && row.expiresAt.getTime() <= expiredBefore.getTime(),
      )
      .slice(0, limit);
  }

  async deleteById(ctx: AuthContext, id: Ulid): Promise<void> {
    const rows = scoped(this.rows, ctx);
    const index = rows.findIndex((row) => row.id === id);
    if (index >= 0) rows.splice(index, 1);
  }
}

export class InMemoryMessages implements MessageRepositoryPort {
  readonly rows = new Map<string, Message[]>();

  async insert(ctx: AuthContext, message: Message): Promise<{ stored: boolean }> {
    const rows = scoped(this.rows, ctx);
    // Mirrors the UNIQUE(account_id, rfc_message_id) constraint that D1 enforces.
    if (rows.some((row) => row.rfcMessageId === message.rfcMessageId)) {
      return { stored: false };
    }
    rows.push(message);
    return { stored: true };
  }

  async findById(ctx: AuthContext, id: Ulid): Promise<Message | null> {
    return scoped(this.rows, ctx).find((row) => row.id === id) ?? null;
  }

  async findByRfcMessageId(ctx: AuthContext, rfcId: RfcMessageId): Promise<Message | null> {
    return scoped(this.rows, ctx).find((row) => row.rfcMessageId === rfcId) ?? null;
  }

  async findThreadIds(
    ctx: AuthContext,
    rfcIds: readonly RfcMessageId[],
  ): Promise<ReadonlyMap<string, ThreadId>> {
    const wanted = new Set<string>(rfcIds);
    const found = new Map<string, ThreadId>();
    for (const row of scoped(this.rows, ctx)) {
      if (wanted.has(row.rfcMessageId)) found.set(row.rfcMessageId, row.threadId);
    }
    return found;
  }

  async list(ctx: AuthContext, query: ListMessagesQuery): Promise<Page<MessageSummary>> {
    let rows = scoped(this.rows, ctx);
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
      const needle = query.q.toLowerCase();
      rows = rows.filter(
        (row) =>
          row.subject.toLowerCase().includes(needle) ||
          (row.bodyText ?? "").toLowerCase().includes(needle),
      );
    }
    const page = paginate(rows, query);
    return { items: page.items.map((row) => MessageVO.summarize(row)), cursor: page.cursor };
  }

  async listThread(ctx: AuthContext, threadId: ThreadId): Promise<Message[]> {
    return scoped(this.rows, ctx)
      .filter((row) => row.threadId === threadId)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  async setSeen(ctx: AuthContext, id: Ulid, seen: boolean): Promise<void> {
    const rows = scoped(this.rows, ctx);
    const index = rows.findIndex((row) => row.id === id);
    if (index >= 0) rows[index] = MessageVO.markSeen(rows[index]!, seen);
  }

  async countSentBetween(
    ctx: AuthContext,
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

  async deleteByInbox(ctx: AuthContext, inboxId: Ulid): Promise<{ storageKeys: string[] }> {
    const rows = scoped(this.rows, ctx);
    const doomed = rows.filter((row) => row.inboxId === inboxId);
    const keys = doomed.flatMap((row) => [
      ...(row.rawKey === null ? [] : [row.rawKey]),
      ...row.attachments.map((attachment) => attachment.storageKey),
    ]);
    this.rows.set(
      ctx.accountId,
      rows.filter((row) => row.inboxId !== inboxId),
    );
    return { storageKeys: keys };
  }
}

export class InMemoryOutbound implements OutboundRepositoryPort {
  readonly rows = new Map<string, OutboundMessage[]>();
  readonly events = new Map<string, StoredDeliveryEvent[]>();

  async insert(ctx: AuthContext, outbound: OutboundMessage): Promise<void> {
    scoped(this.rows, ctx).push(outbound);
  }

  async update(ctx: AuthContext, outbound: OutboundMessage): Promise<void> {
    const rows = scoped(this.rows, ctx);
    const index = rows.findIndex((row) => row.id === outbound.id);
    if (index >= 0) rows[index] = outbound;
  }

  async findById(ctx: AuthContext, id: Ulid): Promise<OutboundMessage | null> {
    return scoped(this.rows, ctx).find((row) => row.id === id) ?? null;
  }

  async findByIdempotencyKey(ctx: AuthContext, key: string): Promise<OutboundMessage | null> {
    return scoped(this.rows, ctx).find((row) => row.idempotencyKey === key) ?? null;
  }

  async findByProviderMessageId(
    ctx: AuthContext,
    providerId: string,
  ): Promise<OutboundMessage | null> {
    return scoped(this.rows, ctx).find((row) => row.providerMessageId === providerId) ?? null;
  }

  async list(ctx: AuthContext, query: ListOutboundQuery): Promise<Page<OutboundMessage>> {
    let rows = scoped(this.rows, ctx);
    if (query.status !== undefined) rows = rows.filter((row) => row.status === query.status);
    if (query.identityId !== undefined) {
      rows = rows.filter((row) => row.identityId === query.identityId);
    }
    return paginate(rows, query);
  }

  async countSince(ctx: AuthContext, identityId: Ulid | null, since: Date): Promise<number> {
    return scoped(this.rows, ctx).filter(
      (row) =>
        row.identityId === identityId &&
        row.createdAt.getTime() >= since.getTime() &&
        row.status !== "rejected",
    ).length;
  }

  async appendDeliveryEvent(ctx: AuthContext, event: StoredDeliveryEvent): Promise<void> {
    scoped(this.events, ctx).push(event);
  }

  async listDeliveryEvents(ctx: AuthContext, outboundId: Ulid): Promise<StoredDeliveryEvent[]> {
    return scoped(this.events, ctx)
      .filter((row) => row.outboundId === outboundId)
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }
}

export class InMemoryIdentities implements IdentityRepositoryPort {
  readonly rows = new Map<string, AgentIdentity[]>();

  async findById(ctx: AuthContext, id: Ulid): Promise<AgentIdentity | null> {
    return scoped(this.rows, ctx).find((row) => row.id === id) ?? null;
  }

  async findByName(ctx: AuthContext, name: string): Promise<AgentIdentity | null> {
    return scoped(this.rows, ctx).find((row) => row.name === name) ?? null;
  }

  async insert(ctx: AuthContext, identity: AgentIdentity): Promise<void> {
    scoped(this.rows, ctx).push(identity);
  }

  async list(ctx: AuthContext): Promise<AgentIdentity[]> {
    return [...scoped(this.rows, ctx)];
  }
}

export class InMemoryApiKeys implements ApiKeyRepositoryPort {
  readonly rows: ApiKey[] = [];

  async findByPrefix(prefix: string): Promise<ApiKey | null> {
    return this.rows.find((row) => row.prefix === prefix) ?? null;
  }

  async insert(_ctx: AuthContext, key: ApiKey): Promise<void> {
    this.rows.push(key);
  }

  async update(_ctx: AuthContext, key: ApiKey): Promise<void> {
    const index = this.rows.findIndex((row) => row.id === key.id);
    if (index >= 0) this.rows[index] = key;
  }

  async list(ctx: AuthContext): Promise<ApiKey[]> {
    return this.rows.filter((row) => row.accountId === ctx.accountId);
  }
}

export class InMemoryDomains implements DomainRepositoryPort {
  constructor(public routings: DomainRouting[] = []) {}

  async findRouting(_ctx: AuthContext, domain: string): Promise<DomainRouting | null> {
    return this.routings.find((row) => row.domain === domain.toLowerCase()) ?? null;
  }

  async list(_ctx: AuthContext): Promise<DomainRouting[]> {
    return [...this.routings];
  }
}

// ---------------------------------------------------------------------------
// Storage, transport, messaging
// ---------------------------------------------------------------------------

export class InMemoryBlobs implements BlobStorePort {
  readonly objects = new Map<string, { body: Uint8Array; meta: BlobMeta | undefined }>();

  async put(_ctx: AuthContext, key: string, body: Uint8Array, meta?: BlobMeta): Promise<void> {
    this.objects.set(key, { body, meta });
  }

  async get(_ctx: AuthContext, key: string): Promise<Uint8Array | null> {
    return this.objects.get(key)?.body ?? null;
  }

  async delete(_ctx: AuthContext, keys: readonly string[]): Promise<void> {
    for (const key of keys) this.objects.delete(key);
  }
}

export class InMemorySuppressions implements SuppressionListPort {
  readonly entries = new Map<string, SuppressionEntry[]>();

  async filterSuppressed(
    ctx: AuthContext,
    addresses: readonly EmailAddress[],
  ): Promise<EmailAddress[]> {
    const listed = new Set(scoped(this.entries, ctx).map((entry) => entry.address));
    return addresses.filter((address) => listed.has(address));
  }

  async add(ctx: AuthContext, entry: SuppressionEntry): Promise<void> {
    const rows = scoped(this.entries, ctx);
    if (!rows.some((row) => row.address === entry.address)) rows.push(entry);
  }

  async remove(ctx: AuthContext, address: EmailAddress): Promise<void> {
    this.entries.set(
      ctx.accountId,
      scoped(this.entries, ctx).filter((row) => row.address !== address),
    );
  }

  async list(ctx: AuthContext): Promise<SuppressionEntry[]> {
    return [...scoped(this.entries, ctx)];
  }
}

/**
 * Records what would have been sent. This is the adapter that lets the entire
 * send path — gates, state machine, sent copy, events — run in a unit test.
 */
export class MemoryTransport implements MailTransportPort {
  readonly sent: DispatchRequest[] = [];
  /** Set to make the next dispatch fail. */
  nextResult: DispatchResult | null = null;
  private counter = 0;

  async dispatch(_ctx: AuthContext, message: DispatchRequest): Promise<DispatchResult> {
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

export class RecordingEventBus implements EventBusPort {
  readonly published: DomainEvent[] = [];

  async publish(events: readonly DomainEvent[]): Promise<void> {
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
export class MemoryWaiter implements WaiterPort {
  readonly notified: Message[] = [];

  async wait(
    _ctx: AuthContext,
    criteria: WaitCriteria,
    _timeoutMs: number,
  ): Promise<Message | null> {
    return this.notified.find((message) => matches(message, criteria)) ?? null;
  }

  async notify(_ctx: AuthContext, message: Message): Promise<void> {
    this.notified.push(message);
  }
}

function matches(message: Message, criteria: WaitCriteria): boolean {
  if (criteria.inboxId !== undefined && message.inboxId !== criteria.inboxId) return false;
  if (criteria.from !== undefined && message.from !== criteria.from) return false;
  if (criteria.after !== undefined && message.id <= criteria.after) return false;
  if (
    criteria.subject !== undefined &&
    !message.subject.toLowerCase().includes(criteria.subject.toLowerCase())
  ) {
    return false;
  }
  if (criteria.match !== undefined) {
    const pattern = new RegExp(criteria.match, "i");
    if (!pattern.test(message.subject) && !pattern.test(message.bodyText ?? "")) return false;
  }
  return true;
}

/**
 * A single-part RFC 5322 parser: unfolds headers, splits on the first blank
 * line. Enough to exercise the ingest path end to end; `packages/mime` will do
 * the real job (multipart, encodings, attachments) with postal-mime.
 */
export class SimpleMimeParser implements MimeParserPort {
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
      rfcMessageId: RfcMessageIdVO.tryParse(headers["message-id"] ?? ""),
      fromHeader: headers["from"] ?? "",
      toHeader: headers["to"] ?? "",
      to: EmailAddressVO.listFromHeader(headers["to"] ?? ""),
      cc: EmailAddressVO.listFromHeader(headers["cc"] ?? ""),
      replyTo: EmailAddressVO.fromHeader(headers["reply-to"] ?? ""),
      subject: headers["subject"] ?? "",
      bodyText: body === "" ? null : body,
      bodyHtml: null,
      inReplyTo: RfcMessageIdVO.tryParse(headers["in-reply-to"] ?? ""),
      references: references === undefined ? [] : RfcMessageIdVO.parseReferences(references),
      auth: AuthVerdict.fromAuthenticationResults(headers["authentication-results"] ?? null),
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

export class SimpleMimeBuilder implements MimeBuilderPort {
  async build(spec: BuildMimeSpec): Promise<Uint8Array> {
    const lines = [
      `From: ${spec.fromName === null ? spec.from : `"${spec.fromName}" <${spec.from}>`}`,
      `To: ${spec.to.join(", ")}`,
      ...(spec.cc.length > 0 ? [`Cc: ${spec.cc.join(", ")}`] : []),
      `Subject: ${spec.subject}`,
      `Date: ${spec.date.toUTCString()}`,
      `Message-ID: ${RfcMessageIdVO.toHeader(spec.messageId)}`,
      ...(spec.inReplyTo === null
        ? []
        : [`In-Reply-To: ${RfcMessageIdVO.toHeader(spec.inReplyTo)}`]),
      ...(spec.references.length > 0
        ? [`References: ${RfcMessageIdVO.referencesToHeader(spec.references)}`]
        : []),
      ...Object.entries(spec.headers).map(([key, value]) => `${key}: ${value}`),
      `Content-Type: text/${spec.html === null ? "plain" : "html"}; charset=utf-8`,
      "",
      spec.html ?? spec.text ?? "",
    ];
    return new TextEncoder().encode(lines.join("\r\n"));
  }
}
