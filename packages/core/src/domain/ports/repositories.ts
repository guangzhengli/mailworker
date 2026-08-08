import type {
  Account,
  AccountId,
  AgentIdentity,
  ApiKey,
  Caller,
  Delivery,
  DeliverySource,
  DeliveryStatus,
  Direction,
  DomainRouting,
  EmailAddress,
  Inbox,
  Message,
  MessageSummary,
  Page,
  PageRequest,
  ProjectId,
  RfcMessageId,
  ThreadId,
  Ulid,
  WebhookSubscription,
} from "@core/domain";

/**
 * Environments, which are accounts. Every lookup here happens before or beside a
 * `Caller` rather than under one, because resolving which environment a request
 * targets is what produces the `Caller` in the first place.
 */
export interface AccountRepository {
  findById(id: AccountId): Promise<Account | null>;
  listByProject(projectId: ProjectId): Promise<Account[]>;
  insert(account: Account): Promise<void>;
}

export interface InboxRepository {
  findById(ctx: Caller, id: Ulid): Promise<Inbox | null>;
  /** Looked up by the tag-stripped `matchKey`. */
  findByAddress(ctx: Caller, address: EmailAddress): Promise<Inbox | null>;
  /**
   * Insert, relying on the `(account_id, address)` unique constraint to settle
   * who won. Returns `stored: false` when the address was already taken instead
   * of throwing, because both callers race: two concurrent `POST /v1/inboxes`
   * for the same address, and two inbound deliveries autocreating the same
   * one. A read-then-write cannot decide this — both sides see it free.
   */
  insert(ctx: Caller, inbox: Inbox): Promise<{ stored: boolean }>;
  update(ctx: Caller, inbox: Inbox): Promise<void>;
  list(ctx: Caller, query: ListInboxesQuery): Promise<Page<Inbox>>;
  /** Expired inboxes, oldest expiry first — drives the retention sweep. */
  findExpired(ctx: Caller, expiredBefore: Date, limit: number): Promise<Inbox[]>;
  deleteById(ctx: Caller, id: Ulid): Promise<void>;
}

export interface ListInboxesQuery extends PageRequest {
  readonly kind?: "ephemeral" | "persistent";
  readonly domain?: string;
  /**
   * Exclude inboxes already expired at this instant. Soft-deleted ones are
   * always excluded.
   *
   * A `Date` rather than an `activeOnly: boolean` because a repository must not
   * read the clock: with the time passed in, "list what was live an hour ago" is
   * a query rather than a race, and testing "list active inboxes" does not
   * involve waiting for one to expire.
   */
  readonly activeAt?: Date;
}

export interface MessageRepository {
  /**
   * Insert, relying on the `(account_id, rfc_message_id)` unique constraint for
   * deduplication. Returns `stored: false` on a duplicate instead of throwing —
   * a retried inbound delivery is normal traffic, not an error.
   */
  insert(ctx: Caller, message: Message): Promise<{ stored: boolean }>;
  findById(ctx: Caller, id: Ulid): Promise<Message | null>;
  findByRfcMessageId(ctx: Caller, rfcId: RfcMessageId): Promise<Message | null>;
  /**
   * Thread ids for whichever of `rfcIds` we already have. One query for the whole
   * candidate set, so `ThreadingPolicy` can stay pure.
   */
  findThreadIds(
    ctx: Caller,
    rfcIds: readonly RfcMessageId[],
  ): Promise<ReadonlyMap<string, ThreadId>>;
  list(ctx: Caller, query: ListMessagesQuery): Promise<Page<MessageSummary>>;
  listThread(ctx: Caller, threadId: ThreadId): Promise<Message[]>;
  setSeen(ctx: Caller, id: Ulid, seen: boolean): Promise<void>;
  /**
   * How many messages we sent from `from` to `to` since `since`.
   * Feeds `LoopBreakerPolicy.exchangesInWindow`.
   */
  countSentBetween(
    ctx: Caller,
    from: EmailAddress,
    to: EmailAddress,
    since: Date,
  ): Promise<number>;
  deleteByInbox(ctx: Caller, inboxId: Ulid): Promise<{ storageKeys: string[] }>;
}

export interface ListMessagesQuery extends PageRequest {
  readonly inboxId?: Ulid;
  readonly threadId?: ThreadId;
  readonly direction?: Direction;
  readonly from?: EmailAddress;
  readonly seen?: boolean;
  /** Full-text over subject + body. */
  readonly q?: string;
  /** Only messages with an id greater than this — used by `wait`. */
  readonly after?: Ulid;
}

