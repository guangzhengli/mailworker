import type { DeliveryService } from "@core/application";
import type { AgentIdentity, Caller } from "@core/domain";
import { AgentIdentity as Identity, isDomainError } from "@core/domain";
import type { Harness } from "@core/testing";
import { createHarness, TEST_DOMAIN } from "@core/testing";
import { beforeEach, describe, expect, it } from "vitest";

let h: Harness;
let send: DeliveryService["send"];
let dispatch: DeliveryService["dispatch"];
const FROM = `agent@${TEST_DOMAIN}`;

beforeEach(async () => {
  h = createHarness();
  send = h.services.delivery.send;
  dispatch = h.services.delivery.dispatch;
  await h.seedInbox(FROM);
});

function inMode(mode: Caller["mode"]): Caller {
  return { ...h.ctx, mode };
}

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

describe("sandbox environments", () => {
  it("loops a dispatched send back through the inbound path", async () => {
    const ctx = inMode("sandbox");
    const queued = await send(ctx, {
      from: FROM,
      to: ["user@corp.com"],
      subject: "Your code is 123456",
      text: "123456",
    });

    await dispatch(ctx, { deliveryId: queued.delivery.id });

    // The whole point: a development send is resolvable by `wait` without a
    // single message reaching the real recipient.
    expect(h.loopback.delivered).toHaveLength(1);
    expect(h.loopback.delivered[0]!.message.recipient).toBe("user@corp.com");
    expect(h.loopback.delivered[0]!.message.raw.byteLength).toBeGreaterThan(0);
  });

  it("gives the looped-back copy its own Message-ID", async () => {
    const ctx = inMode("sandbox");
    const queued = await send(ctx, {
      from: FROM,
      to: ["user@corp.com"],
      subject: "Your code is 123456",
      text: "123456",
    });
    await dispatch(ctx, { deliveryId: queued.delivery.id });

    // `messages` is unique on (account_id, rfc_message_id) and the sent copy
    // already claimed the original, so reusing it made every loopback dedupe
    // away as a duplicate of our own archive — silently, because ingest treats
    // a duplicate as normal traffic. That is the whole sandbox case: an
    // environment mailing its own test inbox.
    const built = h.mimeBuilder.specs;
    expect(built.length).toBeGreaterThanOrEqual(2);
    const ids = built.map((spec) => spec.messageId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((id) => id.includes(".loopback@"))).toBe(true);
  });

  it("synthesizes a delivered event, because no provider will send one", async () => {
    const ctx = inMode("sandbox");
    const queued = await send(ctx, {
      from: FROM,
      to: ["user@corp.com"],
      subject: "Report",
      text: "Attached.",
    });

    const result = await dispatch(ctx, { deliveryId: queued.delivery.id });
    expect(result.outcome).toBe("dispatched");

    const stored = await h.deps.deliveries.findById(ctx, queued.delivery.id);
    // `delivered`, not `dispatched`: a sandbox timeline that stopped at handoff
    // would read as stuck rather than as finished.
    expect(stored?.status).toBe("delivered");

    const events = await h.deps.deliveries.listDeliveryEvents(ctx, queued.delivery.id);
    expect(events.map((event) => event.type)).toEqual(["delivered"]);
    expect(events[0]!.terminal).toBe(true);
  });

  it("leaves a live environment alone", async () => {
    const queued = await send(h.ctx, {
      from: FROM,
      to: ["user@corp.com"],
      subject: "Report",
      text: "Attached.",
    });

    await dispatch(h.ctx, { deliveryId: queued.delivery.id });

    expect(h.loopback.delivered).toHaveLength(0);
    const stored = await h.deps.deliveries.findById(h.ctx, queued.delivery.id);
    expect(stored?.status).toBe("dispatched");
  });
});

