import { Inbox, MAX_NOTES_PER_MESSAGE, Message } from "@core/domain";
import { createHarness, rawEmail, TEST_DOMAIN } from "@core/testing";
import { describe, expect, it } from "vitest";

async function withMessage() {
  const h = createHarness();
  const inbox = await h.seedInbox(`support@${TEST_DOMAIN}`);
  const result = await h.services.ingestion.ingest(h.ctx, {
    recipient: inbox.address,
    envelopeFrom: "sender@example.com",
    raw: rawEmail({ from: "sender@example.com", to: inbox.address }),
  });
  if (result.outcome !== "stored") throw new Error("Expected a stored fixture.");
  return { ...h, mailbox: h.services.mailbox, message: result.message };
}

describe("mail client state services", () => {
  it("defaults mute by kind and permits explicit overrides", async () => {
    const {
      services: { mailbox },
      ctx,
    } = createHarness();
    for (const [kind, muted, expected] of [
      ["ephemeral", undefined, true],
      ["persistent", undefined, false],
      ["ephemeral", false, false],
      ["persistent", true, true],
    ] as const) {
      const inbox = await mailbox.createInbox(ctx, {
        kind,
        ...(muted === undefined ? {} : { muted }),
      });
      expect(inbox.muted).toBe(expected);
    }
    expect((await mailbox.listInboxes(ctx, { muted: true })).items).toHaveLength(2);
  });

  it("renames and mutes expired inboxes, and refuses deleted ones", async () => {
    const {
      services: { mailbox },
      clock,
      inboxes,
      ctx,
    } = createHarness();
    const inbox = await mailbox.createInbox(ctx, { ttlMs: 1 });
    clock.advance(1);
    await expect(
      mailbox.updateInbox(ctx, inbox.id, { muted: false, displayName: "  QA  " }),
    ).resolves.toMatchObject({ muted: false, displayName: "QA" });
    await expect(
      mailbox.updateInbox(ctx, inbox.id, { displayName: "  " }),
    ).resolves.toMatchObject({ muted: false, displayName: null });
    await expect(
      mailbox.updateInbox(ctx, inbox.id, { displayName: "x".repeat(256) }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await inboxes.update(ctx, Inbox.markDeleted(inbox, clock.now()));
    await expect(mailbox.updateInbox(ctx, inbox.id, { muted: true })).rejects.toMatchObject({
      code: "inbox_not_found",
    });
  });

  it("validates update changes, deduplicates IDs and labels, and toggles archive", async () => {
    const { mailbox, ctx, clock, message } = await withMessage();
    const ids = [message.id];
    await expect(mailbox.updateMessages(ctx, ids, {})).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(mailbox.updateMessages(ctx, [], { seen: true })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(
      mailbox.updateMessages(ctx, ids, { addLabels: [], removeLabels: [] }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(
      mailbox.updateMessages(ctx, ids, { addLabels: [" Bug "], removeLabels: ["BUG"] }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    const added = await mailbox.updateMessages(ctx, [message.id, message.id], {
      starred: true,
      archived: true,
      addLabels: ["  Bug ", "BUG", "投诉"],
      removeLabels: ["unused"],
    });
    expect(added).toEqual({ updated: 1 });
    expect(await mailbox.getMessage(ctx, message.id)).toMatchObject({
      seen: false,
      starred: true,
      archivedAt: clock.now(),
      labels: ["Bug", "投诉"],
    });
    await mailbox.updateMessages(ctx, ids, {
      archived: false,
      starred: false,
      removeLabels: ["bug"],
    });
    expect(await mailbox.getMessage(ctx, message.id)).toMatchObject({
      starred: false,
      archivedAt: null,
      labels: ["投诉"],
    });
  });

  it("permits note deletion by its author or an admin", async () => {
    const { mailbox, ctx, message, withScopes } = await withMessage();
    const author = { ...withScopes(["message:read"]), subject: "key:author" };
    const other = { ...author, subject: "key:other" };
    const first = await mailbox.addNote(author, message.id, "   <b>plain text</b>  ");
    expect(first).toMatchObject({
      body: "<b>plain text</b>",
      authorSubject: author.subject,
      authorIdentityId: null,
    });
    await expect(mailbox.deleteNote(other, first.id)).rejects.toMatchObject({
      code: "forbidden",
    });
    await mailbox.deleteNote(author, first.id);
    const second = await mailbox.addNote(author, message.id, "reason");
    await mailbox.deleteNote(ctx, second.id);
    expect(await mailbox.listNotes(ctx, message.id)).toEqual([]);
  });

  it("rejects empty or oversized notes and caps a message at 50", async () => {
    const { mailbox, ctx, message } = await withMessage();
    await expect(mailbox.addNote(ctx, message.id, "  ")).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(mailbox.addNote(ctx, message.id, "a".repeat(4001))).rejects.toMatchObject({
      code: "invalid_argument",
    });
    for (let index = 0; index < MAX_NOTES_PER_MESSAGE; index++)
      await mailbox.addNote(ctx, message.id, `Note ${index}`);
    await expect(mailbox.addNote(ctx, message.id, "Over the limit")).rejects.toMatchObject({
      code: "invalid_argument",
    });
    expect((await mailbox.getMessageSummary(ctx, message.id)).noteCount).toBe(50);
  });

  it("bounds stored mailing-list headers without shortening a URI", async () => {
    const { message } = await withMessage();
    const stored = Message.create({
      ...message,
      listId: "é".repeat(5000),
      unsubscribe: {
        https: `https://example.com/${"x".repeat(9000)}`,
        mailto: "mailto:leave@example.com",
        oneClick: true,
      },
    });
    expect(stored.listId).toBe("é".repeat(4096));
    expect(stored.unsubscribe).toEqual({
      https: null,
      mailto: "mailto:leave@example.com",
      oneClick: false,
    });
  });
});
