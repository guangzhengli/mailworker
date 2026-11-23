import type {
  AttachmentMeta,
  BlobStore,
  Caller,
  EmailAddress,
  ListMessagesQuery,
  MessageLabelChanges,
  MessageRepository,
  MessageStateChange,
  MessageSummary,
  Page,
  RfcMessageId,
  ThreadId,
  Ulid,
} from "@mailworker/core";
import {
  decodeStoredMessageBody,
  LabelName,
  MESSAGE_INDEX_TEXT_BYTES,
  Message,
  notFound,
  PREVIEW_SOURCE_LENGTH,
  truncateUtf8,
} from "@mailworker/core";
import type { Db } from "@web/workers/adapters/d1";
import { afterCursor, pageLimit, toDate, toIsoText, toPage } from "@web/workers/adapters/d1";
import { D1Labels, rethrowLabelError } from "@web/workers/adapters/d1-labels";
import type { AttachmentRow, MessageRow } from "@web/workers/adapters/schema";
import { attachments, messages } from "@web/workers/adapters/schema";
import type { SQL } from "drizzle-orm";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";

export class D1Messages implements MessageRepository {
  constructor(
    private readonly db: Db,
    private readonly blobs?: BlobStore,
    readonly labels = new D1Labels(db),
  ) {}

  /**
   * Insert, letting
   * `UNIQUE(account_id, inbox_id, envelope_recipient, rfc_message_id)`
   * deduplicate retries without dropping two +tags or catch-all recipients that
   * legitimately route the same RFC message into one inbox.
   *
   * `ON CONFLICT DO NOTHING ... RETURNING id` collapses "is it already there"
   * and "put it there" into one statement. A read-then-write would race itself:
   * Email Routing retries deliveries, and two concurrent retries would both see
   * an empty table and both insert.
   *
   * A duplicate is not an error. It is ordinary traffic.
   */
  async insert(
    ctx: Caller,
    message: Message,
    options: { readonly bodyKey?: string | null } = {},
  ): Promise<{ stored: boolean }> {
    const insertMessage = this.db
      .insert(messages)
      .values(toRow(ctx, message, options.bodyKey ?? null))
      .onConflictDoNothing()
      .returning({ id: messages.id });

    // Native D1 batch is transactional. Every attachment statement includes an
    // EXISTS guard on THIS newly minted message id: when a concurrent duplicate
    // wins, our INSERT OR IGNORE returns no row and no loser attachment can be
    // written. Ten rows × nine values + two guard values = 92 parameters, under
    // D1's hard 100-bound-parameter ceiling for each statement.
    const messageQuery = insertMessage.toSQL();
    const statements: D1PreparedStatement[] = [
      this.db.$client.prepare(messageQuery.sql).bind(...toD1Values(messageQuery.params)),
    ];
    for (const group of chunks(message.attachments, ATTACHMENTS_PER_STATEMENT)) {
      statements.push(attachmentInsert(this.db.$client, ctx, message.id, group));
    }
    if (message.labels.length > 0) {
      statements.push(
        ...this.addLabelStatements(
          ctx,
          changePrefix(ctx, [message.id], null),
          message.labels,
          message.receivedAt,
        ),
      );
    }
    try {
      const [inserted] = await this.db.$client.batch(statements);
      return { stored: (inserted?.results.length ?? 0) > 0 };
    } catch (error) {
      rethrowLabelError(error);
    }
  }

