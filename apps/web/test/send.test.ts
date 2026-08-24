import { env, SELF } from "cloudflare:test";
import type {
  AgentIdentityDto,
  ApiKeyDto,
  DeliveryTimelineDto,
  InboxDto,
  SendBatchResponse,
  SendResponse,
} from "@mailworker/contract";
import { createDb, schema } from "@web/workers/adapters";
import { toProviderEvent } from "@web/workers/queue";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * The outbound half, against a real D1.
 *
 * There is no `send_email` binding here — deliberately. The test environment is
 * the same shape as a Free-plan deployment: it can receive, and a send gets as
 * far as a durable decision and then stops. That covers everything up to the
 * network call, which is exactly the part with rules in it: idempotency, the
 * policy gates, the state machine, the approval hold.
 */

const ADMIN_KEY = "test-bootstrap-key";
const DOMAIN = "mail.example.com";

const db = createDb(env.DB);

beforeEach(async () => {
  await db.batch([
    db.delete(schema.attachments),
    db.delete(schema.messages),
    db.delete(schema.deliveryEvents),
    db.delete(schema.dispatchOutbox),
    db.delete(schema.deliveries),
    db.delete(schema.inboxes),
    db.delete(schema.apiKeys),
    db.delete(schema.agentIdentities),
    db.delete(schema.suppressions),
    db.delete(schema.domains),
  ]);
  const blobs = await env.BLOBS.list();
  if (blobs.objects.length > 0) await env.BLOBS.delete(blobs.objects.map((item) => item.key));
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

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return await apiAs(ADMIN_KEY, path, init);
}

async function apiAs(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return await SELF.fetch(`https://mailworker.test${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

async function createInbox(): Promise<InboxDto> {
  const response = await api("/v1/inboxes", {
    method: "POST",
    body: JSON.stringify({ prefix: "agent", domain: DOMAIN, kind: "persistent" }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as InboxDto;
}

async function post(
  from: string,
  body: Record<string, unknown> = {},
  headers: HeadersInit = {},
) {
  const response = await api("/v1/send", {
    method: "POST",
    headers,
    body: JSON.stringify({
      from,
      to: ["someone@elsewhere.test"],
      subject: "Hello",
      text: "Body",
      ...body,
    }),
  });
  return { response, body: (await response.json()) as SendResponse };
}

describe("POST /v1/send", () => {
  it("answers 202 with a durable decision, not a delivery", async () => {
    const inbox = await createInbox();
    const { response, body } = await post(inbox.address);

    // 202, because nothing has been delivered. At this moment the provider has
    // not even been called; a 200 would claim more than we know.
    expect(response.status).toBe(202);
    expect(body.outcome).toBe("queued");
    expect(body.delivery.status).toBe("queued");
    expect(body.delivery.recipients).toEqual(["someone@elsewhere.test"]);
  });

  it("returns the original send for a repeated Idempotency-Key", async () => {
    const inbox = await createInbox();
    const first = await post(inbox.address, {}, { "Idempotency-Key": "abc-123" });
    const second = await post(inbox.address, {}, { "Idempotency-Key": "abc-123" });

    // Same delivery, and NOT re-sent — a caller retrying after a timeout gets
    // the first submission back rather than a second message going out. The
    // The same request returns its durable original decision.
    expect(second.body.outcome).toBe("duplicate");
    expect(second.response.status).toBe(200);
    expect(second.body.delivery.id).toBe(first.body.delivery.id);
  });

  it("collapses concurrent Idempotency-Key requests without orphan rows or blobs", async () => {
    const inbox = await createInbox();
    const init: RequestInit = {
      method: "POST",
      headers: { "Idempotency-Key": "parallel-http-1" },
      body: JSON.stringify({
        from: inbox.address,
        to: ["someone@elsewhere.test"],
        subject: "Exactly once",
        text: "One accepted intent.",
      }),
    };

    const responses = await Promise.all([api("/v1/send", init), api("/v1/send", init)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 202]);
    const bodies = (await Promise.all(responses.map((response) => response.json()))) as Array<{
      delivery: { id: string };
    }>;
    expect(new Set(bodies.map((body) => body.delivery.id)).size).toBe(1);
    expect(await db.select().from(schema.deliveries)).toHaveLength(1);
    // Publication alone is not completion; the durable task stays until the
    // consumer records provider hand-off and archives the sent copy.
    expect(await db.select().from(schema.dispatchOutbox)).toHaveLength(1);
    expect((await env.BLOBS.list({ prefix: "out/default/" })).objects).toHaveLength(1);
  });

  it("returns 409 when an idempotency key is reused for different mail", async () => {
    const inbox = await createInbox();
    const request = (subject: string) => ({
      method: "POST",
      headers: { "Idempotency-Key": "http-conflict-1" },
      body: JSON.stringify({
        from: inbox.address,
        to: ["someone@elsewhere.test"],
        subject,
        text: subject,
      }),
    });
    expect((await api("/v1/send", request("First"))).status).toBe(202);
    const conflict = await api("/v1/send", request("Different"));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { code: "idempotency_conflict" },
    });
  });

  it("atomically reserves a one-message identity quota across concurrent requests", async () => {
    const identityResponse = await api("/v1/identities", {
      method: "POST",
      body: JSON.stringify({ name: "limited", dailySendQuota: 1 }),
    });
    expect(identityResponse.status).toBe(201);
    const identity = (await identityResponse.json()) as AgentIdentityDto;
    const keyResponse = await api("/v1/keys", {
      method: "POST",
      body: JSON.stringify({
        name: "limited key",
        identityName: identity.name,
        scopes: ["inbox:write", "message:send"],
      }),
    });
    const token = ((await keyResponse.json()) as ApiKeyDto & { token: string }).token;
    const inboxResponse = await apiAs(token, "/v1/inboxes", {
      method: "POST",
      body: JSON.stringify({ prefix: "limited", domain: DOMAIN, kind: "persistent" }),
    });
    const inbox = (await inboxResponse.json()) as InboxDto;
    const request = (key: string): RequestInit => ({
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify({
        from: inbox.address,
        to: ["someone@elsewhere.test"],
        subject: key,
        text: "Only one slot.",
      }),
    });

    const responses = await Promise.all([
      apiAs(token, "/v1/send", request("quota-http-a")),
      apiAs(token, "/v1/send", request("quota-http-b")),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([202, 429]);
    const refused = responses.find((response) => response.status === 429)!;
    expect((await refused.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "quota_exceeded" },
    });
    expect(await db.select().from(schema.deliveries)).toHaveLength(1);
    expect(await db.select().from(schema.dispatchOutbox)).toHaveLength(1);
    expect((await env.BLOBS.list({ prefix: "out/default/" })).objects).toHaveLength(1);
  });

  it("refuses to send from an address no inbox owns", async () => {
    const { response, body } = await post("stranger@mail.example.com");
    expect(response.status).toBe(404);
    // Not just "unknown sender": there is nowhere for the reply to land, and
    // Cloudflare would refuse the send anyway.
    expect((body as unknown as { error: { code: string } }).error.code).toBe("inbox_not_found");
  });

  it("refuses a suppressed recipient before the provider is called", async () => {
    const inbox = await createInbox();
    await api("/v1/suppressions", {
      method: "POST",
      body: JSON.stringify({ address: "bounced@elsewhere.test", reason: "hard_bounce" }),
    });

    const response = await api("/v1/send", {
      method: "POST",
      body: JSON.stringify({
        from: inbox.address,
        to: ["bounced@elsewhere.test"],
        subject: "Hello again",
        text: "Body",
      }),
    });

    // Refusing locally keeps a doomed attempt off the account's sending
    // reputation, and an API-level rejection does not consume quota.
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("suppressed_recipient");
  });
});

describe("POST /v1/send/batch", () => {
  async function batch(messages: Record<string, unknown>[]) {
    const response = await api("/v1/send/batch", {
      method: "POST",
      body: JSON.stringify({ messages }),
    });
    return { response, body: (await response.json()) as SendBatchResponse };
  }

  it("answers 207 with one item per message", async () => {
    const inbox = await createInbox();
    const { response, body } = await batch([
      { from: inbox.address, to: ["a@elsewhere.test"], subject: "One", text: "x" },
      { from: inbox.address, to: ["b@elsewhere.test"], subject: "Two", text: "y" },
    ]);

    // 207 even when everything succeeded. A status that varied with the
    // contents would mean a client had to handle three shapes on the happy
    // path, and the failure mode of getting that wrong is silently dropping the
    // one message a gate refused.
    expect(response.status).toBe(207);
    expect(body.accepted).toBe(2);
    expect(body.failed).toBe(0);
    expect(body.items.map((item) => item.index)).toEqual([0, 1]);
  });

  it("reports a per-message refusal without failing the batch", async () => {
    const inbox = await createInbox();
    await api("/v1/suppressions", {
      method: "POST",
      body: JSON.stringify({ address: "bounced@elsewhere.test", reason: "hard_bounce" }),
    });

    const { response, body } = await batch([
      { from: inbox.address, to: ["fine@elsewhere.test"], subject: "One", text: "x" },
      { from: inbox.address, to: ["bounced@elsewhere.test"], subject: "Two", text: "y" },
    ]);

    expect(response.status).toBe(207);
    expect(body.accepted).toBe(1);
    expect(body.failed).toBe(1);
    const failure = body.items[1];
    if (failure?.outcome !== "error") throw new Error("expected an error item");
    expect(failure.error.code).toBe("suppressed_recipient");
  });

  it("rejects the whole request when the batch is over the cap", async () => {
    const inbox = await createInbox();
    const { response } = await batch(
      Array.from({ length: 101 }, (_, i) => ({
        from: inbox.address,
        to: ["a@elsewhere.test"],
        subject: `#${i}`,
        text: "x",
      })),
    );
    // Schema-level, so nothing is sent. A partial prefix of a batch the caller
    // did not ask for would be the worst available answer.
    expect(response.status).toBe(400);
  });
});

