import { type IngestionService, MAX_INBOUND_MESSAGE_BYTES } from "@core/application";
import { BlobKeys, decodeStoredMessageBody, eventsOfType } from "@core/domain";
import type { Harness } from "@core/testing";
import { createHarness, rawEmail, TEST_DOMAIN } from "@core/testing";
import { beforeEach, describe, expect, it } from "vitest";

let h: Harness;
let ingest: IngestionService["ingest"];

beforeEach(() => {
  h = createHarness();
  ingest = h.services.ingestion.ingest;
});

const PASSING_AUTH = "mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass";

describe("ingestion.ingest", () => {
  it("rejects a message larger than the inbound transport limit before parsing", async () => {
    await expect(
      ingest(h.ctx, {
        recipient: `support@${TEST_DOMAIN}`,
        envelopeFrom: "sender@corp.com",
        raw: new Uint8Array(MAX_INBOUND_MESSAGE_BYTES + 1),
      }),
    ).rejects.toMatchObject({
      code: "message_too_large",
      details: { max: MAX_INBOUND_MESSAGE_BYTES },
    });
    expect(h.blobs.objects.size).toBe(0);
  });

  it("requires the dedicated injection scope", async () => {
    await expect(
      ingest(h.withScopes(["message:read"]), {
        recipient: `support@${TEST_DOMAIN}`,
        envelopeFrom: "sender@corp.com",
        raw: rawEmail({
          from: "sender@corp.com",
          to: `support@${TEST_DOMAIN}`,
          subject: "Forged",
        }),
      }),
    ).rejects.toMatchObject({ code: "forbidden", details: { required: "message:inject" } });
  });

  it("does not let one identity inject into another identity's inbox", async () => {
    const alice = await h.services.identity.createIdentity(h.ctx, { name: "alice" });
    const bob = await h.services.identity.createIdentity(h.ctx, { name: "bob" });
    const inbox = await h.seedInbox(`alice@${TEST_DOMAIN}`, { identityId: alice.id });

    const result = await ingest(h.asIdentity(bob.id, ["message:inject"]), {
      recipient: inbox.address,
      envelopeFrom: "sender@corp.com",
      raw: rawEmail({ from: "sender@corp.com", to: inbox.address, messageId: "forged@x" }),
    });

    expect(result).toEqual({ outcome: "unroutable", reason: "no_such_inbox" });
    expect(h.messages.rows.get(h.ctx.accountId) ?? []).toEqual([]);
  });

  it("stores a message into the addressed inbox", async () => {
    const inbox = await h.seedInbox(`support@${TEST_DOMAIN}`);
    const result = await ingest(h.ctx, {
      recipient: `support@${TEST_DOMAIN}`,
      envelopeFrom: "sender@corp.com",
      raw: rawEmail({
        from: '"Alice" <alice@corp.com>',
        to: `support@${TEST_DOMAIN}`,
        subject: "Need help",
        messageId: "m1@corp.com",
        authResults: PASSING_AUTH,
      }),
    });

    expect(result.outcome).toBe("stored");
    if (result.outcome !== "stored") return;
    expect(result.message.inboxId).toBe(inbox.id);
    expect(result.message.subject).toBe("Need help");
    // The raw From header is preserved; the bare address is extracted alongside.
    expect(result.message.fromHeader).toBe('"Alice" <alice@corp.com>');
    expect(result.message.from).toBe("alice@corp.com");
    expect(result.message.seen).toBe(false);
  });

  it("routes a +tag address to the base inbox and records the tag", async () => {
    const inbox = await h.seedInbox(`agent-7@${TEST_DOMAIN}`);
    const result = await ingest(h.ctx, {
      recipient: `agent-7+run42@${TEST_DOMAIN}`,
      envelopeFrom: "x@corp.com",
      raw: rawEmail({
        from: "x@corp.com",
        to: `agent-7+run42@${TEST_DOMAIN}`,
        messageId: "t@x",
      }),
    });

    if (result.outcome !== "stored") throw new Error(`expected stored, got ${result.outcome}`);
    expect(result.message.inboxId).toBe(inbox.id);
    expect(result.message.tag).toBe("run42");
    expect(result.message.envelopeRecipient).toBe(`agent-7+run42@${TEST_DOMAIN}`);
  });

  it("keeps +tag routes distinct while deduplicating a retry to the same tag", async () => {
    const inbox = await h.seedInbox(`agent-7@${TEST_DOMAIN}`);
    // Keep the MIME bytes identical on purpose. Deduplication must use SMTP
    // RCPT TO, not the spoofable/possibly unrelated To header.
    const raw = rawEmail({
      from: "x@corp.com",
      to: inbox.address,
      messageId: "tag-fanout@x",
    });
    const deliver = (recipient: string) =>
      ingest(h.ctx, { recipient, envelopeFrom: "x@corp.com", raw });

    expect((await deliver(`agent-7+run-one@${TEST_DOMAIN}`)).outcome).toBe("stored");
    expect((await deliver(`agent-7+run-two@${TEST_DOMAIN}`)).outcome).toBe("stored");
    expect((await deliver(`Agent-7+RUN-ONE@${TEST_DOMAIN}`)).outcome).toBe("duplicate");

    const rows = h.messages.rows.get(h.ctx.accountId) ?? [];
    expect(rows.map((row) => row.envelopeRecipient).sort()).toEqual([
      `agent-7+run-one@${TEST_DOMAIN}`,
      `agent-7+run-two@${TEST_DOMAIN}`,
    ]);
  });

  it("keeps distinct catch-all recipients that share one quarantine inbox", async () => {
    const quarantine = await h.seedInbox(`quarantine@${TEST_DOMAIN}`);
    h.domains.routings = [
      {
        domain: TEST_DOMAIN,
        catchAllMode: "store",
        catchAllInboxId: quarantine.id,
        autocreatePattern: null,
        sendingStatus: "verified",
        dkimSelector: null,
      },
    ];
    const raw = rawEmail({
      from: "x@corp.com",
      to: "undisclosed@corp.com",
      messageId: "catch-all-fanout@x",
    });
    const deliver = (recipient: string) =>
      ingest(h.ctx, { recipient, envelopeFrom: "x@corp.com", raw });

    expect((await deliver(`first@${TEST_DOMAIN}`)).outcome).toBe("stored");
    expect((await deliver(`second@${TEST_DOMAIN}`)).outcome).toBe("stored");
    expect((await deliver(`FIRST@${TEST_DOMAIN}`)).outcome).toBe("duplicate");

    const rows = h.messages.rows.get(h.ctx.accountId) ?? [];
    expect(rows.map((row) => row.envelopeRecipient).sort()).toEqual([
      `first@${TEST_DOMAIN}`,
      `second@${TEST_DOMAIN}`,
    ]);
  });

  it("archives the raw MIME before the row exists", async () => {
    await h.seedInbox(`support@${TEST_DOMAIN}`);
    const raw = rawEmail({
      from: "a@corp.com",
      to: `support@${TEST_DOMAIN}`,
      messageId: "r1@x",
    });
    const result = await ingest(h.ctx, {
      recipient: `support@${TEST_DOMAIN}`,
      envelopeFrom: "a@corp.com",
      raw,
    });

    if (result.outcome !== "stored") throw new Error("expected stored");
    expect(result.message.rawKey).not.toBeNull();
    // This is what makes `get --raw` into `inject` a closed loop.
    const stored = await h.deps.blobs.get(h.ctx, result.message.rawKey!);
    expect(stored).toEqual(raw);
  });

  it("stores the complete decoded body separately for D1-backed repositories", async () => {
    await h.seedInbox(`support@${TEST_DOMAIN}`);
    const body = "The complete body stays outside D1.";
    const result = await ingest(h.ctx, {
      recipient: `support@${TEST_DOMAIN}`,
      envelopeFrom: "a@corp.com",
      raw: rawEmail({
        from: "a@corp.com",
        to: `support@${TEST_DOMAIN}`,
        messageId: "body-r2@x",
        body,
      }),
    });

    if (result.outcome !== "stored") throw new Error("expected stored");
    const key = BlobKeys.messageBody(h.ctx.accountId, result.message.id);
    const bytes = await h.blobs.get(h.ctx, key);
    expect(bytes).not.toBeNull();
    expect(decodeStoredMessageBody(bytes!)).toEqual({ bodyText: body, bodyHtml: null });
  });

  it("cleans already-written objects when a later R2 write fails", async () => {
    await h.seedInbox(`support@${TEST_DOMAIN}`);
    const put = h.blobs.put.bind(h.blobs);
    let calls = 0;
    h.blobs.put = async (...args: Parameters<typeof h.blobs.put>) => {
      calls += 1;
      if (calls === 2) throw new Error("body R2 unavailable");
      await put(...args);
    };

    await expect(
      ingest(h.ctx, {
        recipient: `support@${TEST_DOMAIN}`,
        envelopeFrom: "a@corp.com",
        raw: rawEmail({
          from: "a@corp.com",
          to: `support@${TEST_DOMAIN}`,
          messageId: "r2-failure@x",
        }),
      }),
    ).rejects.toThrow("body R2 unavailable");
    expect(h.blobs.objects.size).toBe(0);
  });

  it("validates oversized metadata before writing any blobs", async () => {
    await h.seedInbox(`support@${TEST_DOMAIN}`);
    await expect(
      ingest(h.ctx, {
        recipient: `support@${TEST_DOMAIN}`,
        envelopeFrom: "a@corp.com",
        raw: rawEmail({
          from: "a@corp.com",
          to: `support@${TEST_DOMAIN}`,
          messageId: "oversized-subject@x",
          subject: "x".repeat(2001),
        }),
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    expect(h.blobs.objects.size).toBe(0);
  });

  it("deduplicates a redelivered message instead of storing it twice", async () => {
    await h.seedInbox(`support@${TEST_DOMAIN}`);
    const raw = rawEmail({
      from: "a@corp.com",
      to: `support@${TEST_DOMAIN}`,
      messageId: "dup@x",
    });
    const input = { recipient: `support@${TEST_DOMAIN}`, envelopeFrom: "a@corp.com", raw };

    expect((await ingest(h.ctx, input)).outcome).toBe("stored");
    const storedObjects = h.blobs.objects.size;
    expect((await ingest(h.ctx, input)).outcome).toBe("duplicate");
    expect(h.blobs.objects.size).toBe(storedObjects);
    expect(eventsOfType(h.events.published, "message.duplicate")).toHaveLength(1);
  });

  it("threads a reply onto its parent", async () => {
    await h.seedInbox(`support@${TEST_DOMAIN}`);
    const first = await ingest(h.ctx, {
      recipient: `support@${TEST_DOMAIN}`,
      envelopeFrom: "a@corp.com",
      raw: rawEmail({ from: "a@corp.com", to: `support@${TEST_DOMAIN}`, messageId: "root@x" }),
    });
    const second = await ingest(h.ctx, {
      recipient: `support@${TEST_DOMAIN}`,
      envelopeFrom: "a@corp.com",
      raw: rawEmail({
        from: "a@corp.com",
        to: `support@${TEST_DOMAIN}`,
        messageId: "reply@x",
        inReplyTo: "root@x",
      }),
    });

    if (first.outcome !== "stored" || second.outcome !== "stored")
      throw new Error("expected both");
    expect(second.message.threadId).toBe(first.message.threadId);
    expect(first.message.threadId).toBe("root@x");
  });

  it("marks an unauthenticated sender untrusted and flags injection risk", async () => {
    await h.seedInbox(`support@${TEST_DOMAIN}`);
    const result = await ingest(h.ctx, {
      recipient: `support@${TEST_DOMAIN}`,
      envelopeFrom: "spoof@corp.com",
      raw: rawEmail({
        from: "ceo@corp.com",
        to: `support@${TEST_DOMAIN}`,
        messageId: "spoof@x",
        authResults: "mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail",
      }),
    });

    if (result.outcome !== "stored") throw new Error("expected stored");
    expect(result.message.trusted).toBe(false);
    expect(result.message.trustReasons).toContain("dmarc_fail");
  });

  it("refuses mail for an unknown address and says why", async () => {
    const result = await ingest(h.ctx, {
      recipient: `nobody@${TEST_DOMAIN}`,
      envelopeFrom: "a@corp.com",
      raw: rawEmail({ from: "a@corp.com", to: `nobody@${TEST_DOMAIN}`, messageId: "u@x" }),
    });

    expect(result).toEqual({ outcome: "unroutable", reason: "no_such_inbox" });
    expect(eventsOfType(h.events.published, "message.unroutable")).toHaveLength(1);
  });

  it("reports an expired inbox as expired, not as missing", async () => {
    await h.seedInbox(`temp@${TEST_DOMAIN}`, { kind: "ephemeral", ttlMs: 60_000 });
    h.clock.advance(120_000);

    const result = await ingest(h.ctx, {
      recipient: `temp@${TEST_DOMAIN}`,
      envelopeFrom: "a@corp.com",
      raw: rawEmail({ from: "a@corp.com", to: `temp@${TEST_DOMAIN}`, messageId: "e@x" }),
    });

    // A test whose inbox expired needs a diagnosable answer, not "not found".
    expect(result).toEqual({ outcome: "inbox_unavailable", reason: "inbox_expired" });
  });

  it("mints an inbox on the fly when the domain is in autocreate mode", async () => {
    const harness = createHarness({
      routings: [
        {
          domain: TEST_DOMAIN,
          catchAllMode: "autocreate",
          catchAllInboxId: null,
          autocreatePattern: `agent-*@${TEST_DOMAIN}`,
          sendingStatus: "verified",
          dkimSelector: null,
        },
      ],
    });
    const result = await harness.services.ingestion.ingest(harness.ctx, {
      recipient: `agent-42@${TEST_DOMAIN}`,
      envelopeFrom: "a@corp.com",
      raw: rawEmail({ from: "a@corp.com", to: `agent-42@${TEST_DOMAIN}`, messageId: "auto@x" }),
    });

    if (result.outcome !== "stored") throw new Error(`expected stored, got ${result.outcome}`);
    expect(result.inbox.address).toBe(`agent-42@${TEST_DOMAIN}`);
    expect(result.inbox.kind).toBe("ephemeral");
    expect(eventsOfType(harness.events.published, "inbox.created")).toHaveLength(1);
  });

  it("wakes waiters only once the message is durable", async () => {
    await h.seedInbox(`support@${TEST_DOMAIN}`);
    await ingest(h.ctx, {
      recipient: `support@${TEST_DOMAIN}`,
      envelopeFrom: "a@corp.com",
      raw: rawEmail({ from: "a@corp.com", to: `support@${TEST_DOMAIN}`, messageId: "w@x" }),
    });

    expect(h.waiter.notified).toHaveLength(1);
    const found = await h.deps.messages.findById(h.ctx, h.waiter.notified[0]!.id);
    expect(found).not.toBeNull();
  });

  it("mints a Message-ID when the sender omitted one", async () => {
    await h.seedInbox(`support@${TEST_DOMAIN}`);
    const raw = new TextEncoder().encode(
      [`From: a@corp.com`, `To: support@${TEST_DOMAIN}`, `Subject: no id`, "", "body"].join(
        "\r\n",
      ),
    );
    const result = await ingest(h.ctx, {
      recipient: `support@${TEST_DOMAIN}`,
      envelopeFrom: "a@corp.com",
      raw,
    });

    if (result.outcome !== "stored") throw new Error("expected stored");
    // Without an id it could be neither deduplicated nor threaded by anyone.
    expect(result.message.rfcMessageId).toContain(`@${TEST_DOMAIN}`);
  });

  it("deduplicates a redelivery that omitted Message-ID", async () => {
    await h.seedInbox(`support@${TEST_DOMAIN}`);
    const raw = new TextEncoder().encode(
      [`From: a@corp.com`, `To: support@${TEST_DOMAIN}`, `Subject: no id`, "", "body"].join(
        "\r\n",
      ),
    );
    const input = {
      recipient: `support@${TEST_DOMAIN}`,
      envelopeFrom: "a@corp.com",
      raw,
    };

    const first = await ingest(h.ctx, input);
    const replay = await ingest(h.ctx, input);

    expect(first.outcome).toBe("stored");
    expect(replay.outcome).toBe("duplicate");
    if (first.outcome === "stored" && replay.outcome === "duplicate") {
      expect(replay.rfcMessageId).toBe(first.message.rfcMessageId);
    }
  });
});
