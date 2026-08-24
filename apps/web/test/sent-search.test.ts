import { env } from "cloudflare:test";
import type { Caller, Ulid } from "@mailworker/core";
import {
  AccountId,
  Delivery,
  EmailAddress,
  Message,
  ProjectId,
  RfcMessageId,
  ThreadId,
} from "@mailworker/core";
import { createDb, D1Deliveries, D1Messages, schema } from "@web/workers/adapters";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * Search on the sent list, which reaches across two tables.
 *
 * A delivery row holds no text worth searching — the subject and body live in
 * the R2 payload, and the only copy in the database is the archived outbound
 * `Message` written at dispatch. So the query matches the FTS index through
 * `deliveries.message_id`, and falls back to the envelope recipients for the
 * sends that have not dispatched yet and therefore have no copy at all. Both
 * halves need a real D1: the in-memory store has no index and no join.
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
const deliveries = new D1Deliveries(db);
const messages = new D1Messages(db);

let counter = 0;
function nextId(): Ulid {
  counter += 1;
  return `01J${counter.toString().padStart(23, "0")}` as Ulid;
}

/** A send that reached the wire: a delivery plus the outbound copy it archived. */
async function dispatched(subject: string, body: string, from: string, to: string) {
  const messageId = nextId();
  await messages.insert(
    ctx,
    Message.create({
      id: messageId,
      accountId: ctx.accountId,
      inboxId: INBOX_ID,
      rfcMessageId: RfcMessageId.parse(`${messageId}@corp.com`),
      threadId: ThreadId.parse(`${messageId}@corp.com`),
      direction: "outbound",
      fromHeader: from,
      from: EmailAddress.parse(from),
      toHeader: to,
      to: [EmailAddress.parse(to)],
      subject,
      bodyText: body,
      receivedAt: NOW,
    }),
  );

  const delivery = Delivery.create({
    id: nextId(),
    accountId: ctx.accountId,
    recipients: [EmailAddress.parse(to)],
    now: NOW,
  });
  await deliveries.insert(ctx, Delivery.attachSentCopy(delivery, messageId, NOW));
  return delivery.id;
}

/** A send still waiting: no copy archived, so recipients are all there is. */
async function undispatched(to: string) {
  const delivery = Delivery.create({
    id: nextId(),
    accountId: ctx.accountId,
    recipients: [EmailAddress.parse(to)],
    now: NOW,
  });
  await deliveries.insert(ctx, delivery);
  return delivery.id;
}

async function search(q: string): Promise<string[]> {
  const page = await deliveries.list(ctx, { q });
  return page.items.map((row) => row.id);
}

describe("sent search", () => {
  beforeEach(async () => {
    await db.batch([
      db.delete(schema.attachments),
      db.delete(schema.messages),
      db.delete(schema.deliveryEvents),
      db.delete(schema.dispatchOutbox),
      db.delete(schema.deliveries),
    ]);
  });

  it("finds a dispatched send by subject, body and sender", async () => {
    const invoice = await dispatched(
      "Invoice 4821",
      "Payment is overdue.",
      "billing@corp.com",
      "human@vendor.example",
    );
    await dispatched("Welcome", "Glad you are here.", "hello@corp.com", "other@vendor.example");

    expect(await search("invoice")).toEqual([invoice]);
    expect(await search("overdue")).toEqual([invoice]);
    expect(await search("billing@corp.com")).toEqual([invoice]);
  });

  it("finds any send by recipient, dispatched or not", async () => {
    const sent = await dispatched(
      "Invoice 4821",
      "Payment is overdue.",
      "billing@corp.com",
      "human@vendor.example",
    );
    // No archived copy, so the FTS half cannot see this one at all. If the
    // recipients fallback regressed, a queued send would vanish from search
    // while still sitting in the list unfiltered — the quietest way to lose it.
    const waiting = await undispatched("human@vendor.example");

    expect((await search("human@vendor.example")).sort()).toEqual([sent, waiting].sort());
  });

  it("matches a recipient case-insensitively", async () => {
    const id = await undispatched("Human@Vendor.Example");
    expect(await search("human@vendor.example")).toEqual([id]);
  });

  it("does not treat a wildcard in the query as a pattern", async () => {
    await undispatched("human@vendor.example");
    // `LIKE '%_%'` would match every row here. `instr` has no wildcards, which
    // is the whole reason it is used instead.
    expect(await search("_")).toEqual([]);
    expect(await search("%")).toEqual([]);
  });

  it("returns nothing for a term that matches neither half", async () => {
    await dispatched(
      "Invoice 4821",
      "Payment is overdue.",
      "billing@corp.com",
      "human@vendor.example",
    );
    expect(await search("unrelated")).toEqual([]);
  });
});
