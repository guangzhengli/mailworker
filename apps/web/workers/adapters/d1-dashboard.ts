import { type Caller, Caller as CallerRules, type Ulid } from "@mailworker/core";
import type { Db } from "@web/workers/adapters/d1";
import { toDate, toIsoText } from "@web/workers/adapters/d1";
import {
  agentIdentities,
  apiKeys,
  deliveries,
  deliveryEvents,
  domains,
  inboxes,
  messages,
} from "@web/workers/adapters/schema";
import { and, asc, desc, eq, gt, isNotNull, isNull, max, or, sql } from "drizzle-orm";

/** Counts that describe one environment at a point in time. */
export interface DashboardSummary {
  readonly pendingApproval: number;
  /** Deliveries released into the outbound pipeline during the selected window. */
  readonly outbound: number;
  readonly delivered: number;
  readonly problems: number;
  readonly inbound: number;
  readonly activeInboxes: number;
  readonly totalDeliveries: number;
  readonly totalMessages: number;
}

export interface MailCounts {
  readonly inboxUnread: number;
  readonly unreadByInbox: Readonly<Record<string, number>>;
  readonly activeEphemeralInboxes: number;
  readonly mutedPersistentInboxes: number;
  readonly pendingApproval: number;
  readonly problems: number;
}

/** The minimum pieces an operator needs before an environment can do useful work. */
export interface DashboardReadiness {
  readonly domains: number;
  readonly activeInboxes: number;
  readonly agents: number;
  readonly activeKeys: number;
}

export interface DashboardAgentPulse {
  readonly id: Ulid;
  readonly name: string;
  readonly requireApproval: boolean;
  readonly dailySendQuota: number | null;
  /** Mirrors the quota gate: every send except a rejected one consumes the window. */
  readonly quotaUsed: number;
  readonly pendingApproval: number;
  readonly problems: number;
  readonly lastActivityAt: Date | null;
}

/**
 * The dashboard's read model.
 *
 * This deliberately lives beside the D1 adapters rather than in a domain
 * service. These are cross-aggregate projections for a human control plane,
 * not business decisions. Keeping the SQL here also prevents the old failure
 * mode where a route fetched a page of five or fifty entities and mistook the
 * page length for a total.
 */
export class D1DashboardQueries {
  constructor(private readonly db: Db) {}

  async summary(ctx: Caller, since: Date, now: Date): Promise<DashboardSummary> {
    CallerRules.require(ctx, "message:read");
    CallerRules.require(ctx, "inbox:read");

    const sinceText = toIsoText(since);
    const nowText = toIsoText(now);
    const identityId = CallerRules.has(ctx, "admin") ? null : ctx.identityId;
    const deliveryVisibility =
      identityId === null
        ? eq(deliveries.accountId, ctx.accountId)
        : and(eq(deliveries.accountId, ctx.accountId), eq(deliveries.identityId, identityId));
    const messageVisibility =
      identityId === null
        ? eq(messages.accountId, ctx.accountId)
        : and(eq(messages.accountId, ctx.accountId), eq(messages.identityId, identityId));
    const inboxVisibility =
      identityId === null
        ? eq(inboxes.accountId, ctx.accountId)
        : and(eq(inboxes.accountId, ctx.accountId), eq(inboxes.identityId, identityId));

    const [deliveryRows, deliveredRows, messageRows, inboxRows] = await Promise.all([
      this.db
        .select({
          pendingApproval: sql<number>`coalesce(sum(case when ${deliveries.status} = 'pending_approval' then 1 else 0 end), 0)`,
          outbound: sql<number>`coalesce(sum(case when ${deliveries.createdAt} >= ${sinceText} and ${deliveries.status} not in ('draft', 'pending_approval', 'rejected') then 1 else 0 end), 0)`,
          problems: sql<number>`coalesce(sum(case when ${deliveries.status} in ('bounced', 'failed', 'rejected', 'complained') and ${deliveries.statusChangedAt} >= ${sinceText} then 1 else 0 end), 0)`,
          total: sql<number>`count(*)`,
        })
        .from(deliveries)
        .where(deliveryVisibility),
      this.db
        .select({
          value: sql<number>`count(distinct ${deliveryEvents.deliveryId})`,
        })
        .from(deliveryEvents)
        .innerJoin(
          deliveries,
          and(
            eq(deliveries.accountId, deliveryEvents.accountId),
            eq(deliveries.id, deliveryEvents.deliveryId),
          ),
        )
        .where(
          and(
            eq(deliveryEvents.accountId, ctx.accountId),
            eq(deliveryEvents.type, "delivered"),
            sql`${deliveryEvents.occurredAt} >= ${sinceText}`,
            identityId === null ? undefined : eq(deliveries.identityId, identityId),
          ),
        ),
      this.db
        .select({
          inbound: sql<number>`coalesce(sum(case when ${messages.direction} = 'inbound' and ${messages.receivedAt} >= ${sinceText} then 1 else 0 end), 0)`,
          total: sql<number>`count(*)`,
        })
        .from(messages)
        .where(messageVisibility),
      this.db
        .select({ value: sql<number>`count(*)` })
        .from(inboxes)
        .where(
          and(
            inboxVisibility,
            isNull(inboxes.deletedAt),
            or(isNull(inboxes.expiresAt), gt(inboxes.expiresAt, nowText)),
          ),
        ),
    ]);

    const delivery = deliveryRows[0];
    const message = messageRows[0];
    return {
      pendingApproval: Number(delivery?.pendingApproval ?? 0),
      outbound: Number(delivery?.outbound ?? 0),
      delivered: Number(deliveredRows[0]?.value ?? 0),
      problems: Number(delivery?.problems ?? 0),
      inbound: Number(message?.inbound ?? 0),
      activeInboxes: Number(inboxRows[0]?.value ?? 0),
      totalDeliveries: Number(delivery?.total ?? 0),
      totalMessages: Number(message?.total ?? 0),
    };
  }

