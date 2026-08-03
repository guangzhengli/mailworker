import { env } from "cloudflare:test";
import type { Caller, Ulid } from "@mailworker/core";
import {
  AccountId,
  EmailAddress,
  Message,
  ProjectId,
  RfcMessageId,
  ThreadId,
} from "@mailworker/core";
import { createDb, D1Messages, schema } from "@web/workers/adapters";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * The FTS5 index and the messages table are two copies of the same text, kept in
 * step by three triggers. This is the only place that can test them: the
 * in-memory store has no index to fall out of sync, so the conformance suite has
 * nothing to say here.
 *
 * The failure being guarded against is quiet. A broken trigger does not error —
 * search simply stops finding things, or starts finding messages that were
 * deleted months ago.
 */

const ctx: Caller = {
  accountId: AccountId.parse("alice"),
  projectId: ProjectId.DEFAULT,
  mode: "live",
  identityId: null,
  scopes: ["admin"],
  subject: "test",
};
const NOW = new Date("2026-07-01T12:00:00.000Z");
const INBOX_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;

const db = createDb(env.DB);
const messages = new D1Messages(db);

let counter = 0;
function aMessage(subject: string, bodyText: string): Message {
  counter += 1;
  const id = `01J${counter.toString().padStart(23, "0")}` as Ulid;
  return Message.create({
    id,
    accountId: ctx.accountId,
    inboxId: INBOX_ID,
    rfcMessageId: RfcMessageId.parse(`${id}@corp.com`),
    threadId: ThreadId.parse(`${id}@corp.com`),
    direction: "inbound",
    fromHeader: "noreply@corp.com",
    from: EmailAddress.parse("noreply@corp.com"),
    toHeader: "agent@mail.example.com",
    subject,
    bodyText,
    receivedAt: NOW,
  });
}

async function search(q: string): Promise<string[]> {
  const page = await messages.list(ctx, { q });
  return page.items.map((m) => m.subject);
}

/**
 * FTS5's own audit of an external-content index: it walks every posting and
 * checks it against the content table, and errors if they disagree. Stronger
 * than any search assertion, because it proves the two are consistent
 * everywhere rather than for the words a test happened to pick.
 */
async function assertIndexMatchesTable(): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)",
  ).run();
}

describe("messages_fts triggers", () => {
  beforeEach(async () => {
    await db.batch([db.delete(schema.attachments), db.delete(schema.messages)]);
  });

  it("indexes a message as it arrives", async () => {
    await messages.insert(ctx, aMessage("Invoice 4821", "Payment is overdue."));
    expect(await search("invoice")).toEqual(["Invoice 4821"]);
    expect(await search("overdue")).toEqual(["Invoice 4821"]);
    await assertIndexMatchesTable();
  });

  it("drops a message from the index when its rows go", async () => {
    await messages.insert(ctx, aMessage("Invoice 4821", "Payment is overdue."));
    await messages.deleteByInbox(ctx, INBOX_ID);

    // Without the delete trigger the postings survive and the row they point at
    // does not, so this search returns a message that no longer exists.
    expect(await search("invoice")).toEqual([]);
    await assertIndexMatchesTable();
  });

  it("re-indexes when the text itself changes", async () => {
    const message = aMessage("Invoice 4821", "Payment is overdue.");
    await messages.insert(ctx, message);
    await db
      .update(schema.messages)
      .set({ subject: "Receipt 4821" })
      .where(eq(schema.messages.id, message.id));

    expect(await search("receipt")).toEqual(["Receipt 4821"]);
    expect(await search("invoice")).toEqual([]);
    await assertIndexMatchesTable();
  });

  it("leaves the index untouched when only metadata changes", async () => {
    const message = aMessage("Invoice 4821", "Payment is overdue.");
    await messages.insert(ctx, message);
    await messages.setSeen(ctx, message.id, true);

    // The update trigger is scoped `OF subject, body_text` so that marking a
    // message read — the most frequent write in the system — does not delete and
    // rebuild a posting list for text that did not change. This proves the
    // narrowing did not also stop the index from being correct.
    expect(await search("invoice")).toEqual(["Invoice 4821"]);
    await assertIndexMatchesTable();
  });

  it("keeps one account's mail out of another's search results", async () => {
    await messages.insert(ctx, aMessage("Invoice 4821", "Payment is overdue."));
    const bob: Caller = { ...ctx, accountId: AccountId.parse("bob") };

    // FTS5 knows nothing about tenancy — the index spans every account. The
    // account filter lives in the outer query, which is exactly why this is
    // worth asserting rather than assuming.
    expect((await messages.list(bob, { q: "invoice" })).items).toEqual([]);
  });
});
