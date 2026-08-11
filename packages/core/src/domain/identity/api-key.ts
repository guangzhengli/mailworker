import { invalidArgument } from "@core/domain/errors";
import type { KeyPrefix } from "@core/domain/identity/account";
import type { AccountId } from "@core/domain/identity/account-id";
import type { Scope } from "@core/domain/identity/scope";
import type { Ulid } from "@core/domain/ulid";

/**
 * A bearer credential. Only the hash is stored; the plaintext is shown once at
 * creation and never again.
 *
 * Generating and hashing the secret needs randomness and a digest, so it lives
 * behind `Secrets` — this entity only holds the result and decides
 * whether the key is still usable.
 */
export interface ApiKey {
  readonly id: Ulid;
  readonly accountId: AccountId;
  readonly name: string;
  /** Public, searchable head of the token, e.g. `mw_live_8fa2c1`. */
  readonly prefix: string;
  readonly hash: string;
  readonly scopes: readonly Scope[];
  /** Binds this key to an agent identity, so SendPolicy has something to meter. */
  readonly identityId: Ulid | null;
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

export interface CreateApiKeyInput {
  readonly id: Ulid;
  readonly accountId: AccountId;
  readonly name: string;
  readonly prefix: string;
  readonly hash: string;
  readonly scopes: readonly Scope[];
  readonly now: Date;
  readonly identityId?: Ulid | null;
  readonly expiresAt?: Date | null;
}

export const API_KEY_PREFIX = "mw";

/**
 * The token format: `mw_<mode>_<public>_<secret>`.
 *
 * The public head is stored in the clear and indexed, so authenticating is one
 * lookup rather than a hash comparison against every key — and a token leaked
 * into a log identifies which key to revoke without holding anything that could
 * authenticate. The mode in the middle makes pasting the wrong environment's key
 * visible at a glance: `mw_live` reaches real people, `mw_sbx` cannot leave the
 * deployment, `mw_test` sends for real behind a recipient allowlist.
 *
 * `test` stays in the pattern for keys minted before `sandbox` got a prefix of
 * its own — they are still valid credentials, and authentication resolves a key
 * by the prefix stored on its row rather than by re-deriving one.
 */
export const ApiKeyToken = {
  PATTERN: /^(mw_(?:live|sbx|test)_[0-9a-f]{6})_([0-9a-f]{32,128})$/,

  format(keyPrefix: KeyPrefix, publicId: string, secret: string): string {
    return `${keyPrefix}_${publicId}_${secret}`;
  },

  /** Null when the string is not shaped like a token at all. */
  split(token: string): { prefix: string; secret: string } | null {
    const match = ApiKeyToken.PATTERN.exec(token.trim());
    if (match === null) return null;
    return { prefix: match[1]!, secret: match[2]! };
  },
} as const;

export const ApiKey = {
  create(input: CreateApiKeyInput): ApiKey {
    if (input.name.trim().length === 0) {
      throw invalidArgument("An API key needs a name.");
    }
    if (input.scopes.length === 0) {
      throw invalidArgument("An API key needs at least one scope.");
    }
    if (input.expiresAt != null && input.expiresAt.getTime() <= input.now.getTime()) {
      throw invalidArgument("API key expiry must be in the future.", {
        expiresAt: input.expiresAt.toISOString(),
      });
    }
    return {
      id: input.id,
      accountId: input.accountId,
      name: input.name.trim(),
      prefix: input.prefix,
      hash: input.hash,
      scopes: [...input.scopes],
      identityId: input.identityId ?? null,
      lastUsedAt: null,
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
      createdAt: input.now,
    };
  },

  isUsable(key: ApiKey, now: Date): boolean {
    if (key.revokedAt !== null) return false;
    if (key.expiresAt !== null && key.expiresAt.getTime() <= now.getTime()) return false;
    return true;
  },

  revoke(key: ApiKey, now: Date): ApiKey {
    return key.revokedAt === null ? { ...key, revokedAt: now } : key;
  },

  touch(key: ApiKey, now: Date): ApiKey {
    return { ...key, lastUsedAt: now };
  },
} as const;
