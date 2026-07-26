import {
  createIdentityBody,
  createKeyBody,
  createWebhookBody,
  toAgentIdentityDto,
  toApiKeyDto,
  toWebhookDto,
} from "@mailworker/contract";
import type { DomainEventType } from "@mailworker/core";
import { Ulid } from "@mailworker/core";
import type { HttpEnv } from "@web/workers/http/env";
import { compact, invalid } from "@web/workers/http/errors";
import { Hono } from "hono";

/**
 * `/v1/identities` — who an agent is allowed to be.
 *
 * The whole context is `admin`-only, and that is the point rather than an
 * oversight: an identity's limits are exactly what the thing acting as it must
 * not be able to widen. If the credential that creates identities were the same
 * one that acts as them, the quota would be a suggestion.
 */
export const identities = new Hono<HttpEnv>()

  .post("/", async (c) => {
    const parsed = createIdentityBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return invalid(c, parsed.error);

    const identity = await c.var.services.identity.createIdentity(
      c.var.caller,
      compact(parsed.data),
    );
    return c.json(toAgentIdentityDto(identity), 201);
  })

  .get("/", async (c) => {
    const all = await c.var.services.identity.listIdentities(c.var.caller);
    return c.json({ items: all.map(toAgentIdentityDto) });
  });

/**
 * `/v1/keys` — the credentials themselves.
 *
 * `POST` is the only response in the entire API that contains a secret, and the
 * only time that secret exists anywhere: what is stored is a hash. There is no
 * endpoint to read it back, by construction rather than by omission.
 */
export const keys = new Hono<HttpEnv>()

  .post("/", async (c) => {
    const parsed = createKeyBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return invalid(c, parsed.error);

    const { expiresAt, ...rest } = parsed.data;
    const minted = await c.var.services.identity.createKey(
      c.var.caller,
      compact({
        ...rest,
        expiresAt: expiresAt === undefined ? undefined : new Date(expiresAt),
      }),
    );
    return c.json({ ...toApiKeyDto(minted.key), token: minted.token }, 201);
  })

  .get("/", async (c) => {
    const all = await c.var.services.identity.listKeys(c.var.caller);
    return c.json({ items: all.map(toApiKeyDto) });
  })

  /**
   * Revoke, not delete. The row survives so `lastUsedAt` and the audit trail
   * survive with it — the question after a leak is what the key did before
   * anyone noticed, and deleting the row is how that becomes unanswerable.
   */
  .delete("/:id", async (c) => {
    const key = await c.var.services.identity.revokeKey(
      c.var.caller,
      Ulid.parse(c.req.param("id")),
    );
    return c.json(toApiKeyDto(key));
  });

export const webhooks = new Hono<HttpEnv>()

  .post("/", async (c) => {
    const parsed = createWebhookBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return invalid(c, parsed.error);

    const subscription = await c.var.services.delivery.createWebhook(
      c.var.caller,
      compact({
        url: parsed.data.url,
        events: parsed.data.events as DomainEventType[] | undefined,
      }),
    );
    // The secret is included here and nowhere else. Unlike an API key it is
    // stored in the clear — signing needs the secret itself and both ends must
    // hold the same one — but showing it on every list would put it in far more
    // logs and screenshots than it needs to be in.
    return c.json({ ...toWebhookDto(subscription), secret: subscription.secret }, 201);
  })

  .get("/", async (c) => {
    const all = await c.var.services.delivery.listWebhooks(c.var.caller);
    return c.json({ items: all.map(toWebhookDto) });
  })

  .delete("/:id", async (c) => {
    await c.var.services.delivery.deleteWebhook(c.var.caller, Ulid.parse(c.req.param("id")));
    return c.body(null, 204);
  });
