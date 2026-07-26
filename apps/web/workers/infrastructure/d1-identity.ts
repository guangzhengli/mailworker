import type {
  AgentIdentity,
  ApiKey,
  ApiKeyRepositoryPort,
  AuthContext,
  DomainRepositoryPort,
  DomainRouting,
  IdentityRepositoryPort,
  Scope,
  Ulid,
} from "@mailworker/core";
import type { Db } from "@web/workers/infrastructure/d1.ts";
import { toDate, toIsoText } from "@web/workers/infrastructure/d1.ts";
import type {
  AgentIdentityRow,
  ApiKeyRow,
  DomainRow,
} from "@web/workers/infrastructure/schema.ts";
import { agentIdentities, apiKeys, domains } from "@web/workers/infrastructure/schema.ts";
import { and, asc, eq } from "drizzle-orm";

/**
 * The three identity-side repositories, together because they are one concept —
 * who is asking, as what, within which limits — and because none of them is more
 * than a few queries. Three files here would be three imports and no clarity.
 */

export class D1Identities implements IdentityRepositoryPort {
  constructor(private readonly db: Db) {}

  async findById(ctx: AuthContext, id: Ulid): Promise<AgentIdentity | null> {
    const [row] = await this.db
      .select()
      .from(agentIdentities)
      .where(and(eq(agentIdentities.accountId, ctx.accountId), eq(agentIdentities.id, id)))
      .limit(1);
    return row === undefined ? null : toIdentity(row);
  }

  async findByName(ctx: AuthContext, name: string): Promise<AgentIdentity | null> {
    const [row] = await this.db
      .select()
      .from(agentIdentities)
      .where(and(eq(agentIdentities.accountId, ctx.accountId), eq(agentIdentities.name, name)))
      .limit(1);
    return row === undefined ? null : toIdentity(row);
  }

  async insert(ctx: AuthContext, identity: AgentIdentity): Promise<void> {
    await this.db.insert(agentIdentities).values({
      id: identity.id,
      accountId: ctx.accountId,
      name: identity.name,
      sendAs: identity.sendAs,
      recipientAllowlist:
        identity.recipientAllowlist === null ? null : [...identity.recipientAllowlist],
      dailySendQuota: identity.dailySendQuota,
      requireApproval: identity.requireApproval,
      createdAt: toIsoText(identity.createdAt),
    });
  }

  async list(ctx: AuthContext): Promise<AgentIdentity[]> {
    const rows = await this.db
      .select()
      .from(agentIdentities)
      .where(eq(agentIdentities.accountId, ctx.accountId))
      .orderBy(asc(agentIdentities.name));
    return rows.map(toIdentity);
  }
}

export class D1ApiKeys implements ApiKeyRepositoryPort {
  constructor(private readonly db: Db) {}

  /**
   * The one query in this package with no `account_id` filter, and the only one
   * entitled to skip it: this is how an AuthContext comes into existence, so
   * there is no account known yet to scope by.
   *
   * That is why `prefix` carries a GLOBAL unique index rather than a per-account
   * one. If two accounts could share a prefix this lookup would be ambiguous,
   * and resolving the ambiguity would mean guessing which tenant a caller meant.
   * The secret is still verified against the hash afterwards; the prefix only
   * selects a row.
   */
  async findByPrefix(prefix: string): Promise<ApiKey | null> {
    const [row] = await this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.prefix, prefix))
      .limit(1);
    return row === undefined ? null : toApiKey(row);
  }

  async insert(ctx: AuthContext, key: ApiKey): Promise<void> {
    await this.db.insert(apiKeys).values(toApiKeyRow(ctx, key));
  }

  async update(ctx: AuthContext, key: ApiKey): Promise<void> {
    const { id: _id, accountId: _accountId, ...mutable } = toApiKeyRow(ctx, key);
    await this.db
      .update(apiKeys)
      .set(mutable)
      .where(and(eq(apiKeys.accountId, ctx.accountId), eq(apiKeys.id, key.id)));
  }

  async list(ctx: AuthContext): Promise<ApiKey[]> {
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.accountId, ctx.accountId))
      .orderBy(asc(apiKeys.createdAt));
    return rows.map(toApiKey);
  }
}

export class D1Domains implements DomainRepositoryPort {
  constructor(private readonly db: Db) {}

  /** Hostnames are compared lowercased; DNS is case-insensitive and callers are not. */
  async findRouting(ctx: AuthContext, domain: string): Promise<DomainRouting | null> {
    const [row] = await this.db
      .select()
      .from(domains)
      .where(and(eq(domains.accountId, ctx.accountId), eq(domains.name, domain.toLowerCase())))
      .limit(1);
    return row === undefined ? null : toRouting(row);
  }

  async list(ctx: AuthContext): Promise<DomainRouting[]> {
    const rows = await this.db
      .select()
      .from(domains)
      .where(eq(domains.accountId, ctx.accountId))
      .orderBy(asc(domains.name));
    return rows.map(toRouting);
  }
}

function toIdentity(row: AgentIdentityRow): AgentIdentity {
  return {
    id: row.id as Ulid,
    accountId: row.accountId as AgentIdentity["accountId"],
    name: row.name,
    sendAs: row.sendAs,
    // Null and [] mean different things — "no restriction" versus "may send to
    // nobody" — so this must not collapse to `?? []`.
    recipientAllowlist: row.recipientAllowlist,
    dailySendQuota: row.dailySendQuota,
    requireApproval: row.requireApproval,
    createdAt: toDate(row.createdAt),
  };
}

function toApiKeyRow(ctx: AuthContext, key: ApiKey): typeof apiKeys.$inferInsert {
  return {
    id: key.id,
    accountId: ctx.accountId,
    name: key.name,
    prefix: key.prefix,
    hash: key.hash,
    scopes: [...key.scopes],
    identityId: key.identityId,
    lastUsedAt: toIsoText(key.lastUsedAt),
    expiresAt: toIsoText(key.expiresAt),
    revokedAt: toIsoText(key.revokedAt),
    createdAt: toIsoText(key.createdAt),
  };
}

function toApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id as Ulid,
    accountId: row.accountId as ApiKey["accountId"],
    name: row.name,
    prefix: row.prefix,
    hash: row.hash,
    scopes: row.scopes as Scope[],
    identityId: row.identityId as Ulid | null,
    lastUsedAt: toDate(row.lastUsedAt),
    expiresAt: toDate(row.expiresAt),
    revokedAt: toDate(row.revokedAt),
    createdAt: toDate(row.createdAt),
  };
}

function toRouting(row: DomainRow): DomainRouting {
  return {
    domain: row.name,
    catchAllMode: row.catchallMode as DomainRouting["catchAllMode"],
    catchAllInboxId: row.catchallInbox as Ulid | null,
    autocreatePattern: row.autocreatePattern,
  };
}
