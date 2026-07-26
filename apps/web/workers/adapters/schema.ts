import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * The D1 schema, and the source of truth for it.
 *
 * `drizzle-kit generate` turns this into the SQL in `migrations/`; nothing
 * hand-edits those files except the FTS5 migration, which drizzle cannot model
 * (a virtual table plus three sync triggers). DESIGN.md §5 documents the shape
 * this produces rather than defining it a second time.
 *
 * Three conventions run through every table:
 *
 * 1. **`account_id` on everything, first in every composite index.** Single
 *    tenant today means one row in `accounts`; the discipline is what makes the
 *    eventual multi-tenant migration a configuration change instead of an audit
 *    of every query (DESIGN.md §6).
 * 2. **ULID primary keys** (ADR-2). Lexicographic order is arrival order, so
 *    `id` is also the pagination cursor and never gets reused.
 * 3. **Timestamps are ISO 8601 UTC text**, not epoch integers. Fixed-width UTC
 *    ISO sorts lexicographically in exactly chronological order, so range
 *    queries work as-is — and a human running `wrangler d1 execute` can read the
 *    result, which matters more than usual for a product people reach for when
 *    debugging mail.
 */

const id = () => text("id").primaryKey();
const accountId = () => text("account_id").notNull();
/** ISO 8601 UTC. Always written with `Date.prototype.toISOString`. */
const timestamp = (name: string) => text(name);
const bool = (name: string) => integer(name, { mode: "boolean" }).notNull().default(false);

