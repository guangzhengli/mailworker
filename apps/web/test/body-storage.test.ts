import { env } from "cloudflare:test";
import type { AttachmentMeta, Caller, Ulid } from "@mailworker/core";
import {
  AccountId,
  BlobKeys,
  EmailAddress,
  encodeStoredMessageBody,
  MESSAGE_INDEX_TEXT_BYTES,
  Message,
  ProjectId,
  RfcMessageId,
  ThreadId,
} from "@mailworker/core";
import { createDb, D1Messages, R2Blobs, schema } from "@web/workers/adapters";
import { beforeEach, describe, expect, it } from "vitest";

const ctx: Caller = {
  accountId: AccountId.parse("alice"),
  projectId: ProjectId.DEFAULT,
  mode: "live",
  identityId: null,
  scopes: ["admin"],
  subject: "test",
};
const db = createDb(env.DB);
const blobs = new R2Blobs(env.BLOBS);
const repository = new D1Messages(db, blobs);
const INBOX_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const NOW = new Date("2026-07-01T12:00:00.000Z");

let sequence = 0;
function nextId(): Ulid {
  sequence += 1;
  return `01J${sequence.toString().padStart(23, "0")}` as Ulid;
}

function message(
  bodyText: string | null,
  bodyHtml: string | null,
  attachments: AttachmentMeta[] = [],
  threadId?: ThreadId,
) {
  const id = nextId();
  return Message.create({
    id,
    accountId: ctx.accountId,
    inboxId: INBOX_ID,
    rfcMessageId: RfcMessageId.parse(`${id}@corp.test`),
    threadId: threadId ?? ThreadId.parse(`${id}@corp.test`),
    direction: "inbound",
    fromHeader: "sender@corp.test",
    from: EmailAddress.parse("sender@corp.test"),
    toHeader: "agent@mail.example.com",
    to: [EmailAddress.parse("agent@mail.example.com")],
    subject: "Large body",
    bodyText,
    bodyHtml,
    attachments,
    receivedAt: NOW,
  });
}

async function reset() {
  await db.batch([db.delete(schema.attachments), db.delete(schema.messages)]);
  let cursor: string | undefined;
  do {
    const page = await env.BLOBS.list(cursor === undefined ? {} : { cursor });
    if (page.objects.length > 0)
      await env.BLOBS.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
}

describe("R2-backed message bodies", () => {
  beforeEach(reset);

  it("keeps only UTF-8-bounded index text in D1 and hydrates the complete >2 MB bodies", async () => {
    const bodyText = `INDEX-MARKER ${"a".repeat(2_100_000)}`;
    const bodyHtml = `<p>${"你".repeat(800_000)}</p>`;
    const stored = message(bodyText, bodyHtml);
    const bodyKey = BlobKeys.messageBody(ctx.accountId, stored.id);
    await blobs.put(ctx, bodyKey, encodeStoredMessageBody({ bodyText, bodyHtml }), {
      contentType: "application/json",
    });

    expect(await repository.insert(ctx, stored, { bodyKey })).toEqual({ stored: true });

    const row = await env.DB.prepare(
      `SELECT length(CAST(body_text AS BLOB)) AS text_bytes,
              length(CAST(body_html AS BLOB)) AS html_bytes,
              body_key
       FROM messages WHERE id = ?`,
    )
      .bind(stored.id)
      .first<{ text_bytes: number; html_bytes: number; body_key: string }>();
    expect(row?.text_bytes).toBe(MESSAGE_INDEX_TEXT_BYTES);
    expect(row?.html_bytes).toBeLessThanOrEqual(MESSAGE_INDEX_TEXT_BYTES);
    expect(row?.body_key).toBe(bodyKey);

    const hydrated = await repository.findById(ctx, stored.id);
    expect(hydrated?.bodyText).toBe(bodyText);
    expect(hydrated?.bodyHtml).toBe(bodyHtml);

    // List/search use the bounded D1 projection and never need the full R2 body.
    await blobs.delete(ctx, [bodyKey]);
    expect((await repository.list(ctx, { q: "INDEX-MARKER" })).items[0]?.id).toBe(stored.id);
    await expect(repository.findById(ctx, stored.id)).rejects.toThrow("body blob is missing");

    await blobs.put(ctx, bodyKey, new TextEncoder().encode("not-json"));
    await expect(repository.findById(ctx, stored.id)).rejects.toThrow();
  });

  it("atomically inserts 25 attachments in sub-100-parameter chunks", async () => {
    const id = nextId();
    const attachments: AttachmentMeta[] = Array.from({ length: 25 }, (_, index) => ({
      id: nextId(),
      filename: `part-${index}.txt`,
      mime: "text/plain",
      contentId: null,
      size: index,
      inline: false,
      storageKey: BlobKeys.attachment(ctx.accountId, id, `part-${index}`),
    }));
    const stored = message("body", null, attachments);

    expect(await repository.insert(ctx, stored)).toEqual({ stored: true });
    expect((await repository.findById(ctx, stored.id))?.attachments).toHaveLength(25);
  });

  it("rolls the message back when any attachment statement fails", async () => {
    const conflictingId = nextId();
    await env.DB.prepare(
      `INSERT INTO attachments
       (id, account_id, message_id, filename, mime, content_id, size, inline, r2_key)
       VALUES (?, ?, 'existing-message', NULL, NULL, NULL, 0, 0, 'att/alice/existing')`,
    )
      .bind(conflictingId, ctx.accountId)
      .run();
    const stored = message("body", null, [
      {
        id: conflictingId,
        filename: null,
        mime: null,
        contentId: null,
        size: 0,
        inline: false,
        storageKey: "att/alice/conflict",
      },
    ]);

    await expect(repository.insert(ctx, stored)).rejects.toThrow();
    const row = await env.DB.prepare("SELECT id FROM messages WHERE id = ?")
      .bind(stored.id)
      .first();
    expect(row).toBeNull();
  });

  it("reads and deletes an inbox with more than 100 message ids without oversized IN bindings", async () => {
    const threadId = ThreadId.parse("long-thread@corp.test");
    for (let index = 0; index < 105; index += 1) {
      expect(
        await repository.insert(ctx, message(`body ${index}`, null, [], threadId)),
      ).toEqual({
        stored: true,
      });
    }

    expect(await repository.listThread(ctx, threadId)).toHaveLength(105);
    await repository.deleteByInbox(ctx, INBOX_ID);
    const count = await env.DB.prepare(
      "SELECT count(*) AS value FROM messages WHERE inbox_id = ?",
    )
      .bind(INBOX_ID)
      .first<{ value: number }>();
    expect(count?.value).toBe(0);
  });
});
