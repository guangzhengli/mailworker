import type {
  AccountId,
  AgentIdentity,
  ApiKey,
  ApiKeyRepository,
  Caller,
  DomainRepository,
  DomainRouting,
  IdentityRepository,
  Scope,
  Ulid,
} from "@mailworker/core";
import type { Db } from "@web/workers/adapters/d1";
import { toDate, toIsoText } from "@web/workers/adapters/d1";
import type { AgentIdentityRow, ApiKeyRow, DomainRow } from "@web/workers/adapters/schema";
import { agentIdentities, apiKeys, domains } from "@web/workers/adapters/schema";
import { and, asc, eq, isNull, lte, or } from "drizzle-orm";

const API_KEY_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * The three identity-side repositories, together because they are one concept —
 * who is asking, as what, within which limits — and because none of them is more
 * than a few queries. Three files here would be three imports and no clarity.
 */

export class D1Identities implements IdentityRepository {
  constructor(private readonly db: Db) {}

  async findById(ctx: Caller, id: Ulid): Promise<AgentIdentity | null> {
    const [row] = await this.db
      .select()
      .from(agentIdentities)
      .where(and(eq(agentIdentities.accountId, ctx.accountId), eq(agentIdentities.id, id)))
      .limit(1);
    return row === undefined ? null : toIdentity(row);
  }

  async findByName(ctx: Caller, name: string): Promise<AgentIdentity | null> {
    const [row] = await this.db
      .select()
      .from(agentIdentities)
      .where(and(eq(agentIdentities.accountId, ctx.accountId), eq(agentIdentities.name, name)))
      .limit(1);
    return row === undefined ? null : toIdentity(row);
  }

  async insert(ctx: Caller, identity: AgentIdentity): Promise<void> {
    await this.db.insert(agentIdentities).values({
      id: identity.id,
      accountId: ctx.accountId,
      name: identity.name,
      sendAs: identity.sendAs,
      recipientAllowlist:
        identity.recipientAllowlist === null ? null : [...identity.recipientAllowlist],
      dailySendQuota: identity.dailySendQuota,
      requireApproval: identity.requireApproval,
      managed: identity.managed,
      createdAt: toIsoText(identity.createdAt),
    });
  }

  async list(ctx: Caller): Promise<AgentIdentity[]> {
    const rows = await this.db
      .select()
      .from(agentIdentities)
      .where(eq(agentIdentities.accountId, ctx.accountId))
      .orderBy(asc(agentIdentities.name));
    return rows.map(toIdentity);
  }
}

export class D1ApiKeys implements ApiKeyRepository {
  constructor(private readonly db: Db) {}

  /**
   * The one query in this package with no `account_id` filter, and the only one
   * entitled to skip it: this is how an Caller comes into existence, so
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

  async insert(ctx: Caller, key: ApiKey): Promise<void> {
    await this.db.insert(apiKeys).values(toApiKeyRow(ctx, key));
  }

  async update(ctx: Caller, key: ApiKey): Promise<void> {
    const { id: _id, accountId: _accountId, ...mutable } = toApiKeyRow(ctx, key);
    await this.db
      .update(apiKeys)
      .set(mutable)
      .where(and(eq(apiKeys.accountId, ctx.accountId), eq(apiKeys.id, key.id)));
  }

  async touchLastUsed(ctx: Caller, keyId: Ulid, at: Date): Promise<void> {
    const cutoff = new Date(at.getTime() - API_KEY_TOUCH_INTERVAL_MS);
    await this.db
      .update(apiKeys)
      .set({ lastUsedAt: toIsoText(at) })
      .where(
        and(
          eq(apiKeys.accountId, ctx.accountId),
          eq(apiKeys.id, keyId),
          or(isNull(apiKeys.lastUsedAt), lte(apiKeys.lastUsedAt, toIsoText(cutoff))),
        ),
      );
  }

  async list(ctx: Caller): Promise<ApiKey[]> {
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.accountId, ctx.accountId))
      .orderBy(asc(apiKeys.createdAt));
    return rows.map(toApiKey);
  }
}

export class D1Domains implements DomainRepository {
  constructor(private readonly db: Db) {}

  /** Hostnames are compared lowercased; DNS is case-insensitive and callers are not. */
  async findRouting(ctx: Caller, domain: string): Promise<DomainRouting | null> {
    const [row] = await this.db
      .select()
      .from(domains)
      .where(and(eq(domains.accountId, ctx.accountId), eq(domains.name, domain.toLowerCase())))
      .limit(1);
    return row === undefined ? null : toRouting(row);
  }

  async list(ctx: Caller): Promise<DomainRouting[]> {
    const rows = await this.db
      .select()
      .from(domains)
      .where(eq(domains.accountId, ctx.accountId))
      .orderBy(asc(domains.name));
    return rows.map(toRouting);
  }

  async insert(ctx: Caller, routing: DomainRouting): Promise<void> {
    await this.db.insert(domains).values({
      id: crypto.randomUUID(),
      accountId: ctx.accountId,
      name: routing.domain.toLowerCase(),
      inboundEnabled: true,
      sendingStatus: routing.sendingStatus,
      dkimSelector: routing.dkimSelector,
      catchallMode: routing.catchAllMode,
      catchallInbox: routing.catchAllInboxId,
      autocreatePattern: routing.autocreatePattern,
      createdAt: toIsoText(new Date()),
    });
  }

  async resolveAccount(domain: string): Promise<AccountId | null> {
    const [row] = await this.db
      .select({ accountId: domains.accountId })
      .from(domains)
      .where(eq(domains.name, domain.toLowerCase()))
      .limit(1);
    return row === undefined ? null : (row.accountId as AccountId);
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
    managed: row.managed,
    createdAt: toDate(row.createdAt),
  };
}

function toApiKeyRow(ctx: Caller, key: ApiKey): typeof apiKeys.$inferInsert {
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
    sendingStatus: row.sendingStatus,
    dkimSelector: row.dkimSelector,
  };
}