  async mailCounts(
    ctx: Caller,
    now: Date,
    problemStatuses: readonly string[],
  ): Promise<MailCounts> {
    CallerRules.require(ctx, "message:read");
    CallerRules.require(ctx, "inbox:read");
    const identityId = CallerRules.has(ctx, "admin") ? null : ctx.identityId;

    const [unread, addresses, delivery] = await Promise.all([
      this.db
        .select({
          id: inboxes.id,
          muted: inboxes.muted,
          count: sql<number>`count(*)`,
        })
        .from(messages)
        .innerJoin(
          inboxes,
          and(eq(inboxes.accountId, messages.accountId), eq(inboxes.id, messages.inboxId)),
        )
        .where(
          and(
            eq(messages.accountId, ctx.accountId),
            eq(messages.direction, "inbound"),
            eq(messages.seen, false),
            isNull(messages.archivedAt),
            isNull(inboxes.deletedAt),
            identityId === null
              ? undefined
              : and(eq(messages.identityId, identityId), eq(inboxes.identityId, identityId)),
          ),
        )
        .groupBy(inboxes.id, inboxes.muted),
      this.db
        .select({
          ephemeral: sql<number>`count(*) FILTER (WHERE ${inboxes.kind} = 'ephemeral')`,
          mutedPersistent: sql<number>`count(*) FILTER (WHERE ${inboxes.kind} = 'persistent' AND ${inboxes.muted} = 1)`,
        })
        .from(inboxes)
        .where(
          and(
            eq(inboxes.accountId, ctx.accountId),
            isNull(inboxes.deletedAt),
            or(isNull(inboxes.expiresAt), gt(inboxes.expiresAt, toIsoText(now))),
            identityId === null ? undefined : eq(inboxes.identityId, identityId),
          ),
        ),
      this.db
        .select({
          pendingApproval: sql<number>`count(*) FILTER (WHERE ${deliveries.status} = 'pending_approval')`,
          problems: sql<number>`count(*) FILTER (WHERE ${deliveries.status} IN (SELECT value FROM json_each(${JSON.stringify(problemStatuses)})))`,
        })
        .from(deliveries)
        .where(
          and(
            eq(deliveries.accountId, ctx.accountId),
            identityId === null ? undefined : eq(deliveries.identityId, identityId),
          ),
        ),
    ]);

    return {
      inboxUnread: unread.reduce((total, inbox) => total + (inbox.muted ? 0 : inbox.count), 0),
      unreadByInbox: Object.fromEntries(unread.map(({ id, count }) => [id, count])),
      activeEphemeralInboxes: addresses[0]?.ephemeral ?? 0,
      mutedPersistentInboxes: addresses[0]?.mutedPersistent ?? 0,
      pendingApproval: delivery[0]?.pendingApproval ?? 0,
      problems: delivery[0]?.problems ?? 0,
    };
  }

