import type {
  AccountId,
  Caller,
  Delivery,
  DeliveryEvent,
  DeliveryInsertOptions,
  DeliveryInsertResult,
  DeliveryRepository,
  DeliveryStatus,
  EmailAddress,
  ListDeliveriesQuery,
  Page,
  Ulid,
} from "@mailworker/core";
import type { Db } from "@web/workers/adapters/d1";
import {
  afterCursor,
  errorText,
  pageLimit,
  toDate,
  toIsoText,
  toPage,
} from "@web/workers/adapters/d1";
import { matchingMessageIds } from "@web/workers/adapters/d1-messages";
import type { DeliveryEventRow, DeliveryRow } from "@web/workers/adapters/schema";
import { deliveries, deliveryEvents, dispatchOutbox } from "@web/workers/adapters/schema";
import type { SQL } from "drizzle-orm";
import { and, asc, count, desc, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";

export class D1Deliveries implements DeliveryRepository {
  constructor(private readonly db: Db) {}

  async insert(
    ctx: Caller,
    delivery: Delivery,
    _options: DeliveryInsertOptions = {},
  ): Promise<DeliveryInsertResult> {
    const insertDelivery = this.db.insert(deliveries).values(toRow(ctx, delivery));
    try {
      // 0009 installs a permanent AFTER INSERT trigger that stages every queued
      // row in the same D1 transaction. 0012's BEFORE INSERT trigger reserves
      // identity quota in this statement, so concurrent requests cannot all
      // pass a stale count. `stageDispatch` remains in the port for the in-memory
      // implementation and to state the intended durability at the call site.
      const inserted = await insertDelivery
        .onConflictDoNothing()
        .returning({ id: deliveries.id });
      return inserted.length > 0 ? "inserted" : "duplicate";
    } catch (error) {
      if (errorText(error).includes("mailworker_quota_exceeded")) return "quota_exceeded";
      if (errorText(error).includes("mailworker_exchange_limit")) {
        return "exchange_limit_exceeded";
      }
      throw error;
    }
  }

  async update(ctx: Caller, delivery: Delivery): Promise<void> {
    const { id: _id, accountId: _accountId, ...mutable } = toRow(ctx, delivery);
    await this.db
      .update(deliveries)
      .set(mutable)
      .where(and(eq(deliveries.accountId, ctx.accountId), eq(deliveries.id, delivery.id)));
  }

  async attachMessageId(
    ctx: Caller,
    deliveryId: Ulid,
    messageId: Ulid,
    at: Date,
  ): Promise<void> {
    await this.db
      .update(deliveries)
      .set({ messageId, updatedAt: toIsoText(at) })
      .where(and(eq(deliveries.accountId, ctx.accountId), eq(deliveries.id, deliveryId)));
  }

  async updateIfStatus(
    ctx: Caller,
    delivery: Delivery,
    expected: DeliveryStatus,
  ): Promise<boolean> {
    const { id: _id, accountId: _accountId, ...mutable } = toRow(ctx, delivery);
    const updated = await this.db
      .update(deliveries)
      .set(mutable)
      .where(
        and(
          eq(deliveries.accountId, ctx.accountId),
          eq(deliveries.id, delivery.id),
          eq(deliveries.status, expected),
        ),
      )
      .returning({ id: deliveries.id });
    return updated.length > 0;
  }

  async approveAndStage(ctx: Caller, delivery: Delivery): Promise<boolean> {
    // Migration 0009's AFTER UPDATE trigger inserts the outbox row in the same
    // statement that wins this CAS. There is no pending row to strand and no
    // stage-before-CAS head-of-line blocker.
    return await this.updateIfStatus(ctx, delivery, "pending_approval");
  }

  async findById(ctx: Caller, id: Ulid): Promise<Delivery | null> {
    return this.findOne(and(eq(deliveries.accountId, ctx.accountId), eq(deliveries.id, id)));
  }

  /**
   * The idempotency lookup. A repeat submission resolves to the original record
   * here, before any policy gate runs — re-running the gates on a retry would be
   * wasted work at best, and a second send at worst.
   */
  async findByIdempotencyKey(
    ctx: Caller,
    key: string,
    identityId?: Ulid | null,
  ): Promise<Delivery | null> {
    return this.findOne(
      and(
        eq(deliveries.accountId, ctx.accountId),
        eq(deliveries.idempotencyKey, key),
        identityId === undefined
          ? undefined
          : identityId === null
            ? isNull(deliveries.identityId)
            : eq(deliveries.identityId, identityId),
      ),
    );
  }

  async findByProviderMessageId(ctx: Caller, providerId: string): Promise<Delivery | null> {
    return this.findOne(
      and(eq(deliveries.accountId, ctx.accountId), eq(deliveries.providerMsgId, providerId)),
    );
  }

  async resolveAccount(providerId: string): Promise<AccountId | null> {
    const [row] = await this.db
      .select({ accountId: deliveries.accountId })
      .from(deliveries)
      .where(eq(deliveries.providerMsgId, providerId))
      .limit(1);
    return row === undefined ? null : (row.accountId as AccountId);
  }

  async list(ctx: Caller, query: ListDeliveriesQuery): Promise<Page<Delivery>> {
    const limit = pageLimit(query);
    const rows = await this.db
      .select()
      .from(deliveries)
      .where(
        and(
          eq(deliveries.accountId, ctx.accountId),
          query.status === undefined ? undefined : eq(deliveries.status, query.status),
          query.statusIn === undefined
            ? undefined
            : inArray(deliveries.status, [...query.statusIn]),
          query.identityId === undefined
            ? undefined
            : eq(deliveries.identityId, query.identityId),
          query.source === undefined ? undefined : eq(deliveries.source, query.source),
          query.q === undefined ? undefined : searchFilter(query.q),
          afterCursor(deliveries.id, query),
        ),
      )
      .orderBy(query.order === "asc" ? asc(deliveries.id) : desc(deliveries.id))
      .limit(limit);
    return toPage(rows.map(toDelivery), limit);
  }

  /**
   * What the quota gate counts.
   *
   * Rejected sends are excluded because they never left: metering an agent for
   * messages the policy itself refused would let one misconfiguration exhaust
   * the day's allowance without a single email being delivered.
   *
   * `identityId` of null is a real value here, not "any identity" — an
   * unbound credential has its own bucket.
   */
  async countSince(ctx: Caller, identityId: Ulid | null, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(deliveries)
      .where(
        and(
          eq(deliveries.accountId, ctx.accountId),
          identityId === null
            ? isNull(deliveries.identityId)
            : eq(deliveries.identityId, identityId),
          gte(deliveries.createdAt, toIsoText(since)),
          ne(deliveries.status, "rejected"),
        ),
      );
    return row?.value ?? 0;
  }

  async stageDispatch(ctx: Caller, deliveryId: Ulid, now: Date): Promise<boolean> {
    const inserted = await this.db
      .insert(dispatchOutbox)
      .values({ accountId: ctx.accountId, deliveryId, createdAt: toIsoText(now)! })
      .onConflictDoNothing()
      .returning({ deliveryId: dispatchOutbox.deliveryId });
    return inserted.length > 0;
  }

  async listStagedDispatches(
    ctx: Caller,
    limit: number,
  ): Promise<Array<{ deliveryId: Ulid; createdAt: Date }>> {
    const rows = await this.db
      .select()
      .from(dispatchOutbox)
      .where(eq(dispatchOutbox.accountId, ctx.accountId))
      .orderBy(asc(dispatchOutbox.createdAt))
      .limit(limit);
    return rows.map((row) => ({
      deliveryId: row.deliveryId as Ulid,
      createdAt: toDate(row.createdAt)!,
    }));
  }

  async unstageDispatch(ctx: Caller, deliveryId: Ulid): Promise<void> {
    await this.db
      .delete(dispatchOutbox)
      .where(
        and(
          eq(dispatchOutbox.accountId, ctx.accountId),
          eq(dispatchOutbox.deliveryId, deliveryId),
        ),
      );
  }

  async appendDeliveryEvent(ctx: Caller, event: DeliveryEvent): Promise<boolean> {
    const inserted = await this.db
      .insert(deliveryEvents)
      .values({
        id: event.id,
        accountId: ctx.accountId,
        eventId: event.eventId,
        deliveryId: event.deliveryId,
        providerMsgId: event.providerMessageId,
        recipient: event.recipient,
        sourceDomain: event.sourceDomain,
        sourceZoneId: event.sourceZoneId,
        type: event.type,
        terminal: event.terminal,
        smtpCode: event.smtpCode,
        smtpEnhancedCode: event.smtpEnhancedCode,
        smtpResponse: event.smtpResponse,
        bounceType: event.bounceType,
        bounceClassification: event.bounceClassification,
        bounceReason: event.bounceReason,
        occurredAt: toIsoText(event.occurredAt),
        processingAt: null,
        processedAt: null,
        raw: event.raw,
      })
      .onConflictDoNothing()
      .returning({ id: deliveryEvents.id });
    return inserted.length > 0;
  }

  async claimDeliveryEvent(
    ctx: Caller,
    eventId: string,
    now: Date,
    staleBefore: Date,
  ): Promise<"claimed" | "processed" | "busy"> {
    const claimed = await this.db
      .update(deliveryEvents)
      .set({ processingAt: toIsoText(now) })
      .where(
        and(
          eq(deliveryEvents.accountId, ctx.accountId),
          eq(deliveryEvents.eventId, eventId),
          or(
            isNull(deliveryEvents.processingAt),
            sql`${deliveryEvents.processingAt} < ${toIsoText(staleBefore)}`,
          ),
          isNull(deliveryEvents.processedAt),
        ),
      )
      .returning({ id: deliveryEvents.id });
    if (claimed.length > 0) return "claimed";

    // An UPDATE miss has two very different meanings to an at-least-once
    // consumer. A completed event is a harmless duplicate; an unprocessed row
    // still under lease must be retried, because its owner may have crashed.
    // Treat a missing scoped row as busy too: acknowledging it would hide a
    // routing or global-id collision rather than repair one.
    const [state] = await this.db
      .select({ processedAt: deliveryEvents.processedAt })
      .from(deliveryEvents)
      .where(
        and(eq(deliveryEvents.accountId, ctx.accountId), eq(deliveryEvents.eventId, eventId)),
      )
      .limit(1);
    return state?.processedAt != null ? "processed" : "busy";
  }

  async completeDeliveryEvent(ctx: Caller, eventId: string, at: Date): Promise<void> {
    await this.db
      .update(deliveryEvents)
      .set({ processedAt: toIsoText(at), processingAt: null })
      .where(
        and(eq(deliveryEvents.accountId, ctx.accountId), eq(deliveryEvents.eventId, eventId)),
      );
  }

  async releaseDeliveryEvent(ctx: Caller, eventId: string): Promise<void> {
    await this.db
      .update(deliveryEvents)
      .set({ processingAt: null })
      .where(
        and(
          eq(deliveryEvents.accountId, ctx.accountId),
          eq(deliveryEvents.eventId, eventId),
          isNull(deliveryEvents.processedAt),
        ),
      );
  }

  async listDeliveryEvents(ctx: Caller, deliveryId: Ulid): Promise<DeliveryEvent[]> {
    const rows = await this.db
      .select()
      .from(deliveryEvents)
      .where(
        and(
          eq(deliveryEvents.accountId, ctx.accountId),
          eq(deliveryEvents.deliveryId, deliveryId),
        ),
      )
      .orderBy(asc(deliveryEvents.occurredAt));
    return rows.map(toDeliveryEvent);
  }

  private async findOne(where: ReturnType<typeof and>): Promise<Delivery | null> {
    const [row] = await this.db.select().from(deliveries).where(where).limit(1);
    return row === undefined ? null : toDelivery(row);
  }
}

/**
 * What the search box on the sent list matches: the archived copy's indexed
 * text, or the recipients on the delivery row itself.
 *
 * `instr` on the JSON array rather than `LIKE '%q%'`, so a `%` or `_` in an
 * address is a character and not a wildcard, and no escape clause is needed.
 * Both sides are lowered because the column holds addresses exactly as they
 * were given and nobody types a search with the original casing in mind.
 */
function searchFilter(q: string): SQL | undefined {
  const matching = matchingMessageIds(q);
  const recipients = sql`instr(lower(${deliveries.recipients}), lower(${q})) > 0`;
  if (matching === null) return recipients;
  return or(sql`${deliveries.messageId} IN ${matching}`, recipients);
}

function toRow(ctx: Caller, delivery: Delivery): typeof deliveries.$inferInsert {
  return {
    id: delivery.id,
    accountId: ctx.accountId,
    inboxId: delivery.inboxId,
    identityId: delivery.identityId,
    messageId: delivery.messageId,
    idempotencyKey: delivery.idempotencyKey,
    // Null rather than `{}` for the empty case, so a row that never had metadata
    // is distinguishable from one whose metadata was cleared, and so the column
    // costs nothing on the overwhelming majority of sends that have none.
    metadata: Object.keys(delivery.metadata).length === 0 ? null : { ...delivery.metadata },
    source: delivery.source,
    status: delivery.status,
    attempts: delivery.attempts,
    recipients: [...delivery.recipients],
    payloadKey: delivery.payloadKey,
    providerMsgId: delivery.providerMessageId,
    rejectReason: delivery.rejectReason,
    lastError: delivery.lastError,
    approvedBy: delivery.approvedBy,
    approvedAt: toIsoText(delivery.approvedAt),
    createdAt: toIsoText(delivery.createdAt),
    updatedAt: toIsoText(delivery.updatedAt),
    statusChangedAt: toIsoText(delivery.statusChangedAt),
  };
}

export function toDelivery(row: DeliveryRow): Delivery {
  return {
    id: row.id as Ulid,
    accountId: row.accountId as Delivery["accountId"],
    inboxId: row.inboxId as Ulid | null,
    identityId: row.identityId as Ulid | null,
    messageId: row.messageId as Ulid | null,
    idempotencyKey: row.idempotencyKey,
    metadata: row.metadata ?? {},
    source: row.source as Delivery["source"],
    status: row.status as Delivery["status"],
    attempts: row.attempts,
    recipients: row.recipients as EmailAddress[],
    payloadKey: row.payloadKey,
    providerMessageId: row.providerMsgId,
    rejectReason: row.rejectReason,
    lastError: row.lastError,
    approvedBy: row.approvedBy,
    approvedAt: toDate(row.approvedAt),
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
    statusChangedAt: toDate(row.statusChangedAt),
  };
}

export function toDeliveryEvent(row: DeliveryEventRow): DeliveryEvent {
  return {
    id: row.id as Ulid,
    eventId: row.eventId,
    deliveryId: row.deliveryId as Ulid | null,
    providerMessageId: row.providerMsgId,
    recipient: row.recipient as EmailAddress | null,
    sourceDomain: row.sourceDomain,
    sourceZoneId: row.sourceZoneId,
    type: row.type,
    terminal: row.terminal,
    smtpCode: row.smtpCode,
    smtpEnhancedCode: row.smtpEnhancedCode,
    smtpResponse: row.smtpResponse,
    bounceType: row.bounceType as DeliveryEvent["bounceType"],
    bounceClassification: row.bounceClassification,
    bounceReason: row.bounceReason,
    occurredAt: toDate(row.occurredAt),
    raw: row.raw,
  };
}
