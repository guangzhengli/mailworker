import type { AccountId } from "@core/domain/account-id.ts";
import { invalidArgument } from "@core/domain/errors.ts";
import type { Scope } from "@core/domain/scope.ts";
import type { Ulid } from "@core/domain/ulid.ts";

/**
 * A bearer credential. Only the hash is stored; the plaintext is shown once at
 * creation and never again.
 *
 * Generating and hashing the secret needs randomness and a digest, so it lives
 * behind `TokenHasherPort` — this entity only holds the result and decides
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
