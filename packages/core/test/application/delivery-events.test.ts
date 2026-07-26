import { dispatchOutbound, recordDeliveryEvent, sendMessage } from "@core/application";
import type { EmailAddress, OutboundMessage } from "@core/domain";
import { eventsOfType, OutboundMessage as Outbound } from "@core/domain";
import type { Harness } from "@core/testing";
import { createHarness, TEST_DOMAIN } from "@core/testing";
import { beforeEach, describe, expect, it } from "vitest";

let h: Harness;
let record: ReturnType<typeof recordDeliveryEvent>;
const FROM = `agent@${TEST_DOMAIN}`;
const TO = "user@corp.com" as EmailAddress;

async function dispatched(): Promise<OutboundMessage> {
  const queued = await sendMessage(h.deps)(h.ctx, {
    from: FROM,
    to: [TO],
    subject: "Report",
    text: "Body",
  });
  const result = await dispatchOutbound(h.deps)(h.ctx, { outboundId: queued.outbound.id });
  if (result.outcome !== "dispatched") throw new Error("expected dispatched");
  return result.outbound;
}

beforeEach(async () => {
  h = createHarness();
  record = recordDeliveryEvent(h.deps);
  await h.seedInbox(FROM);
});

describe("recordDeliveryEvent", () => {
  it("advances a dispatched send to delivered", async () => {
    const outbound = await dispatched();
    h.clock.advance(1000);

    const result = await record(h.ctx, {
      type: "delivered",
      providerMessageId: outbound.providerMessageId!,
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: true,
      smtpCode: "250",
    });

    expect(result).toEqual({ outcome: "applied", from: "dispatched", to: "delivered" });
    const reloaded = await h.deps.outbound.findById(h.ctx, outbound.id);
    expect(reloaded?.status).toBe("delivered");
  });

  it("builds the timeline `mailworker status` prints", async () => {
    const outbound = await dispatched();
    h.clock.advance(1000);
    await record(h.ctx, {
      type: "deferred",
      providerMessageId: outbound.providerMessageId!,
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: false,
      smtpCode: "451",
    });
    h.clock.advance(1000);
    await record(h.ctx, {
      type: "delivered",
      providerMessageId: outbound.providerMessageId!,
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: true,
      smtpCode: "250",
    });

    const timeline = await h.deps.outbound.listDeliveryEvents(h.ctx, outbound.id);
    expect(timeline.map((event) => event.type)).toEqual(["deferred", "delivered"]);
  });

  it("suppresses a hard-bounced recipient", async () => {
    const outbound = await dispatched();
    h.clock.advance(1000);
    await record(h.ctx, {
      type: "bounced",
      providerMessageId: outbound.providerMessageId!,
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
    const outbound = await dispatched();
    h.clock.advance(1000);
    await record(h.ctx, {
      type: "delivered",
      providerMessageId: outbound.providerMessageId!,
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: true,
    });
    h.clock.advance(86_400_000);
    const result = await record(h.ctx, {
      type: "complained",
      providerMessageId: outbound.providerMessageId!,
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: true,
    });

    expect(result).toEqual({ outcome: "applied", from: "delivered", to: "complained" });
  });

  it("drops a stale event instead of throwing", async () => {
    // Throwing here would make the queue retry forever, and out-of-order
    // arrival is normal at scale.
    const outbound = await dispatched();
    h.clock.advance(5000);
    await record(h.ctx, {
      type: "delivered",
      providerMessageId: outbound.providerMessageId!,
      recipient: TO,
      occurredAt: h.clock.now(),
      terminal: true,
    });

    const result = await record(h.ctx, {
      type: "deferred",
      providerMessageId: outbound.providerMessageId!,
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

describe("OutboundMessage state machine", () => {
  it("refuses an illegal transition", () => {
    const draft = Outbound.create({
      id: h.ids.ulid(),
      accountId: h.ctx.accountId,
      recipients: [TO],
      now: h.clock.now(),
    });
    expect(() => Outbound.markDispatched(draft, "p", h.clock.now())).toThrowError(
      /Cannot move outbound message from draft to dispatched/,
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