  async findById(ctx: Caller, id: Ulid): Promise<Message | null> {
    const [row] = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.accountId, ctx.accountId), eq(messages.id, id)))
      .limit(1);
    if (row === undefined) return null;
    return (await this.hydrateRows(ctx, [row]))[0]!;
  }

  async findByRfcMessageId(ctx: Caller, rfcId: RfcMessageId): Promise<Message | null> {
    const [row] = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.accountId, ctx.accountId), eq(messages.rfcMessageId, rfcId)))
      .limit(1);
    if (row === undefined) return null;
    return (await this.hydrateRows(ctx, [row]))[0]!;
  }

  async findPlacement(
    ctx: Caller,
    inboxId: Ulid,
    envelopeRecipient: EmailAddress | null,
    rfcId: RfcMessageId,
  ): Promise<Message | null> {
    const [row] = await this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.accountId, ctx.accountId),
          eq(messages.inboxId, inboxId),
          envelopeRecipient === null
            ? isNull(messages.envelopeRecipient)
            : eq(messages.envelopeRecipient, envelopeRecipient),
          eq(messages.rfcMessageId, rfcId),
        ),
      )
      .limit(1);
    if (row === undefined) return null;
    return (await this.hydrateRows(ctx, [row]))[0]!;
  }

  /**
   * One query for every candidate ancestor at once.
   *
   * A reply carries its whole `References` chain, and resolving a thread by
   * looking each id up in turn would be up to fifty round trips on the hot
   * inbound path. Returning the map lets `ThreadingPolicy` stay a pure function.
   */
  async findThreadIds(
    ctx: Caller,
    rfcIds: readonly RfcMessageId[],
    inboxId?: Ulid,
  ): Promise<ReadonlyMap<string, ThreadId>> {
    if (rfcIds.length === 0) return new Map();
    const found = new Map<string, ThreadId>();
    for (const group of chunks(rfcIds, MESSAGE_IDS_PER_QUERY)) {
      const rows = await this.db
        .select({ rfcMessageId: messages.rfcMessageId, threadId: messages.threadId })
        .from(messages)
        .where(
          and(
            eq(messages.accountId, ctx.accountId),
            inboxId === undefined ? undefined : eq(messages.inboxId, inboxId),
            inArray(messages.rfcMessageId, group),
          ),
        );
      for (const row of rows) found.set(row.rfcMessageId, row.threadId as ThreadId);
    }
    return found;
  }

  /**
   * The list projection never selects a body.
   *
   * `substr(body_text, 1, PREVIEW_SOURCE_LENGTH)` is the whole trick: a page of
   * fifty messages costs a few hundred kilobytes instead of however many
   * megabytes of mail those fifty happen to be. The domain declares the bound so
   * the in-memory store truncates identically and the two agree exactly.
   */
  async list(ctx: Caller, query: ListMessagesQuery): Promise<Page<MessageSummary>> {
    const limit = pageLimit(query);
    const rows = await this.db
      .select({
        row: summaryProjection(),
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
        noteCount: sql<number>`(
          SELECT count(*) FROM message_notes
          WHERE message_notes.account_id = messages.account_id
            AND message_notes.message_id = messages.id
        )`,
        attachmentCount: sql<number>`(
          SELECT count(*) FROM attachments
          WHERE attachments.account_id = messages.account_id
            AND attachments.message_id = messages.id
        )`,
      })
      .from(messages)
      .where(and(eq(messages.accountId, ctx.accountId), ...listFilters(ctx, query)))
      .orderBy(query.order === "asc" ? asc(messages.id) : desc(messages.id))
      .limit(limit);

    const labels = await this.labels.namesForMessages(
      ctx,
      rows.map(({ row }) => row.id),
    );
    const items = rows.map(
      (r): MessageSummary => ({
        ...summaryFields(r.row, labels.get(r.row.id) ?? []),
        noteCount: Number(r.noteCount),
        attachmentCount: Number(r.attachmentCount),
        hasText: Boolean(r.hasText),
        hasHtml: Boolean(r.hasHtml),
        preview: Message.previewFrom(r.previewSource),
      }),
    );
    return toPage(items, limit);
  }

  /** Ascending: a thread reads oldest first, unlike every other listing. */
  async listThread(ctx: Caller, threadId: ThreadId): Promise<Message[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.accountId, ctx.accountId), eq(messages.threadId, threadId)))
      .orderBy(asc(messages.id));
    return await this.hydrateRows(ctx, rows);
  }

  private async hydrateRows(ctx: Caller, rows: readonly MessageRow[]): Promise<Message[]> {
    const ids = rows.map((row) => row.id as Ulid);
    const [byMessage, labels] = await Promise.all([
      this.attachmentsFor(ctx, ids),
      this.labels.namesForMessages(ctx, ids),
    ]);
    const hydrated: Message[] = [];
    // Workers allow six simultaneous outbound connections. R2 reads use those
    // slots, so hydrate five at a time rather than Promise.all over a long thread.
    for (const group of chunks(rows, BODY_HYDRATION_CONCURRENCY)) {
      hydrated.push(
        ...(await Promise.all(
          group.map((row) =>
            this.toHydratedMessage(ctx, row, byMessage, labels.get(row.id) ?? []),
          ),
        )),
      );
    }
    return hydrated;
  }

  async setSeen(ctx: Caller, id: Ulid, seen: boolean): Promise<void> {
    await this.updateState(ctx, [id], { seen });
  }

  async updateState(
    ctx: Caller,
    ids: readonly Ulid[],
    change: MessageStateChange,
  ): Promise<void> {
    const statement = this.stateStatement(ctx, ids, change);
    if (statement !== null) await statement.run();
  }

  async applyChanges(
    ctx: Caller,
    ids: readonly Ulid[],
    change: MessageStateChange,
    options: MessageLabelChanges,
  ): Promise<void> {
    const prefix = changePrefix(ctx, ids, options.identityId);
    const client = this.db.$client;
    // D1 batches are transactional. Every write is gated by the same set of
    // accessible IDs, and a limit violation aborts the whole batch.
    const missing = client
      .prepare(
        `${prefix.sql} SELECT value AS id FROM requested, json_each(requested.ids)
       WHERE value NOT IN (SELECT id FROM eligible)`,
      )
      .bind(...prefix.bindings);
    const statements = [missing];
    if (options.remove.length > 0) {
      statements.push(
        client
          .prepare(
            `${prefix.sql}
         DELETE FROM message_labels WHERE account_id = ? AND ${prefix.allowed}
           AND message_id IN (SELECT id FROM eligible)
           AND label_id IN (SELECT id FROM labels WHERE account_id = ? AND name_key IN (SELECT value FROM json_each(?)))`,
          )
          .bind(
            ...prefix.bindings,
            ctx.accountId,
            ctx.accountId,
            JSON.stringify(options.remove),
          ),
      );
    }
    if (options.add.length > 0) {
      statements.push(...this.addLabelStatements(ctx, prefix, options.add, options.now));
    }
    const state = this.stateStatement(ctx, ids, change, prefix);
    if (state !== null) statements.push(state);

    try {
      const [result] = await client.batch<{ id: string }>(statements);
      const missingIds = result!.results.map((row) => row.id);
      if (missingIds.length > 0) {
        throw notFound("message_not_found", "One or more messages were not found.", {
          ids: missingIds,
        });
      }
    } catch (error) {
      rethrowLabelError(error);
    }
  }

  private addLabelStatements(
    ctx: Caller,
    prefix: ReturnType<typeof changePrefix>,
    names: readonly string[],
    now: Date,
  ): D1PreparedStatement[] {
    return [
      this.labels.ensureStatement(ctx, names, now, prefix),
      this.db.$client
        .prepare(
          `${prefix.sql}
         INSERT INTO message_labels (account_id, message_id, label_id, created_at)
         SELECT l.account_id, eligible.id, l.id, ?
         FROM labels l CROSS JOIN eligible
         WHERE l.account_id = ? AND l.name_key IN (SELECT value FROM json_each(?))
           AND ${prefix.allowed}
         ON CONFLICT (account_id, message_id, label_id) DO NOTHING`,
        )
        .bind(
          ...prefix.bindings,
          toIsoText(now),
          ctx.accountId,
          JSON.stringify(names.map(LabelName.key)),
        ),
    ];
  }

  private stateStatement(
    ctx: Caller,
    ids: readonly Ulid[],
    change: MessageStateChange,
    prefix?: ReturnType<typeof changePrefix>,
  ): D1PreparedStatement | null {
    const { seen, starred, archivedAt } = change;
    if (
      ids.length === 0 ||
      (seen === undefined && starred === undefined && archivedAt === undefined)
    )
      return null;
    return this.db.$client
      .prepare(
        `${prefix?.sql ?? ""}
       UPDATE messages
       SET seen = coalesce(?, seen), starred = coalesce(?, starred),
           archived_at = CASE WHEN ? THEN ? ELSE archived_at END
       WHERE account_id = ? AND id IN (${prefix === undefined ? "SELECT value FROM json_each(?)" : "SELECT id FROM eligible"})
         AND ${prefix?.allowed ?? "1"}`,
      )
      .bind(
        ...(prefix?.bindings ?? []),
        seen === undefined ? null : Number(seen),
        starred === undefined ? null : Number(starred),
        Number(archivedAt !== undefined),
        toIsoText(archivedAt ?? null),
        ctx.accountId,
        ...(prefix === undefined ? [JSON.stringify(ids)] : []),
      );
  }

  /**
   * Feeds `LoopBreakerPolicy.exchangesInWindow`.
   *
   * `to_addrs` is a JSON array, so membership goes through `json_each` rather
   * than a `LIKE '%addr%'` — which would match `bob@corp.com` inside
   * `notbob@corp.com` and quietly throttle sends to an innocent recipient.
   */
  async countSentBetween(
    ctx: Caller,
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
  async deleteByInbox(ctx: Caller, inboxId: Ulid): Promise<{ storageKeys: string[] }> {
    const doomed = await this.db
      .select({ rawKey: messages.rawKey, bodyKey: messages.bodyKey })
      .from(messages)
      .where(and(eq(messages.accountId, ctx.accountId), eq(messages.inboxId, inboxId)));
    if (doomed.length === 0) return { storageKeys: [] };

    // Keep bound parameters constant. Expanding every id into IN (?, ?, ...)
    // made deleting an inbox with 100 messages exceed D1's query limit.
    const attachmentRows = await this.db.$client
      .prepare(
        `SELECT a.r2_key FROM attachments a
         WHERE a.account_id = ? AND a.message_id IN (
           SELECT id FROM messages WHERE account_id = ? AND inbox_id = ?
         )`,
      )
      .bind(ctx.accountId, ctx.accountId, inboxId)
      .all<{ r2_key: string }>();

    await this.db.batch([
      this.db.delete(attachments).where(
        and(
          eq(attachments.accountId, ctx.accountId),
          sql`${attachments.messageId} IN (
              SELECT id FROM messages
              WHERE account_id = ${ctx.accountId} AND inbox_id = ${inboxId}
            )`,
        ),
      ),
      this.db
        .delete(messages)
        .where(and(eq(messages.accountId, ctx.accountId), eq(messages.inboxId, inboxId))),
    ]);

    return {
      storageKeys: [
        ...doomed.flatMap((row) => (row.rawKey === null ? [] : [row.rawKey])),
        ...doomed.flatMap((row) => (row.bodyKey === null ? [] : [row.bodyKey])),
        ...attachmentRows.results.map((row) => row.r2_key),
      ],
    };
  }

  private async toHydratedMessage(
    ctx: Caller,
    row: MessageRow,
    byMessage: Map<string, AttachmentMeta[]>,
    labels: readonly string[],
  ): Promise<Message> {
    const indexed = toMessage(row, byMessage, labels);
    if (row.bodyKey === null) return indexed;
    if (this.blobs === undefined) {
      throw new Error("D1Messages needs a BlobStore to hydrate R2-backed message bodies.");
    }
    const bytes = await this.blobs.get(ctx, row.bodyKey);
    if (bytes === null) throw new Error(`Message ${row.id} body blob is missing.`);
    return { ...indexed, ...decodeStoredMessageBody(bytes) };
  }

  private async attachmentsFor(
    ctx: Caller,
    messageIds: readonly Ulid[],
  ): Promise<Map<string, AttachmentMeta[]>> {
    const byMessage = new Map<string, AttachmentMeta[]>();
    if (messageIds.length === 0) return byMessage;
    // One account binding plus at most 90 ids keeps each query under D1's 100
    // bound-parameter limit even for very long threads.
    for (const group of chunks(messageIds, MESSAGE_IDS_PER_QUERY)) {
      const rows = await this.db
        .select()
        .from(attachments)
        .where(
          and(eq(attachments.accountId, ctx.accountId), inArray(attachments.messageId, group)),
        );
      for (const row of rows) {
        const list = byMessage.get(row.messageId) ?? [];
        list.push(toAttachmentMeta(row));
        byMessage.set(row.messageId, list);
      }
    }
    return byMessage;
  }
}

