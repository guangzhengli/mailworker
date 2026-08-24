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
