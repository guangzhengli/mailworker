import { scope, toIso } from "@contract/primitives";
import type { AgentIdentity, ApiKey, WebhookSubscription } from "@mailworker/core";
import { z } from "zod";

/**
 * `POST /v1/identities` — declaring an agent and the rope it gets.
 *
 * Every field is a limit, and every one of them is nullable in a way that
 * means something specific:
 *
 *   - `sendAs: null` — may use any address this account owns.
 *   - `recipientAllowlist: null` — unrestricted. `[]` — may send to NOBODY,
 *     which is how an identity is parked without being deleted. Collapsing the
 *     two would turn "parked" into "unrestricted", in the direction that
 *     matters.
 *   - `dailySendQuota: null` — only the account-level limit applies.
 */
export const createIdentityBody = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "lowercase alphanumeric with - or _"),
  sendAs: z.string().nullish(),
  recipientAllowlist: z.array(z.string()).nullish(),
  dailySendQuota: z.number().int().nonnegative().nullish(),
  requireApproval: z.boolean().optional(),
});

export const agentIdentityDto = z.object({
  id: z.string(),
  name: z.string(),
  sendAs: z.string().nullable(),
  recipientAllowlist: z.array(z.string()).nullable(),
  dailySendQuota: z.number().int().nullable(),
  requireApproval: z.boolean(),
  createdAt: z.string(),
});

export type AgentIdentityDto = z.infer<typeof agentIdentityDto>;

export function toAgentIdentityDto(identity: AgentIdentity): AgentIdentityDto {
  return {
    id: identity.id,
    name: identity.name,
    sendAs: identity.sendAs,
    recipientAllowlist:
      identity.recipientAllowlist === null ? null : [...identity.recipientAllowlist],
    dailySendQuota: identity.dailySendQuota,
    requireApproval: identity.requireApproval,
    createdAt: toIso(identity.createdAt),
  };
}

export const createKeyBody = z.strictObject({
  name: z.string().min(1).max(255),
  scopes: z.array(scope).min(1),
  /** Bind to an identity, so `SendPolicy` has something to meter. */
  identityName: z.string().optional(),
  expiresAt: z.iso.datetime().optional(),
});

/**
 * `hash` is not here, and neither is the token.
 *
 * The token appears exactly once, in the response to `POST /v1/keys`, as a
 * field alongside this DTO rather than inside it — so that nothing which
 * serializes a stored key can accidentally include a secret, because a stored
 * key does not have one.
 */
export const apiKeyDto = z.object({
  id: z.string(),
  name: z.string(),
  /** The public head, e.g. `mw_live_8fa2c1`. Safe to log; identifies the key. */
  prefix: z.string(),
  scopes: z.array(z.string()),
  identityId: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
});

export type ApiKeyDto = z.infer<typeof apiKeyDto>;

export function toApiKeyDto(key: ApiKey): ApiKeyDto {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    scopes: [...key.scopes],
    identityId: key.identityId,
    lastUsedAt: toIso(key.lastUsedAt),
    expiresAt: toIso(key.expiresAt),
    revokedAt: toIso(key.revokedAt),
    createdAt: toIso(key.createdAt),
  };
}

/**
 * `POST /v1/webhooks`.
 *
 * An empty `events` means every type, including ones added later — right for a
 * debugging subscription, wrong for a production integration. It is a choice
 * rather than an omission, so it is spelled out here.
 */
export const createWebhookBody = z.strictObject({
  url: z.url(),
  events: z.array(z.string()).optional(),
});

export const webhookDto = z.object({
  id: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  enabled: z.boolean(),
  createdAt: z.string(),
});

export type WebhookDto = z.infer<typeof webhookDto>;

/** `secret` is absent. It is returned once, at creation, and never listed. */
export function toWebhookDto(subscription: WebhookSubscription): WebhookDto {
  return {
    id: subscription.id,
    url: subscription.url,
    events: [...subscription.events],
    enabled: subscription.enabled,
    createdAt: toIso(subscription.createdAt),
  };
}
