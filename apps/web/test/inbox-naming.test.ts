import { env, SELF } from "cloudflare:test";
import type { ErrorResponse, InboxDto } from "@mailworker/contract";
import { createDb, schema } from "@web/workers/adapters";
import { beforeEach, describe, expect, it } from "vitest";

const ADMIN_KEY = "test-bootstrap-key";
const DOMAIN = "mail.example.com";

const db = createDb(env.DB);

beforeEach(async () => {
  await db.batch([
    db.delete(schema.messages),
    db.delete(schema.inboxes),
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

async function create(body: Record<string, unknown>): Promise<Response> {
  return await SELF.fetch("https://mailworker.test/v1/inboxes", {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    body: JSON.stringify({ domain: DOMAIN, ...body }),
  });
}

describe("naming an inbox", () => {
  it("uses localPart verbatim", async () => {
    const response = await create({ localPart: "support" });

    expect(response.status).toBe(201);
    expect(((await response.json()) as InboxDto).address).toBe(`support@${DOMAIN}`);
  });

  it("still appends a random suffix to a prefix", async () => {
    const response = await create({ prefix: "support" });
    const address = ((await response.json()) as InboxDto).address;

    expect(address).toMatch(new RegExp(`^support-[0-9a-f]+@${DOMAIN}$`));
    expect(address).not.toBe(`support@${DOMAIN}`);
  });

  it("refuses a name that is already in use", async () => {
    await create({ localPart: "support" });

    const clash = await create({ localPart: "support" });

    expect(clash.status).toBe(409);
    expect(((await clash.json()) as ErrorResponse).error.code).toBe("address_taken");
  });

  it("frees the name again once the inbox is deleted", async () => {
    const created = (await (await create({ localPart: "support" })).json()) as InboxDto;
    const deleted = await SELF.fetch(`https://mailworker.test/v1/inboxes/${created.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(deleted.status).toBe(204);

    const again = await create({ localPart: "support" });

    expect(again.status).toBe(201);
    expect(((await again.json()) as InboxDto).address).toBe(`support@${DOMAIN}`);
  });

  it("rejects localPart together with prefix", async () => {
    const response = await create({ localPart: "support", prefix: "support" });

    expect(response.status).toBe(400);
  });

  it("rejects a localPart that is not a local part", async () => {
    expect((await create({ localPart: "sup port" })).status).toBe(400);
    expect((await create({ localPart: "support@elsewhere.test" })).status).toBe(400);
    expect((await create({ localPart: "support+tag" })).status).toBe(400);
  });
});
