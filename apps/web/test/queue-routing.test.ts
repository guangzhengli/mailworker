import {
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
} from "cloudflare:test";
import { createDb, schema } from "@web/workers/adapters";
import { queue } from "@web/workers/queue";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Queue messages have no authenticated request to name an environment. These
 * tests keep the two correlation rules at the protocol boundary, against the
 * same workerd and D1 bindings used by the deployed consumer.
 */

const SECONDARY_ACCOUNT = "development";
const SECONDARY_DOMAIN = "dev.mail.example.com";
const OCCURRED_AT = "2026-07-01T12:00:00.000Z";
const db = createDb(env.DB);

beforeEach(async () => {
  await db.batch([
    db.delete(schema.deliveryEvents),
    db.delete(schema.suppressions),
    db.delete(schema.webhooks),
    db.delete(schema.domains),
    db.delete(schema.accounts).where(eq(schema.accounts.id, SECONDARY_ACCOUNT)),
  ]);
  await db.insert(schema.accounts).values({
    id: SECONDARY_ACCOUNT,
    projectId: "default",
    env: "development",
    name: "development",
    mode: "sandbox",
    createdAt: OCCURRED_AT,
  });
});

afterEach(() => vi.restoreAllMocks());

async function consume(queueName: string, body: unknown, id: string) {
  const batch = createMessageBatch(queueName, [
    { id, timestamp: new Date(OCCURRED_AT), body, attempts: 1 },
  ]);
  const ctx = createExecutionContext();
  await queue(batch, env);
  return await getQueueResult(batch, ctx);
}

function hardBounce(sourceDomain: string, recipient: string): Record<string, unknown> {
  return {
    type: "cf.email.sending.message.bounced",
    source: { type: "email.sending", zoneId: "zone-development", domain: sourceDomain },
    payload: {
      eventId: "provider-event-unmatched-development",
      messageId: "provider-message-not-in-deliveries",
      sender: `agent@${sourceDomain}`,
      recipient,
      terminal: true,
      delivery: {
        status: "bounced",
        smtpStatusCode: "550",
        smtpEnhancedStatusCode: "5.1.1",
        smtpResponse: "550 5.1.1 User unknown",
      },
      bounce: {
        type: "hard",
        classification: "permanent_failure",
        reason: "550 5.1.1 User unknown",
      },
    },
    metadata: {
      accountId: "cloudflare-account",
      eventSubscriptionId: "subscription-development",
      eventSchemaVersion: 1,
      eventTimestamp: OCCURRED_AT,
    },
  };
}

describe("queue environment routing", () => {
  it("fans a queued domain event out only inside event.accountId", async () => {
    // A production-only subscriber is a leak detector. The development event
    // must not reach it merely because `default` is the deployment fallback.
    await db.insert(schema.webhooks).values({
      id: "01J00000000000000000000001",
      accountId: "default",
      url: "https://production-webhook.example/hook",
      secret: "whsec_test",
      events: ["suppression.added"],
      enabled: true,
      createdAt: OCCURRED_AT,
    });
    const outboundFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    const result = await consume(
      "mailworker-webhooks",
      {
        id: "domain-event-development",
        event: {
          type: "suppression.added",
          accountId: SECONDARY_ACCOUNT,
          occurredAt: OCCURRED_AT,
          address: "bounced@example.net",
          reason: "hard_bounce",
        },
      },
      "queued-webhook-development",
    );

    expect(outboundFetch).not.toHaveBeenCalled();
    expect(result.explicitAcks).toEqual(["queued-webhook-development"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("routes an unmatched hard bounce by source domain, not to default", async () => {
    await db.insert(schema.domains).values({
      id: "01J00000000000000000000002",
      accountId: SECONDARY_ACCOUNT,
      name: SECONDARY_DOMAIN,
      zoneId: "zone-development",
      inboundEnabled: true,
      sendingStatus: "verified",
      catchallMode: "reject",
      catchallInbox: null,
      autocreatePattern: null,
      createdAt: OCCURRED_AT,
    });

    const recipient = "gone@example.net";
    const result = await consume(
      "mailworker-events",
      hardBounce(SECONDARY_DOMAIN, recipient),
      "queued-provider-development",
    );

    expect(result.explicitAcks).toEqual(["queued-provider-development"]);
    expect(result.retryMessages).toEqual([]);
    expect(
      await db
        .select({
          accountId: schema.suppressions.accountId,
          address: schema.suppressions.address,
        })
        .from(schema.suppressions),
    ).toEqual([{ accountId: SECONDARY_ACCOUNT, address: recipient }]);
    expect(
      await db
        .select({
          accountId: schema.deliveryEvents.accountId,
          deliveryId: schema.deliveryEvents.deliveryId,
          sourceDomain: schema.deliveryEvents.sourceDomain,
        })
        .from(schema.deliveryEvents),
    ).toEqual([
      {
        accountId: SECONDARY_ACCOUNT,
        deliveryId: null,
        sourceDomain: SECONDARY_DOMAIN,
      },
    ]);
  });
});
