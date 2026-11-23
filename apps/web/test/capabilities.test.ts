import { env, SELF } from "cloudflare:test";
import type { AgentIdentityDto, ApiKeyDto, CapabilitiesDto } from "@mailworker/contract";
import { capabilitiesDto } from "@mailworker/contract";
import { createDb, schema } from "@web/workers/adapters";
import { beforeEach, describe, expect, it } from "vitest";

const ADMIN_KEY = "test-bootstrap-key";
const DOMAIN = "mail.example.com";
const db = createDb(env.DB);

beforeEach(async () => {
  await db.batch([
    db.delete(schema.apiKeys),
    db.delete(schema.agentIdentities),
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

describe("GET /v1/capabilities", () => {
  it("lets any valid key discover its own effective boundary", async () => {
    const identityResponse = await api("/v1/identities", ADMIN_KEY, {
      method: "POST",
      body: JSON.stringify({ name: "reader", dailySendQuota: 3, requireApproval: true }),
    });
    const identity = (await identityResponse.json()) as AgentIdentityDto;

    const keyResponse = await api("/v1/keys", ADMIN_KEY, {
      method: "POST",
      body: JSON.stringify({
        name: "reader key",
        scopes: ["message:read"],
        identityName: "reader",
      }),
    });
    const token = ((await keyResponse.json()) as ApiKeyDto & { token: string }).token;

    const response = await api("/v1/capabilities", token);
    expect(response.status).toBe(200);
    const body = capabilitiesDto.parse(await response.json()) as CapabilitiesDto;

    expect(body.environment).toEqual({ id: "default", mode: "live" });
    expect(body.principal.identity).toMatchObject({
      id: identity.id,
      name: "reader",
      dailySendQuota: 3,
      requireApproval: true,
    });
    expect(body.principal.scopes).toEqual(["message:read"]);
    expect(body.actions).toMatchObject({
      readMessages: true,
      annotateMessages: true,
      createInboxes: false,
      injectMessages: false,
      sendMessages: false,
      administer: false,
    });
    expect(body.domains).toEqual([
      { domain: DOMAIN, sendingStatus: "verified", catchAllMode: "reject" },
    ]);
    expect(body.limits.maxRecipients).toBe(50);
    expect(body.limits.maxInboundMessageBytes).toBe(25 * 1024 * 1024);
    expect(body.limits.maxOutboundMessageBytes).toBe(5 * 1024 * 1024);
    expect(body.features).toMatchObject({ receiving: true, labels: true, notes: true });
    expect(body.features.sending).toBe(false);
  });

  it("does not advertise annotation for a key without message:read", async () => {
    const key = await api("/v1/keys", ADMIN_KEY, {
      method: "POST",
      body: JSON.stringify({ name: "inbox reader", scopes: ["inbox:read"] }),
    });
    const { token } = (await key.json()) as { token: string };
    const response = await api("/v1/capabilities", token);
    expect(capabilitiesDto.parse(await response.json()).actions.annotateMessages).toBe(false);
  });

  it("reports bootstrap administration without exposing the secret", async () => {
    const response = await api("/v1/capabilities", ADMIN_KEY);
    const body = capabilitiesDto.parse(await response.json());

    expect(body.actions.administer).toBe(true);
    expect(body.actions.approveMessages).toBe(true);
    expect(body.principal.subject).toBe("key:bootstrap");
    expect(JSON.stringify(body)).not.toContain(ADMIN_KEY);
  });
});
