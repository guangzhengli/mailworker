import type { DeliveryService } from "@core/application";
import { AgentIdentity, Attachment, SENDING_LIMITS } from "@core/domain";
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

const HELLO = "aGVsbG8=";

function base64Of(bytes: number): string {
  // 4 base64 chars per 3 bytes, no padding when the length is a multiple of 3.
  return "A".repeat(Math.ceil(bytes / 3) * 4);
}

const attachment = (overrides: Record<string, unknown> = {}) => ({
  filename: "report.csv",
  mime: "text/csv",
  content: HELLO,
  inline: false,
  contentId: null,
  ...overrides,
});

describe("Attachment.byteLength", () => {
  // The size gate runs on messages it is about to refuse, so it must not decode
  // to measure. That only works if the arithmetic is right at each padding case.
  it.each([
    ["QQ==", 1],
    ["QUI=", 2],
    ["QUJD", 3],
    [HELLO, 5],
    ["", 0],
  ])("reads %s as %i bytes without decoding", (base64, bytes) => {
    expect(Attachment.byteLength(base64)).toBe(bytes);
    expect(Attachment.decode({ ...attachment(), content: base64 })).toHaveLength(bytes);
  });
});

describe("delivery.send with attachments", () => {
  it("carries them through the queue to the transport", async () => {
    const result = await send(h.ctx, {
      from: FROM,
      to: ["user@corp.com"],
      subject: "Invoice",
      text: "Attached.",
      attachments: [attachment()],
    });

    await dispatch(h.ctx, { deliveryId: result.delivery.id });

    const [dispatched] = h.transport.sent;
    expect(dispatched?.attachments).toHaveLength(1);
    expect(dispatched?.attachments[0]?.filename).toBe("report.csv");
    // Decoded exactly once, on the far side of the queue.
    expect(new TextDecoder().decode(dispatched?.attachments[0]?.content)).toBe("hello");
  });

  it("hands the same decoded bytes to the archive as to the transport", async () => {
    // Both consumers, one decode. What the recipient gets and what `get --raw`
    // replays have to be the same bytes, or the fixture-replay loop lies.
    // How they are laid out as MIME is `packages/mime`'s problem, and is tested
    // there against a real parser.
    const result = await send(h.ctx, {
      from: FROM,
      to: ["user@corp.com"],
      subject: "Invoice",
      text: "Attached.",
      html: "<p>Attached.</p>",
      attachments: [attachment()],
    });
    await dispatch(h.ctx, { deliveryId: result.delivery.id });

    const archived = h.mimeBuilder.specs[0]?.attachments ?? [];
    expect(archived).toHaveLength(1);
    expect(archived[0]?.content).toEqual(h.transport.sent[0]?.attachments[0]?.content);
    expect(new TextDecoder().decode(archived[0]?.content)).toBe("hello");
  });

  it("marks an attachment with a contentId as inline, so cid: references resolve", async () => {
    const result = await send(h.ctx, {
      from: FROM,
      to: ["user@corp.com"],
      subject: "Hero",
      html: '<img src="cid:hero">',
      attachments: [
        attachment({
          filename: "hero.png",
          mime: "image/png",
          inline: true,
          contentId: "hero",
        }),
      ],
    });
    await dispatch(h.ctx, { deliveryId: result.delivery.id });

    expect(h.transport.sent[0]?.attachments[0]).toMatchObject({
      inline: true,
      contentId: "hero",
      mime: "image/png",
    });
    expect(h.mimeBuilder.specs[0]?.attachments[0]).toMatchObject({ contentId: "hero" });
  });

  it("refuses a message over the size limit before doing any I/O", async () => {
    await expect(
      send(h.ctx, {
        from: FROM,
        to: ["user@corp.com"],
        subject: "Too big",
        text: "x",
        attachments: [attachment({ content: base64Of(SENDING_LIMITS.MAX_MESSAGE_BYTES) })],
      }),
    ).rejects.toMatchObject({ code: "message_too_large" });

    // Nothing was written: no delivery row, nothing queued.
    expect((await h.services.delivery.list(h.ctx)).items).toHaveLength(0);
    expect(h.dispatchQueue.enqueued).toHaveLength(0);
  });

  it("counts the base64 length, not the decoded length, against the limit", async () => {
    // Just under 5 MiB decoded, comfortably over it encoded — the case that
    // passes a naive check here and then fails at Cloudflare.
    const decodedBytes = SENDING_LIMITS.MAX_MESSAGE_BYTES - 100 * 1024;
    await expect(
      send(h.ctx, {
        from: FROM,
        to: ["user@corp.com"],
        subject: "Sneaky",
        text: "x",
        attachments: [attachment({ content: base64Of(decodedBytes) })],
      }),
    ).rejects.toMatchObject({ code: "message_too_large" });
  });

  it("refuses more attachments than the cap", async () => {
    await expect(
      send(h.ctx, {
        from: FROM,
        to: ["user@corp.com"],
        subject: "Many",
        text: "x",
        attachments: Array.from({ length: SENDING_LIMITS.MAX_ATTACHMENTS + 1 }, () =>
          attachment(),
        ),
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("still dispatches a payload written before attachments existed", async () => {
    // A queue can be holding one across the deploy that added the field, and a
    // missing `attachments` must read as "none" rather than throwing.
    const result = await send(h.ctx, {
      from: FROM,
      to: ["user@corp.com"],
      subject: "Old",
      text: "x",
    });
    const delivery = await h.deps.deliveries.findById(h.ctx, result.delivery.id);
    const stored = JSON.parse(
      new TextDecoder().decode(await h.deps.blobs.get(h.ctx, delivery!.payloadKey!)),
    );
    delete stored.attachments;
    await h.deps.blobs.put(
      h.ctx,
      delivery!.payloadKey!,
      new TextEncoder().encode(JSON.stringify(stored)),
      { contentType: "application/json" },
    );

    const outcome = await dispatch(h.ctx, { deliveryId: result.delivery.id });
    expect(outcome.outcome).toBe("dispatched");
    expect(h.transport.sent[0]?.attachments).toEqual([]);
  });
});

describe("delivery.preview", () => {
  it("lists attachments without returning their bytes", async () => {
    const result = await send(h.ctx, {
      from: FROM,
      to: ["user@corp.com"],
      subject: "Invoice",
      html: "<p>Hi</p>",
      attachments: [attachment()],
    });

    const preview = await h.services.delivery.preview(h.ctx, result.delivery.id);
    expect(preview.subject).toBe("Invoice");
    expect(preview.html).toBe("<p>Hi</p>");
    expect(preview.attachments).toEqual([
      { filename: "report.csv", mime: "text/csv", bytes: 5, inline: false },
    ]);
  });

  it("reads a message that is still held for approval", async () => {
    // The whole point of `preview`: the sent copy is written at dispatch, so
    // without this an approver would be releasing an id rather than a message.
    const identity = AgentIdentity.create({
      id: h.ids.ulid(),
      accountId: h.ctx.accountId,
      name: "held",
      requireApproval: true,
      now: h.clock.now(),
    });
    await h.deps.identities.insert(h.ctx, identity);

    const result = await send(h.asIdentity(identity.id), {
      from: FROM,
      to: ["user@corp.com"],
      subject: "Needs a human",
      text: "Please check.",
    });
    expect(result.outcome).toBe("pending_approval");

    const preview = await h.services.delivery.preview(h.ctx, result.delivery.id);
    expect(preview.text).toBe("Please check.");
  });
});
