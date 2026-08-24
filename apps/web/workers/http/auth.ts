import type { Account, AccountId, Caller } from "@mailworker/core";
import { ApiKey, ApiKeyToken, DomainError } from "@mailworker/core";
import { WebCryptoSecrets } from "@web/workers/adapters";
import type { Container } from "@web/workers/container";

const secrets = new WebCryptoSecrets();
const KEY_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Turn a bearer token into a `Caller`, or refuse.
 *
 * The one place in the system that builds a `Caller`; everything downstream
 * takes it as a parameter. Because an environment IS an account,
 * this is also the only place that decides which environment a request acts on
 * — a repository is never in a position to choose one.
 *
 * Two credentials are accepted:
 *
 *   - A **stored API key**, looked up by its public prefix and verified against
 *     a hash. The only one that can carry narrow scopes or bind to an identity.
 *   - The **bootstrap admin key**, a Worker secret. A fresh deployment has an
 *     empty `api_keys` table and no way to fill it, so something has to break
 *     the cycle.
 */
export async function authenticate(
  container: Container,
  env: Env,
  header: string | undefined,
  now: Date,
  targetAccountId?: AccountId | undefined,
): Promise<Caller> {
  const token = bearer(header);
  if (token === null) {
    throw new DomainError("unauthorized", "Send a bearer token in the Authorization header.");
  }
  return await callerForToken(container, env, token, now, targetAccountId);
}

/**
 * The credential check with the transport stripped off, because the dashboard
 * authenticates the same tokens from a sealed cookie rather than a header. What
 * must not be duplicated is what follows: the prefix lookup, the constant-time
 * verify, the revocation check and the shape of the resulting `Caller`.
 *
 * Note what is NOT shared: `/v1` reads only the `Authorization` header and never
 * a cookie. A browser attaches cookies to cross-site requests it was tricked
 * into making and does not attach headers, which is what makes every mutating
 * endpoint under `/v1` unreachable by CSRF without a token dance.
 */
export async function callerForToken(
  container: Container,
  env: Env,
  token: string,
  now: Date,
  targetAccountId?: AccountId | undefined,
): Promise<Caller> {
  const admin = env.MAILWORKER_ADMIN_KEY;
  if (admin !== undefined && admin.length > 0 && (await constantTimeEqual(token, admin))) {
    const account = await resolveAccount(container, container.defaultAccountId);
    return await inTargetEnvironment(
      container,
      {
        accountId: account.id,
        projectId: account.projectId,
        mode: account.mode,
        identityId: null,
        scopes: ["admin"],
        subject: "key:bootstrap",
      },
      targetAccountId,
    );
  }

  const split = ApiKeyToken.split(token);
  if (split === null) {
    throw new DomainError("unauthorized", "That is not a valid API key.");
  }

  const key = await container.apiKeys.findByPrefix(split.prefix);
  // Same answer for "no such key" and "wrong secret". Distinguishing them would
  // turn the prefix into an oracle for which keys exist.
  if (key === null || !(await secrets.verify(split.secret, key.hash))) {
    throw new DomainError("unauthorized", "That is not a valid API key.");
  }
  if (!ApiKey.isUsable(key, now)) {
    throw new DomainError("unauthorized", "That API key has been revoked or has expired.");
  }

  const account = await resolveAccount(container, key.accountId);
  const caller: Caller = {
    accountId: account.id,
    projectId: account.projectId,
    mode: account.mode,
    identityId: key.identityId,
    scopes: key.scopes,
    subject: `key:${key.prefix}`,
  };

  // Keep the key inventory useful without turning every authenticated request
  // into a D1 write. The first use is recorded immediately; active keys are
  // refreshed at most once every five minutes.
  if (
    key.lastUsedAt === null ||
    now.getTime() - key.lastUsedAt.getTime() >= KEY_TOUCH_INTERVAL_MS
  ) {
    // Telemetry must never block a valid request, and it must not race a revoke
    // by rewriting the full key row from this stale authentication snapshot.
    try {
      await container.apiKeys.touchLastUsed(caller, key.id, now);
    } catch (error) {
      console.error("API key last-used timestamp could not be recorded", error);
    }
  }

  return await inTargetEnvironment(container, caller, targetAccountId);
}

/**
 * Point a caller at a sibling environment.
 *
 * Admin only, and never across projects. This is the asymmetry the whole design
 * rests on: a human's credential spans the environments of their project so the
 * dashboard needs one login, while an agent key stays pinned to the environment
 * it was minted in and cannot reach production by asking.
 */
async function inTargetEnvironment(
  container: Container,
  caller: Caller,
  targetAccountId: AccountId | undefined,
): Promise<Caller> {
  if (targetAccountId === undefined || targetAccountId === caller.accountId) return caller;

  if (!caller.scopes.includes("admin")) {
    throw new DomainError("forbidden", "This credential is bound to a single environment.", {
      required: "admin",
    });
  }

  const target = await container.accounts.findById(targetAccountId);
  if (target === null || target.projectId !== caller.projectId) {
    throw new DomainError("environment_not_found", `No environment ${targetAccountId}.`, {
      accountId: targetAccountId,
    });
  }

  return { ...caller, accountId: target.id, mode: target.mode };
}

/**
 * A deployment that has not run the environment migration yet still has to
 * authenticate, so a missing row resolves to the live production defaults rather
 * than locking everyone out.
 */
async function resolveAccount(container: Container, accountId: AccountId): Promise<Account> {
  const account = await container.accounts.findById(accountId);
  if (account !== null) return account;
  return {
    id: accountId,
    projectId: container.projectId,
    env: "production",
    name: "production",
    mode: "live",
    createdAt: new Date(0),
  };
}

function bearer(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? null : match[1]!.trim();
}

/** Digest comparison, so timing does not depend on how many characters matched. */
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  return await secrets.verify(a, await secrets.hash(b));
}
