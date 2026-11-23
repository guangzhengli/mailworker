import { env } from "cloudflare:test";
import { runRepositoryConformance } from "@mailworker/core/testing";
import {
  createDb,
  D1ApiKeys,
  D1Deliveries,
  D1Identities,
  D1Inboxes,
  D1Messages,
  D1Notes,
  D1Suppressions,
  R2Blobs,
  schema,
} from "@web/workers/adapters";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * The same suite `packages/core` runs against the in-memory adapters, run here
 * against a real D1 and R2 inside workerd.
 *
 * Everything this catches is something a mock could not: whether the unique
 * constraint really deduplicates, whether NULL idempotency keys really compare
 * as distinct, whether `json_each` really matches a whole address, whether ISO
 * text really orders chronologically. If this file and its twin both pass, the
 * fast suite is telling the truth.
 */

const db = createDb(env.DB);

/**
 * Vitest 4's Workers pool no longer rolls storage back between tests, so state
 * is cleared explicitly. Truncating beats recreating the schema per test: the
 * migrations — including the FTS5 triggers — stay applied exactly once, which is
 * both faster and closer to how a real deployment runs.
 *
 * Deleting from `messages` fires the FTS delete trigger, so the index empties
 * with the table. If it did not, a later search would match rows that no longer
 * exist, and the test that noticed would be baffling.
 */
async function reset(): Promise<void> {
  await db.batch([
    db.delete(schema.attachments),
    db.delete(schema.messages),
    db.delete(schema.labels),
    db.delete(schema.deliveryEvents),
    db.delete(schema.dispatchOutbox),
    db.delete(schema.deliveries),
    db.delete(schema.inboxes),
    db.delete(schema.agentIdentities),
    db.delete(schema.apiKeys),
    db.delete(schema.suppressions),
    db.delete(schema.domains),
  ]);

  let cursor: string | undefined;
  do {
    const listed = await env.BLOBS.list(cursor === undefined ? {} : { cursor });
    if (listed.objects.length > 0) {
      await env.BLOBS.delete(listed.objects.map((object) => object.key));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
}

runRepositoryConformance("D1 + R2", async () => {
  await reset();
  const messages = new D1Messages(db);
  return {
    inboxes: new D1Inboxes(db),
    messages,
    labels: messages.labels,
    notes: new D1Notes(db),
    deliveries: new D1Deliveries(db),
    identities: new D1Identities(db),
    apiKeys: new D1ApiKeys(db),
    suppressions: new D1Suppressions(db),
    blobs: new R2Blobs(env.BLOBS),
  };
});

describe("0010 rolling Worker compatibility", () => {
  beforeEach(reset);

  it("derives and persists a route key when an older INSERT omits the new column", async () => {
    await env.DB.prepare(
      `INSERT INTO inboxes (
        id, account_id, address, local_part, domain, kind, created_at
      ) VALUES (
        'legacy-inbox', 'alice', 'agent@mail.example.com', 'agent',
        'mail.example.com', 'persistent', '2026-07-01T12:00:00.000Z'
      )`,
    ).run();
    const insertAsOldWorker = async (id: string, tag: string) => {
      const mimeRecipient = "agent@mail.example.com";
      await env.DB.prepare(
        `INSERT OR IGNORE INTO messages (
          id, account_id, inbox_id, rfc_message_id, thread_id, direction,
          from_header, to_header, to_addrs, cc_addrs, bcc_addrs,
          references_ids, trust_reasons, tag, received_at
        ) VALUES (?, 'alice', 'legacy-inbox', 'same@sender.test',
          'same@sender.test', 'inbound', 'sender@sender.test', ?, ?, '[]',
          '[]', '[]', '[]', ?, '2026-07-01T12:00:00.000Z')`,
      )
        .bind(id, mimeRecipient, JSON.stringify([mimeRecipient]), tag)
        .run();
    };

    await insertAsOldWorker("01J00000000000000000000001", "one");
    await insertAsOldWorker("01J00000000000000000000002", "ONE");
    await insertAsOldWorker("01J00000000000000000000003", "two");

    const { results } = await env.DB.prepare(
      `SELECT id, envelope_recipient
       FROM messages WHERE account_id = 'alice' ORDER BY id`,
    ).all<{ id: string; envelope_recipient: string }>();
    expect(results).toEqual([
      {
        id: "01J00000000000000000000001",
        envelope_recipient: "agent+one@mail.example.com",
      },
      {
        id: "01J00000000000000000000003",
        envelope_recipient: "agent+two@mail.example.com",
      },
    ]);
  });
});

describe("0017 mail client state migration", () => {
  beforeEach(reset);

  it("backfills mute for legacy ephemeral inboxes and leaves persistent inboxes watched", async () => {
    await env.DB.prepare(
      `INSERT INTO inboxes (id, account_id, address, local_part, domain, kind, created_at)
       VALUES ('old-e', 'alice', 'old-e@example.com', 'old-e', 'example.com', 'ephemeral', '2026-07-01'),
              ('old-p', 'alice', 'old-p@example.com', 'old-p', 'example.com', 'persistent', '2026-07-01')`,
    ).run();
    const migration = env.TEST_MIGRATIONS.find(
      (entry) => entry.name === "0017_mail_client_state.sql",
    );
    const backfill = migration?.queries.find((query) => query.startsWith("UPDATE `inboxes`"));
    expect(backfill).toBeDefined();
    await env.DB.prepare(backfill!).run();
    const { results } = await env.DB.prepare(
      "SELECT id, muted FROM inboxes WHERE account_id = 'alice' ORDER BY id",
    ).all<{ id: string; muted: number }>();
    expect(results).toEqual([
      { id: "old-e", muted: 1 },
      { id: "old-p", muted: 0 },
    ]);
  });

  it("uses the mail client indexes for ordered main-inbox and starred pages", async () => {
    const main = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT id FROM messages
       WHERE account_id = ? AND direction = ? AND archived_at IS NULL
         AND EXISTS (SELECT 1 FROM inboxes i WHERE i.account_id = messages.account_id
           AND i.id = messages.inbox_id AND i.muted = ? AND i.deleted_at IS NULL)
       ORDER BY id DESC LIMIT 50`,
    )
      .bind("alice", "inbound", 0)
      .all<{ detail: string }>();
    const starred = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT id FROM messages WHERE account_id = ? AND starred = ?
       ORDER BY id DESC LIMIT 50`,
    )
      .bind("alice", 1)
      .all<{ detail: string }>();
    expect(main.results.map(({ detail }) => detail).join("\n")).toContain(
      "SEARCH messages USING INDEX idx_messages_direction_archive",
    );
    expect(starred.results.map(({ detail }) => detail).join("\n")).toContain(
      "idx_messages_starred",
    );
  });
});
