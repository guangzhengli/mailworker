import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Caller, RetentionPolicy } from "@mailworker/core";
import { createDb, schema } from "@web/workers/adapters";
import { createContainer } from "@web/workers/container";
import entry from "@web/workers/entry";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * The retention sweep against a real D1 and a real R2.
 *
 * The fast suite already proves the policy. What it cannot prove is the part
 * that only exists here: that `deleteByInbox` hands back the storage keys of
 * messages it deleted **in the same statement that deleted them**, and that
 * those keys name objects R2 will actually remove. An in-memory store returns
 * whatever the fake decided to remember; a sweep that deletes rows and reports
 * an empty key list would pass every fast test while leaking every object it
 * ever stored — which is the exact failure this whole feature exists to stop.
 */

const DOMAIN = "mail.example.com";
const HOUR = 60 * 60 * 1000;
const GRACE = RetentionPolicy.DEFAULT_GRACE_PERIOD_MS;

const db = createDb(env.DB);

beforeEach(async () => {
  await db.batch([
    db.delete(schema.attachments),
    db.delete(schema.messages),
    db.delete(schema.inboxes),
    db.delete(schema.domains),
  ]);
  // R2 too, and not only for tidiness: the grace-period case deliberately leaves
  // an object behind, so a suite that only reset D1 would have the next test
  // asserting on its neighbour's leftovers.
  const stale = await env.BLOBS.list();
  if (stale.objects.length > 0) {
    await env.BLOBS.delete(stale.objects.map((object) => object.key));
  }
  await db.insert(schema.domains).values({
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    accountId: "default",
    name: DOMAIN,
    zoneId: null,
    inboundEnabled: true,
    sendingStatus: "verified",
    catchallMode: "reject",
    catchallInbox: null,
    autocreatePattern: null,
    createdAt: new Date().toISOString(),
  });
});

function ctx() {
  const container = createContainer(env as unknown as Env);
  return {
    services: container.services,
    caller: Caller.system({
      accountId: container.defaultAccountId,
      projectId: container.projectId,
      mode: "live",
      subject: "system:test",
    }),
  };
}

async function expiredInboxWithMail(prefix: string, agoMs: number) {
  const { services, caller } = ctx();
  const inbox = await services.mailbox.createInbox(caller, {
    prefix,
    domain: DOMAIN,
    ttlMs: HOUR,
  });

  const raw = [
    "From: Sender <noreply@sender.test>",
    `To: ${inbox.address}`,
    "Subject: Receipt",
    `Message-ID: <${crypto.randomUUID()}@sender.test>`,
    "Date: Wed, 01 Jul 2026 12:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Nothing to see here.",
    "",
  ].join("\r\n");

  await entry.email(
    {
      from: "noreply@sender.test",
      to: inbox.address,
      raw: new Response(raw).body!,
      rawSize: raw.length,
      headers: new Headers(),
      setReject() {},
      forward: async () => {},
      reply: async () => {},
    } as unknown as ForwardableEmailMessage,
    env as unknown as Env,
  );

  // Backdate the expiry rather than waiting: the clock is the system clock here,
  // and the behaviour under test is the erasure, not the passage of time.
  await db
    .update(schema.inboxes)
    .set({ expiresAt: new Date(Date.now() - agoMs).toISOString() })
    .where(eq(schema.inboxes.id, inbox.id));

  return inbox;
}

describe("retention, against real D1 and R2", () => {
  it("erases the rows and the R2 objects together", async () => {
    await expiredInboxWithMail("sweepme", GRACE + HOUR);

    const before = await env.BLOBS.list({ prefix: "raw/default/" });
    expect(before.objects.length).toBeGreaterThan(0);

    const { services, caller } = ctx();
    const result = await services.mailbox.sweepExpired(caller);

    expect(result).toMatchObject({ purged: 1, failed: 0 });
    expect(await services.mailbox.listInboxes(caller, { includeExpired: true })).toMatchObject({
      items: [],
    });

    // The assertion the fast suite cannot make: R2 is actually empty, because
    // the keys came back from the same D1 statement that deleted the rows.
    const after = await env.BLOBS.list({ prefix: "raw/default/" });
    expect(after.objects).toEqual([]);

    // And the message rows went with it, rather than being orphaned by an
    // inbox delete that only touched one table.
    const rows = await db.select().from(schema.messages);
    expect(rows).toEqual([]);
  });

  it("leaves an inbox still inside its grace period alone", async () => {
    const inbox = await expiredInboxWithMail("recent", HOUR);

    const { services, caller } = ctx();
    expect(await services.mailbox.sweepExpired(caller)).toMatchObject({ purged: 0 });
    expect(await services.mailbox.getInbox(caller, inbox.id)).toMatchObject({ id: inbox.id });
  });

  it("runs from the cron entry point the deployment actually uses", async () => {
    // `entry.scheduled` is what Cloudflare invokes. Testing `sweepExpired`
    // directly would leave the wiring — the handler export, the system Caller,
    // the waitUntil — untested, and wiring is what breaks on deploy.
    await expiredInboxWithMail("viacron", GRACE + HOUR);

    const execution = createExecutionContext();
    await entry.scheduled!(
      { cron: "0 * * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController,
      env as unknown as Env,
      execution,
    );
    await waitOnExecutionContext(execution);

    const { services, caller } = ctx();
    expect(await services.mailbox.listInboxes(caller, { includeExpired: true })).toMatchObject({
      items: [],
    });
    expect((await env.BLOBS.list({ prefix: "raw/default/" })).objects).toEqual([]);
  });
});
