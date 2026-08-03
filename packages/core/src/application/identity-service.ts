import type { AccountId, AccountMode, Scope, Ulid } from "@core/domain";
import {
  Account,
  AgentIdentity,
  ApiKey,
  ApiKeyToken,
  Caller,
  DomainError,
  invalidArgument,
  notFound,
} from "@core/domain";
import type {
  AccountRepository,
  ApiKeyRepository,
  Clock,
  DomainRepository,
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
  readonly accounts: AccountRepository;
  readonly domains: DomainRepository;
}

export interface CreateEnvironmentRequest {
  readonly env: string;
  readonly name?: string;
  readonly mode: AccountMode;
  /**
   * The hostname this environment receives on. Without one it can hold no
   * inboxes at all, because an address needs a domain this environment owns.
   */
  readonly domain?: string;
}

export interface CreateIdentityRequest {
  readonly name: string;
  readonly sendAs?: string | null;
  readonly recipientAllowlist?: readonly string[] | null;
  readonly dailySendQuota?: number | null;
  readonly requireApproval?: boolean;
  readonly managed?: boolean;
}

export interface CreateKeyRequest {
  readonly name: string;
  readonly scopes: readonly Scope[];
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
  readonly token: string;
}

const PUBLIC_ID_BYTES = 3;
const SECRET_BYTES = 24;

export const CONSOLE_IDENTITY = "console";

export function createIdentityService(deps: IdentityDeps) {
  return {
    async listEnvironments(ctx: Caller): Promise<Account[]> {
      return await deps.accounts.listByProject(ctx.projectId);
    },

    /**
     * Add an environment to this project.
     *
     * `admin` only, and the account id is derived rather than chosen: it is the
     * tenant key every row in the new environment will carry, so letting a
     * caller pick it is letting them collide with an existing one.
     */
    async createEnvironment(ctx: Caller, input: CreateEnvironmentRequest): Promise<Account> {
      Caller.require(ctx, "admin");

      const existing = await deps.accounts.listByProject(ctx.projectId);
      if (existing.some((account) => account.env === input.env)) {
        throw new DomainError("invalid_argument", `An environment named ${input.env} exists.`, {
          env: input.env,
        });
      }

      const account = Account.create({
        id: `${ctx.projectId}-${input.env}` as AccountId,
        projectId: ctx.projectId,
        env: input.env,
        name: input.name ?? input.env,
        mode: input.mode,
        now: deps.clock.now(),
      });

      // A hostname belongs to exactly one environment: inbound mail names an
      // address and nothing else, so `resolveAccount` has nothing to
      // disambiguate with and would pick one of two arbitrarily. Refusing here
      // is what makes "give each environment a subdomain" a rule rather than
      // advice.
      if (input.domain !== undefined) {
        const owner = await deps.domains.resolveAccount(input.domain);
        if (owner !== null) {
          throw new DomainError(
            "invalid_argument",
            `${input.domain} already receives mail for environment ${owner}. ` +
              "Give each environment its own hostname, e.g. dev.mail.example.com.",
            { domain: input.domain, owner },
          );
        }
      }

      await deps.accounts.insert(account);

      if (input.domain !== undefined) {
        await deps.domains.insert(
          { ...ctx, accountId: account.id, mode: account.mode },
          {
            domain: input.domain.toLowerCase(),
            catchAllMode: "reject",
            catchAllInboxId: null,
            autocreatePattern: null,
            sendingStatus: account.mode === "sandbox" ? "verified" : "unverified",
            dkimSelector: null,
          },
        );
      }

      return account;
    },

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
        ...(input.managed === undefined ? {} : { managed: input.managed }),
      });

      await deps.identities.insert(ctx, identity);
      return identity;
    },

    async listIdentities(ctx: Caller): Promise<AgentIdentity[]> {
      Caller.require(ctx, "admin");
      return await deps.identities.list(ctx);
    },

    /**
     * The identity a human's dashboard sends are metered against.
     *
     * Without it a console send rides the session's own credential, which for a
     * human is usually `admin` — and gate 2 exempts `admin` from the sender
     * rule, the recipient allowlist and the quota entirely. That would make the
     * dashboard the one unmetered way out of the building, which is exactly the
     * shape `SendPolicy` exists to prevent.
     *
     * Provisioned on first use rather than by a migration, so a deployment that
     * never sends from the dashboard never grows the row. `managed` marks it as
     * ours: the Agents page shows it apart from the identities an operator
     * declared, because deleting it would only cause it to come back.
     */
    async ensureConsoleIdentity(ctx: Caller): Promise<AgentIdentity> {
      Caller.require(ctx, "admin");

      const existing = await deps.identities.findByName(ctx, CONSOLE_IDENTITY);
      if (existing !== null) return existing;

      const identity = AgentIdentity.create({
        id: deps.ids.ulid(),
        accountId: ctx.accountId,
        name: CONSOLE_IDENTITY,
        // No allowlist and no quota: a human replying to support mail must be
        // able to reach whoever wrote in. The metering that matters here is
        // attribution — every console delivery names this identity, so "who
        // sent this" stays answerable.
        now: deps.clock.now(),
        managed: true,
      });

      await deps.identities.insert(ctx, identity);
      return identity;
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

      // The prefix names the environment, so pasting a development key into a
      // production shell is visible rather than merely rejected.
      const keyPrefix = Account.keyPrefix(ctx.mode);
      const publicId = deps.secrets.generate(PUBLIC_ID_BYTES);
      const secret = deps.secrets.generate(SECRET_BYTES);
      const key = ApiKey.create({
        id: deps.ids.ulid(),
        accountId: ctx.accountId,
        name: input.name,
        prefix: `${keyPrefix}_${publicId}`,
        hash: await deps.secrets.hash(secret),
        scopes: input.scopes,
        now: deps.clock.now(),
        identityId,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      });

      await deps.apiKeys.insert(ctx, key);
      return { key, token: ApiKeyToken.format(keyPrefix, publicId, secret) };
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
