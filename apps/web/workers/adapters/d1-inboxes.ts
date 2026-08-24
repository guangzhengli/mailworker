import type {
  Caller,
  EmailAddress,
  Inbox,
  InboxRepository,
  ListInboxesQuery,
  Page,
  Ulid,
} from "@mailworker/core";
import type { Db } from "@web/workers/adapters/d1";
import { afterCursor, pageLimit, toDate, toIsoText, toPage } from "@web/workers/adapters/d1";
import type { InboxRow } from "@web/workers/adapters/schema";
import { inboxes } from "@web/workers/adapters/schema";
import { and, asc, desc, eq, gt, isNotNull, isNull, lte, or } from "drizzle-orm";

export class D1Inboxes implements InboxRepository {
  constructor(private readonly db: Db) {}

  async findById(ctx: Caller, id: Ulid): Promise<Inbox | null> {
    const [row] = await this.db
      .select()
      .from(inboxes)
      .where(and(eq(inboxes.accountId, ctx.accountId), eq(inboxes.id, id)))
      .limit(1);
    return row === undefined ? null : toInbox(row);
  }

  /**
   * Looked up by the tag-stripped `matchKey`, which the caller has already
   * derived. `agent-7+run42@x` and `agent-7@x` are one inbox, and pushing that
   * into `MailboxAddress` is what keeps this a single indexed equality rather
   * than a pattern match.
   */
  async findByAddress(ctx: Caller, address: EmailAddress): Promise<Inbox | null> {
    const [row] = await this.db
      .select()
      .from(inboxes)
      .where(
        and(
          eq(inboxes.accountId, ctx.accountId),
          eq(inboxes.address, address),
          isNull(inboxes.deletedAt),
        ),
      )
      .limit(1);
    return row === undefined ? null : toInbox(row);
  }

  /**
   * Insert, letting `uq_inboxes_account_address` decide whether this caller was
   * the one that created it.
   *
   * `ON CONFLICT DO NOTHING ... RETURNING id` collapses "is it already there"
   * and "put it there" into one statement, the same way `D1Messages.insert`
   * does. A read-then-write races itself here just as it does there: two
   * concurrent creates of one address both find the table empty, both insert,
   * and the loser surfaces a raw constraint violation as a 500 instead of the
   * `address_taken` the caller can act on.
   */
  async insert(ctx: Caller, inbox: Inbox): Promise<{ stored: boolean }> {
    const inserted = await this.db
      .insert(inboxes)
      .values(toRow(ctx, inbox))
      .onConflictDoNothing()
      .returning({ id: inboxes.id });

    return { stored: inserted.length > 0 };
  }

  async update(ctx: Caller, inbox: Inbox): Promise<void> {
    const { id: _id, accountId: _accountId, ...mutable } = toRow(ctx, inbox);
    await this.db
      .update(inboxes)
      .set(mutable)
      .where(and(eq(inboxes.accountId, ctx.accountId), eq(inboxes.id, inbox.id)));
  }

  async list(ctx: Caller, query: ListInboxesQuery): Promise<Page<Inbox>> {
    const limit = pageLimit(query);
    const rows = await this.db
      .select()
      .from(inboxes)
      .where(
        and(
          eq(inboxes.accountId, ctx.accountId),
          isNull(inboxes.deletedAt),
          query.kind === undefined ? undefined : eq(inboxes.kind, query.kind),
          query.domain === undefined ? undefined : eq(inboxes.domain, query.domain),
          query.identityId === undefined ? undefined : eq(inboxes.identityId, query.identityId),
          // The comparison is on ISO text, which sorts chronologically — and the
          // instant comes from the caller, because a repository that read the
          // clock would make "list what was live at 09:00" impossible to ask.
          query.activeAt === undefined
            ? undefined
            : or(isNull(inboxes.expiresAt), gt(inboxes.expiresAt, toIsoText(query.activeAt))),
          afterCursor(inboxes.id, query),
        ),
      )
      .orderBy(query.order === "asc" ? asc(inboxes.id) : desc(inboxes.id))
      .limit(limit);
    return toPage(rows.map(toInbox), limit);
  }

  /** Oldest expiry first — the retention sweep works through the backlog in order. */
  async findExpired(ctx: Caller, expiredBefore: Date, limit: number): Promise<Inbox[]> {
    const rows = await this.db
      .select()
      .from(inboxes)
      .where(
        and(
          eq(inboxes.accountId, ctx.accountId),
          isNotNull(inboxes.expiresAt),
          lte(inboxes.expiresAt, toIsoText(expiredBefore)),
        ),
      )
      .orderBy(asc(inboxes.expiresAt))
      .limit(limit);
    return rows.map(toInbox);
  }

  async deleteById(ctx: Caller, id: Ulid): Promise<void> {
    await this.db
      .delete(inboxes)
      .where(and(eq(inboxes.accountId, ctx.accountId), eq(inboxes.id, id)));
  }
}

function toRow(ctx: Caller, inbox: Inbox): typeof inboxes.$inferInsert {
  return {
    id: inbox.id,
    // From the request-scoped context, never from the aggregate. An entity that
    // arrived carrying someone else's accountId must not be able to write there.
    accountId: ctx.accountId,
    address: inbox.address,
    localPart: inbox.localPart,
    domain: inbox.domain,
    displayName: inbox.displayName,
    kind: inbox.kind,
    identityId: inbox.identityId,
    metadata: inbox.metadata === null ? null : { ...inbox.metadata },
    expiresAt: toIsoText(inbox.expiresAt),
    deletedAt: toIsoText(inbox.deletedAt),
    createdAt: toIsoText(inbox.createdAt),
  };
}

export function toInbox(row: InboxRow): Inbox {
  return {
    id: row.id as Ulid,
    accountId: row.accountId as Inbox["accountId"],
    address: row.address as EmailAddress,
    localPart: row.localPart,
    domain: row.domain,
    displayName: row.displayName,
    kind: row.kind as Inbox["kind"],
    identityId: row.identityId as Ulid | null,
    metadata: row.metadata,
    expiresAt: toDate(row.expiresAt),
    deletedAt: toDate(row.deletedAt),
    createdAt: toDate(row.createdAt),
  };
}
