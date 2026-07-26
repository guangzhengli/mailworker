import type {
  AttachmentMeta,
  AuthContext,
  EmailAddress,
  ListMessagesQuery,
  Message,
  MessageRepositoryPort,
  MessageSummary,
  Page,
  RfcMessageId,
  ThreadId,
  Ulid,
} from "@mailworker/core";
import { Message as MessageVO, PREVIEW_SOURCE_LENGTH } from "@mailworker/core";
import type { Db } from "@web/workers/infrastructure/d1.ts";
import {
  afterCursor,
  pageLimit,
  toDate,
  toIsoText,
  toPage,
} from "@web/workers/infrastructure/d1.ts";
import type { AttachmentRow, MessageRow } from "@web/workers/infrastructure/schema.ts";
import { attachments, messages } from "@web/workers/infrastructure/schema.ts";
import type { SQL } from "drizzle-orm";
import { and, asc, count, desc, eq, gte, inArray, sql } from "drizzle-orm";

export class D1Messages implements MessageRepositoryPort {
  constructor(private readonly db: Db) {}

  /**
   * Insert, letting `UNIQUE(account_id, rfc_message_id)` do the deduplication.
   *
   * `ON CONFLICT DO NOTHING ... RETURNING id` collapses "is it already there"
   * and "put it there" into one statement. A read-then-write would race itself:
   * Email Routing retries deliveries, and two concurrent retries would both see
   * an empty table and both insert.
   *
   * A duplicate is not an error. It is ordinary traffic.
   */
  async insert(ctx: AuthContext, message: Message): Promise<{ stored: boolean }> {
    const inserted = await this.db
      .insert(messages)
      .values(toRow(ctx, message))
      .onConflictDoNothing()
      .returning({ id: messages.id });

    if (inserted.length === 0) return { stored: false };

    // Sequential rather than batched with the insert above, because the
    // attachment rows must NOT be written when the message turned out to be a
    // duplicate — a batch has no way to make the second statement depend on the
    // first one's result. The window where the message row exists and its
    // attachment rows do not is real but small, and it degrades to a message
    // whose attachments are missing from the list, not a corrupt one.
    if (message.attachments.length > 0) {
      await this.db
        .insert(attachments)
        .values(message.attachments.map((a) => toAttachmentRow(ctx, message.id, a)));
    }
    return { stored: true };
  }