/** Tenant root. One row (`default`) until registration exists. */
export const accounts = sqliteTable("accounts", {
  id: id(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").notNull(),
});

/**
 * A domain we receive on, send from, or both.
 *
 * `catchall_mode` is what lets the whole product run on ONE Cloudflare routing
 * rule: address ownership is resolved here, in the Worker, instead of by a rule
 * per address against a ceiling of 200 per domain (DESIGN.md §2.1).
 */
export const domains = sqliteTable(
  "domains",
  {
    id: id(),
    accountId: accountId(),
    name: text("name").notNull(),
    zoneId: text("zone_id"),
    inboundEnabled: bool("inbound_enabled"),
    /** unverified | pending | verified */
    sendingStatus: text("sending_status").notNull().default("unverified"),
    /** Published by Cloudflare on verification. `doctor` looks up its record. */
    dkimSelector: text("dkim_selector"),
    /** reject | store | autocreate */
    catchallMode: text("catchall_mode").notNull().default("reject"),
    catchallInbox: text("catchall_inbox"),
    /** Required by `autocreate`, e.g. `agent-*@mail.example.com`. */
    autocreatePattern: text("autocreate_pattern"),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [uniqueIndex("uq_domains_account_name").on(t.accountId, t.name)],
);

export const inboxes = sqliteTable(
  "inboxes",
  {
    id: id(),
    accountId: accountId(),
    /** Tag-stripped and lowercased — the lookup key, not the address as typed. */
    address: text("address").notNull(),
    localPart: text("local_part").notNull(),
    domain: text("domain").notNull(),
    displayName: text("display_name"),
    /** ephemeral | persistent */
    kind: text("kind").notNull().default("ephemeral"),
    identityId: text("identity_id"),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, string>>(),
    /** Null means never. Always null for `persistent`. */
    expiresAt: timestamp("expires_at"),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_inboxes_account_address").on(t.accountId, t.address),
    // Partial: only rows that can ever expire are worth carrying in the sweep index.
    index("idx_inboxes_expiry").on(t.expiresAt).where(sql`expires_at IS NOT NULL`),
    index("idx_inboxes_account").on(t.accountId, t.createdAt),
  ],
);

/**
 * Inbound and outbound in one table.
 *
 * An agent asking "what happened in this conversation" should not have to union
 * two schemas, and threading has to resolve across both directions anyway.
 */
export const messages = sqliteTable(
  "messages",
  {
    id: id(),
    accountId: accountId(),
    inboxId: text("inbox_id").notNull(),
    rfcMessageId: text("rfc_message_id").notNull(),
    threadId: text("thread_id").notNull(),
    /** inbound | outbound. Immutable once written. */
    direction: text("direction").notNull(),

    /** The raw `From` header, display name intact. Never the envelope sender. */
    fromHeader: text("from_header").notNull(),
    /** The bare address, as the parser resolved it. Null if unparseable. */
    fromAddr: text("from_addr"),
    toHeader: text("to_header").notNull(),
    toAddrs: text("to_addrs", { mode: "json" }).$type<string[]>().notNull(),
    ccAddrs: text("cc_addrs", { mode: "json" }).$type<string[]>().notNull(),
    bccAddrs: text("bcc_addrs", { mode: "json" }).$type<string[]>().notNull(),
    replyTo: text("reply_to"),

    subject: text("subject").notNull().default(""),
    bodyText: text("body_text"),
    bodyHtml: text("body_html"),

    inReplyTo: text("in_reply_to"),
    referencesIds: text("references_ids", { mode: "json" }).$type<string[]>().notNull(),

    spf: text("spf").notNull().default("unknown"),
    dkim: text("dkim").notNull().default("unknown"),
    dmarc: text("dmarc").notNull().default("unknown"),
    trusted: bool("trusted"),
    injectionRisk: bool("injection_risk"),
    trustReasons: text("trust_reasons", { mode: "json" }).$type<string[]>().notNull(),
    spamScore: real("spam_score"),

    /** The `+tag` this was addressed to, carried through as a label. */
    tag: text("tag"),
    /**
     * The `Auto-Submitted` header, verbatim. Stored so the loop breaker can read
     * it when we later reply, instead of re-parsing the raw MIME on every send.
     */
    autoSubmitted: text("auto_submitted"),
    rawKey: text("raw_key"),
    size: integer("size").notNull().default(0),
    seen: bool("seen"),

    /**
     * The `Date` header. DISPLAY ONLY.
     *
     * Never sort by this. A message whose `Date` is three years old arriving
     * today would insert mid-sequence and invalidate every cursor a client has
     * cached. `id` is the arrival order (ADR-2).
     */
    sentAt: timestamp("sent_at"),
    receivedAt: timestamp("received_at").notNull(),
  },
  (t) => [
    // Deduplication lives here rather than in a read-then-write: Email Routing
    // can deliver the same message twice, and a check-then-insert races itself.
    uniqueIndex("uq_messages_account_rfc_id").on(t.accountId, t.rfcMessageId),
    index("idx_messages_inbox").on(t.accountId, t.inboxId, t.id),
    index("idx_messages_thread").on(t.accountId, t.threadId, t.id),
    // Covers the loop breaker's "how many did we send this counterparty lately".
    index("idx_messages_sent_between").on(t.accountId, t.direction, t.fromAddr, t.receivedAt),
  ],
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: id(),
    accountId: accountId(),
    messageId: text("message_id").notNull(),
    filename: text("filename"),
    mime: text("mime"),
    contentId: text("content_id"),
    size: integer("size").notNull().default(0),
    inline: bool("inline"),
    r2Key: text("r2_key").notNull(),
  },
  (t) => [index("idx_attachments_message").on(t.accountId, t.messageId)],
);

/**
 * One send attempt and everything we learn about its fate.
 *
 * The body is not here — it is in R2 under `payload_key`. This row is the part
 * we query, count against quota and transition, so keeping it narrow keeps all
 * three cheap.
 */
export const deliveries = sqliteTable(
  "deliveries",
  {
    id: id(),
    accountId: accountId(),
    inboxId: text("inbox_id"),
    identityId: text("identity_id"),
    /** Points at the stored sent copy once there is one. */
    messageId: text("message_id"),
    idempotencyKey: text("idempotency_key"),
    /** See the state machine in DESIGN.md §4.3. */
    status: text("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    recipients: text("recipients", { mode: "json" }).$type<string[]>().notNull(),
    payloadKey: text("payload_key"),
    providerMsgId: text("provider_msg_id"),
    rejectReason: text("reject_reason"),
    lastError: text("last_error"),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    /** When `status` last changed. Out-of-order provider events compare to this. */
    statusChangedAt: timestamp("status_changed_at").notNull(),
  },
  (t) => [
    // A retried submission returns the original instead of sending twice.
    uniqueIndex("uq_delivery_idempotency").on(t.accountId, t.idempotencyKey),
    index("idx_delivery_status").on(t.accountId, t.status, t.createdAt),
    // How a provider delivery event finds the send it belongs to.
    index("idx_delivery_provider_id").on(t.accountId, t.providerMsgId),
    index("idx_delivery_quota").on(t.accountId, t.identityId, t.createdAt),
  ],
);

/**
 * Append-only, from the Queues event subscription (DESIGN.md §2.3).
 *
 * Rows land here even when they cannot be matched to a send or applied to its
 * state: a stale or unmatched event is still a fact about what the provider
 * said, and `mailworker status` is more useful for showing it.
 */
export const deliveryEvents = sqliteTable(
  "delivery_events",
  {
    id: id(),
    accountId: accountId(),
    deliveryId: text("delivery_id"),
    providerMsgId: text("provider_msg_id"),
    recipient: text("recipient"),
    /** delivered | deferred | bounced | failed | rejected | complained */
    type: text("type").notNull(),
    terminal: bool("terminal"),
    smtpCode: text("smtp_code"),
    smtpResponse: text("smtp_response"),
    occurredAt: timestamp("occurred_at").notNull(),
    /** The provider's original payload, verbatim, for forensics. */
    raw: text("raw"),
  },
  (t) => [index("idx_events_delivery").on(t.accountId, t.deliveryId, t.occurredAt)],
);

/**
 * Addresses we must not mail.
 *
 * Mirrored from Cloudflare's account-level list so `SendPolicy` can refuse
 * locally. Refusing before the API call keeps the attempt off the domain's
 * reputation and, since API-level rejections do not count against quota, off the
 * bill too.
 */
export const suppressions = sqliteTable(
  "suppressions",
  {
    accountId: accountId(),
    address: text("address").notNull(),
    /** hard_bounce | soft_bounce | complaint | manual */
    reason: text("reason").notNull(),
    /** cf_sync | local */
    source: text("source").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.address] })],
);

