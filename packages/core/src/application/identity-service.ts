import type { Scope, Ulid } from "@core/domain";
import {
  AgentIdentity,
  ApiKey,
  ApiKeyToken,
  Caller,
  DomainError,
  invalidArgument,
  notFound,
} from "@core/domain";
import type {
  ApiKeyRepository,
  Clock,
  IdentityRepository,
  IdGenerator,
  Secrets,
} from "@core/domain/ports";

/**
 * identity — who may act, as whom, and within what limits.
 *
 * The context that makes the other three safe to hand to an agent. Without it
 * there is one credential with every scope, and "an agent sending email is an
 * irreversible outward action" is a sentence in a README rather than something
 * the system enforces.
 */

export interface IdentityDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly secrets: Secrets;
  readonly identities: IdentityRepository;
  readonly apiKeys: ApiKeyRepository;
}

export interface CreateIdentityRequest {
  readonly name: string;
  /** Address glob this identity may put in `From`. Null or absent means any owned address. */
  readonly sendAs?: string | null;
  /** Address globs it may send TO. `[]` means "nobody", which is not the same as absent. */
  readonly recipientAllowlist?: readonly string[] | null;
  readonly dailySendQuota?: number | null;
  readonly requireApproval?: boolean;
}

export interface CreateKeyRequest {
  readonly name: string;
  readonly scopes: readonly Scope[];
  /** Bind the key to an identity, so `SendPolicy` has something to meter. */
  readonly identityName?: string;
  readonly expiresAt?: Date | null;
}

/**
 * The one time the plaintext exists.
 *
 * Returned separately from the `ApiKey` rather than as a field on it, so that
 * nothing downstream can accidentally serialize a stored key and find a secret
 * in it: the entity genuinely does not have one, because only the hash is
 * stored.
 */
export interface MintedKey {
  readonly key: ApiKey;
  /** Shown once. There is no way to recover it, by construction.  */
  readonly token: string;
}

const PUBLIC_ID_BYTES = 3;
const SECRET_BYTES = 24;

export function createIdentityService(deps: IdentityDeps) {
  return {
    /**
     * Declare an agent and its limits.
     *
     * `admin` only. The limits an identity carries are exactly what it must not
     * be able to widen, so the credential that creates identities has to be a
     * different one from the credential that acts as them — otherwise the
     * quota is a suggestion.
     */
    async createIdentity(ctx: Caller, input: CreateIdentityRequest): Promise<AgentIdentity> {
      Caller.require(ctx, "admin");

      const existing = await deps.identities.findByName(ctx, input.name);
      if (existing !== null) {
        throw new DomainError("invalid_argument", `An identity named ${input.name} exists.`, {
          name: input.name,
        });
      }

      const identity = AgentIdentity.create({
        id: deps.ids.ulid(),
        accountId: ctx.accountId,
        name: input.name,
        now: deps.clock.now(),
        ...(input.sendAs === undefined ? {} : { sendAs: input.sendAs }),
        ...(input.recipientAllowlist === undefined
          ? {}
          : { recipientAllowlist: input.recipientAllowlist }),
        ...(input.dailySendQuota === undefined ? {} : { dailySendQuota: input.dailySendQuota }),
        ...(input.requireApproval === undefined
          ? {}
          : { requireApproval: input.requireApproval }),
      });

      await deps.identities.insert(ctx, identity);
      return identity;
    },

    async listIdentities(ctx: Caller): Promise<AgentIdentity[]> {
      Caller.require(ctx, "admin");
      return await deps.identities.list(ctx);
    },

    /**
     * Mint a credential.
     *
     * The token is `mw_live_<public>_<secret>`: the public head is stored in
     * the clear and indexed, so authenticating is one lookup rather than a hash
     * comparison against every key, and a token leaked into a log or a
     * repository can be identified and revoked from the prefix alone — which
     * holds nothing that could be used to authenticate.
     *
     * Only the hash of the secret is kept. That is why `token` is returned
     * beside the entity instead of on it: there is genuinely nowhere to read it
     * from afterwards, and a shape that suggested otherwise would eventually
     * lead someone to try.
     */
    async createKey(ctx: Caller, input: CreateKeyRequest): Promise<MintedKey> {
      Caller.require(ctx, "admin");

      if (input.scopes.includes("admin") && input.identityName !== undefined) {
        // An admin key can do anything, including editing the identity's own
        // limits — so binding one to an identity produces a credential whose
        // metering it can remove. Refusing is clearer than silently metering
        // something that can opt out.
        throw invalidArgument(
          "An admin key cannot be bound to an agent identity: it could raise its own limits.",
        );
      }

      let identityId: Ulid | null = null;
      if (input.identityName !== undefined) {
        const identity = await deps.identities.findByName(ctx, input.identityName);
        if (identity === null) {
          throw notFound(
            "identity_not_found",
            `No agent identity named ${input.identityName}.`,
            {
              identityName: input.identityName,
            },
          );
        }
        identityId = identity.id;
      }

      const publicId = deps.secrets.generate(PUBLIC_ID_BYTES);
      const secret = deps.secrets.generate(SECRET_BYTES);
      const key = ApiKey.create({
        id: deps.ids.ulid(),
        accountId: ctx.accountId,
        name: input.name,
        prefix: `mw_live_${publicId}`,
        hash: await deps.secrets.hash(secret),
        scopes: input.scopes,
        now: deps.clock.now(),
        identityId,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      });

      await deps.apiKeys.insert(ctx, key);
      return { key, token: ApiKeyToken.format(publicId, secret) };
    },

    async listKeys(ctx: Caller): Promise<ApiKey[]> {
      Caller.require(ctx, "admin");
      return await deps.apiKeys.list(ctx);
    },

    /**
     * Revoke, rather than delete.
     *
     * The row stays, so `lastUsedAt` and the audit trail survive the revocation
     * — the question after a leak is "what did this key do before I noticed",
     * and deleting the row is how that becomes unanswerable. Revoking twice is
     * a no-op, because the second caller is usually someone panicking.
     */
    async revokeKey(ctx: Caller, keyId: Ulid): Promise<ApiKey> {
      Caller.require(ctx, "admin");

      const keys = await deps.apiKeys.list(ctx);
      const key = keys.find((candidate) => candidate.id === keyId);
      if (key === undefined) {
        throw notFound("api_key_not_found", `No API key ${keyId}.`, { keyId });
      }

      const revoked = ApiKey.revoke(key, deps.clock.now());
      await deps.apiKeys.update(ctx, revoked);
      return revoked;
    },
  };
}

export type IdentityService = ReturnType<typeof createIdentityService>;
