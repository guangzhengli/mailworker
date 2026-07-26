import type {
  Caller,
  DomainEventType,
  Ulid,
  WebhookRepository,
  WebhookSubscription,
} from "@mailworker/core";
import type { Db } from "@web/workers/adapters/d1";
import { toDate, toIsoText } from "@web/workers/adapters/d1";
import type { WebhookRow } from "@web/workers/adapters/schema";
import { webhooks } from "@web/workers/adapters/schema";
import { and, asc, eq } from "drizzle-orm";

export class D1Webhooks implements WebhookRepository {
  constructor(private readonly db: Db) {}

  async insert(ctx: Caller, subscription: WebhookSubscription): Promise<void> {
    await this.db.insert(webhooks).values(toRow(ctx, subscription));
  }

  async update(ctx: Caller, subscription: WebhookSubscription): Promise<void> {
    await this.db
      .update(webhooks)
      .set(toRow(ctx, subscription))
      .where(and(eq(webhooks.accountId, ctx.accountId), eq(webhooks.id, subscription.id)));
  }

  async findById(ctx: Caller, id: Ulid): Promise<WebhookSubscription | null> {
    const [row] = await this.db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.accountId, ctx.accountId), eq(webhooks.id, id)))
      .limit(1);
    return row === undefined ? null : toSubscription(row);
  }

  async list(ctx: Caller): Promise<WebhookSubscription[]> {
    const rows = await this.db
      .select()
      .from(webhooks)
      .where(eq(webhooks.accountId, ctx.accountId))
      .orderBy(asc(webhooks.createdAt));
    return rows.map(toSubscription);
  }

  async deleteById(ctx: Caller, id: Ulid): Promise<void> {
    await this.db
      .delete(webhooks)
      .where(and(eq(webhooks.accountId, ctx.accountId), eq(webhooks.id, id)));
  }
}

/**
 * `accountId` comes from the caller, never from the entity. Same rule as every
 * other adapter here: a row cannot be written into the wrong account even if
 * the object handed in carries a stale one.
 */
function toRow(ctx: Caller, subscription: WebhookSubscription): WebhookRow {
  return {
    id: subscription.id,
    accountId: ctx.accountId,
    url: subscription.url,
    secret: subscription.secret,
    // A JSON column rather than a join table: the list is short, always read
    // whole, and never queried by element. A `webhook_events` table would be
    // three more statements per write to answer a question nobody asks.
    events: [...subscription.events],
    enabled: subscription.enabled,
    createdAt: toIsoText(subscription.createdAt),
  };
}

function toSubscription(row: WebhookRow): WebhookSubscription {
  return {
    id: row.id as Ulid,
    accountId: row.accountId as WebhookSubscription["accountId"],
    url: row.url,
    secret: row.secret,
    events: row.events as DomainEventType[],
    enabled: row.enabled,
    createdAt: toDate(row.createdAt),
  };
}