export interface DeliveryRepository {
  insert(ctx: Caller, delivery: Delivery): Promise<void>;
  update(ctx: Caller, delivery: Delivery): Promise<void>;
  findById(ctx: Caller, id: Ulid): Promise<Delivery | null>;
  findByIdempotencyKey(ctx: Caller, key: string): Promise<Delivery | null>;
  /** Correlates an inbound provider delivery event back to its send. */
  findByProviderMessageId(ctx: Caller, providerId: string): Promise<Delivery | null>;
  /**
   * Which environment a provider delivery event belongs to.
   *
   * Unscoped, and one of only three queries entitled to be: a provider event
   * arrives from Cloudflare carrying its own message id and nothing that names
   * an environment, so this is what produces the `Caller` the rest of the
   * handling runs under. Safe because a provider message id is globally unique.
   */
  resolveAccount(providerId: string): Promise<AccountId | null>;
  list(ctx: Caller, query: ListDeliveriesQuery): Promise<Page<Delivery>>;
  countSince(ctx: Caller, identityId: Ulid | null, since: Date): Promise<number>;
  appendDeliveryEvent(ctx: Caller, event: DeliveryEvent): Promise<void>;
  listDeliveryEvents(ctx: Caller, deliveryId: Ulid): Promise<DeliveryEvent[]>;
}

export interface ListDeliveriesQuery extends PageRequest {
  readonly status?: DeliveryStatus;
  readonly statusIn?: readonly DeliveryStatus[];
  readonly identityId?: Ulid;
  readonly source?: DeliverySource;
  /**
   * Full-text over the archived sent copy — subject, body, sender — or a
   * substring of the envelope recipients.
   *
   * The two halves cover different rows on purpose. A sent copy is only written
   * when a delivery is dispatched, so a send still queued or awaiting approval
   * has no indexed text at all; its recipients are on the delivery row from the
   * moment it is created, and are the only thing there is to match on.
   */
  readonly q?: string;
}

/** Append-only delivery event row. The timeline `mailworker status` prints. */
export interface DeliveryEvent {
  readonly id: Ulid;
  readonly deliveryId: Ulid | null;
  readonly providerMessageId: string | null;
  readonly recipient: EmailAddress | null;
  readonly type: string;
  readonly terminal: boolean;
  readonly smtpCode: string | null;
  readonly smtpResponse: string | null;
  readonly occurredAt: Date;
  /** Original provider payload, kept verbatim for forensics. */
  readonly raw: string | null;
}

export interface IdentityRepository {
  findById(ctx: Caller, id: Ulid): Promise<AgentIdentity | null>;
  findByName(ctx: Caller, name: string): Promise<AgentIdentity | null>;
  insert(ctx: Caller, identity: AgentIdentity): Promise<void>;
  list(ctx: Caller): Promise<AgentIdentity[]>;
}

export interface ApiKeyRepository {
  /**
   * By public prefix; the caller then verifies the secret against the hash.
   *
   * The one deliberate exception to the Caller-first rule: this is how a
   * context gets built in the first place, so there is nothing to pass yet. It
   * looks across accounts by design, which is why the prefix must be globally
   * unique and why nothing else in this file is allowed to do the same.
   */
  findByPrefix(prefix: string): Promise<ApiKey | null>;
  insert(ctx: Caller, key: ApiKey): Promise<void>;
  update(ctx: Caller, key: ApiKey): Promise<void>;
  list(ctx: Caller): Promise<ApiKey[]>;
}

export interface WebhookRepository {
  insert(ctx: Caller, subscription: WebhookSubscription): Promise<void>;
  update(ctx: Caller, subscription: WebhookSubscription): Promise<void>;
  findById(ctx: Caller, id: Ulid): Promise<WebhookSubscription | null>;
  list(ctx: Caller): Promise<WebhookSubscription[]>;
  deleteById(ctx: Caller, id: Ulid): Promise<void>;
}

export interface DomainRepository {
  /** Routing config for a hostname, or null if this deployment does not own it. */
  findRouting(ctx: Caller, domain: string): Promise<DomainRouting | null>;
  list(ctx: Caller): Promise<DomainRouting[]>;
  /**
   * Which environment receives mail for a hostname.
   *
   * Unscoped for the same reason as `DeliveryRepository.resolveAccount`:
   * inbound mail arrives naming an address and nothing else, so the domain is
   * what decides which environment it lands in. This is why environments want
   * separate hostnames — `dev.mail.example.com` beside `mail.example.com`.
   */
  resolveAccount(domain: string): Promise<AccountId | null>;
  /**
   * Register a hostname for this environment.
   *
   * A hostname belongs to exactly one environment, because `resolveAccount` is
   * how inbound mail picks one and there is nothing to disambiguate with. The
   * caller checks that before inserting.
   */
  insert(ctx: Caller, routing: DomainRouting): Promise<void>;
}
