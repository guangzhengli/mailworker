import { env, SELF } from "cloudflare:test";
import type { AgentIdentityDto, ApiKeyDto, WebhookDto } from "@mailworker/contract";
import { createDb, schema } from "@web/workers/adapters";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * The control plane, end to end.
 *
 * The assertion that matters is not that keys can be created — it is that a
 * key minted through the API then *works as a credential* and is bounded by
 * the scopes it was given. That crosses three things a unit test cannot join
 * up: the hash written to D1, the prefix lookup, and the constant-time verify
 * in the auth middleware. If any one of them disagreed about encoding, this is
 * the only place it would show.
 */

const ADMIN_KEY = "test-bootstrap-key";
const DOMAIN = "mail.example.com";

const db = createDb(env.DB);

beforeEach(async () => {
  await db.batch([
    db.delete(schema.messages),
    db.delete(schema.deliveries),
    db.delete(schema.inboxes),
    db.delete(schema.apiKeys),
    db.delete(schema.agentIdentities),
    db.delete(schema.webhooks),
    db.delete(schema.domains),
  ]);
  await db.insert(schema.domains).values({
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    accountId: "default",
    name: DOMAIN,
    zoneId: null,
    inboundEnabled: true,
    sendingStatus: "verified",
    catchallMode: "reject",
    catchallInbox: null,
    autocreatePattern: null,
    createdAt: new Date().toISOString(),
  });
});

async function api(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return await SELF.fetch(`https://mailworker.test${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

async function mintKey(scopes: string[], identityName?: string): Promise<string> {
  const response = await api("/v1/keys", ADMIN_KEY, {
    method: "POST",
    body: JSON.stringify({
      name: "test key",
      scopes,
      ...(identityName === undefined ? {} : { identityName }),
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as ApiKeyDto & { token: string }).token;
}

describe("api keys", () => {
  it("mints a key that then authenticates", async () => {
    const token = await mintKey(["inbox:read", "message:read"]);

    const response = await api("/v1/inboxes", token);
    expect(response.status).toBe(200);
  });

  it("bounds the key to the scopes it was given", async () => {
    const readOnly = await mintKey(["message:read"]);

    // No `inbox:write`, so minting an address is refused — the credential is
    // narrower than the one that created it, which is the entire point.
    const response = await api("/v1/inboxes", readOnly, {
      method: "POST",
      body: JSON.stringify({ prefix: "nope", domain: DOMAIN }),
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "forbidden",
    );
  });

  it("refuses a revoked key", async () => {
    const token = await mintKey(["inbox:read"]);
    const listed = (await (await api("/v1/keys", ADMIN_KEY)).json()) as { items: ApiKeyDto[] };
    await api(`/v1/keys/${listed.items[0]!.id}`, ADMIN_KEY, { method: "DELETE" });

    const response = await api("/v1/inboxes", token);
    expect(response.status).toBe(401);
  });

  it("never returns the token or the hash again", async () => {
    const token = await mintKey(["inbox:read"]);
    const body = await (await api("/v1/keys", ADMIN_KEY)).text();

    // The PREFIX is expected to be here — it is the public head, and being able
    // to see which key is which is the reason it exists. The secret half must
    // not be, and neither must the hash: asserting both is what stops a future
    // `select *` from quietly putting one on the wire.
    expect(body).toContain("mw_live_");
    expect(body).not.toContain(token);
    expect(body).not.toContain("hash");
  });

  it("refuses a token that is well-formed but unknown", async () => {
    const response = await api("/v1/inboxes", `mw_live_aaaaaa_${"0".repeat(48)}`);
    // Same answer as a wrong secret. Distinguishing the two would turn the
    // prefix into an oracle for which keys exist.
    expect(response.status).toBe(401);
  });
});

describe("agent identities", () => {
  it("makes a bound key act as the identity", async () => {
    const created = await api("/v1/identities", ADMIN_KEY, {
      method: "POST",
      body: JSON.stringify({ name: "bot", dailySendQuota: 3, requireApproval: true }),
    });
    expect(created.status).toBe(201);
    const identity = (await created.json()) as AgentIdentityDto;

    const token = await mintKey(["inbox:write", "message:send"], "bot");
    const listed = (await (await api("/v1/keys", ADMIN_KEY)).json()) as { items: ApiKeyDto[] };
    const bound = listed.items.find((key) => key.identityId !== null);
    expect(bound?.identityId).toBe(identity.id);

    // And the binding is what SendPolicy meters: this identity requires
    // approval, so a send from it must be held rather than queued.
    const inbox = await (
      await api("/v1/inboxes", token, {
        method: "POST",
        body: JSON.stringify({ prefix: "bot", domain: DOMAIN, kind: "persistent" }),
      })
    ).json();

    const send = await api("/v1/send", token, {
      method: "POST",
      body: JSON.stringify({
        from: (inbox as { address: string }).address,
        to: ["someone@elsewhere.test"],
        subject: "Held",
        text: "Body",
      }),
    });
    const result = (await send.json()) as { outcome: string };
    expect(result.outcome).toBe("pending_approval");
  });

  it("refuses to bind an admin key to an identity", async () => {
    await api("/v1/identities", ADMIN_KEY, {
      method: "POST",
      body: JSON.stringify({ name: "bot" }),
    });

    const response = await api("/v1/keys", ADMIN_KEY, {
      method: "POST",
      body: JSON.stringify({ name: "oops", scopes: ["admin"], identityName: "bot" }),
    });
    // An admin key could edit the identity's own limits, so the metering would
    // be something the metered party can switch off.
    expect(response.status).toBe(400);
  });
});

describe("webhooks", () => {
  it("returns the signing secret once and never lists it", async () => {
    const created = await api("/v1/webhooks", ADMIN_KEY, {
      method: "POST",
      body: JSON.stringify({ url: "https://example.test/hook" }),
    });
    expect(created.status).toBe(201);
    const subscription = (await created.json()) as WebhookDto & { secret: string };
    expect(subscription.secret).toMatch(/^whsec_/);

    const listed = await (await api("/v1/webhooks", ADMIN_KEY)).text();
    expect(listed).not.toContain(subscription.secret);
  });

  it("rejects a plain-http endpoint", async () => {
    const response = await api("/v1/webhooks", ADMIN_KEY, {
      method: "POST",
      body: JSON.stringify({ url: "http://example.test/hook" }),
    });
    // The payload carries subjects and recipients; the signature proves origin,
    // not confidentiality.
    expect(response.status).toBe(400);
  });
});
