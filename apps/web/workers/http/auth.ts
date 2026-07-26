import type { Caller } from "@mailworker/core";
import { ApiKey, ApiKeyToken, DomainError } from "@mailworker/core";
import { WebCryptoSecrets } from "@web/workers/adapters";
import type { Container } from "@web/workers/container";

const secrets = new WebCryptoSecrets();

/**
 * Turn a bearer token into a `Caller`, or refuse.
 *
 * This is the one place in the system that builds a `Caller` for a request, and
 * everything downstream takes it as a parameter. That discipline is what makes
 * the eventual multi-tenant migration a change here rather than an audit of
 * every query (DESIGN §6) — a repository can never accidentally serve the wrong
 * account, because it was never in a position to choose one.
 *
 * Two credentials are accepted, and the difference matters:
 *
 *   - A **stored API key**, looked up by its public prefix and verified against
 *     a hash. This is the normal path, and the only one that can carry narrow
 *     scopes or bind to an agent identity.
 *   - The **bootstrap admin key**, a Worker secret. A fresh deployment has an
 *     empty `api_keys` table and no way to fill it, so something has to break
 *     the cycle; `mailworker deploy` sets this, and `mailworker keys create`
 *     uses it once to mint a real key. It is unscoped and unattributable to an
 *     identity, which is exactly why it should not be what an agent holds.
 */
export async function authenticate(
  container: Container,
  env: Env,
  header: string | undefined,
  now: Date,
): Promise<Caller> {
  const token = bearer(header);
  if (token === null) {
    throw new DomainError("unauthorized", "Send a bearer token in the Authorization header.");
  }

  const admin = env.MAILWORKER_ADMIN_KEY;
  if (admin !== undefined && admin.length > 0 && (await constantTimeEqual(token, admin))) {
    return {
      accountId: container.accountId,
      identityId: null,
      scopes: ["admin"],
      subject: "key:bootstrap",
    };
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

  return {
    accountId: key.accountId,
    identityId: key.identityId,
    scopes: key.scopes,
    subject: `key:${key.prefix}`,
  };
}

function bearer(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? null : match[1]!.trim();
}

/**
 * Compared as digests rather than as strings, so the time taken does not depend
 * on how many leading characters the guess got right — and, incidentally, so a
 * length difference leaks nothing either.
 */
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  return await secrets.verify(a, await secrets.hash(b));
}
