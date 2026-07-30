import { env, SELF } from "cloudflare:test";
import type {
  DeliveryTimelineDto,
  InboxDto,
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
    db.delete(schema.deliveries),
    db.delete(schema.inboxes),
    db.delete(schema.suppressions),
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

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return await SELF.fetch(`https://mailworker.test${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${ADMIN_KEY}`, ...(init.headers ?? {}) },
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
    const second = await post(
      inbox.address,
      { subject: "Different subject entirely" },
      { "Idempotency-Key": "abc-123" },
    );

    // Same delivery, and NOT re-sent — a caller retrying after a timeout gets
    // the first submission back rather than a second message going out. The
    // changed subject is ignored on purpose: the key identifies the intent.
    expect(second.body.outcome).toBe("duplicate");
    expect(second.response.status).toBe(200);
    expect(second.body.delivery.id).toBe(first.body.delivery.id);
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
    const event = toProviderEvent({
      type: "cf.email.sending.message.delivered",
      payload: {
        messageId: "cf-abc",
        recipient: "someone@elsewhere.test",
        timestamp: "2026-07-01T12:00:00.000Z",
        smtpCode: "250",
      },
    });

    expect(event).toMatchObject({
      type: "delivered",
      providerMessageId: "cf-abc",
      recipient: "someone@elsewhere.test",
      terminal: true,
      smtpCode: "250",
    });
    expect(event?.occurredAt.toISOString()).toBe("2026-07-01T12:00:00.000Z");
  });

  it("treats deferred and failed as non-terminal", () => {
    // A deferral is the receiving host saying "later", and a failure may still
    // be retried by the provider. Marking either terminal would freeze the
    // state machine before the real outcome arrived.
    for (const type of ["deferred", "failed"]) {
      const event = toProviderEvent({
        type: `cf.email.sending.message.${type}`,
        payload: { messageId: "cf-abc" },
      });
      expect(event?.terminal).toBe(false);
    }
  });

  it("keeps the provider payload verbatim", () => {
    const body = {
      type: "cf.email.sending.message.bounced",
      payload: { messageId: "cf-x", response: "550 5.1.1 no such user" },
    };
    // When a bounce happens for a reason our mapping did not anticipate, the
    // response the receiving host actually gave is the only thing that answers
    // why. A reconstruction is not evidence.
    expect(toProviderEvent(body)?.raw).toBe(JSON.stringify(body));
  });

  it("returns null for anything it does not recognise", () => {
    // Acked rather than retried by the consumer. Cloudflare may add event
    // types, and a message we will never understand would otherwise cycle
    // through every retry and land in the DLQ on every deploy.
    expect(toProviderEvent({ type: "cf.email.sending.message.invented" })).toBeNull();
    expect(toProviderEvent({ type: "cf.email.sending.message.delivered" })).toBeNull();
    expect(toProviderEvent("not an object")).toBeNull();
    expect(toProviderEvent(null)).toBeNull();
  });
});