  async findById(ctx: AuthContext, id: Ulid): Promise<Message | null> {
    const [row] = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.accountId, ctx.accountId), eq(messages.id, id)))
      .limit(1);
    if (row === undefined) return null;
    return toMessage(row, await this.attachmentsFor(ctx, [id]));
  }

  async findByRfcMessageId(ctx: AuthContext, rfcId: RfcMessageId): Promise<Message | null> {
    const [row] = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.accountId, ctx.accountId), eq(messages.rfcMessageId, rfcId)))
      .limit(1);
    if (row === undefined) return null;
    return toMessage(row, await this.attachmentsFor(ctx, [row.id as Ulid]));
  }

  /**
   * One query for every candidate ancestor at once.
   *
   * A reply carries its whole `References` chain, and resolving a thread by
   * looking each id up in turn would be up to fifty round trips on the hot
   * inbound path. Returning the map lets `ThreadingPolicy` stay a pure function.
   */
  async findThreadIds(
    ctx: AuthContext,
    rfcIds: readonly RfcMessageId[],
  ): Promise<ReadonlyMap<string, ThreadId>> {
    if (rfcIds.length === 0) return new Map();
    const rows = await this.db
      .select({ rfcMessageId: messages.rfcMessageId, threadId: messages.threadId })
      .from(messages)
      .where(
        and(eq(messages.accountId, ctx.accountId), inArray(messages.rfcMessageId, [...rfcIds])),
      );
    return new Map(rows.map((row) => [row.rfcMessageId, row.threadId as ThreadId]));
  }

  /**
   * The list projection never selects a body.
   *
   * `substr(body_text, 1, PREVIEW_SOURCE_LENGTH)` is the whole trick: a page of
   * fifty messages costs a few hundred kilobytes instead of however many
   * megabytes of mail those fifty happen to be. The domain declares the bound so
   * the in-memory store truncates identically and the two agree exactly.
   */
  async list(ctx: AuthContext, query: ListMessagesQuery): Promise<Page<MessageSummary>> {
    const limit = pageLimit(query);
    const rows = await this.db
      .select({
        row: messages,
        previewSource: sql<
          string | null
        >`substr(${messages.bodyText}, 1, ${PREVIEW_SOURCE_LENGTH})`,
        hasText: sql<number>`(${messages.bodyText} IS NOT NULL AND length(trim(${messages.bodyText})) > 0)`,
        hasHtml: sql<number>`(${messages.bodyHtml} IS NOT NULL AND length(trim(${messages.bodyHtml})) > 0)`,
        // Table-qualified by hand. Interpolating the drizzle column references
        // here renders them BARE — `WHERE "message_id" = "id"` — because the
        // outer query has no join, and SQLite then resolves both names against
        // the subquery's own table. It compares `attachments.message_id` to
        // `attachments.id`, matches nothing, and reports every message as having
        // no attachments. It does not error, and it is invisible until someone
        // notices a paperclip missing.
        //
        // Matching on `account_id` too is what lets this use
        // `idx_attachments_message` instead of scanning.
        attachmentCount: sql<number>`(
          SELECT count(*) FROM attachments
          WHERE attachments.account_id = messages.account_id
            AND attachments.message_id = messages.id
        )`,
      })
      .from(messages)
      .where(and(eq(messages.accountId, ctx.accountId), ...listFilters(query)))
      .orderBy(query.order === "asc" ? asc(messages.id) : desc(messages.id))
      .limit(limit);

    const items = rows.map(
      (r): MessageSummary => ({
        ...summaryFields(r.row),
        attachmentCount: Number(r.attachmentCount),
        hasText: Boolean(r.hasText),
        hasHtml: Boolean(r.hasHtml),
        preview: MessageVO.previewFrom(r.previewSource),
      }),
    );
    return toPage(items, limit);
  }

  /** Ascending: a thread reads oldest first, unlike every other listing. */
  async listThread(ctx: AuthContext, threadId: ThreadId): Promise<Message[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.accountId, ctx.accountId), eq(messages.threadId, threadId)))
      .orderBy(asc(messages.id));
    const byMessage = await this.attachmentsFor(
      ctx,
      rows.map((row) => row.id as Ulid),
    );
    return rows.map((row) => toMessage(row, byMessage));
  }

  async setSeen(ctx: AuthContext, id: Ulid, seen: boolean): Promise<void> {
    await this.db
      .update(messages)
      .set({ seen })
      .where(and(eq(messages.accountId, ctx.accountId), eq(messages.id, id)));
  }

  /**
   * Feeds `LoopBreakerPolicy.exchangesInWindow`.
   *
   * `to_addrs` is a JSON array, so membership goes through `json_each` rather
   * than a `LIKE '%addr%'` — which would match `bob@corp.com` inside
   * `notbob@corp.com` and quietly throttle sends to an innocent recipient.
   */
  async countSentBetween(
    ctx: AuthContext,
    from: EmailAddress,
    to: EmailAddress,
    since: Date,
  ): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(messages)
      .where(
        and(
          eq(messages.accountId, ctx.accountId),
          eq(messages.direction, "outbound"),
          eq(messages.fromAddr, from),
          gte(messages.receivedAt, toIsoText(since)),
          sql`EXISTS (SELECT 1 FROM json_each(${messages.toAddrs}) WHERE json_each.value = ${to})`,
        ),
      );
    return row?.value ?? 0;
  }

  /**
   * Delete the rows and hand back the blob keys, rather than deleting blobs too.
   *
   * D1 and R2 cannot be written atomically, so the order is forced: rows first,
   * blobs after. A blob whose row is gone is an orphan the sweeper collects; a
   * row whose blob is gone is a message that renders as an error forever.
   */
  async deleteByInbox(ctx: AuthContext, inboxId: Ulid): Promise<{ storageKeys: string[] }> {
    const doomed = await this.db
      .select({ id: messages.id, rawKey: messages.rawKey })
      .from(messages)
      .where(and(eq(messages.accountId, ctx.accountId), eq(messages.inboxId, inboxId)));
    if (doomed.length === 0) return { storageKeys: [] };

    const ids = doomed.map((row) => row.id);
    const attachmentRows = await this.db
      .select({ r2Key: attachments.r2Key })
      .from(attachments)
      .where(
        and(eq(attachments.accountId, ctx.accountId), inArray(attachments.messageId, ids)),
      );

    await this.db.batch([
      this.db
        .delete(attachments)
        .where(
          and(eq(attachments.accountId, ctx.accountId), inArray(attachments.messageId, ids)),
        ),
      this.db
        .delete(messages)
        .where(and(eq(messages.accountId, ctx.accountId), eq(messages.inboxId, inboxId))),
    ]);

    return {
      storageKeys: [
        ...doomed.flatMap((row) => (row.rawKey === null ? [] : [row.rawKey])),
        ...attachmentRows.map((row) => row.r2Key),
      ],
    };
  }

  private async attachmentsFor(
    ctx: AuthContext,
    messageIds: readonly Ulid[],
  ): Promise<Map<string, AttachmentMeta[]>> {
    const byMessage = new Map<string, AttachmentMeta[]>();
    if (messageIds.length === 0) return byMessage;
    const rows = await this.db
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.accountId, ctx.accountId),
          inArray(attachments.messageId, [...messageIds]),
        ),
      );
    for (const row of rows) {
      const list = byMessage.get(row.messageId) ?? [];
      list.push(toAttachmentMeta(row));
      byMessage.set(row.messageId, list);
    }
    return byMessage;
  }
}