function changePrefix(ctx: Caller, ids: readonly Ulid[], identityId: Ulid | null) {
  return {
    sql: `WITH requested(account_id, ids, identity_id) AS (VALUES (?, ?, ?)),
           eligible AS (
             SELECT m.id FROM requested r JOIN messages m ON m.account_id = r.account_id
             WHERE m.id IN (SELECT value FROM json_each(r.ids))
               AND (r.identity_id IS NULL OR m.identity_id = r.identity_id)
           )`,
    bindings: [ctx.accountId, JSON.stringify([...new Set(ids)]), identityId],
    allowed: "(SELECT count(*) FROM eligible) = (SELECT json_array_length(ids) FROM requested)",
  };
}

function listFilters(ctx: Caller, query: ListMessagesQuery): (SQL | undefined)[] {
  return [
    query.id === undefined ? undefined : eq(messages.id, query.id),
    query.starred === undefined ? undefined : eq(messages.starred, query.starred),
    query.archived === undefined
      ? undefined
      : query.archived
        ? isNotNull(messages.archivedAt)
        : isNull(messages.archivedAt),
    query.muted === undefined
      ? undefined
      : sql`EXISTS (
      SELECT 1 FROM inboxes i
      WHERE i.account_id = messages.account_id AND i.id = messages.inbox_id
        AND i.deleted_at IS NULL AND i.muted = ${Number(query.muted)}
    )`,
    query.label === undefined
      ? undefined
      : sql`messages.id IN (
      SELECT ml.message_id FROM labels l
      JOIN message_labels ml ON ml.account_id = l.account_id AND ml.label_id = l.id
      WHERE l.account_id = ${ctx.accountId} AND l.name_key = ${LabelName.key(query.label)}
    )`,
    query.inboxId === undefined ? undefined : eq(messages.inboxId, query.inboxId),
    query.identityId === undefined ? undefined : eq(messages.identityId, query.identityId),
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
 * The shortest term a trigram index can answer. Below this the index holds no
 * posting that could match, and FTS5 reports that as zero rows rather than as
 * an error — which is why a term this short must never reach it.
 */
const TRIGRAM_MIN_LENGTH = 3;

/**
 * The ids of every message whose indexed text matches, as a subquery.
 *
 * `null` when the input has no usable terms — all whitespace and nothing else.
 * The caller decides what that means: matching nothing is right for a message
 * search, and wrong for a delivery search that also looks at recipients.
 *
 * Terms are ANDed, and each one is matched as a SUBSTRING, not as a word. That
 * is the whole point of the trigram index behind this (migration 0006): with
 * the default tokenizer an entire run of Han characters is one token, so
 * `验证码` could not find `您的验证码是483920` — the two are different tokens,
 * and no amount of query rewriting fixes that from this side.
 *
 * Terms shorter than three characters take a LIKE scan instead, because the
 * index cannot answer them at all. Two-character words are ordinary in Chinese
 * (订单, 发票, 退款), so treating those as unanswerable would have replaced one
 * broken case with a quieter one. The scan is bounded by everything else in the
 * WHERE clause — account, inbox, cursor — and by the page limit.
 *
 * Nothing here is interpolated as FTS syntax. Terms are quoted into phrases, so
 * a stray `"` or a bare `AND` is text rather than a syntax error, and `NEAR`,
 * `*` and column filters cannot be reached from a search box.
 */
export function matchingMessageIds(q: string): SQL | null {
  const terms = q.split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0) return null;

  const conditions = terms.map((term) =>
    term.length >= TRIGRAM_MIN_LENGTH ? trigramMatch(term) : likeScan(term),
  );
  return sql`(SELECT m.id FROM messages m WHERE ${and(...conditions)})`;
}

/** One indexed substring term. The quotes make it a phrase, never FTS syntax. */
function trigramMatch(term: string): SQL {
  const phrase = `"${term.replace(/"/g, "")}"`;
  return sql`m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ${phrase})`;
}

/**
 * The unindexed fallback, over the same three columns the index covers.
 *
 * `%` and `_` are escaped rather than passed through: someone searching for a
 * literal `100%` off means the character, and an unescaped `%` here would
 * quietly match every message in the account.
 */
function likeScan(term: string): SQL {
  const pattern = `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  return sql`(
    m.subject LIKE ${pattern} ESCAPE '\\'
    OR m.body_text LIKE ${pattern} ESCAPE '\\'
    OR m.from_header LIKE ${pattern} ESCAPE '\\'
  )`;
}

/** Full-text search over the external-content FTS5 index. */
export function fullTextFilter(q: string): SQL {
  const matching = matchingMessageIds(q);
  // Match nothing rather than hand FTS5 an empty query, which is an error.
  if (matching === null) return sql`1 = 0`;
  return sql`${messages.id} IN ${matching}`;
}

function toRow(
  ctx: Caller,
  message: Message,
  bodyKey: string | null,
): typeof messages.$inferInsert {
  return {
    id: message.id,
    accountId: ctx.accountId,
    inboxId: message.inboxId,
    identityId: message.identityId,
    rfcMessageId: message.rfcMessageId,
    envelopeRecipient: message.envelopeRecipient,
    threadId: message.threadId,
    direction: message.direction,
    origin: message.origin,
    fromHeader: message.fromHeader,
    fromAddr: message.from,
    toHeader: message.toHeader,
    toAddrs: [...message.to],
    ccAddrs: [...message.cc],
    bccAddrs: [...message.bcc],
    replyTo: message.replyTo,
    subject: message.subject,
    bodyKey,
    bodyText: truncateUtf8(message.bodyText, MESSAGE_INDEX_TEXT_BYTES),
    bodyHtml: truncateUtf8(message.bodyHtml, MESSAGE_INDEX_TEXT_BYTES),
    inReplyTo: message.inReplyTo,
    referencesIds: [...message.references],
    spf: message.auth.spf,
    dkim: message.auth.dkim,
    dmarc: message.auth.dmarc,
    trusted: message.trusted,
    trustReasons: [...message.trustReasons],
    tag: message.tag,
    autoSubmitted: message.autoSubmitted,
    rawKey: message.rawKey,
    size: message.size,
    seen: message.seen,
    starred: message.starred,
    archivedAt: toIsoText(message.archivedAt),
    listId: message.listId,
    listUnsubscribe: message.unsubscribe,
    sentAt: toIsoText(message.sentAt),
    receivedAt: toIsoText(message.receivedAt),
  };
}

const ATTACHMENT_BOUND_PARAMETERS = 9;
const ATTACHMENTS_PER_STATEMENT = Math.floor((100 - 2) / ATTACHMENT_BOUND_PARAMETERS);
const MESSAGE_IDS_PER_QUERY = 90;
const BODY_HYDRATION_CONCURRENCY = 5;

function attachmentInsert(
  db: D1Database,
  ctx: Caller,
  messageId: Ulid,
  group: readonly AttachmentMeta[],
): D1PreparedStatement {
  const row = "(?, ?, ?, ?, ?, ?, ?, ?, ?)";
  const sqlText = `INSERT INTO attachments
    (id, account_id, message_id, filename, mime, content_id, size, inline, r2_key)
    SELECT column1, column2, column3, column4, column5, column6, column7, column8, column9
    FROM (VALUES ${group.map(() => row).join(", ")})
    WHERE EXISTS (SELECT 1 FROM messages WHERE account_id = ? AND id = ?)`;
  const params: unknown[] = group.flatMap((attachment) => [
    attachment.id,
    ctx.accountId,
    messageId,
    attachment.filename,
    attachment.mime,
    attachment.contentId,
    attachment.size,
    attachment.inline ? 1 : 0,
    attachment.storageKey,
  ]);
  params.push(ctx.accountId, messageId);
  return db.prepare(sqlText).bind(...params);
}

function toD1Values(values: readonly unknown[]): unknown[] {
  return values.map((value) => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      value instanceof ArrayBuffer ||
      ArrayBuffer.isView(value)
    ) {
      return value;
    }
    throw new Error(`Unsupported D1 bind value: ${typeof value}`);
  });
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

type SummaryRow = Omit<
  MessageRow,
  "bodyKey" | "bodyText" | "bodyHtml" | "listId" | "listUnsubscribe"
>;

function summaryFields(
  row: SummaryRow,
  labels: readonly string[],
): Omit<MessageSummary, "attachmentCount" | "noteCount" | "hasText" | "hasHtml" | "preview"> {
  return {
    id: row.id as Ulid,
    accountId: row.accountId as Message["accountId"],
    inboxId: row.inboxId as Ulid,
    identityId: row.identityId as Ulid | null,
    rfcMessageId: row.rfcMessageId as RfcMessageId,
    envelopeRecipient: row.envelopeRecipient as EmailAddress | null,
    threadId: row.threadId as ThreadId,
    direction: row.direction as Message["direction"],
    origin: row.origin as Message["origin"],
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
    trustReasons: row.trustReasons as Message["trustReasons"],
    tag: row.tag,
    autoSubmitted: row.autoSubmitted,
    rawKey: row.rawKey,
    size: row.size,
    seen: row.seen,
    starred: row.starred,
    archivedAt: toDate(row.archivedAt),
    labels,
    sentAt: toDate(row.sentAt),
    receivedAt: toDate(row.receivedAt),
  };
}

/** Every summary column except body/body_key; keeps list memory proportional to page size. */
function summaryProjection() {
  return {
    id: messages.id,
    accountId: messages.accountId,
    inboxId: messages.inboxId,
    identityId: messages.identityId,
    rfcMessageId: messages.rfcMessageId,
    envelopeRecipient: messages.envelopeRecipient,
    threadId: messages.threadId,
    direction: messages.direction,
    origin: messages.origin,
    fromHeader: messages.fromHeader,
    fromAddr: messages.fromAddr,
    toHeader: messages.toHeader,
    toAddrs: messages.toAddrs,
    ccAddrs: messages.ccAddrs,
    bccAddrs: messages.bccAddrs,
    replyTo: messages.replyTo,
    subject: messages.subject,
    inReplyTo: messages.inReplyTo,
    referencesIds: messages.referencesIds,
    spf: messages.spf,
    dkim: messages.dkim,
    dmarc: messages.dmarc,
    trusted: messages.trusted,
    trustReasons: messages.trustReasons,
    tag: messages.tag,
    autoSubmitted: messages.autoSubmitted,
    rawKey: messages.rawKey,
    size: messages.size,
    seen: messages.seen,
    starred: messages.starred,
    archivedAt: messages.archivedAt,
    sentAt: messages.sentAt,
    receivedAt: messages.receivedAt,
  };
}

export function toMessage(
  row: MessageRow,
  byMessage: Map<string, AttachmentMeta[]>,
  labels: readonly string[] = [],
): Message {
  return {
    ...summaryFields(row, labels),
    listId: row.listId,
    unsubscribe: row.listUnsubscribe,
    bodyText: row.bodyText,
    bodyHtml: row.bodyHtml,
    attachments: byMessage.get(row.id) ?? [],
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
