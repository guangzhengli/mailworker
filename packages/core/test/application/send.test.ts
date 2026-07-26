import { dispatchOutbound, ingestInboundEmail, sendMessage } from "@core/application/index.ts";
import type { AgentIdentity } from "@core/domain/index.ts";
import { eventsOfType, AgentIdentity as Identity, isDomainError } from "@core/domain/index.ts";
import type { Harness } from "@core/testing/index.ts";
import { createHarness, rawEmail, TEST_DOMAIN } from "@core/testing/index.ts";
import { beforeEach, describe, expect, it } from "vitest";

let h: Harness;
let send: ReturnType<typeof sendMessage>;
let dispatch: ReturnType<typeof dispatchOutbound>;
const FROM = `agent@${TEST_DOMAIN}`;

beforeEach(async () => {
  h = createHarness();
  send = sendMessage(h.deps);
  dispatch = dispatchOutbound(h.deps);
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

describe("sendMessage", () => {
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
    expect(eventsOfType(h.events.published, "outbound.queued")).toHaveLength(1);
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
    expect(second.outbound.id).toBe(first.outbound.id);
  });

  it("parks a send for approval when the identity demands it", async () => {
    const identity = await seedIdentity({ requireApproval: true });
    const ctx = h.asIdentity(identity.id);

    const result = await send(ctx, {
      from: FROM,
      to: ["user@corp.com"],
      subject: "Needs a human",
      text: "…",
    });

    expect(result.outcome).toBe("pending_approval");
    expect(result.outbound.status).toBe("pending_approval");
    expect(eventsOfType(h.events.published, "outbound.approval_requested")).toHaveLength(1);
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
    expect(eventsOfType(h.events.published, "outbound.rejected")).toHaveLength(1);
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
    await dispatch(h.ctx, { outboundId: result.outbound.id });

    expect(h.transport.sent[0]?.headers["Auto-Submitted"]).toBe("auto-replied");
  });

  it("will not auto-reply to an automated message", async () => {
    // The two-bot loop, end to end: an autoresponder mails us, and an agent
    // tries to answer it automatically.
    const ingest = ingestInboundEmail(h.deps);
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

describe("dispatchOutbound", () => {
  it("sends, then archives our own copy", async () => {
    const queued = await send(h.ctx, {
      from: FROM,
      to: ["user@corp.com"],
      subject: "Report",
      text: "Body",
    });
    const result = await dispatch(h.ctx, { outboundId: queued.outbound.id });

    expect(result.outcome).toBe("dispatched");
    if (result.outcome !== "dispatched") return;
    expect(h.transport.sent).toHaveLength(1);
    expect(result.outbound.status).toBe("dispatched");
    expect(result.outbound.providerMessageId).toBe("prov-1");
    // The sent copy is read, and lands in the sending inbox.
    expect(result.sentCopy.direction).toBe("outbound");
    expect(result.sentCopy.seen).toBe(true);
    expect(result.outbound.messageId).toBe(result.sentCopy.id);
  });

  it("skips a job the queue delivered twice", async () => {
    const queued = await send(h.ctx, {
      from: FROM,
      to: ["user@corp.com"],
      subject: "Once",
      text: "y",
    });
    await dispatch(h.ctx, { outboundId: queued.outbound.id });
    const again = await dispatch(h.ctx, { outboundId: queued.outbound.id });

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

    await expect(dispatch(h.ctx, { outboundId: queued.outbound.id })).rejects.toSatisfy(
      (err: unknown) => isDomainError(err) && err.code === "send_rejected",
    );
    // Still queued, so the redelivery has something to pick up.
    const reloaded = await h.deps.outbound.findById(h.ctx, queued.outbound.id);
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

    const result = await dispatch(h.ctx, { outboundId: queued.outbound.id });
    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") return;
    // Retrying would only burn quota; the queue must not be told to try again.
    expect(result.outbound.status).toBe("failed");
  });

  it("does not store a sent copy when the send failed", async () => {
    const queued = await send(h.ctx, {
      from: FROM,
      to: ["user@corp.com"],
      subject: "doomed",
      text: "y",
    });
    h.transport.nextResult = { ok: false, error: "550", retryable: false };
    await dispatch(h.ctx, { outboundId: queued.outbound.id });

    const page = await h.deps.messages.list(h.ctx, { direction: "outbound" });
    // A mail log that shows a message which never left is the one lie it must not tell.
    expect(page.items).toHaveLength(0);
  });

  it("threads our reply into the inbound conversation", async () => {
    const ingest = ingestInboundEmail(h.deps);
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
    const result = await dispatch(h.ctx, { outboundId: queued.outbound.id });

    if (result.outcome !== "dispatched") throw new Error("expected dispatched");
    expect(result.sentCopy.threadId).toBe(inbound.message.threadId);
    expect(result.sentCopy.inReplyTo).toBe("root@corp.com");
  });
});
