import type { DeliveryService } from "@core/application";
import type { Delivery, EmailAddress } from "@core/domain";
import { eventsOfType, Delivery as Outbound } from "@core/domain";
import type { Harness } from "@core/testing";
import { createHarness, TEST_DOMAIN } from "@core/testing";
import { beforeEach, describe, expect, it } from "vitest";

let h: Harness;
let record: DeliveryService["recordEvent"];
const FROM = `agent@${TEST_DOMAIN}`;
const TO = "user@corp.com" as EmailAddress;

async function dispatched(): Promise<Delivery> {
  const queued = await h.services.delivery.send(h.ctx, {
    from: FROM,
    to: [TO],
    subject: "Report",
    text: "Body",
  });
  const result = await h.services.delivery.dispatch(h.ctx, { deliveryId: queued.delivery.id });
  if (result.outcome !== "dispatched") throw new Error("expected dispatched");
  return result.delivery;
}

beforeEach(async () => {
  h = createHarness();
  record = h.services.delivery.recordEvent;
  await h.seedInbox(FROM);
});

describe("delivery.recordEvent", () => {
  it("advances a dispatched send to delivered", async () => {
    const delivery = await dispatched();
    h.clock.advance(1000);

    const result = await record(h.ctx, {
      type: "delivered",
      providerMessageId: delivery.providerMessageId!,
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: true,
      smtpCode: "250",
    });

    expect(result).toEqual({ outcome: "applied", from: "dispatched", to: "delivered" });
    const reloaded = await h.deps.deliveries.findById(h.ctx, delivery.id);
    expect(reloaded?.status).toBe("delivered");
  });

  it("builds the timeline `mailworker status` prints", async () => {
    const delivery = await dispatched();
    h.clock.advance(1000);
    await record(h.ctx, {
      type: "deferred",
      providerMessageId: delivery.providerMessageId!,
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: false,
      smtpCode: "451",
    });
    h.clock.advance(1000);
    await record(h.ctx, {
      type: "delivered",
      providerMessageId: delivery.providerMessageId!,
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: true,
      smtpCode: "250",
    });

    const timeline = await h.deps.deliveries.listDeliveryEvents(h.ctx, delivery.id);
    expect(timeline.map((event) => event.type)).toEqual(["deferred", "delivered"]);
  });

  it("suppresses a hard-bounced recipient", async () => {
    const delivery = await dispatched();
    h.clock.advance(1000);
    await record(h.ctx, {
      type: "bounced",
      providerMessageId: delivery.providerMessageId!,
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: true,
      smtpResponse: "550 no such user",
    });

    expect(await h.deps.suppressions.filterSuppressed(h.ctx, [TO])).toEqual([TO]);
    expect(eventsOfType(h.events.published, "suppression.added")).toHaveLength(1);
  });

  it("accepts a complaint that arrives after delivery", async () => {
    // The non-obvious edge: a spam report legitimately lands days after a
    // successful delivery, so `delivered` cannot be fully terminal.
    const delivery = await dispatched();
    h.clock.advance(1000);
    await record(h.ctx, {
      type: "delivered",
      providerMessageId: delivery.providerMessageId!,
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: true,
    });
    h.clock.advance(86_400_000);
    const result = await record(h.ctx, {
      type: "complained",
      providerMessageId: delivery.providerMessageId!,
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: true,
    });

    expect(result).toEqual({ outcome: "applied", from: "delivered", to: "complained" });
  });

  it("accepts a complaint for a deferred send whose delivered event never arrived", async () => {
    // Queues are at-least-once and unordered, so "we missed the success and only
    // heard about the complaint" is ordinary, not corruption. Without this edge
    // the delivery sat in `deferred` forever, because every event that could
    // have moved it was refused.
    const delivery = await dispatched();
    h.clock.advance(1000);
    await record(h.ctx, {
      type: "deferred",
      providerMessageId: delivery.providerMessageId!,
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: false,
      smtpCode: "451",
    });
    h.clock.advance(86_400_000);
    const result = await record(h.ctx, {
      type: "complained",
      providerMessageId: delivery.providerMessageId!,
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: true,
    });

    expect(result).toEqual({ outcome: "applied", from: "deferred", to: "complained" });
  });

  it("accepts a rejection on a later attempt at a deferred send", async () => {
    // The provider keeps retrying a deferred message; the attempt that finally
    // resolves it can resolve it as a refusal.
    const delivery = await dispatched();
    h.clock.advance(1000);
    await record(h.ctx, {
      type: "deferred",
      providerMessageId: delivery.providerMessageId!,
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: false,
      smtpCode: "451",
    });
    h.clock.advance(1000);
    const result = await record(h.ctx, {
      type: "rejected",
      providerMessageId: delivery.providerMessageId!,
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: true,
      smtpResponse: "550 policy",
    });

    expect(result).toEqual({ outcome: "applied", from: "deferred", to: "rejected" });
    const reloaded = await h.deps.deliveries.findById(h.ctx, delivery.id);
    expect(reloaded?.rejectReason).toBe("550 policy");
  });

  it("drops a stale event instead of throwing", async () => {
    // Throwing here would make the queue retry forever, and out-of-order
    // arrival is normal at scale.
    const delivery = await dispatched();
    h.clock.advance(5000);
    await record(h.ctx, {
      type: "delivered",
      providerMessageId: delivery.providerMessageId!,
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: true,
    });

    const result = await record(h.ctx, {
      type: "deferred",
      providerMessageId: delivery.providerMessageId!,
      recipient: TO,
      occurredAt: new Date(h.clock.now().getTime() - 10_000),
      terminal: false,
    });

    expect(result).toMatchObject({ outcome: "recorded_only", reason: "stale_event" });
  });

  it("still records an event it cannot match to a send", async () => {
    const result = await record(h.ctx, {
      type: "bounced",
      providerMessageId: "prov-unknown",
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: true,
    });

    expect(result).toEqual({ outcome: "unmatched" });
    // Reputation protection must not depend on tidy bookkeeping.
    expect(await h.deps.suppressions.filterSuppressed(h.ctx, [TO])).toEqual([TO]);
  });
});

describe("Delivery state machine", () => {
  it("refuses an illegal transition", () => {
    const draft = Outbound.create({
      id: h.ids.ulid(),
      accountId: h.ctx.accountId,
      recipients: [TO],
      now: h.clock.now(),
    });
    expect(() => Outbound.markDispatched(draft, "p", h.clock.now())).toThrowError(
      /Cannot move delivery message from draft to dispatched/,
    );
  });

  it("caps recipients at the provider limit", () => {
    const many = Array.from({ length: 51 }, (_, i) => `u${i}@corp.com` as EmailAddress);
    expect(() =>
      Outbound.create({
        id: h.ids.ulid(),
        accountId: h.ctx.accountId,
        recipients: many,
        now: h.clock.now(),
      }),
    ).toThrowError(/Too many recipients/);
  });

  it("only approves something awaiting approval", () => {
    const draft = Outbound.create({
      id: h.ids.ulid(),
      accountId: h.ctx.accountId,
      recipients: [TO],
      now: h.clock.now(),
    });
    expect(() => Outbound.approve(draft, "alice", h.clock.now())).toThrowError(
      /pending_approval/,
    );
  });
});
