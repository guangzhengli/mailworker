import type {
  AccountId,
  Caller,
  Delivery,
  DeliveryEvent,
  DeliveryRepository,
  EmailAddress,
  ListDeliveriesQuery,
  Page,
  Ulid,
} from "@mailworker/core";
import type { Db } from "@web/workers/adapters/d1";
import { afterCursor, pageLimit, toDate, toIsoText, toPage } from "@web/workers/adapters/d1";
import type { DeliveryEventRow, DeliveryRow } from "@web/workers/adapters/schema";
import { deliveries, deliveryEvents } from "@web/workers/adapters/schema";
import { and, asc, count, desc, eq, gte, inArray, isNull, ne } from "drizzle-orm";

export class D1Deliveries implements DeliveryRepository {
  constructor(private readonly db: Db) {}

  async insert(ctx: Caller, delivery: Delivery): Promise<void> {
    await this.db.insert(deliveries).values(toRow(ctx, delivery));
  }

  async update(ctx: Caller, delivery: Delivery): Promise<void> {
    const { id: _id, accountId: _accountId, ...mutable } = toRow(ctx, delivery);
    await this.db
      .update(deliveries)
      .set(mutable)
      .where(and(eq(deliveries.accountId, ctx.accountId), eq(deliveries.id, delivery.id)));
  }

  async findById(ctx: Caller, id: Ulid): Promise<Delivery | null> {
    return this.findOne(and(eq(deliveries.accountId, ctx.accountId), eq(deliveries.id, id)));
  }

  /**
   * The idempotency lookup. A repeat submission resolves to the original record
   * here, before any policy gate runs — re-running the gates on a retry would be
   * wasted work at best, and a second send at worst.
   */
  async findByIdempotencyKey(ctx: Caller, key: string): Promise<Delivery | null> {
    return this.findOne(
      and(eq(deliveries.accountId, ctx.accountId), eq(deliveries.idempotencyKey, key)),
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

  async appendDeliveryEvent(ctx: Caller, event: DeliveryEvent): Promise<void> {
    await this.db.insert(deliveryEvents).values({
      id: event.id,
      accountId: ctx.accountId,
      deliveryId: event.deliveryId,
      providerMsgId: event.providerMessageId,
      recipient: event.recipient,
      type: event.type,
      terminal: event.terminal,
      smtpCode: event.smtpCode,
      smtpResponse: event.smtpResponse,
      occurredAt: toIsoText(event.occurredAt),
      raw: event.raw,
    });
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
    deliveryId: row.deliveryId as Ulid | null,
    providerMessageId: row.providerMsgId,
    recipient: row.recipient as EmailAddress | null,
    type: row.type,
    terminal: row.terminal,
    smtpCode: row.smtpCode,
    smtpResponse: row.smtpResponse,
    occurredAt: toDate(row.occurredAt),
    raw: row.raw,
  };
}
