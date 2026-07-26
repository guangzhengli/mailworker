import type {
  AgentIdentity,
  ApiKey,
  AuthContext,
  Direction,
  DomainRouting,
  EmailAddress,
  Inbox,
  Message,
  MessageSummary,
  OutboundMessage,
  OutboundStatus,
  Page,
  PageRequest,
  RfcMessageId,
  ThreadId,
  Ulid,
} from "@core/domain/index.ts";

export interface InboxRepositoryPort {
  findById(ctx: AuthContext, id: Ulid): Promise<Inbox | null>;
  /** Looked up by the tag-stripped `matchKey`. */
  findByAddress(ctx: AuthContext, address: EmailAddress): Promise<Inbox | null>;
  insert(ctx: AuthContext, inbox: Inbox): Promise<void>;
  update(ctx: AuthContext, inbox: Inbox): Promise<void>;
  list(ctx: AuthContext, query: ListInboxesQuery): Promise<Page<Inbox>>;
  /** Expired inboxes, oldest expiry first — drives the retention sweep. */
  findExpired(ctx: AuthContext, expiredBefore: Date, limit: number): Promise<Inbox[]>;
  deleteById(ctx: AuthContext, id: Ulid): Promise<void>;
}

export interface ListInboxesQuery extends PageRequest {
  readonly kind?: "ephemeral" | "persistent";
  readonly domain?: string;
  /** Exclude expired and soft-deleted inboxes. */
  readonly activeOnly?: boolean;
}

export interface MessageRepositoryPort {
  /**
   * Insert, relying on the `(account_id, rfc_message_id)` unique constraint for
   * deduplication. Returns `stored: false` on a duplicate instead of throwing —
   * a retried inbound delivery is normal traffic, not an error.
   */
  insert(ctx: AuthContext, message: Message): Promise<{ stored: boolean }>;
  findById(ctx: AuthContext, id: Ulid): Promise<Message | null>;
  findByRfcMessageId(ctx: AuthContext, rfcId: RfcMessageId): Promise<Message | null>;
  /**
   * Thread ids for whichever of `rfcIds` we already have. One query for the whole
   * candidate set, so `ThreadingPolicy` can stay pure.
   */
  findThreadIds(
    ctx: AuthContext,
    rfcIds: readonly RfcMessageId[],
  ): Promise<ReadonlyMap<string, ThreadId>>;
  list(ctx: AuthContext, query: ListMessagesQuery): Promise<Page<MessageSummary>>;
  listThread(ctx: AuthContext, threadId: ThreadId): Promise<Message[]>;
  setSeen(ctx: AuthContext, id: Ulid, seen: boolean): Promise<void>;
  /**
   * How many messages we sent from `from` to `to` since `since`.
   * Feeds `LoopBreakerPolicy.exchangesInWindow`.
   */
  countSentBetween(
    ctx: AuthContext,
    from: EmailAddress,
    to: EmailAddress,
    since: Date,
  ): Promise<number>;
  deleteByInbox(ctx: AuthContext, inboxId: Ulid): Promise<{ storageKeys: string[] }>;
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

export interface OutboundRepositoryPort {
  insert(ctx: AuthContext, outbound: OutboundMessage): Promise<void>;
  update(ctx: AuthContext, outbound: OutboundMessage): Promise<void>;
  findById(ctx: AuthContext, id: Ulid): Promise<OutboundMessage | null>;
  findByIdempotencyKey(ctx: AuthContext, key: string): Promise<OutboundMessage | null>;
  /** Correlates an inbound provider delivery event back to its send. */
  findByProviderMessageId(
    ctx: AuthContext,
    providerId: string,
  ): Promise<OutboundMessage | null>;
  list(ctx: AuthContext, query: ListOutboundQuery): Promise<Page<OutboundMessage>>;
  countSince(ctx: AuthContext, identityId: Ulid | null, since: Date): Promise<number>;
  appendDeliveryEvent(ctx: AuthContext, event: StoredDeliveryEvent): Promise<void>;
  listDeliveryEvents(ctx: AuthContext, outboundId: Ulid): Promise<StoredDeliveryEvent[]>;
}

export interface ListOutboundQuery extends PageRequest {
  readonly status?: OutboundStatus;
  readonly identityId?: Ulid;
}

/** Append-only delivery event row. The timeline `mailworker status` prints. */
export interface StoredDeliveryEvent {
  readonly id: Ulid;
  readonly outboundId: Ulid | null;
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

export interface IdentityRepositoryPort {
  findById(ctx: AuthContext, id: Ulid): Promise<AgentIdentity | null>;
  findByName(ctx: AuthContext, name: string): Promise<AgentIdentity | null>;
  insert(ctx: AuthContext, identity: AgentIdentity): Promise<void>;
  list(ctx: AuthContext): Promise<AgentIdentity[]>;
}

export interface ApiKeyRepositoryPort {
  /**
   * By public prefix; the caller then verifies the secret against the hash.
   *
   * The one deliberate exception to the AuthContext-first rule: this is how a
   * context gets built in the first place, so there is nothing to pass yet. It
   * looks across accounts by design, which is why the prefix must be globally
   * unique and why nothing else in this file is allowed to do the same.
   */
  findByPrefix(prefix: string): Promise<ApiKey | null>;
  insert(ctx: AuthContext, key: ApiKey): Promise<void>;
  update(ctx: AuthContext, key: ApiKey): Promise<void>;
  list(ctx: AuthContext): Promise<ApiKey[]>;
}

export interface DomainRepositoryPort {
  /** Routing config for a hostname, or null if this deployment does not own it. */
  findRouting(ctx: AuthContext, domain: string): Promise<DomainRouting | null>;
  list(ctx: AuthContext): Promise<DomainRouting[]>;
}
