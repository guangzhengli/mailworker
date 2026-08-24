import { inboxDto, toInboxDto } from "@contract/inbox";
import {
  messageDto,
  messageSummaryDto,
  toMessageDto,
  toMessageSummaryDto,
} from "@contract/message";
import {
  deliveryDto,
  deliveryEventDto,
  toDeliveryDto,
  toDeliveryEventDto,
} from "@contract/send";
import type { DeliveryEvent } from "@mailworker/core";
import { Delivery, Message, Ulid } from "@mailworker/core";
import { createHarness, rawEmail, TEST_DOMAIN } from "@mailworker/core/testing";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * These are the tests that matter in this package.
 *
 * A DTO schema and the function that produces it are two descriptions of one
 * thing, and nothing stops them drifting — add a field to the mapper, forget the
 * schema, and the SDK silently parses it away. So every codec is fed a domain
 * object the system genuinely produced (via the real ingest use case, not a
 * hand-written literal) and the result is parsed back through its own schema.
 */

let message: Message;
let harness: ReturnType<typeof createHarness>;

beforeAll(async () => {
  harness = createHarness();
  const inbox = await harness.seedInbox(`agent-1@${TEST_DOMAIN}`);
  const result = await harness.services.ingestion.ingest(harness.ctx, {
    recipient: `agent-1+run42@${TEST_DOMAIN}`,
    envelopeFrom: "bounces@corp.com",
    raw: rawEmail({
      from: '"Corp Security" <noreply@corp.com>',
      to: `agent-1+run42@${TEST_DOMAIN}`,
      subject: "Your code is 483920",
      body: "Your verification code is 483920. It expires in 10 minutes.",
      messageId: "abc123@corp.com",
      authResults: "mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass",
    }),
  });
  if (result.outcome !== "stored") throw new Error(`ingest failed: ${result.outcome}`);
  message = result.message;
  expect(inbox.id).toBe(message.inboxId);
});

describe("message codec", () => {
  it("round-trips through its own schema", () => {
    const dto = toMessageDto(message);
    expect(() => messageDto.parse(dto)).not.toThrow();
  });

  it("keeps internal storage addresses off the wire", () => {
    const dto = toMessageDto(message) as Record<string, unknown>;
    // rawKey is an R2 path and accountId is a tenant identifier; neither is
    // something a caller can act on, and both invite reasoning about internals.
    expect(message.rawKey).not.toBeNull();
    expect(dto).not.toHaveProperty("rawKey");
    expect(dto).not.toHaveProperty("accountId");
  });

  it("groups provenance and carries the auth results verbatim", () => {
    const dto = toMessageDto(message);
    expect(dto.provenance).toEqual({
      trusted: true,
      reasons: ["dmarc_pass"],
      spf: "pass",
      dkim: "pass",
      dmarc: "pass",
    });
  });

  it("preserves the display name in fromHeader and the bare address in from", () => {
    const dto = toMessageDto(message);
    expect(dto.fromHeader).toBe('"Corp Security" <noreply@corp.com>');
    expect(dto.from).toBe("noreply@corp.com");
  });

  it("carries the +tag the message was addressed to", () => {
    expect(toMessageDto(message).tag).toBe("run42");
  });

  it("renames rfcMessageId to messageId without colliding with the ULID", () => {
    const dto = toMessageDto(message);
    expect(dto.messageId).toBe("abc123@corp.com");
    expect(dto.id).toBe(message.id);
  });

  it("emits dates as ISO 8601", () => {
    const dto = toMessageDto(message);
    expect(dto.receivedAt).toBe(message.receivedAt.toISOString());
    expect(new Date(dto.receivedAt).getTime()).toBe(message.receivedAt.getTime());
  });
});

describe("bodyHtml fails closed", () => {
  const withHtml = (): Message => ({
    ...message,
    bodyHtml: '<p onclick="steal()">hi<script>alert(1)</script></p>',
  });

  it("returns null when no sanitizer is supplied", () => {
    // The point: forgetting to wire the sanitizer costs a missing preview,
    // which someone notices — not attacker-authored markup in a dashboard,
    // which nobody notices until it matters.
    expect(toMessageDto(withHtml()).bodyHtml).toBeNull();
  });

  it("applies the sanitizer when one is supplied", () => {
    const dto = toMessageDto(withHtml(), {
      sanitizeHtml: (html) => html.replace(/<script[\s\S]*?<\/script>/g, ""),
    });
    expect(dto.bodyHtml).toBe('<p onclick="steal()">hi</p>');
  });

  it("stays null when the message has no HTML at all", () => {
    expect(toMessageDto(message, { sanitizeHtml: (h) => h }).bodyHtml).toBeNull();
  });
});