  async deliveriesForMessages(
    ctx: Caller,
    messageIds: readonly Ulid[],
  ): Promise<ReadonlyMap<string, { readonly id: Ulid; readonly status: string }>> {
    CallerRules.require(ctx, "message:read");
    const result = new Map<string, { id: Ulid; status: string }>();
    if (messageIds.length === 0) return result;
    const identityId = CallerRules.has(ctx, "admin") ? null : ctx.identityId;
    const rows = await this.db
      .select({ messageId: messages.id, id: deliveries.id, status: deliveries.status })
      .from(deliveries)
      .innerJoin(
        messages,
        and(
          eq(messages.accountId, deliveries.accountId),
          eq(messages.id, deliveries.messageId),
        ),
      )
      .where(
        and(
          eq(deliveries.accountId, ctx.accountId),
          eq(messages.direction, "outbound"),
          sql`${deliveries.messageId} IN (SELECT value FROM json_each(${JSON.stringify(messageIds)}))`,
          identityId === null
            ? undefined
            : and(eq(deliveries.identityId, identityId), eq(messages.identityId, identityId)),
        ),
      )
      .orderBy(desc(deliveries.id));
    for (const row of rows) {
      if (!result.has(row.messageId))
        result.set(row.messageId, { id: row.id as Ulid, status: row.status });
    }
    return result;
  }

  async readiness(ctx: Caller, now: Date): Promise<DashboardReadiness> {
    CallerRules.require(ctx, "admin");
    const nowText = toIsoText(now);

    const [domainRows, inboxRows, agentRows, keyRows] = await Promise.all([
      this.db
        .select({ value: sql<number>`count(*)` })
        .from(domains)
        .where(eq(domains.accountId, ctx.accountId)),
      this.db
        .select({ value: sql<number>`count(*)` })
        .from(inboxes)
        .where(
          and(
            eq(inboxes.accountId, ctx.accountId),
            isNull(inboxes.deletedAt),
            or(isNull(inboxes.expiresAt), gt(inboxes.expiresAt, nowText)),
          ),
        ),
      this.db
        .select({ value: sql<number>`count(*)` })
        .from(agentIdentities)
        .where(
          and(eq(agentIdentities.accountId, ctx.accountId), eq(agentIdentities.managed, false)),
        ),
      this.db
        .select({ value: sql<number>`count(*)` })
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.accountId, ctx.accountId),
            isNotNull(apiKeys.identityId),
            isNull(apiKeys.revokedAt),
            or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, nowText)),
          ),
        ),
    ]);

    return {
      domains: Number(domainRows[0]?.value ?? 0),
      activeInboxes: Number(inboxRows[0]?.value ?? 0),
      agents: Number(agentRows[0]?.value ?? 0),
      activeKeys: Number(keyRows[0]?.value ?? 0),
    };
  }

  async agentPulse(ctx: Caller, since: Date, limit = 5): Promise<DashboardAgentPulse[]> {
    CallerRules.require(ctx, "admin");
    const sinceText = toIsoText(since);
    const lastActivity = max(deliveries.updatedAt);

    const rows = await this.db
      .select({
        id: agentIdentities.id,
        name: agentIdentities.name,
        requireApproval: agentIdentities.requireApproval,
        dailySendQuota: agentIdentities.dailySendQuota,
        quotaUsed: sql<number>`coalesce(sum(case when ${deliveries.createdAt} >= ${sinceText} and ${deliveries.status} <> 'rejected' then 1 else 0 end), 0)`,
        pendingApproval: sql<number>`coalesce(sum(case when ${deliveries.status} = 'pending_approval' then 1 else 0 end), 0)`,
        problems: sql<number>`coalesce(sum(case when ${deliveries.status} in ('bounced', 'failed', 'rejected', 'complained') and ${deliveries.statusChangedAt} >= ${sinceText} then 1 else 0 end), 0)`,
        lastActivityAt: lastActivity,
      })
      .from(agentIdentities)
      .leftJoin(
        deliveries,
        and(
          eq(deliveries.accountId, agentIdentities.accountId),
          eq(deliveries.identityId, agentIdentities.id),
        ),
      )
      .where(
        and(eq(agentIdentities.accountId, ctx.accountId), eq(agentIdentities.managed, false)),
      )
      .groupBy(
        agentIdentities.id,
        agentIdentities.name,
        agentIdentities.requireApproval,
        agentIdentities.dailySendQuota,
      )
      .orderBy(desc(lastActivity), asc(agentIdentities.name))
      .limit(Math.max(1, Math.min(limit, 20)));

    return rows.map((row) => ({
      id: row.id as Ulid,
      name: row.name,
      requireApproval: row.requireApproval,
      dailySendQuota: row.dailySendQuota,
      quotaUsed: Number(row.quotaUsed),
      pendingApproval: Number(row.pendingApproval),
      problems: Number(row.problems),
      lastActivityAt: row.lastActivityAt === null ? null : toDate(row.lastActivityAt),
    }));
  }
}
