import type {
  AuthContext,
  EmailAddress,
  ListOutboundQuery,
  OutboundMessage,
  OutboundRepositoryPort,
  Page,
  StoredDeliveryEvent,
  Ulid,
} from "@mailworker/core";
import type { Db } from "@web/workers/infrastructure/d1";
import {
  afterCursor,
  pageLimit,
  toDate,
  toIsoText,
  toPage,
} from "@web/workers/infrastructure/d1";
import type { DeliveryEventRow, OutboundRow } from "@web/workers/infrastructure/schema";
import { deliveryEvents, outboundMessages } from "@web/workers/infrastructure/schema";
import { and, asc, count, desc, eq, gte, isNull, ne } from "drizzle-orm";

export class D1Outbound implements OutboundRepositoryPort {
  constructor(private readonly db: Db) {}

  async insert(ctx: AuthContext, outbound: OutboundMessage): Promise<void> {
    await this.db.insert(outboundMessages).values(toRow(ctx, outbound));
  }

  async update(ctx: AuthContext, outbound: OutboundMessage): Promise<void> {
    const { id: _id, accountId: _accountId, ...mutable } = toRow(ctx, outbound);
    await this.db
      .update(outboundMessages)
      .set(mutable)
      .where(
        and(
          eq(outboundMessages.accountId, ctx.accountId),
          eq(outboundMessages.id, outbound.id),
        ),
      );
  }

  async findById(ctx: AuthContext, id: Ulid): Promise<OutboundMessage | null> {
    return this.findOne(
      and(eq(outboundMessages.accountId, ctx.accountId), eq(outboundMessages.id, id)),
    );
  }

  /**
   * The idempotency lookup. A repeat submission resolves to the original record
   * here, before any policy gate runs — re-running the gates on a retry would be
   * wasted work at best, and a second send at worst.
   */
  async findByIdempotencyKey(ctx: AuthContext, key: string): Promise<OutboundMessage | null> {
    return this.findOne(
      and(
        eq(outboundMessages.accountId, ctx.accountId),
        eq(outboundMessages.idempotencyKey, key),
      ),
    );
  }

  async findByProviderMessageId(
    ctx: AuthContext,
    providerId: string,
  ): Promise<OutboundMessage | null> {
    return this.findOne(
      and(
        eq(outboundMessages.accountId, ctx.accountId),
        eq(outboundMessages.providerMsgId, providerId),
      ),
    );
  }

  async list(ctx: AuthContext, query: ListOutboundQuery): Promise<Page<OutboundMessage>> {
    const limit = pageLimit(query);
    const rows = await this.db
      .select()
      .from(outboundMessages)
      .where(
        and(
          eq(outboundMessages.accountId, ctx.accountId),
          query.status === undefined ? undefined : eq(outboundMessages.status, query.status),
          query.identityId === undefined
            ? undefined
            : eq(outboundMessages.identityId, query.identityId),
          afterCursor(outboundMessages.id, query),
        ),
      )
      .orderBy(query.order === "asc" ? asc(outboundMessages.id) : desc(outboundMessages.id))
      .limit(limit);
    return toPage(rows.map(toOutbound), limit);
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
  async countSince(ctx: AuthContext, identityId: Ulid | null, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(outboundMessages)
      .where(
        and(
          eq(outboundMessages.accountId, ctx.accountId),
          identityId === null
            ? isNull(outboundMessages.identityId)
            : eq(outboundMessages.identityId, identityId),
          gte(outboundMessages.createdAt, toIsoText(since)),
          ne(outboundMessages.status, "rejected"),
        ),
      );
    return row?.value ?? 0;
  }

  async appendDeliveryEvent(ctx: AuthContext, event: StoredDeliveryEvent): Promise<void> {
    await this.db.insert(deliveryEvents).values({
      id: event.id,
      accountId: ctx.accountId,
      outboundId: event.outboundId,
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

  async listDeliveryEvents(ctx: AuthContext, outboundId: Ulid): Promise<StoredDeliveryEvent[]> {
    const rows = await this.db
      .select()
      .from(deliveryEvents)
      .where(
        and(
          eq(deliveryEvents.accountId, ctx.accountId),
          eq(deliveryEvents.outboundId, outboundId),
        ),
      )
      .orderBy(asc(deliveryEvents.occurredAt));
    return rows.map(toDeliveryEvent);
  }

  private async findOne(where: ReturnType<typeof and>): Promise<OutboundMessage | null> {
    const [row] = await this.db.select().from(outboundMessages).where(where).limit(1);
    return row === undefined ? null : toOutbound(row);
  }
}

function toRow(
  ctx: AuthContext,
  outbound: OutboundMessage,
): typeof outboundMessages.$inferInsert {
  return {
    id: outbound.id,
    accountId: ctx.accountId,
    inboxId: outbound.inboxId,
    identityId: outbound.identityId,
    messageId: outbound.messageId,
    idempotencyKey: outbound.idempotencyKey,
    status: outbound.status,
    attempts: outbound.attempts,
    recipients: [...outbound.recipients],
    payloadKey: outbound.payloadKey,
    providerMsgId: outbound.providerMessageId,
    rejectReason: outbound.rejectReason,
    lastError: outbound.lastError,
    approvedBy: outbound.approvedBy,
    approvedAt: toIsoText(outbound.approvedAt),
    createdAt: toIsoText(outbound.createdAt),
    updatedAt: toIsoText(outbound.updatedAt),
    statusChangedAt: toIsoText(outbound.statusChangedAt),
  };
}

export function toOutbound(row: OutboundRow): OutboundMessage {
  return {
    id: row.id as Ulid,
    accountId: row.accountId as OutboundMessage["accountId"],
    inboxId: row.inboxId as Ulid | null,
    identityId: row.identityId as Ulid | null,
    messageId: row.messageId as Ulid | null,
    idempotencyKey: row.idempotencyKey,
    status: row.status as OutboundMessage["status"],
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

export function toDeliveryEvent(row: DeliveryEventRow): StoredDeliveryEvent {
  return {
    id: row.id as Ulid,
    outboundId: row.outboundId as Ulid | null,
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