describe("attachments and metadata", () => {
  it("round-trips both onto the delivery record", async () => {
    const inbox = await createInbox();
    const { response, body } = await post(inbox.address, {
      attachments: [{ filename: "report.csv", type: "text/csv", content: "aGVsbG8=" }],
      metadata: { tenant: "acme", orderId: "A-1" },
    });

    expect(response.status).toBe(202);
    expect(body.delivery.metadata).toEqual({ tenant: "acme", orderId: "A-1" });

    // Metadata is on the row, so it survives a fresh read — which is what a
    // bounce handler days later actually does.
    const reread = await api(`/v1/send/${body.delivery.id}`);
    const timeline = (await reread.json()) as DeliveryTimelineDto;
    expect(timeline.delivery.metadata).toEqual({ tenant: "acme", orderId: "A-1" });
  });

  it("refuses content that is not base64", async () => {
    const inbox = await createInbox();
    const { response } = await post(inbox.address, {
      attachments: [{ filename: "bad.bin", content: "not base64!!" }],
    });
    // At the boundary, not inside the queue consumer twenty seconds later where
    // nobody is listening.
    expect(response.status).toBe(400);
  });

  it("refuses a message over the size limit", async () => {
    const inbox = await createInbox();
    const { response, body } = await post(inbox.address, {
      attachments: [{ filename: "big.bin", content: "A".repeat(6 * 1024 * 1024) }],
    });
    expect(response.status).toBe(413);
    expect((body as unknown as { error: { code: string } }).error.code).toBe(
      "message_too_large",
    );
  });
});

