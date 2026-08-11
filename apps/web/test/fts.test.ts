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
function aMessage(subject: string, bodyText: string, fromHeader = "noreply@corp.com"): Message {
  counter += 1;
  const id = `01J${counter.toString().padStart(23, "0")}` as Ulid;
  return Message.create({
    id,
    accountId: ctx.accountId,
    inboxId: INBOX_ID,
    rfcMessageId: RfcMessageId.parse(`${id}@corp.com`),
    threadId: ThreadId.parse(`${id}@corp.com`),
    direction: "inbound",
    fromHeader,
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

  it("finds a message by its sender", async () => {
    await messages.insert(
      ctx,
      aMessage("Invoice 4821", "Payment is overdue.", '"Alice Cheng" <alice@vendor.example>'),
    );
    await messages.insert(ctx, aMessage("Receipt 4822", "Thanks."));

    // The whole address as one token: `fullTextFilter` quotes it, and FTS5
    // tokenizes a quoted string into a phrase, so `alice vendor example` has to
    // appear consecutively — which is exactly how the header indexed it.
    expect(await search("alice@vendor.example")).toEqual(["Invoice 4821"]);
    // The display name is in the header too, so it is searchable as well.
    expect(await search("cheng")).toEqual(["Invoice 4821"]);
    // A sender that does not match must not drag the other message in.
    expect(await search("vendor")).toEqual(["Invoice 4821"]);
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

/**
 * What the tokenizer choice actually buys, asserted in the language that broke.
 *
 * The default `unicode61` tokenizer splits on non-alphanumerics, which assumes
 * words are delimited by spaces. An entire run of Han characters is therefore
 * ONE token, and `验证码` could not find `您的验证码是483920` — not a ranking
 * problem, a zero-results problem. Migration 0006 switches to `trigram`; these
 * are the cases that would regress if it were ever switched back.
 */
describe("search across languages", () => {
  beforeEach(async () => {
    await db.batch([db.delete(schema.attachments), db.delete(schema.messages)]);
  });

  it("finds a Chinese word inside an unspaced run", async () => {
    await messages.insert(ctx, aMessage("验证", "您的验证码是483920，十分钟内有效"));
    await messages.insert(ctx, aMessage("发货", "订单已发货，请查收发票"));

    expect(await search("验证码")).toEqual(["验证"]);
    expect(await search("十分钟")).toEqual(["验证"]);
    // Not merely "returns something": the other message must stay out.
    expect(await search("请查收")).toEqual(["发货"]);
    await assertIndexMatchesTable();
  });

  it("finds a two-character Chinese word, which the index alone cannot answer", async () => {
    await messages.insert(ctx, aMessage("发货", "订单已发货，请查收发票"));
    await messages.insert(ctx, aMessage("验证", "您的验证码是483920"));

    // A trigram index holds no posting shorter than three characters, and FTS5
    // reports that as zero rows rather than as an error. 订单 and 发票 are
    // perfectly ordinary words, so the adapter routes them to a LIKE scan.
    expect(await search("订单")).toEqual(["发货"]);
    expect(await search("发票")).toEqual(["发货"]);
    // And the fallback still has to be a filter, not a pass-through.
    expect(await search("退款")).toEqual([]);
  });

  it("ANDs a short term with an indexed one", async () => {
    await messages.insert(ctx, aMessage("发货", "订单已发货，请查收发票"));
    await messages.insert(ctx, aMessage("退款", "订单已退款，款项原路返回"));

    // One term through the index, one through the scan, both required.
    expect(await search("订单 已发货")).toEqual(["发货"]);
    expect(await search("订单 已退款")).toEqual(["退款"]);
    expect(await search("订单 不存在的词")).toEqual([]);
  });

  it("matches part of an English word, not just the whole word", async () => {
    await messages.insert(ctx, aMessage("Verify", "Your verification code is 483920"));

    // `unicode61` matched whole tokens, so this returned nothing.
    expect(await search("verif")).toEqual(["Verify"]);
    expect(await search("cation")).toEqual(["Verify"]);
    await assertIndexMatchesTable();
  });

  it("treats % and _ in a short term as characters, not wildcards", async () => {
    await messages.insert(ctx, aMessage("Sale", "100% off this week"));
    await messages.insert(ctx, aMessage("Plain", "nothing on offer"));

    // Unescaped, `%` in a LIKE pattern matches every message in the account —
    // the worst kind of wrong answer, because it looks like a working search.
    expect(await search("%")).toEqual(["Sale"]);
    expect(await search("_")).toEqual([]);
  });
});
