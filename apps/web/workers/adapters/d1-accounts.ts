import type { Account, AccountId, AccountRepository, ProjectId } from "@mailworker/core";
import type { Db } from "@web/workers/adapters/d1";
import { toDate, toIsoText } from "@web/workers/adapters/d1";
import type { AccountRow } from "@web/workers/adapters/schema";
import { accounts } from "@web/workers/adapters/schema";
import { asc, eq } from "drizzle-orm";

/**
 * Environments. No `Caller` filter, because resolving which environment a
 * request targets is what produces the `Caller` — the same exception
 * `findByPrefix` makes for API keys.
 */
export class D1Accounts implements AccountRepository {
  constructor(private readonly db: Db) {}

  async findById(id: AccountId): Promise<Account | null> {
    const [row] = await this.db.select().from(accounts).where(eq(accounts.id, id)).limit(1);
    return row === undefined ? null : toAccount(row);
  }

  async listByProject(projectId: ProjectId): Promise<Account[]> {
    const rows = await this.db
      .select()
      .from(accounts)
      .where(eq(accounts.projectId, projectId))
      .orderBy(asc(accounts.env));
    return rows.map(toAccount);
  }

  async insert(account: Account): Promise<void> {
    await this.db.insert(accounts).values({
      id: account.id,
      projectId: account.projectId,
      env: account.env,
      name: account.name,
      mode: account.mode,
      createdAt: toIsoText(account.createdAt),
    });
  }
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id as AccountId,
    projectId: row.projectId as ProjectId,
    env: row.env,
    name: row.name,
    mode: row.mode as Account["mode"],
    createdAt: toDate(row.createdAt),
  };
}
