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
 * The D1 schema. `drizzle-kit generate` turns this into `migrations/`; nothing
 * hand-edits those except the FTS5 migration, which drizzle cannot model.
 *
 * `account_id` is on every table and first in every composite index. An account
 * is an environment (DESIGN ADR-9), so that column is also what keeps a
 * development send from ever seeing production data.
 */

const id = () => text("id").primaryKey();
const accountId = () => text("account_id").notNull();
const timestamp = (name: string) => text(name);
const bool = (name: string) => integer(name, { mode: "boolean" }).notNull().default(false);

/** One row per environment. `project_id` groups the environments of a deployment. */
export const accounts = sqliteTable(
  "accounts",
  {
    id: id(),
    projectId: text("project_id").notNull(),
    /** Slug shown in the environment switcher: `production`, `development`, … */
    env: text("env").notNull(),
    name: text("name").notNull(),
    /** live | sandbox | test — decides whether sends reach the outside world. */
    mode: text("mode").notNull().default("live"),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [uniqueIndex("uq_accounts_project_env").on(t.projectId, t.env)],
);

/**
 * `catchall_mode` is what lets the product run on ONE Cloudflare routing rule:
 * address ownership resolves here rather than by a rule per address against a
 * ceiling of 200 per domain.
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
    dkimSelector: text("dkim_selector"),
    /** reject | store | autocreate */
    catchallMode: text("catchall_mode").notNull().default("reject"),
    catchallInbox: text("catchall_inbox"),
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
    expiresAt: timestamp("expires_at"),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_inboxes_account_address").on(t.accountId, t.address),
    index("idx_inboxes_expiry").on(t.expiresAt).where(sql`expires_at IS NOT NULL`),
    index("idx_inboxes_account").on(t.accountId, t.createdAt),
  ],
);

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

    fromHeader: text("from_header").notNull(),
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

    tag: text("tag"),
    autoSubmitted: text("auto_submitted"),
    rawKey: text("raw_key"),
    size: integer("size").notNull().default(0),
    seen: bool("seen"),

    /**
     * The `Date` header. DISPLAY ONLY — never sort by it. A message whose `Date`
     * is three years old arriving today would insert mid-sequence and invalidate
     * every cached cursor. `id` is the arrival order (ADR-2).
     */
    sentAt: timestamp("sent_at"),
    receivedAt: timestamp("received_at").notNull(),
  },
  (t) => [
    // Deduplication lives here rather than in a read-then-write: Email Routing
    // can deliver the same message twice, and check-then-insert races itself.
    uniqueIndex("uq_messages_account_rfc_id").on(t.accountId, t.rfcMessageId),
    index("idx_messages_inbox").on(t.accountId, t.inboxId, t.id),
    index("idx_messages_thread").on(t.accountId, t.threadId, t.id),
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

export const deliveries = sqliteTable(
  "deliveries",
  {
    id: id(),
    accountId: accountId(),
    inboxId: text("inbox_id"),
    identityId: text("identity_id"),
    messageId: text("message_id"),
    idempotencyKey: text("idempotency_key"),
    /**
     * On the row rather than in the payload blob because `recordEvent` reads
     * this row and never the blob.
     */
    metadata: text("metadata", { mode: "json" }).$type<Record<string, string>>(),
    /** agent | console — a console send skips the approval queue. */
    source: text("source").notNull().default("agent"),
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
    uniqueIndex("uq_delivery_idempotency").on(t.accountId, t.idempotencyKey),
    index("idx_delivery_status").on(t.accountId, t.status, t.createdAt),
    index("idx_delivery_provider_id").on(t.accountId, t.providerMsgId),
    index("idx_delivery_quota").on(t.accountId, t.identityId, t.createdAt),
  ],
);

/**
 * Append-only. Rows land here even when they cannot be matched to a send or
 * applied to its state: an unmatched event is still a fact about what the
 * provider said.
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
    raw: text("raw"),
  },
  (t) => [index("idx_events_delivery").on(t.accountId, t.deliveryId, t.occurredAt)],
);

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
    /** Auto-provisioned identity that dashboard sends are metered against. */
    managed: bool("managed"),
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
     * Globally unique, not unique per account: authentication looks a key up
     * before it knows which account it belongs to.
     */
    prefix: text("prefix").notNull(),
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
    secret: text("secret").notNull(),
    events: text("events", { mode: "json" }).$type<string[]>().notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [index("idx_webhooks_account").on(t.accountId)],
);

export type AccountRow = typeof accounts.$inferSelect;
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
