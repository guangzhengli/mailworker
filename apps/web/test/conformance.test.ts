import { env } from "cloudflare:test";
import { runRepositoryConformance } from "@mailworker/core/testing";
import {
  createDb,
  D1ApiKeys,
  D1Identities,
  D1Inboxes,
  D1Messages,
  D1Outbound,
  D1Suppressions,
  R2Blobs,
  schema,
} from "@web/workers/infrastructure";

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
    db.delete(schema.deliveryEvents),
    db.delete(schema.outboundMessages),
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
  return {
    inboxes: new D1Inboxes(db),
    messages: new D1Messages(db),
    outbound: new D1Outbound(db),
    identities: new D1Identities(db),
    apiKeys: new D1ApiKeys(db),
    suppressions: new D1Suppressions(db),
    blobs: new R2Blobs(env.BLOBS),
  };
});
