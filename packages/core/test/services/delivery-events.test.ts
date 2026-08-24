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
const providerFields = (eventId: string) => ({
  eventId,
  sourceDomain: TEST_DOMAIN,
  sourceZoneId: "zone-1",
});

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
      ...providerFields("evt-delivered-1"),
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
      ...providerFields("evt-deferred-1"),
      type: "deferred",
      providerMessageId: delivery.providerMessageId!,
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: false,
      smtpCode: "451",
    });
    h.clock.advance(1000);
    await record(h.ctx, {
      ...providerFields("evt-delivered-2"),
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
      ...providerFields("evt-bounced-hard-1"),
      type: "bounced",
      providerMessageId: delivery.providerMessageId!,
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: true,
      bounceType: "hard",
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
      ...providerFields("evt-delivered-3"),
      type: "delivered",
      providerMessageId: delivery.providerMessageId!,
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: true,
    });
    h.clock.advance(86_400_000);
    const result = await record(h.ctx, {
      ...providerFields("evt-complained-1"),
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
      ...providerFields("evt-deferred-2"),
      type: "deferred",
      providerMessageId: delivery.providerMessageId!,
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: false,
      smtpCode: "451",
    });
    h.clock.advance(86_400_000);
    const result = await record(h.ctx, {
      ...providerFields("evt-complained-2"),
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
      ...providerFields("evt-deferred-3"),
      type: "deferred",
      providerMessageId: delivery.providerMessageId!,
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: false,
      smtpCode: "451",
    });
    h.clock.advance(1000);
    const result = await record(h.ctx, {
      ...providerFields("evt-rejected-1"),
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
      ...providerFields("evt-delivered-4"),
      type: "delivered",
      providerMessageId: delivery.providerMessageId!,
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: true,
    });

    const result = await record(h.ctx, {
      ...providerFields("evt-deferred-stale"),
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
      ...providerFields("evt-bounced-unmatched"),
      type: "bounced",
      providerMessageId: "prov-unknown",
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: true,
      bounceType: "hard",
    });

    expect(result).toEqual({ outcome: "unmatched" });
    // Reputation protection must not depend on tidy bookkeeping.
    expect(await h.deps.suppressions.filterSuppressed(h.ctx, [TO])).toEqual([TO]);
  });

  it("does not suppress a soft bounce", async () => {
    const delivery = await dispatched();
    h.clock.advance(1000);

    await record(h.ctx, {
      ...providerFields("evt-bounced-soft-1"),
      type: "bounced",
      providerMessageId: delivery.providerMessageId!,
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: true,
      bounceType: "soft",
      bounceReason: "Retries exhausted",
    });

    expect(await h.deps.suppressions.filterSuppressed(h.ctx, [TO])).toEqual([]);
  });

  it("deduplicates a provider event before applying side effects", async () => {
    const delivery = await dispatched();
    h.clock.advance(1000);
    const event = {
      ...providerFields("evt-bounced-once"),
      type: "bounced" as const,
      providerMessageId: delivery.providerMessageId!,
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: true,
      bounceType: "hard" as const,
    };

    expect(await record(h.ctx, event)).toMatchObject({ outcome: "applied" });
    expect(await record(h.ctx, event)).toEqual({ outcome: "duplicate" });
    expect(eventsOfType(h.events.published, "suppression.added")).toHaveLength(1);
    expect(await h.deps.deliveries.listDeliveryEvents(h.ctx, delivery.id)).toHaveLength(1);
  });

  it("retries a live claim after a hard crash instead of acknowledging it as a duplicate", async () => {
    const delivery = await dispatched();
    h.clock.advance(1000);
    const event = {
      ...providerFields("evt-crashed-after-claim"),
      type: "delivered" as const,
      providerMessageId: delivery.providerMessageId!,
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: true,
    };

    await h.deps.deliveries.appendDeliveryEvent(h.ctx, {
      id: h.ids.ulid(),
      eventId: event.eventId,
      deliveryId: delivery.id,
      providerMessageId: event.providerMessageId,
      recipient: event.recipient,
      sourceDomain: event.sourceDomain,
      sourceZoneId: event.sourceZoneId,
      type: event.type,
      terminal: event.terminal,
      smtpCode: null,
      smtpEnhancedCode: null,
      smtpResponse: null,
      bounceType: null,
      bounceClassification: null,
      bounceReason: null,
      occurredAt: event.occurredAt,
      raw: null,
    });
    expect(
      await h.deps.deliveries.claimDeliveryEvent(
        h.ctx,
        event.eventId,
        h.clock.now(),
        new Date(h.clock.now().getTime() - 5 * 60 * 1000),
      ),
    ).toBe("claimed");

    // Simulate the isolate disappearing without running the catch/release
    // branch. The immediate queue retry must stay retryable, not be ACKed as a
    // completed duplicate.
    await expect(record(h.ctx, event)).rejects.toThrow("still being processed");
    expect(await h.deps.deliveries.findById(h.ctx, delivery.id)).toMatchObject({
      status: "dispatched",
    });

    h.clock.advance(5 * 60 * 1000 + 1);
    await expect(record(h.ctx, event)).resolves.toEqual({
      outcome: "applied",
      from: "dispatched",
      to: "delivered",
    });
    expect(await h.deps.deliveries.listDeliveryEvents(h.ctx, delivery.id)).toHaveLength(1);
  });

  it("resumes an event whose side effects failed after its durable insert", async () => {
    const delivery = await dispatched();
    h.clock.advance(1000);
    const event = {
      ...providerFields("evt-resume-after-publish-failure"),
      type: "bounced" as const,
      providerMessageId: delivery.providerMessageId!,
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: true,
      bounceType: "hard" as const,
    };

    h.events.failure = new Error("webhook queue unavailable");
    await expect(record(h.ctx, event)).rejects.toThrow("webhook queue unavailable");
    h.events.failure = null;

    await expect(record(h.ctx, event)).resolves.toMatchObject({ outcome: "applied" });
    expect(await h.deps.suppressions.filterSuppressed(h.ctx, [TO])).toEqual([TO]);
    expect(await h.deps.deliveries.listDeliveryEvents(h.ctx, delivery.id)).toHaveLength(1);
    expect(await h.deps.deliveries.findById(h.ctx, delivery.id)).toMatchObject({
      status: "bounced",
    });
  });

  it("records a non-terminal failure without freezing the delivery", async () => {
    const delivery = await dispatched();
    h.clock.advance(1000);

    const result = await record(h.ctx, {
      ...providerFields("evt-failed-retryable"),
      type: "failed",
      providerMessageId: delivery.providerMessageId!,
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: false,
      smtpResponse: "Provider will retry",
    });

    expect(result).toEqual({ outcome: "recorded_only", reason: "non_terminal_failure" });
    expect(await h.deps.deliveries.findById(h.ctx, delivery.id)).toMatchObject({
      status: "dispatched",
    });
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
