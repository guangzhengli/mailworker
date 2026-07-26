import type {
  AgentIdentity,
  ApiKey,
  Caller,
  Delivery,
  DeliveryStatus,
  Direction,
  DomainRouting,
  EmailAddress,
  Inbox,
  Message,
  MessageSummary,
  Page,
  PageRequest,
  RfcMessageId,
  ThreadId,
  Ulid,
} from "@core/domain";

export interface InboxRepository {
  findById(ctx: Caller, id: Ulid): Promise<Inbox | null>;
  /** Looked up by the tag-stripped `matchKey`. */
  findByAddress(ctx: Caller, address: EmailAddress): Promise<Inbox | null>;
  insert(ctx: Caller, inbox: Inbox): Promise<void>;
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
  list(ctx: Caller, query: ListDeliveriesQuery): Promise<Page<Delivery>>;
  countSince(ctx: Caller, identityId: Ulid | null, since: Date): Promise<number>;
  appendDeliveryEvent(ctx: Caller, event: DeliveryEvent): Promise<void>;
  listDeliveryEvents(ctx: Caller, deliveryId: Ulid): Promise<DeliveryEvent[]>;
}

export interface ListDeliveriesQuery extends PageRequest {
  readonly status?: DeliveryStatus;
  readonly identityId?: Ulid;
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

export interface DomainRepository {
  /** Routing config for a hostname, or null if this deployment does not own it. */
  findRouting(ctx: Caller, domain: string): Promise<DomainRouting | null>;
  list(ctx: Caller): Promise<DomainRouting[]>;
}
