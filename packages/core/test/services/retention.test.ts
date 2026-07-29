import type { MailboxService } from "@core/application";
import { DEFAULT_SWEEP_LIMIT } from "@core/application";
import type { Ulid } from "@core/domain";
import { eventsOfType, RetentionPolicy } from "@core/domain";
import type { Harness } from "@core/testing";
import { createHarness, rawEmail, TEST_DOMAIN } from "@core/testing";
import { beforeEach, describe, expect, it } from "vitest";

const HOUR = 60 * 60 * 1000;
const GRACE = RetentionPolicy.DEFAULT_GRACE_PERIOD_MS;

let h: Harness;
let sweep: MailboxService["sweepExpired"];

beforeEach(() => {
  h = createHarness();
  sweep = h.services.mailbox.sweepExpired;
});

/** An inbox with one message in it, so a purge has blobs to collect. */
async function seedWithMail(address: string, ttlMs: number): Promise<Ulid> {
  const inbox = await h.seedInbox(address, { kind: "ephemeral", ttlMs });
  await h.services.ingestion.ingest(h.ctx, {
    recipient: address,
    envelopeFrom: "sender@service.com",
    raw: rawEmail({
      from: "sender@service.com",
      to: address,
      subject: "Hello",
      messageId: `${address}@service.com`,
    }),
  });
  return inbox.id;
}

describe("mailbox.sweepExpired", () => {
  it("leaves a live inbox alone", async () => {
    await seedWithMail(`live@${TEST_DOMAIN}`, HOUR);

    expect(await sweep(h.ctx)).toMatchObject({ examined: 0, purged: 0 });
  });

  it("leaves an expired inbox alone while it is inside the grace period", async () => {
    // The property that makes a timed-out test diagnosable: the inbox stops
    // receiving the moment it expires, but a caller asking "where did my mail
    // go" still gets "expired" rather than "not found".
    const id = await seedWithMail(`recent@${TEST_DOMAIN}`, HOUR);
    h.clock.advance(HOUR + GRACE / 2);

    expect(await sweep(h.ctx)).toMatchObject({ purged: 0 });
    expect(await h.inboxes.findById(h.ctx, id)).not.toBeNull();
  });

  it("erases the inbox, its messages and its blobs once the grace period is up", async () => {
    const id = await seedWithMail(`old@${TEST_DOMAIN}`, HOUR);
    expect(h.blobs.objects.size).toBeGreaterThan(0);

    h.clock.advance(HOUR + GRACE + 1);
    const result = await sweep(h.ctx);

    expect(result).toMatchObject({ examined: 1, purged: 1, failed: 0 });
    expect(await h.inboxes.findById(h.ctx, id)).toBeNull();
    expect(await h.messages.list(h.ctx, { inboxId: id })).toMatchObject({ items: [] });
    // The whole point of the sweep: R2 does not keep growing. A row deleted
    // without its blob would leave an object nothing can ever reach or bill for.
    expect(h.blobs.objects.size).toBe(0);
  });

  it("publishes inbox.expired so a subscriber can stop polling", async () => {
    const id = await seedWithMail(`notify@${TEST_DOMAIN}`, HOUR);
    h.clock.advance(HOUR + GRACE + 1);
    h.events.published.length = 0;

    await sweep(h.ctx);

    const expired = eventsOfType(h.events.published, "inbox.expired");
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ inboxId: id, address: `notify@${TEST_DOMAIN}` });
  });

  it("never touches a persistent inbox, however old", async () => {
    const inbox = await h.seedInbox(`forever@${TEST_DOMAIN}`, { kind: "persistent" });
    h.clock.advance(365 * 24 * HOUR);

    expect(await sweep(h.ctx)).toMatchObject({ examined: 0 });
    expect(await h.inboxes.findById(h.ctx, inbox.id)).not.toBeNull();
  });

  it("caps a run and drains oldest-first across runs", async () => {
    // A burst of expiries has to cost many short invocations rather than one
    // that exceeds the CPU limit and commits nothing.
    for (let i = 0; i < 5; i += 1) {
      await h.seedInbox(`burst-${i}@${TEST_DOMAIN}`, {
        kind: "ephemeral",
        ttlMs: (i + 1) * HOUR,
      });
    }
    h.clock.advance(10 * HOUR + GRACE);

    const first = await sweep(h.ctx, { limit: 2 });
    expect(first).toMatchObject({ examined: 2, purged: 2 });

    // The two oldest expiries went, not an arbitrary two — otherwise a capped
    // sweep would revisit recent rows forever and never reach the backlog.
    const remaining = await h.inboxes.list(h.ctx, {});
    expect(remaining.items.map((inbox) => inbox.address).sort()).toEqual([
      `burst-2@${TEST_DOMAIN}`,
      `burst-3@${TEST_DOMAIN}`,
      `burst-4@${TEST_DOMAIN}`,
    ]);

    expect(await sweep(h.ctx, { limit: 10 })).toMatchObject({ purged: 3 });
    expect((await h.inboxes.list(h.ctx, {})).items).toEqual([]);
  });

  it("honours a custom grace period", async () => {
    const id = await seedWithMail(`short@${TEST_DOMAIN}`, HOUR);
    h.clock.advance(HOUR + 2 * HOUR);

    expect(await sweep(h.ctx, { gracePeriodMs: HOUR })).toMatchObject({ purged: 1 });
    expect(await h.inboxes.findById(h.ctx, id)).toBeNull();
  });

  it("keeps going when one inbox fails, and leaves it for the next run", async () => {
    const bad = await seedWithMail(`bad@${TEST_DOMAIN}`, HOUR);
    await seedWithMail(`good@${TEST_DOMAIN}`, 2 * HOUR);
    h.clock.advance(2 * HOUR + GRACE + 1);

    const realDelete = h.blobs.delete.bind(h.blobs);
    let firstCall = true;
    h.blobs.delete = async (ctx, keys) => {
      if (firstCall) {
        firstCall = false;
        throw new Error("R2 is having a day");
      }
      return await realDelete(ctx, keys);
    };

    const result = await sweep(h.ctx);

    // One broken inbox must not cost the other 199 their erasure.
    expect(result).toMatchObject({ examined: 2, purged: 1, failed: 1 });
    expect(await h.inboxes.findById(h.ctx, bad)).not.toBeNull();

    h.blobs.delete = realDelete;
    expect(await sweep(h.ctx)).toMatchObject({ purged: 1, failed: 0 });
  });

  it("requires inbox:write — a read-only credential cannot erase anything", async () => {
    await expect(sweep(h.withScopes(["inbox:read"]))).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("bounds a default run", () => {
    // Documented because the cron reads it back to decide whether the log line
    // should say the backlog is still draining.
    expect(DEFAULT_SWEEP_LIMIT).toBe(200);
  });
});