function listFilters(query: ListMessagesQuery): (SQL | undefined)[] {
  return [
    query.inboxId === undefined ? undefined : eq(messages.inboxId, query.inboxId),
    query.threadId === undefined ? undefined : eq(messages.threadId, query.threadId),
    query.direction === undefined ? undefined : eq(messages.direction, query.direction),
    query.from === undefined ? undefined : eq(messages.fromAddr, query.from),
    query.seen === undefined ? undefined : eq(messages.seen, query.seen),
    query.after === undefined ? undefined : sql`${messages.id} > ${query.after}`,
    query.q === undefined ? undefined : fullTextFilter(query.q),
    afterCursor(messages.id, query),
  ];
}

/**
 * Full-text search over the external-content FTS5 index.
 *
 * The user's text is turned into quoted phrase tokens joined by AND, never
 * interpolated as FTS syntax. Raw input would let a stray `"` or a bare `AND`
 * turn a search into a syntax error, and `NEAR`/`*`/column filters into
 * behaviour nobody asked for. Quoting each token makes every input a literal
 * word search, which is also what someone typing into a search box expects.
 */
export function fullTextFilter(q: string): SQL {
  const tokens = q
    .split(/\s+/)
    .map((token) => token.replace(/"/g, ""))
    .filter((token) => token.length > 0);
  // All punctuation and nothing else: match nothing rather than hand FTS5 an
  // empty query, which is an error.
  if (tokens.length === 0) return sql`1 = 0`;
  const match = tokens.map((token) => `"${token}"`).join(" AND ");
  return sql`${messages.id} IN (
    SELECT m.id FROM messages m
    JOIN messages_fts f ON f.rowid = m.rowid
    WHERE messages_fts MATCH ${match}
  )`;
}

function toRow(ctx: AuthContext, message: Message): typeof messages.$inferInsert {
  return {
    id: message.id,
    accountId: ctx.accountId,
    inboxId: message.inboxId,
    rfcMessageId: message.rfcMessageId,
    threadId: message.threadId,
    direction: message.direction,
    fromHeader: message.fromHeader,
    fromAddr: message.from,
    toHeader: message.toHeader,
    toAddrs: [...message.to],
    ccAddrs: [...message.cc],
    bccAddrs: [...message.bcc],
    replyTo: message.replyTo,
    subject: message.subject,
    bodyText: message.bodyText,
    bodyHtml: message.bodyHtml,
    inReplyTo: message.inReplyTo,
    referencesIds: [...message.references],
    spf: message.auth.spf,
    dkim: message.auth.dkim,
    dmarc: message.auth.dmarc,
    trusted: message.trusted,
    injectionRisk: message.injectionRisk,
    trustReasons: [...message.trustReasons],
    tag: message.tag,
    autoSubmitted: message.autoSubmitted,
    rawKey: message.rawKey,
    size: message.size,
    seen: message.seen,
    sentAt: toIsoText(message.sentAt),
    receivedAt: toIsoText(message.receivedAt),
  };
}

/** The fields a summary and a full message share. */
function summaryFields(
  row: MessageRow,
): Omit<MessageSummary, "attachmentCount" | "hasText" | "hasHtml" | "preview"> {
  return {
    id: row.id as Ulid,
    accountId: row.accountId as Message["accountId"],
    inboxId: row.inboxId as Ulid,
    rfcMessageId: row.rfcMessageId as RfcMessageId,
    threadId: row.threadId as ThreadId,
    direction: row.direction as Message["direction"],
    fromHeader: row.fromHeader,
    from: row.fromAddr as EmailAddress | null,
    toHeader: row.toHeader,
    to: row.toAddrs as EmailAddress[],
    cc: row.ccAddrs as EmailAddress[],
    bcc: row.bccAddrs as EmailAddress[],
    replyTo: row.replyTo as EmailAddress | null,
    subject: row.subject,
    inReplyTo: row.inReplyTo as RfcMessageId | null,
    references: row.referencesIds as RfcMessageId[],
    auth: {
      spf: row.spf as Message["auth"]["spf"],
      dkim: row.dkim as Message["auth"]["dkim"],
      dmarc: row.dmarc as Message["auth"]["dmarc"],
    },
    trusted: row.trusted,
    injectionRisk: row.injectionRisk,
    trustReasons: row.trustReasons as Message["trustReasons"],
    tag: row.tag,
    autoSubmitted: row.autoSubmitted,
    rawKey: row.rawKey,
    size: row.size,
    seen: row.seen,
    sentAt: toDate(row.sentAt),
    receivedAt: toDate(row.receivedAt),
  };
}

export function toMessage(row: MessageRow, byMessage: Map<string, AttachmentMeta[]>): Message {
  return {
    ...summaryFields(row),
    bodyText: row.bodyText,
    bodyHtml: row.bodyHtml,
    attachments: byMessage.get(row.id) ?? [],
  };
}

function toAttachmentRow(
  ctx: AuthContext,
  messageId: Ulid,
  attachment: AttachmentMeta,
): typeof attachments.$inferInsert {
  return {
    id: attachment.id,
    accountId: ctx.accountId,
    messageId,
    filename: attachment.filename,
    mime: attachment.mime,
    contentId: attachment.contentId,
    size: attachment.size,
    inline: attachment.inline,
    r2Key: attachment.storageKey,
  };
}

function toAttachmentMeta(row: AttachmentRow): AttachmentMeta {
  return {
    id: row.id as Ulid,
    filename: row.filename,
    mime: row.mime,
    contentId: row.contentId,
    size: row.size,
    inline: row.inline,
    storageKey: row.r2Key,
  };
}
