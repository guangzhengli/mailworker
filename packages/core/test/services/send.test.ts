import type { DeliveryService } from "@core/application";
import type { AgentIdentity } from "@core/domain";
import { Delivery, eventsOfType, AgentIdentity as Identity, isDomainError } from "@core/domain";
import type { Harness } from "@core/testing";
import { createHarness, rawEmail, TEST_DOMAIN } from "@core/testing";
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

describe("delivery.send", () => {
  it("queues a valid send without touching the transport", async () => {
    const result = await send(h.ctx, {
      from: FROM,
      to: ["user@corp.com"],
      subject: "Report",
      text: "Attached.",
    });

    expect(result.outcome).toBe("queued");
    // Nothing leaves until the queue consumer runs. That split is what makes a
    // crashed send retryable against a recorded decision.
    expect(h.transport.sent).toHaveLength(0);
    expect(eventsOfType(h.events.published, "delivery.queued")).toHaveLength(1);
  });

  it("leaves a durable outbox entry when queue publication fails", async () => {
    h.dispatchQueue.failure = new Error("queue unavailable");

    await expect(
      send(h.ctx, {
        from: FROM,
        to: ["user@corp.com"],
        subject: "Recover me",
        text: "The database accepted this send.",
      }),
    ).rejects.toThrow("queue unavailable");

    const deliveries = await h.services.delivery.list(h.ctx);
    expect(deliveries.items[0]?.status).toBe("queued");
    expect(await h.deliveries.listStagedDispatches(h.ctx, 10)).toMatchObject([
      { deliveryId: deliveries.items[0]?.id },
    ]);

    h.dispatchQueue.failure = null;
    expect(await h.services.delivery.reconcileDispatchOutbox(h.ctx)).toMatchObject({
      examined: 1,
      enqueued: 1,
      failed: 0,
    });
    expect(h.dispatchQueue.enqueued).toEqual([deliveries.items[0]?.id]);
    // The durable task remains until the consumer has both handed off and
    // archived the sent copy; Queue.send alone is not completion.
    expect(await h.deliveries.listStagedDispatches(h.ctx, 10)).toMatchObject([
      { deliveryId: deliveries.items[0]?.id },
    ]);
  });

  it("does not let reconciliation release an unapproved delivery", async () => {
    const identity = await seedIdentity({ requireApproval: true });
    const inbox = await h.seedInbox(`held@${TEST_DOMAIN}`, { identityId: identity.id });
    const pending = await send(h.asIdentity(identity.id), {
      from: inbox.address,
      to: ["user@corp.com"],
      subject: "Still needs review",
      text: "Hold this.",
    });
    expect(pending.outcome).toBe("pending_approval");
    await h.deliveries.stageDispatch(h.ctx, pending.delivery.id, h.clock.now());

    expect(await h.services.delivery.reconcileDispatchOutbox(h.ctx)).toMatchObject({
      examined: 1,
      enqueued: 0,
      discarded: 1,
    });
    expect(h.dispatchQueue.enqueued).toEqual([]);
    expect(await h.deliveries.listStagedDispatches(h.ctx, 10)).toEqual([]);
  });

  it("refuses to send from an address no inbox owns", async () => {
    await expect(
      send(h.ctx, {
        from: `ghost@${TEST_DOMAIN}`,
        to: ["user@corp.com"],
        subject: "x",
        text: "y",
      }),
    ).rejects.toMatchObject({ code: "inbox_not_found" });
  });

  it("requires a body", async () => {
    await expect(
      send(h.ctx, { from: FROM, to: ["user@corp.com"], subject: "empty" }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("rejects managed, injected, and oversized custom headers before storage", async () => {
    for (const headers of [
      { Subject: "override" },
      { "X-Test": "safe\r\nBcc: stolen@example.com" },
      { "X-Large": "x".repeat(16_385) },
    ]) {
      await expect(
        send(h.ctx, {
          from: FROM,
          to: ["user@corp.com"],
          subject: "Headers",
          text: "Body",
          headers,
        }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
    }
    expect([...h.blobs.objects.keys()].filter((key) => key.startsWith("out/"))).toEqual([]);
  });

  it("returns the original send for a repeated idempotency key", async () => {
    const request = {
      from: FROM,
      to: ["user@corp.com"],
      subject: "Once",
      text: "Only once",
      idempotencyKey: "run-1",
    };
    const first = await send(h.ctx, request);
    const second = await send(h.ctx, request);

    expect(second.outcome).toBe("duplicate");
    expect(second.delivery.id).toBe(first.delivery.id);
  });

  it("rejects reuse of an idempotency key for different content", async () => {
    await send(h.ctx, {
      from: FROM,
      to: ["first@corp.com"],
      subject: "Original",
      text: "First body",
      idempotencyKey: "conflicting-run",
    });

    await expect(
      send(h.ctx, {
        from: FROM,
        to: ["second@corp.com"],
        subject: "Different",
        text: "Second body",
        idempotencyKey: "conflicting-run",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect((await h.services.delivery.list(h.ctx)).items).toHaveLength(1);
  });

  it("resolves concurrent idempotent sends to one delivery without orphan payloads", async () => {
    const request = {
      from: FROM,
      to: ["user@corp.com"],
      subject: "One side effect",
      text: "Only one durable payload.",
      idempotencyKey: "parallel-run-1",
    };

    const [first, second] = await Promise.all([send(h.ctx, request), send(h.ctx, request)]);
    expect([first.outcome, second.outcome].sort()).toEqual(["duplicate", "queued"]);
    expect(first.delivery.id).toBe(second.delivery.id);
    expect((await h.services.delivery.list(h.ctx)).items).toHaveLength(1);
    expect([...h.blobs.objects.keys()].filter((key) => key.startsWith("out/"))).toHaveLength(1);
    // Queue publication is not completion: the row protects consumer hand-off
    // and archive recovery until dispatch finishes.
    expect(await h.deliveries.listStagedDispatches(h.ctx, 10)).toHaveLength(1);
  });

  it("reserves identity quota atomically across concurrent sends", async () => {
    const identity = await seedIdentity({ dailySendQuota: 1 });
    const inbox = await h.seedInbox(`limited@${TEST_DOMAIN}`, { identityId: identity.id });
    const ctx = h.asIdentity(identity.id);
    const request = (id: string) => ({
      from: inbox.address,
      to: ["user@corp.com"],
      subject: id,
      text: "One slot.",
      idempotencyKey: id,
    });

    const results = await Promise.allSettled([
      send(ctx, request("quota-parallel-a")),
      send(ctx, request("quota-parallel-b")),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((result) => result.status === "rejected");
    expect(refused).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "quota_exceeded" }),
    });
    expect((await h.services.delivery.list(ctx)).items).toHaveLength(1);
    expect([...h.blobs.objects.keys()].filter((key) => key.startsWith("out/"))).toHaveLength(1);
  });

  it("resolves an admin retry by the inbox identity before re-running quota", async () => {
    const identity = await seedIdentity({ dailySendQuota: 1 });
    const inbox = await h.seedInbox(`admin-retry@${TEST_DOMAIN}`, { identityId: identity.id });
    const request = {
      from: inbox.address,
      to: ["user@corp.com"],
      subject: "One durable decision",
      text: "Body",
      idempotencyKey: "admin-identity-retry",
    };
    const first = await send(h.ctx, request);
    const retry = await send(h.ctx, request);
    expect(retry).toMatchObject({ outcome: "duplicate", delivery: { id: first.delivery.id } });
  });

  it("parks a send for approval when the identity demands it", async () => {
    const identity = await seedIdentity({ requireApproval: true });
    const ctx = h.asIdentity(identity.id);
    const inbox = await h.seedInbox(`reviewed@${TEST_DOMAIN}`, { identityId: identity.id });

    const result = await send(ctx, {
      from: inbox.address,
      to: ["user@corp.com"],
      subject: "Needs a human",
      text: "…",
    });

    expect(result.outcome).toBe("pending_approval");
    expect(result.delivery.status).toBe("pending_approval");
    expect(eventsOfType(h.events.published, "delivery.approval_requested")).toHaveLength(1);
  });

  it("does not let an identity-bound key send from another identity's inbox", async () => {
    const owner = await seedIdentity({ name: "owner" });
    const intruder = await seedIdentity({ name: "intruder" });
    const owned = await h.seedInbox(`owned@${TEST_DOMAIN}`, { identityId: owner.id });

    await expect(
      send(h.asIdentity(intruder.id, ["message:send"]), {
        from: owned.address,
        to: ["user@corp.com"],
        subject: "Not mine",
        text: "Body",
      }),
    ).rejects.toMatchObject({ code: "inbox_not_found" });
    expect(h.dispatchQueue.enqueued).toEqual([]);
  });

  it("keeps delivery lists and timelines inside an identity boundary", async () => {
    const alice = await seedIdentity({ name: "alice" });
    const bob = await seedIdentity({ name: "bob" });
    const aliceInbox = await h.seedInbox(`alice-send@${TEST_DOMAIN}`, { identityId: alice.id });
    const bobInbox = await h.seedInbox(`bob-send@${TEST_DOMAIN}`, { identityId: bob.id });
    const aliceSend = await send(h.asIdentity(alice.id), {
      from: aliceInbox.address,
      to: ["alice-recipient@corp.com"],
      subject: "Alice",
      text: "Private",
    });
    const bobSend = await send(h.asIdentity(bob.id), {
      from: bobInbox.address,
      to: ["bob-recipient@corp.com"],
      subject: "Bob",
      text: "Private",
    });

    const aliceCaller = h.asIdentity(alice.id, ["message:read"]);
    expect((await h.services.delivery.list(aliceCaller)).items.map((item) => item.id)).toEqual([
      aliceSend.delivery.id,
    ]);
    await expect(
      h.services.delivery.timeline(aliceCaller, bobSend.delivery.id),
    ).rejects.toMatchObject({ code: "message_not_found" });
  });

  it("lets identities reuse an idempotency key without disclosing each other", async () => {
    const alice = await seedIdentity({ name: "alice" });
    const bob = await seedIdentity({ name: "bob" });
    const aliceInbox = await h.seedInbox(`alice-key@${TEST_DOMAIN}`, { identityId: alice.id });
    const bobInbox = await h.seedInbox(`bob-key@${TEST_DOMAIN}`, { identityId: bob.id });
    await send(h.asIdentity(alice.id, ["message:send"]), {
      from: aliceInbox.address,
      to: ["one@corp.com"],
      subject: "One",
      text: "One",
      idempotencyKey: "shared-run",
    });

    const bobResult = await send(h.asIdentity(bob.id, ["message:send"]), {
      from: bobInbox.address,
      to: ["two@corp.com"],
      subject: "Two",
      text: "Two",
      idempotencyKey: "shared-run",
    });
    expect(bobResult.outcome).toBe("queued");
  });

  it("cannot attach a reply to another identity's private message", async () => {
    const alice = await seedIdentity({ name: "alice" });
    const bob = await seedIdentity({ name: "bob" });
    const aliceInbox = await h.seedInbox(`alice-reply@${TEST_DOMAIN}`, {
      identityId: alice.id,
    });
    const bobInbox = await h.seedInbox(`bob-reply@${TEST_DOMAIN}`, { identityId: bob.id });
    const inbound = await h.services.ingestion.ingest(h.ctx, {
      recipient: aliceInbox.address,
      envelopeFrom: "sender@corp.com",
      raw: rawEmail({
        from: "sender@corp.com",
        to: aliceInbox.address,
        messageId: "private-parent@corp.com",
      }),
    });
    if (inbound.outcome !== "stored") throw new Error("expected stored");

    await expect(
      send(h.asIdentity(bob.id, ["message:send"]), {
        from: bobInbox.address,
        to: ["sender@corp.com"],
        subject: "Not my thread",
        text: "No",
        inReplyToMessageId: inbound.message.id,
      }),
    ).rejects.toMatchObject({ code: "message_not_found" });
  });

  it("rejects a suppressed recipient before spending an API call", async () => {
    await h.deps.suppressions.add(h.ctx, {
      address: "bounced@corp.com" as never,
      reason: "hard_bounce",
      source: "cf_sync",
      createdAt: h.clock.now(),
    });

    await expect(
      send(h.ctx, { from: FROM, to: ["bounced@corp.com"], subject: "x", text: "y" }),
    ).rejects.toMatchObject({ code: "suppressed_recipient" });
    expect(eventsOfType(h.events.published, "delivery.rejected")).toHaveLength(1);
  });

  it("stops an agent from mailing itself", async () => {
    await expect(
      send(h.ctx, { from: FROM, to: [FROM], subject: "hello me", text: "y" }),
    ).rejects.toMatchObject({ code: "loop_detected" });
  });

  it("refuses a send without the message:send scope", async () => {
    const readOnly = h.withScopes(["message:read"]);
    await expect(
      send(readOnly, { from: FROM, to: ["user@corp.com"], subject: "x", text: "y" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("stamps Auto-Submitted so peers can break loops from their side", async () => {
    const result = await send(h.ctx, {
      from: FROM,
      to: ["user@corp.com"],
      subject: "auto",
      text: "y",
      automated: true,
    });
    await dispatch(h.ctx, { deliveryId: result.delivery.id });

    expect(h.transport.sent[0]?.headers["Auto-Submitted"]).toBe("auto-replied");
  });

  it("will not auto-reply to an automated message", async () => {
    // The two-bot loop, end to end: an autoresponder mails us, and an agent
    // tries to answer it automatically.
    const ingest = h.services.ingestion.ingest;
    const inbound = await ingest(h.ctx, {
      recipient: FROM,
      envelopeFrom: "robot@corp.com",
      raw: rawEmail({
        from: "robot@corp.com",
        to: FROM,
        messageId: "bot@corp.com",
        autoSubmitted: "auto-replied",
      }),
    });
    if (inbound.outcome !== "stored") throw new Error("expected stored");

    await expect(
      send(h.ctx, {
        from: FROM,
        to: ["robot@corp.com"],
        subject: "Re: hello",
        text: "…",
        inReplyToMessageId: inbound.message.id,
        automated: true,
      }),
    ).rejects.toMatchObject({ code: "loop_detected" });
  });
});

describe("delivery.dispatch", () => {
  it("sends, then archives our own copy", async () => {
    const queued = await send(h.ctx, {
      from: FROM,
      to: ["user@corp.com"],
      subject: "Report",
      text: "Body",
    });
    const result = await dispatch(h.ctx, { deliveryId: queued.delivery.id });

    expect(result.outcome).toBe("dispatched");
    if (result.outcome !== "dispatched") return;
    expect(h.transport.sent).toHaveLength(1);
    expect(result.delivery.status).toBe("dispatched");
    expect(result.delivery.providerMessageId).toBe("prov-1");
    // The sent copy is read, and lands in the sending inbox.
    expect(result.sentCopy.direction).toBe("outbound");
    expect(result.sentCopy.seen).toBe(true);
    expect(result.delivery.messageId).toBe(result.sentCopy.id);
    expect(await h.deliveries.listStagedDispatches(h.ctx, 10)).toEqual([]);
  });

  it("repairs a failed sent-copy archive without calling the transport twice", async () => {
    const queued = await send(h.ctx, {
      from: FROM,
      to: ["user@corp.com"],
      subject: "Archive repair",
      text: "Body",
    });
    h.mimeBuilder.failure = new Error("archive unavailable");

    await expect(dispatch(h.ctx, { deliveryId: queued.delivery.id })).rejects.toThrow(
      "archive unavailable",
    );
    expect(h.transport.sent).toHaveLength(1);
    expect(await h.deliveries.findById(h.ctx, queued.delivery.id)).toMatchObject({
      status: "dispatched",
      messageId: null,
      providerMessageId: "prov-1",
    });
    expect(await h.deliveries.listStagedDispatches(h.ctx, 10)).toHaveLength(1);

    h.mimeBuilder.failure = null;
    const repaired = await dispatch(h.ctx, { deliveryId: queued.delivery.id });
    expect(repaired.outcome).toBe("dispatched");
    expect(h.transport.sent).toHaveLength(1);
    expect(await h.deliveries.listStagedDispatches(h.ctx, 10)).toEqual([]);
  });

  it("marks an abandoned provider hand-off unknown instead of resending it", async () => {
    const queued = await send(h.ctx, {
      from: FROM,
      to: ["user@corp.com"],
      subject: "Interrupted",
      text: "Body",
    });
    const claimed = Delivery.beginDispatch(queued.delivery, h.clock.now());
    expect(await h.deliveries.updateIfStatus(h.ctx, claimed, "queued")).toBe(true);
    h.clock.advance(5 * 60 * 1000 + 1);

    expect(await h.services.delivery.reconcileDispatchOutbox(h.ctx)).toMatchObject({
      markedUnknown: 1,
      enqueued: 0,
    });
    expect(await h.deliveries.findById(h.ctx, queued.delivery.id)).toMatchObject({
      status: "failed",
      lastError: expect.stringContaining("outcome is unknown"),
    });
    expect(h.transport.sent).toEqual([]);
    expect(await h.deliveries.listStagedDispatches(h.ctx, 10)).toEqual([]);
  });

  it("skips a job the queue delivered twice", async () => {
    const queued = await send(h.ctx, {
      from: FROM,
      to: ["user@corp.com"],
      subject: "Once",
      text: "y",
    });
    await dispatch(h.ctx, { deliveryId: queued.delivery.id });
    const again = await dispatch(h.ctx, { deliveryId: queued.delivery.id });

    expect(again.outcome).toBe("skipped");
    expect(h.transport.sent).toHaveLength(1);
  });

  it("throws on a retryable failure so the queue redelivers", async () => {
    const queued = await send(h.ctx, {
      from: FROM,
      to: ["user@corp.com"],
      subject: "flaky",
      text: "y",
    });
    h.transport.nextResult = { ok: false, error: "503 upstream", retryable: true };

    await expect(dispatch(h.ctx, { deliveryId: queued.delivery.id })).rejects.toSatisfy(
      (err: unknown) => isDomainError(err) && err.code === "send_rejected",
    );
    // Still queued, so the redelivery has something to pick up.
    const reloaded = await h.deps.deliveries.findById(h.ctx, queued.delivery.id);
    expect(reloaded?.status).toBe("queued");
  });

  it("records a permanent failure without throwing", async () => {
    const queued = await send(h.ctx, {
      from: FROM,
      to: ["user@corp.com"],
      subject: "doomed",
      text: "y",
    });
    h.transport.nextResult = { ok: false, error: "550 no such user", retryable: false };

    const result = await dispatch(h.ctx, { deliveryId: queued.delivery.id });
    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") return;
    // Retrying would only burn quota; the queue must not be told to try again.
    expect(result.delivery.status).toBe("failed");
  });

  it("does not store a sent copy when the send failed", async () => {
    const queued = await send(h.ctx, {
      from: FROM,
      to: ["user@corp.com"],
      subject: "doomed",
      text: "y",
    });
    h.transport.nextResult = { ok: false, error: "550", retryable: false };
    await dispatch(h.ctx, { deliveryId: queued.delivery.id });

    const page = await h.deps.messages.list(h.ctx, { direction: "outbound" });
    // A mail log that shows a message which never left is the one lie it must not tell.
    expect(page.items).toHaveLength(0);
  });

  it("threads our reply into the inbound conversation", async () => {
    const ingest = h.services.ingestion.ingest;
    const inbound = await ingest(h.ctx, {
      recipient: FROM,
      envelopeFrom: "user@corp.com",
      raw: rawEmail({ from: "user@corp.com", to: FROM, messageId: "root@corp.com" }),
    });
    if (inbound.outcome !== "stored") throw new Error("expected stored");

    const queued = await send(h.ctx, {
      from: FROM,
      to: ["user@corp.com"],
      subject: "Re: hello",
      text: "answer",
      inReplyToMessageId: inbound.message.id,
    });
    const result = await dispatch(h.ctx, { deliveryId: queued.delivery.id });

    if (result.outcome !== "dispatched") throw new Error("expected dispatched");
    expect(result.sentCopy.threadId).toBe(inbound.message.threadId);
    expect(result.sentCopy.inReplyTo).toBe("root@corp.com");
  });
});

describe("delivery.approve", () => {
  async function pendingApproval(): Promise<Awaited<ReturnType<typeof send>>["delivery"]> {
    const identity = await seedIdentity({ requireApproval: true });
    const ctx = h.asIdentity(identity.id);
    const inbox = await h.seedInbox(`approval@${TEST_DOMAIN}`, { identityId: identity.id });
    const result = await send(ctx, {
      from: inbox.address,
      to: ["user@corp.com"],
      subject: "Needs a human",
      text: "Body",
    });
    if (result.outcome !== "pending_approval") throw new Error("expected approval hold");
    return result.delivery;
  }

  it("moves a held send to queued exactly once", async () => {
    const pending = await pendingApproval();

    const approved = await h.services.delivery.approve(h.ctx, pending.id);

    expect(approved.status).toBe("queued");
    expect(approved.approvedBy).toBe(h.ctx.subject);
    expect(h.dispatchQueue.enqueued).toEqual([pending.id]);
    expect(await h.deps.deliveries.findById(h.ctx, pending.id)).toMatchObject({
      status: "queued",
      approvedBy: h.ctx.subject,
    });
  });

  it("refuses a repeated approval without enqueueing twice", async () => {
    const pending = await pendingApproval();
    await h.services.delivery.approve(h.ctx, pending.id);

    await expect(h.services.delivery.approve(h.ctx, pending.id)).rejects.toMatchObject({
      code: "invalid_state_transition",
    });
    expect(h.dispatchQueue.enqueued).toEqual([pending.id]);
  });

  it("does not let an identity-bound credential approve its own hold", async () => {
    const pending = await pendingApproval();
    const identity = h.identities.rows
      .get(h.ctx.accountId)!
      .find((item) => item.name === "reporter")!;

    await expect(
      h.services.delivery.approve(h.asIdentity(identity.id, ["message:approve"]), pending.id),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(h.dispatchQueue.enqueued).toEqual([]);
  });
});
