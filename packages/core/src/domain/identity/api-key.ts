import { invalidArgument } from "@core/domain/errors";
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
 * The token format: `mw_live_<public>_<secret>`.
 *
 * The public head is stored in the clear and indexed, so authenticating is one
 * lookup by a short string rather than a hash comparison against every key in
 * the table. It is also what makes a leaked token greppable — `mw_live_8fa2c1`
 * in a log or a repository identifies exactly which key to revoke, without the
 * log holding anything that could be used to authenticate.
 *
 * Split rather than parsed into an object with methods: everything downstream
 * wants the two halves, and there is nothing else to know about a token.
 */
export const ApiKeyToken = {
  PATTERN: /^(mw_live_[0-9a-f]{6})_([0-9a-f]{32,128})$/,

  format(publicId: string, secret: string): string {
    return `mw_live_${publicId}_${secret}`;
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
