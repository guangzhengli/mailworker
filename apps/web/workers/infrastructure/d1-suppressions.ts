import type {
  AuthContext,
  EmailAddress,
  SuppressionEntry,
  SuppressionListPort,
} from "@mailworker/core";
import type { Db } from "@web/workers/infrastructure/d1";
import { toDate, toIsoText } from "@web/workers/infrastructure/d1";
import type { SuppressionRow } from "@web/workers/infrastructure/schema";
import { suppressions } from "@web/workers/infrastructure/schema";
import { and, asc, eq, inArray } from "drizzle-orm";

export class D1Suppressions implements SuppressionListPort {
  constructor(private readonly db: Db) {}

  /**
   * Batched, because `SendPolicy` needs the verdict for every recipient at once
   * and a message may carry fifty. One query beats fifty on the path that stands
   * between an agent and an irreversible action.
   */
  async filterSuppressed(
    ctx: AuthContext,
    addresses: readonly EmailAddress[],
  ): Promise<EmailAddress[]> {
    if (addresses.length === 0) return [];
    const rows = await this.db
      .select({ address: suppressions.address })
      .from(suppressions)
      .where(
        and(
          eq(suppressions.accountId, ctx.accountId),
          inArray(suppressions.address, [...addresses]),
        ),
      );
    const listed = new Set(rows.map((row) => row.address));
    // Filtered from the caller's list rather than returned from the query, so
    // the order and the exact values they passed come back unchanged.
    return addresses.filter((address) => listed.has(address));
  }

  /**
   * First reason wins.
   *
   * A hard bounce recorded on Monday should not be overwritten by a manual entry
   * on Friday: the original reason is what explains why the address is here, and
   * that is the question anyone asking has.
   */
  async add(ctx: AuthContext, entry: SuppressionEntry): Promise<void> {
    await this.db
      .insert(suppressions)
      .values({
        accountId: ctx.accountId,
        address: entry.address,
        reason: entry.reason,
        source: entry.source,
        createdAt: toIsoText(entry.createdAt),
      })
      .onConflictDoNothing();
  }

  async remove(ctx: AuthContext, address: EmailAddress): Promise<void> {
    await this.db
      .delete(suppressions)
      .where(and(eq(suppressions.accountId, ctx.accountId), eq(suppressions.address, address)));
  }

  async list(ctx: AuthContext): Promise<SuppressionEntry[]> {
    const rows = await this.db
      .select()
      .from(suppressions)
      .where(eq(suppressions.accountId, ctx.accountId))
      .orderBy(asc(suppressions.createdAt));
    return rows.map(toEntry);
  }
}

function toEntry(row: SuppressionRow): SuppressionEntry {
  return {
    address: row.address as EmailAddress,
    reason: row.reason as SuppressionEntry["reason"],
    source: row.source as SuppressionEntry["source"],
    createdAt: toDate(row.createdAt),
  };
}