describe("GET /v1/send/:id", () => {
  it("returns the delivery with an empty timeline before anything happens", async () => {
    const inbox = await createInbox();
    const { body } = await post(inbox.address);

    const timeline = (await (
      await api(`/v1/send/${body.delivery.id}`)
    ).json()) as DeliveryTimelineDto;

    expect(timeline.delivery.id).toBe(body.delivery.id);
    // Empty is the correct answer, not a missing one: the provider has not said
    // anything yet, which is the whole reason this endpoint exists separately
    // from the send response.
    expect(timeline.events).toEqual([]);
  });
});

describe("POST /v1/send/:id/approve", () => {
  async function createPendingSend(): Promise<{ deliveryId: string }> {
    const name = `reviewed-${crypto.randomUUID()}`;
    const identityResponse = await api("/v1/identities", {
      method: "POST",
      body: JSON.stringify({ name, requireApproval: true }),
    });
    expect(identityResponse.status).toBe(201);

    const keyResponse = await api("/v1/keys", {
      method: "POST",
      body: JSON.stringify({
        name: `key-${name}`,
        scopes: ["inbox:write", "message:send"],
        identityName: name,
      }),
    });
    expect(keyResponse.status).toBe(201);
    const token = ((await keyResponse.json()) as { token: string }).token;
    const withAgentKey = async (path: string, init: RequestInit) =>
      await SELF.fetch(`https://mailworker.test${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      });

    const inboxResponse = await withAgentKey("/v1/inboxes", {
      method: "POST",
      body: JSON.stringify({
        prefix: `reviewed-${crypto.randomUUID().slice(0, 8)}`,
        domain: DOMAIN,
        kind: "persistent",
      }),
    });
    expect(inboxResponse.status).toBe(201);
    const inbox = (await inboxResponse.json()) as InboxDto;

    const sendResponse = await withAgentKey("/v1/send", {
      method: "POST",
      body: JSON.stringify({
        from: inbox.address,
        to: ["someone@elsewhere.test"],
        subject: "Please review",
        text: "Body",
      }),
    });
    expect(sendResponse.status).toBe(202);
    const pending = (await sendResponse.json()) as SendResponse;
    expect(pending.outcome).toBe("pending_approval");
    return { deliveryId: pending.delivery.id };
  }

  it("queues a held send after one human approval", async () => {
    const { deliveryId } = await createPendingSend();

    const response = await api(`/v1/send/${deliveryId}/approve`, { method: "POST" });

    expect(response.status).toBe(200);
    expect((await response.json()) as SendResponse["delivery"]).toMatchObject({
      id: deliveryId,
      status: "queued",
      approvedBy: "key:bootstrap",
    });
  });

  it("returns 409 for a repeated approval and leaves one queued decision", async () => {
    const { deliveryId } = await createPendingSend();
    expect((await api(`/v1/send/${deliveryId}/approve`, { method: "POST" })).status).toBe(200);

    const repeated = await api(`/v1/send/${deliveryId}/approve`, { method: "POST" });

    expect(repeated.status).toBe(409);
    expect((await repeated.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "invalid_state_transition" },
    });
    const timeline = (await (
      await api(`/v1/send/${deliveryId}`)
    ).json()) as DeliveryTimelineDto;
    expect(timeline.delivery.status).toBe("queued");
  });

  it("records a human rejection and cannot later approve it", async () => {
    const { deliveryId } = await createPendingSend();
    const response = await api(`/v1/send/${deliveryId}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason: "Recipient is outside this task" }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as SendResponse["delivery"]).toMatchObject({
      id: deliveryId,
      status: "rejected",
    });
    expect((await api(`/v1/send/${deliveryId}/approve`, { method: "POST" })).status).toBe(409);
  });
});

