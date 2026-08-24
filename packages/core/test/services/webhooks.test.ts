import type { DomainEvent } from "@core/domain";
import { AccountId, WebhookSignature, WebhookSubscription } from "@core/domain";
import { createHarness, type Harness } from "@core/testing";
import { beforeEach, describe, expect, it } from "vitest";

let h: Harness;
beforeEach(() => {
  h = createHarness();
});

const event = {
  type: "message.received",
  accountId: AccountId.DEFAULT,
  occurredAt: new Date("2026-07-01T12:00:00.000Z"),
  messageId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  inboxId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
} as unknown as DomainEvent;

describe("subscriptions", () => {
  it("insists on https", async () => {
    // The payload carries subjects and recipient addresses, and the signature
    // proves origin rather than providing confidentiality — over plain HTTP the
    // whole thing is readable by anyone on the path.
    await expect(
      h.services.delivery.createWebhook(h.ctx, { url: "http://example.com/hook" }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("mints a secret and returns it, once", async () => {
    const created = await h.services.delivery.createWebhook(h.ctx, {
      url: "https://example.com/hook",
    });
    expect(created.secret).toMatch(/^whsec_/);
  });
});

describe("fanOut", () => {
  it("delivers to a subscription that wants everything", async () => {
    await h.services.delivery.createWebhook(h.ctx, { url: "https://a.test/hook" });

    expect(await h.services.delivery.fanOut(h.ctx, event, "evt-1")).toBe(1);
    expect(h.webhookSender.delivered).toHaveLength(1);
    expect(JSON.parse(h.webhookSender.delivered[0]!.body)).toMatchObject({
      id: "evt-1",
      type: "message.received",
    });
  });

  it("signs an old event with the current delivery-attempt time", async () => {
    await h.services.delivery.createWebhook(h.ctx, { url: "https://a.test/hook" });
    h.clock.advance(60 * 60 * 1000);

    await h.services.delivery.fanOut(h.ctx, event, "evt-delayed");
    expect(h.webhookSender.delivered[0]?.timestamp).toEqual(h.clock.now());
    expect(JSON.parse(h.webhookSender.delivered[0]!.body)).toMatchObject({
      occurredAt: event.occurredAt.toISOString(),
    });
  });

  it("skips a subscription that asked for other types", async () => {
    await h.services.delivery.createWebhook(h.ctx, {
      url: "https://a.test/hook",
      events: ["delivery.status_changed"],
    });
    expect(await h.services.delivery.fanOut(h.ctx, event, "evt-1")).toBe(0);
    expect(h.webhookSender.delivered).toHaveLength(0);
  });

  it("gives each subscription its own delivery id", async () => {
    await h.services.delivery.createWebhook(h.ctx, { url: "https://a.test/hook" });
    await h.services.delivery.createWebhook(h.ctx, { url: "https://b.test/hook" });

    await h.services.delivery.fanOut(h.ctx, event, "evt-1");
    const ids = h.webhookSender.delivered.map((request) => request.messageId);
    // Two subscribers retrying independently must not be told they received the
    // same delivery — they dedupe on this id.
    expect(new Set(ids).size).toBe(2);
  });

  it("still tells the healthy subscriber when another one is down", async () => {
    await h.services.delivery.createWebhook(h.ctx, { url: "https://down.test/hook" });
    await h.services.delivery.createWebhook(h.ctx, { url: "https://up.test/hook" });
    h.webhookSender.failFor.add("https://down.test/hook");

    // Throws, so the queue retries the event — but only AFTER every subscriber
    // has been attempted. One server being down must not cost the others their
    // notification.
    await expect(h.services.delivery.fanOut(h.ctx, event, "evt-1")).rejects.toThrow();
    expect(h.webhookSender.delivered.map((r) => r.url)).toEqual(["https://up.test/hook"]);
  });
});

describe("WebhookSignature", () => {
  it("puts the timestamp inside the signed string, not beside it", () => {
    // This is what makes it a replay defence rather than a decoration: an
    // attacker replaying a captured delivery cannot move it forward in time
    // without invalidating the signature.
    const input = WebhookSignature.signingInput("msg_1", 1782000000, '{"a":1}');
    expect(input).toBe('msg_1.1782000000.{"a":1}');
  });

  it("versions the header so the scheme can be rotated", () => {
    expect(WebhookSignature.header("abc")).toBe("v1,abc");
  });

  it("rejects a timestamp outside the tolerance", () => {
    const now = new Date("2026-07-01T12:00:00.000Z");
    const seconds = Math.floor(now.getTime() / 1000);
    expect(WebhookSignature.fresh(seconds, now)).toBe(true);
    expect(WebhookSignature.fresh(seconds - 299, now)).toBe(true);
    expect(WebhookSignature.fresh(seconds - 301, now)).toBe(false);
    // Both directions: a clock ahead of ours is as suspicious as one behind.
    expect(WebhookSignature.fresh(seconds + 301, now)).toBe(false);
  });
});

describe("WebhookSubscription.wants", () => {
  const base = WebhookSubscription.create({
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" as never,
    accountId: AccountId.DEFAULT,
    url: "https://a.test/hook",
    secret: "whsec_x",
    now: new Date(),
  });

  it("treats an empty event list as every type", () => {
    expect(WebhookSubscription.wants(base, event)).toBe(true);
  });

  it("never delivers to a disabled subscription", () => {
    expect(WebhookSubscription.wants(WebhookSubscription.disable(base), event)).toBe(false);
  });
});
