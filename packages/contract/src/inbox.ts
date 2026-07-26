import {
  durationMs,
  emailAddress,
  metadata,
  pageQuery,
  queryBool,
  toIso,
} from "@contract/primitives";
import type { CreateInboxRequest, Inbox } from "@mailworker/core";
import { z } from "zod";

/**
 * `POST /v1/inboxes`.
 *
 * The wire spells it `ttl` and `identity`; the use case wants `ttlMs` and
 * `identityName`. Translating here rather than renaming either side keeps the
 * public contract readable to whoever is typing curl and keeps the use case
 * signature honest about units.
 *
 * Note what this does NOT check: that `address` and `prefix` are mutually
 * exclusive, or that the address is one we serve. Those are rules, and rules
 * live in the domain — this layer only decides what JSON we are willing to
 * unpack. One definition of each question, in the layer that owns it.
 */
export const createInboxBody = z
  .strictObject({
    /** Full address. Mutually exclusive with `prefix`. */
    address: z.string().optional(),
    /** Generate `<prefix>-<random>@<domain>`. */
    prefix: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "A prefix must be lowercase alphanumeric with dashes.")
      .optional(),
    /** Required only when this deployment serves more than one domain. */
    domain: z.string().optional(),
    kind: z.enum(["ephemeral", "persistent"]).optional(),
    ttl: durationMs.optional(),
    displayName: z.string().max(255).optional(),
    identity: z.string().optional(),
    metadata: metadata.optional(),
  })
  .transform(
    (input): CreateInboxRequest => ({
      ...(input.address === undefined ? {} : { address: input.address }),
      ...(input.prefix === undefined ? {} : { prefix: input.prefix }),
      ...(input.domain === undefined ? {} : { domain: input.domain }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.ttl === undefined ? {} : { ttlMs: input.ttl }),
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      ...(input.identity === undefined ? {} : { identityName: input.identity }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    }),
  );

export const listInboxesQuery = pageQuery.extend({
  kind: z.enum(["ephemeral", "persistent"]).optional(),
  domain: z.string().optional(),
  /**
   * Expired inboxes are hidden by default, because an agent listing inboxes
   * wants the ones it can still use. The dashboard asks for them, since "my
   * address stopped working" is answered by seeing the expiry, not by the
   * address having vanished.
   */
  includeExpired: queryBool.optional(),
});

export type ListInboxesQuery = z.infer<typeof listInboxesQuery>;

export const inboxDto = z.object({
  id: z.string(),
  address: z.string(),
  localPart: z.string(),
  domain: z.string(),
  displayName: z.string().nullable(),
  kind: z.enum(["ephemeral", "persistent"]),
  identityId: z.string().nullable(),
  metadata: z.record(z.string(), z.string()).nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});

export type InboxDto = z.infer<typeof inboxDto>;

/**
 * `accountId` is deliberately absent. The caller's credential already determines
 * it, so returning it tells them nothing they can act on while adding a tenant
 * identifier to every log line and screenshot. `deletedAt` is absent for a
 * simpler reason: a deleted inbox is never in a response.
 */
export function toInboxDto(inbox: Inbox): InboxDto {
  return {
    id: inbox.id,
    address: inbox.address,
    localPart: inbox.localPart,
    domain: inbox.domain,
    displayName: inbox.displayName,
    kind: inbox.kind,
    identityId: inbox.identityId,
    metadata: inbox.metadata === null ? null : { ...inbox.metadata },
    expiresAt: toIso(inbox.expiresAt),
    createdAt: toIso(inbox.createdAt),
  };
}

/** `GET /v1/suppressions` and friends. Small enough to live beside the inbox. */
export const suppressionDto = z.object({
  address: z.string(),
  reason: z.enum(["hard_bounce", "soft_bounce", "complaint", "manual"]),
  source: z.enum(["cf_sync", "local"]),
  createdAt: z.string(),
});

export type SuppressionDto = z.infer<typeof suppressionDto>;

export const addSuppressionBody = z.strictObject({
  address: emailAddress,
  reason: z.enum(["hard_bounce", "soft_bounce", "complaint", "manual"]).optional(),
});

export type AddSuppressionBody = z.infer<typeof addSuppressionBody>;