describe("suppressions", () => {
  it("round-trips an address through the list", async () => {
    await api("/v1/suppressions", {
      method: "POST",
      body: JSON.stringify({ address: "nope@elsewhere.test" }),
    });

    const listed = (await (await api("/v1/suppressions")).json()) as {
      items: { address: string; reason: string; source: string }[];
    };
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      address: "nope@elsewhere.test",
      reason: "manual",
      source: "local",
    });

    await api(`/v1/suppressions/${encodeURIComponent("nope@elsewhere.test")}`, {
      method: "DELETE",
    });
    const after = (await (await api("/v1/suppressions")).json()) as { items: unknown[] };
    // Removable on purpose. An address can be fixed, and a list with no way out
    // becomes a list of people you have permanently stopped talking to.
    expect(after.items).toEqual([]);
  });
});

/**
 * The event envelope is the one input we neither generate nor validate at a
 * schema boundary, and a `TypeError` here becomes an infinite retry rather than
 * a stack trace anyone reads. So it is tested as a parser, in isolation.
 */
describe("toProviderEvent", () => {
  it("flattens a delivered event", () => {
    const body = {
      type: "cf.email.sending.message.delivered",
      source: { type: "email.sending", zoneId: "zone-1", domain: DOMAIN },
      payload: {
        eventId: "0190d0c4-7e9a-7b3c-9f12-1a2b3c4d5e6f",
        messageId: "cf-abc",
        sender: `agent@${DOMAIN}`,
        recipient: "someone@elsewhere.test",
        subject: "Hello",
        terminal: true,
        delivery: {
          status: "delivered",
          provider: "gmail",
          deliveryTimeMs: 1234,
          smtpStatusCode: "250",
          smtpEnhancedStatusCode: "2.0.0",
          smtpResponse: "250 2.0.0 OK",
        },
      },
      metadata: {
        accountId: "cf-account",
        eventSubscriptionId: "subscription-1",
        eventSchemaVersion: 1,
        eventTimestamp: "2026-07-01T12:00:00.000Z",
      },
    };
    const event = toProviderEvent(body);

    expect(event).toMatchObject({
      eventId: "0190d0c4-7e9a-7b3c-9f12-1a2b3c4d5e6f",
      type: "delivered",
      providerMessageId: "cf-abc",
      recipient: "someone@elsewhere.test",
      sourceDomain: DOMAIN,
      sourceZoneId: "zone-1",
      terminal: true,
      smtpCode: "250",
      smtpEnhancedCode: "2.0.0",
      smtpResponse: "250 2.0.0 OK",
    });
    expect(event?.occurredAt.toISOString()).toBe("2026-07-01T12:00:00.000Z");
    expect(event?.raw).toBe(JSON.stringify(body));
  });

  it("reads bounce classification and nested SMTP fields", () => {
    const event = toProviderEvent({
      type: "cf.email.sending.message.bounced",
      source: { type: "email.sending", zoneId: "zone-1", domain: DOMAIN },
      payload: {
        eventId: "event-bounce",
        messageId: "cf-x",
        sender: `agent@${DOMAIN}`,
        recipient: "someone@elsewhere.test",
        terminal: true,
        delivery: {
          status: "bounced",
          smtpStatusCode: "550",
          smtpEnhancedStatusCode: "5.1.1",
          smtpResponse: "550 5.1.1 User unknown",
        },
        bounce: {
          type: "hard",
          classification: "permanent_failure",
          reason: "550 5.1.1 User unknown",
        },
      },
      metadata: {
        accountId: "cf-account",
        eventSubscriptionId: "subscription-1",
        eventSchemaVersion: 1,
        eventTimestamp: "2026-07-01T12:00:00.000Z",
      },
    });

    expect(event).toMatchObject({
      smtpCode: "550",
      smtpEnhancedCode: "5.1.1",
      bounceType: "hard",
      bounceClassification: "permanent_failure",
      bounceReason: "550 5.1.1 User unknown",
    });
  });

  it("uses payload.terminal for a failed event", () => {
    const failed = (terminal: boolean) =>
      toProviderEvent({
        type: "cf.email.sending.message.failed",
        source: { type: "email.sending", zoneId: "zone-1", domain: DOMAIN },
        payload: {
          eventId: `event-failed-${terminal}`,
          messageId: "cf-failed",
          sender: `agent@${DOMAIN}`,
          recipient: "someone@elsewhere.test",
          terminal,
          delivery: { status: "failed" },
          failure: { reason: "delivery_failed" },
        },
        metadata: {
          accountId: "cf-account",
          eventSubscriptionId: "subscription-1",
          eventSchemaVersion: 1,
          eventTimestamp: "2026-07-01T12:00:00.000Z",
        },
      });

    expect(failed(false)?.terminal).toBe(false);
    expect(failed(true)?.terminal).toBe(true);
  });

  it("returns null for unknown or malformed v1 envelopes", () => {
    // Acked rather than retried by the consumer. Cloudflare may add event
    // types, and a message we will never understand would otherwise cycle
    // through every retry and land in the DLQ on every deploy.
    expect(toProviderEvent({ type: "cf.email.sending.message.invented" })).toBeNull();
    expect(toProviderEvent({ type: "cf.email.sending.message.delivered" })).toBeNull();
    expect(
      toProviderEvent({
        type: "cf.email.sending.message.delivered",
        payload: { messageId: "old-flat-shape", timestamp: "2026-07-01T12:00:00Z" },
      }),
    ).toBeNull();
    expect(toProviderEvent("not an object")).toBeNull();
    expect(toProviderEvent(null)).toBeNull();
  });
});