/** Who an agent may be, and how much rope it gets. What SendPolicy meters. */
export const agentIdentities = sqliteTable(
  "agent_identities",
  {
    id: id(),
    accountId: accountId(),
    name: text("name").notNull(),
    /** Address glob this identity may put in `From`. Null means any owned address. */
    sendAs: text("send_as"),
    /** Globs it may send TO. Null means unrestricted; `[]` means nobody. */
    recipientAllowlist: text("recipient_allowlist", { mode: "json" }).$type<string[]>(),
    dailySendQuota: integer("daily_send_quota"),
    requireApproval: bool("require_approval"),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [uniqueIndex("uq_identities_account_name").on(t.accountId, t.name)],
);

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: id(),
    accountId: accountId(),
    name: text("name").notNull(),
    /**
     * The public head of the token, e.g. `mw_live_8fa2c1`.
     *
     * Globally unique, not unique per account: authentication looks a key up
     * before it knows which account it belongs to, which is the one lookup in
     * the system that legitimately crosses tenants.
     */
    prefix: text("prefix").notNull(),
    /** Only the hash. The plaintext is shown once at creation and never stored. */
    hash: text("hash").notNull(),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
    identityId: text("identity_id"),
    lastUsedAt: timestamp("last_used_at"),
    expiresAt: timestamp("expires_at"),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [uniqueIndex("uq_api_keys_prefix").on(t.prefix)],
);

export const webhooks = sqliteTable(
  "webhooks",
  {
    id: id(),
    accountId: accountId(),
    url: text("url").notNull(),
    /** HMAC signing secret. */
    secret: text("secret").notNull(),
    events: text("events", { mode: "json" }).$type<string[]>().notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [index("idx_webhooks_account").on(t.accountId)],
);

export type InboxRow = typeof inboxes.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;
export type DeliveryRow = typeof deliveries.$inferSelect;
export type DeliveryEventRow = typeof deliveryEvents.$inferSelect;
export type SuppressionRow = typeof suppressions.$inferSelect;
export type AgentIdentityRow = typeof agentIdentities.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type DomainRow = typeof domains.$inferSelect;
export type WebhookRow = typeof webhooks.$inferSelect;