describe("message summary codec", () => {
  it("round-trips through its own schema", () => {
    const dto = toMessageSummaryDto(Message.summarize(message));
    expect(() => messageSummaryDto.parse(dto)).not.toThrow();
    expect(dto.preview).toContain("483920");
    expect(dto.hasText).toBe(true);
    expect(dto.hasHtml).toBe(false);
  });

  it("carries no body", () => {
    const dto = toMessageSummaryDto(Message.summarize(message)) as Record<string, unknown>;
    expect(dto).not.toHaveProperty("bodyText");
    expect(dto).not.toHaveProperty("bodyHtml");
  });
});

describe("inbox codec", () => {
  it("round-trips through its own schema", async () => {
    const inbox = await harness.seedInbox(`ephemeral@${TEST_DOMAIN}`, {
      kind: "ephemeral",
      ttlMs: 600_000,
    });
    const dto = toInboxDto(inbox);
    expect(() => inboxDto.parse(dto)).not.toThrow();
    expect(dto.expiresAt).toBe(inbox.expiresAt?.toISOString());
    expect(dto).not.toHaveProperty("accountId");
    expect(dto).not.toHaveProperty("deletedAt");
  });

  it("renders a persistent inbox's absent expiry as null, not a missing key", async () => {
    // A missing key and an explicit null read the same in JavaScript and
    // differently in every schema validator, so the codec always emits the key.
    const dto = toInboxDto(await harness.seedInbox(`forever@${TEST_DOMAIN}`));
    expect(dto).toHaveProperty("expiresAt");
    expect(dto.expiresAt).toBeNull();
    expect(() => inboxDto.parse(dto)).not.toThrow();
  });
});

describe("outbound and delivery-event codecs", () => {
  const OUTBOUND_ID = Ulid.parse("01ARZ3NDEKTSV4RRFFQ69G5FAV");

  const aDelivery = (): Delivery =>
    Delivery.create({
      id: OUTBOUND_ID,
      accountId: message.accountId,
      recipients: [message.from!],
      idempotencyKey: "run-42",
      payloadKey: "out/default/01ARZ3NDEKTSV4RRFFQ69G5FAV.json",
      now: new Date("2026-07-01T12:00:00.000Z"),
    });

  it("round-trips and keeps the payload key off the wire", () => {
    const dto = toDeliveryDto(aDelivery());
    expect(() => deliveryDto.parse(dto)).not.toThrow();
    expect(dto).not.toHaveProperty("payloadKey");
    expect(dto.idempotencyKey).toBe("run-42");
  });

  it("round-trips a delivery event, raw payload included", () => {
    const event: DeliveryEvent = {
      id: OUTBOUND_ID,
      eventId: "0190d0c4-7ea1-7af2-8b88-c1d2e3f4a5b6",
      deliveryId: OUTBOUND_ID,
      providerMessageId: "prov-1",
      recipient: message.from,
      sourceDomain: "mail.example.com",
      sourceZoneId: "zone-1",
      type: "bounced",
      terminal: true,
      smtpCode: "550",
      smtpEnhancedCode: "5.1.1",
      smtpResponse: "5.1.1 user unknown",
      bounceType: "hard",
      bounceClassification: "permanent_failure",
      bounceReason: "User unknown",
      occurredAt: new Date("2026-07-01T12:00:05.000Z"),
      raw: '{"type":"cf.email.sending.message.bounced"}',
    };
    const dto = toDeliveryEventDto(event);
    expect(() => deliveryEventDto.parse(dto)).not.toThrow();
    // The provider's own words are what answer "why did this bounce" when our
    // mapping did not anticipate the reason.
    expect(dto.raw).toContain("bounced");
    expect(dto.smtpResponse).toBe("5.1.1 user unknown");
    expect(dto.bounceType).toBe("hard");
  });
});