describe("test environments", () => {
  it("refuses an identity with no recipient allowlist", async () => {
    const identity = await seedIdentity({ recipientAllowlist: null });
    const ctx = { ...inMode("test"), identityId: identity.id };
    const inbox = await h.seedInbox(`test-agent@${TEST_DOMAIN}`, { identityId: identity.id });

    // `test` sends for real, so an unrestricted identity here is a development
    // agent that can mail a customer.
    await expect(
      send(ctx, { from: inbox.address, to: ["user@corp.com"], subject: "Hi", text: "Hi" }),
    ).rejects.toSatisfy(
      (error: unknown) => isDomainError(error) && error.code === "send_rejected",
    );
  });

  it("allows one that has an allowlist covering the recipient", async () => {
    const identity = await seedIdentity({ recipientAllowlist: ["*@corp.com"] });
    const ctx = { ...inMode("test"), identityId: identity.id };
    const inbox = await h.seedInbox(`allowed-agent@${TEST_DOMAIN}`, {
      identityId: identity.id,
    });

    const result = await send(ctx, {
      from: inbox.address,
      to: ["user@corp.com"],
      subject: "Hi",
      text: "Hi",
    });
    expect(result.outcome).toBe("queued");
  });

  it("does not impose an allowlist on a sandbox environment", async () => {
    const identity = await seedIdentity({ recipientAllowlist: null });
    const ctx = { ...inMode("sandbox"), identityId: identity.id };
    const inbox = await h.seedInbox(`sandbox-agent@${TEST_DOMAIN}`, {
      identityId: identity.id,
    });

    const result = await send(ctx, {
      from: inbox.address,
      to: ["user@corp.com"],
      subject: "Hi",
      text: "Hi",
    });
    expect(result.outcome).toBe("queued");
  });
});

describe("console sends", () => {
  it("skips the approval hold, because the sender is the approver", async () => {
    const identity = await seedIdentity({ requireApproval: true });
    const ctx = { ...h.ctx, identityId: identity.id };
    const inbox = await h.seedInbox(`console-review@${TEST_DOMAIN}`, {
      identityId: identity.id,
    });

    const agent = await send(ctx, {
      from: inbox.address,
      to: ["user@corp.com"],
      subject: "From an agent",
      text: "Hi",
    });
    expect(agent.outcome).toBe("pending_approval");

    const console = await send(ctx, {
      from: inbox.address,
      to: ["user@corp.com"],
      subject: "From a human",
      text: "Hi",
      source: "console",
    });
    expect(console.outcome).toBe("queued");
    expect(console.delivery.source).toBe("console");
  });

  it("is metered against a provisioned identity rather than the admin session", async () => {
    const identity = await h.services.identity.ensureConsoleIdentity(h.ctx);
    expect(identity.name).toBe("console");
    expect(identity.managed).toBe(true);

    // Provisioned once, not on every send.
    const again = await h.services.identity.ensureConsoleIdentity(h.ctx);
    expect(again.id).toBe(identity.id);
    const inbox = await h.seedInbox(`console-metered@${TEST_DOMAIN}`, {
      identityId: identity.id,
    });

    const result = await send(
      { ...h.ctx, identityId: identity.id },
      {
        from: inbox.address,
        to: ["user@corp.com"],
        subject: "Hi",
        text: "Hi",
        source: "console",
      },
    );

    // The delivery names an identity, so "who sent this" survives the audit.
    // An unbound admin send would have left this null and skipped gates 3, 4 and 6.
    expect(result.delivery.identityId).toBe(identity.id);
  });

  it("still runs every rejecting gate", async () => {
    const identity = await seedIdentity({ recipientAllowlist: ["*@allowed.com"] });
    const ctx = { ...h.ctx, identityId: identity.id };
    const inbox = await h.seedInbox(`console-policy@${TEST_DOMAIN}`, {
      identityId: identity.id,
    });

    // A console send is not a way around the gates — only around the hold.
    await expect(
      send(ctx, {
        from: inbox.address,
        to: ["user@corp.com"],
        subject: "Hi",
        text: "Hi",
        source: "console",
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isDomainError(error) && error.code === "send_rejected",
    );
  });
});
