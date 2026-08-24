import type { DeliveryService, SendMessageRequest } from "@core/application";
import type { AgentIdentity } from "@core/domain";
import { eventsOfType, AgentIdentity as Identity, SENDING_LIMITS } from "@core/domain";
import type { Harness } from "@core/testing";
import { createHarness, TEST_DOMAIN } from "@core/testing";
import { beforeEach, describe, expect, it } from "vitest";

let h: Harness;
let sendBatch: DeliveryService["sendBatch"];
const FROM = `agent@${TEST_DOMAIN}`;

beforeEach(async () => {
  h = createHarness();
  sendBatch = h.services.delivery.sendBatch;
  await h.seedInbox(FROM);
});

async function seedIdentity(
  overrides: Partial<Parameters<typeof Identity.create>[0]> = {},
): Promise<AgentIdentity> {
  const identity = Identity.create({
    id: h.ids.ulid(),
    accountId: h.ctx.accountId,
    name: "reporter",
    now: h.clock.now(),
    ...overrides,
  });
  await h.deps.identities.insert(h.ctx, identity);
  return identity;
}

const message = (overrides: Partial<SendMessageRequest> = {}): SendMessageRequest => ({
  from: FROM,
  to: ["user@corp.com"],
  subject: "Report",
  text: "Body",
  ...overrides,
});

describe("delivery.sendBatch", () => {
  it("queues every message and reports one item each, in order", async () => {
    const items = await sendBatch(h.ctx, [
      message({ subject: "One" }),
      message({ subject: "Two" }),
      message({ subject: "Three" }),
    ]);

    expect(items).toHaveLength(3);
    expect(items.map((item) => item.index)).toEqual([0, 1, 2]);
    expect(items.every((item) => item.outcome === "queued")).toBe(true);
    expect(h.dispatchQueue.enqueued).toHaveLength(3);
    expect(eventsOfType(h.events.published, "delivery.queued")).toHaveLength(3);
  });

  it("sends the rest when one message is refused", async () => {
    await h.deps.suppressions.add(h.ctx, {
      address: "bounced@corp.com" as never,
      reason: "hard_bounce",
      source: "local",
      createdAt: h.clock.now(),
    });

    const items = await sendBatch(h.ctx, [
      message({ subject: "Fine" }),
      message({ subject: "Doomed", to: ["bounced@corp.com"] }),
      message({ subject: "Also fine" }),
    ]);

    // Partial success. Failing the whole batch would leave two good messages
    // unsent, and there is nothing to roll back anyway.
    expect(items[0]?.outcome).toBe("queued");
    expect(items[1]).toMatchObject({
      index: 1,
      outcome: "error",
      code: "suppressed_recipient",
    });
    expect(items[2]?.outcome).toBe("queued");
    expect(h.dispatchQueue.enqueued).toHaveLength(2);
  });

  it("meters quota across the batch rather than against a stale count", async () => {
    // The reason `sendBatch` is sequential. Run concurrently, all five would
    // read the same pre-batch count of 0 and a quota of 2 would admit all five.
    const identity = await seedIdentity({ dailySendQuota: 2 });
    const ctx = h.asIdentity(identity.id);
    const inbox = await h.seedInbox(`metered@${TEST_DOMAIN}`, { identityId: identity.id });

    const items = await sendBatch(
      ctx,
      Array.from({ length: 5 }, () => message({ from: inbox.address })),
    );

    expect(items.filter((item) => item.outcome === "queued")).toHaveLength(2);
    const refused = items.filter((item) => item.outcome === "error");
    expect(refused).toHaveLength(3);
    expect(
      refused.every((item) => item.outcome === "error" && item.code === "quota_exceeded"),
    ).toBe(true);
  });

  it("dedupes within a batch by idempotency key", async () => {
    const items = await sendBatch(h.ctx, [
      message({ idempotencyKey: "run-1" }),
      message({ idempotencyKey: "run-1" }),
    ]);

    expect(items[0]?.outcome).toBe("queued");
    expect(items[1]?.outcome).toBe("duplicate");
    expect(h.dispatchQueue.enqueued).toHaveLength(1);
  });

  it("holds an approval-gated message as its own item", async () => {
    const identity = await seedIdentity({ requireApproval: true });
    const inbox = await h.seedInbox(`reviewed@${TEST_DOMAIN}`, { identityId: identity.id });
    const items = await sendBatch(h.asIdentity(identity.id), [
      message({ from: inbox.address }),
      message({ from: inbox.address }),
    ]);

    expect(items.every((item) => item.outcome === "pending_approval")).toBe(true);
    expect(h.dispatchQueue.enqueued).toHaveLength(0);
  });

  it("refuses an oversized batch outright, rather than sending the first hundred", async () => {
    // A cap breach is the caller getting the call wrong; sending a prefix of
    // what they asked for would be the worst possible answer to that.
    await expect(
      sendBatch(
        h.ctx,
        Array.from({ length: SENDING_LIMITS.MAX_BATCH + 1 }, () => message()),
      ),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    expect(h.dispatchQueue.enqueued).toHaveLength(0);
  });

  it("refuses an empty batch", async () => {
    await expect(sendBatch(h.ctx, [])).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("requires message:send before doing anything", async () => {
    await expect(sendBatch(h.withScopes(["message:read"]), [message()])).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});

describe("delivery metadata", () => {
  it("rides along on every event about the send, including the bounce", async () => {
    const metadata = { tenant: "acme", orderId: "A-1" };
    const result = await h.services.delivery.send(h.ctx, message({ metadata }));

    expect(result.delivery.metadata).toEqual(metadata);
    expect(eventsOfType(h.events.published, "delivery.queued")[0]?.metadata).toEqual(metadata);

    await h.services.delivery.dispatch(h.ctx, { deliveryId: result.delivery.id });
    expect(eventsOfType(h.events.published, "delivery.dispatched")[0]?.metadata).toEqual(
      metadata,
    );

    // The one that matters: a bounce arriving days later, on a webhook, still
    // carries enough to route it without a lookup.
    await h.services.delivery.recordEvent(h.ctx, {
      eventId: "evt-metadata-bounce",
      type: "bounced",
      providerMessageId: "prov-1",
      recipient: "user@corp.com" as never,
      sourceDomain: TEST_DOMAIN,
      sourceZoneId: "zone-1",
      occurredAt: h.clock.now(),
      terminal: true,
      bounceType: "hard",
    });
    expect(eventsOfType(h.events.published, "delivery.status_changed")[0]?.metadata).toEqual(
      metadata,
    );
  });

  it("defaults to an empty map rather than null", async () => {
    const result = await h.services.delivery.send(h.ctx, message());
    expect(result.delivery.metadata).toEqual({});
  });
});
