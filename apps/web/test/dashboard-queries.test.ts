import { env } from "cloudflare:test";
import { AccountId, type Caller, type DomainError, ProjectId, Ulid } from "@mailworker/core";
import { createDb, D1DashboardQueries, schema } from "@web/workers/adapters";
import { beforeEach, describe, expect, it } from "vitest";

const db = createDb(env.DB);
const queries = new D1DashboardQueries(db);
const ACCOUNT = AccountId.parse("dashboard-test");
const NOW = new Date("2026-08-12T12:00:00.000Z");
const SINCE = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);

const ADMIN: Caller = {
  accountId: ACCOUNT,
  projectId: ProjectId.parse("dashboard-test"),
  mode: "live",
  identityId: null,
  scopes: ["admin"],
  subject: "key:dashboard-test",
};

function id(n: number): string {
  return n.toString().padStart(26, "0");
}

describe("D1DashboardQueries", () => {
  beforeEach(async () => {
    await db.batch([
      db.delete(schema.messages),
      db.delete(schema.dispatchOutbox),
      db.delete(schema.deliveryEvents),
      db.delete(schema.deliveries),
      db.delete(schema.inboxes),
      db.delete(schema.agentIdentities),
      db.delete(schema.apiKeys),
      db.delete(schema.domains),
    ]);
  });

  it("counts the whole environment rather than a first page of rows", async () => {
    const recent = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const old = new Date(SINCE.getTime() - 1).toISOString();

    const inboxRows = Array.from({ length: 60 }, (_, index) => ({
      id: id(index + 1),
      accountId: ACCOUNT,
      address: `box-${index}@mail.example`,
      localPart: `box-${index}`,
      domain: "mail.example",
      kind: "persistent",
      createdAt: recent,
    }));
    for (let offset = 0; offset < inboxRows.length; offset += 10) {
      await db.insert(schema.inboxes).values(inboxRows.slice(offset, offset + 10));
    }

    const statuses = [
      ...Array.from({ length: 55 }, () => "pending_approval"),
      ...Array.from({ length: 6 }, () => "delivered"),
      ...Array.from({ length: 4 }, () => "bounced"),
      ...Array.from({ length: 5 }, () => "delivered"),
    ];
    const deliveryRows = statuses.map((status, index) => ({
      id: id(100 + index),
      accountId: ACCOUNT,
      status,
      source: "agent",
      recipients: [`recipient-${index}@example.com`],
      createdAt: index >= 65 ? old : recent,
      updatedAt: index >= 65 ? old : recent,
      statusChangedAt: index >= 65 ? old : recent,
    }));
    for (let offset = 0; offset < deliveryRows.length; offset += 10) {
      await db.insert(schema.deliveries).values(deliveryRows.slice(offset, offset + 10));
    }
    await db.insert(schema.deliveryEvents).values(
      deliveryRows.slice(55, 61).map((delivery, index) => ({
        id: id(500 + index),
        accountId: ACCOUNT,
        deliveryId: delivery.id,
        type: "delivered",
        terminal: true,
        occurredAt: recent,
      })),
    );

    const messageRows = Array.from({ length: 7 }, (_, index) => ({
      id: id(200 + index),
      accountId: ACCOUNT,
      inboxId: id(1),
      rfcMessageId: `${id(200 + index)}@mail.example`,
      threadId: id(200 + index),
      direction: "inbound",
      fromHeader: `sender-${index}@example.com`,
      toHeader: "box-0@mail.example",
      toAddrs: ["box-0@mail.example"],
      ccAddrs: [],
      bccAddrs: [],
      subject: "hello",
      referencesIds: [],
      trustReasons: [],
      receivedAt: index === 6 ? old : recent,
    }));
    for (const row of messageRows) await db.insert(schema.messages).values(row);

    await expect(queries.summary(ADMIN, SINCE, NOW)).resolves.toEqual({
      pendingApproval: 55,
      outbound: 10,
      delivered: 6,
      problems: 4,
      inbound: 6,
      activeInboxes: 60,
      totalDeliveries: 70,
      totalMessages: 7,
    });
  });

  it("reports readiness and per-agent quota pressure", async () => {
    const recent = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const agentId = id(300);

    await db.insert(schema.domains).values({
      id: id(301),
      accountId: ACCOUNT,
      name: "mail.example",
      createdAt: recent,
    });
    await db.insert(schema.inboxes).values({
      id: id(302),
      accountId: ACCOUNT,
      address: "agent@mail.example",
      localPart: "agent",
      domain: "mail.example",
      kind: "persistent",
      createdAt: recent,
    });
    await db.insert(schema.agentIdentities).values({
      id: agentId,
      accountId: ACCOUNT,
      name: "support-agent",
      dailySendQuota: 10,
      requireApproval: true,
      managed: false,
      createdAt: recent,
    });
    await db.insert(schema.apiKeys).values({
      id: id(303),
      accountId: ACCOUNT,
      name: "support-agent",
      prefix: "mw_live_dashboard",
      hash: "test",
      scopes: ["message:read"],
      identityId: agentId,
      createdAt: recent,
    });
    await db.insert(schema.deliveries).values([
      {
        id: id(304),
        accountId: ACCOUNT,
        identityId: agentId,
        status: "pending_approval",
        source: "agent",
        recipients: ["one@example.com"],
        createdAt: recent,
        updatedAt: recent,
        statusChangedAt: recent,
      },
      {
        id: id(305),
        accountId: ACCOUNT,
        identityId: agentId,
        status: "bounced",
        source: "agent",
        recipients: ["two@example.com"],
        createdAt: recent,
        updatedAt: recent,
        statusChangedAt: recent,
      },
    ]);
    await expect(queries.readiness(ADMIN, NOW)).resolves.toEqual({
      domains: 1,
      activeInboxes: 1,
      agents: 1,
      activeKeys: 1,
    });
    await expect(queries.agentPulse(ADMIN, SINCE)).resolves.toEqual([
      {
        id: agentId,
        name: "support-agent",
        requireApproval: true,
        dailySendQuota: 10,
        quotaUsed: 2,
        pendingApproval: 1,
        problems: 1,
        lastActivityAt: new Date(recent),
      },
    ]);
  });

  it("scopes identity-bound summaries while preserving legacy unbound reads", async () => {
    const recent = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const aliceId = Ulid.parse(id(400));
    const bobId = Ulid.parse(id(401));
    const aliceInboxId = id(402);
    const bobInboxId = id(403);

    await db.insert(schema.agentIdentities).values([
      {
        id: aliceId,
        accountId: ACCOUNT,
        name: "alice-dashboard",
        managed: false,
        createdAt: recent,
      },
      {
        id: bobId,
        accountId: ACCOUNT,
        name: "bob-dashboard",
        managed: false,
        createdAt: recent,
      },
    ]);
    await db.insert(schema.inboxes).values([
      {
        id: aliceInboxId,
        accountId: ACCOUNT,
        identityId: aliceId,
        address: "alice@mail.example",
        localPart: "alice",
        domain: "mail.example",
        kind: "persistent",
        createdAt: recent,
      },
      {
        id: bobInboxId,
        accountId: ACCOUNT,
        identityId: bobId,
        address: "bob@mail.example",
        localPart: "bob",
        domain: "mail.example",
        kind: "persistent",
        createdAt: recent,
      },
    ]);
    await db.insert(schema.deliveries).values([
      {
        id: id(404),
        accountId: ACCOUNT,
        identityId: aliceId,
        status: "pending_approval",
        source: "agent",
        recipients: ["one@example.com"],
        createdAt: recent,
        updatedAt: recent,
        statusChangedAt: recent,
      },
      {
        id: id(405),
        accountId: ACCOUNT,
        identityId: aliceId,
        status: "delivered",
        source: "agent",
        recipients: ["two@example.com"],
        createdAt: recent,
        updatedAt: recent,
        statusChangedAt: recent,
      },
      {
        id: id(406),
        accountId: ACCOUNT,
        identityId: bobId,
        status: "pending_approval",
        source: "agent",
        recipients: ["three@example.com"],
        createdAt: recent,
        updatedAt: recent,
        statusChangedAt: recent,
      },
      {
        id: id(407),
        accountId: ACCOUNT,
        identityId: bobId,
        status: "bounced",
        source: "agent",
        recipients: ["four@example.com"],
        createdAt: recent,
        updatedAt: recent,
        statusChangedAt: recent,
      },
    ]);
    await db.insert(schema.deliveryEvents).values({
      id: id(410),
      accountId: ACCOUNT,
      deliveryId: id(405),
      type: "delivered",
      terminal: true,
      occurredAt: recent,
    });

    for (const [messageId, inboxId, identityId] of [
      [id(408), aliceInboxId, aliceId],
      [id(409), bobInboxId, bobId],
    ] as const) {
      await db.insert(schema.messages).values({
        id: messageId,
        accountId: ACCOUNT,
        inboxId,
        identityId,
        rfcMessageId: `${messageId}@mail.example`,
        threadId: messageId,
        direction: "inbound",
        fromHeader: "sender@example.com",
        toHeader: "agent@mail.example",
        toAddrs: ["agent@mail.example"],
        ccAddrs: [],
        bccAddrs: [],
        subject: "hello",
        referencesIds: [],
        trustReasons: [],
        receivedAt: recent,
      });
    }

    const alice: Caller = {
      ...ADMIN,
      identityId: aliceId,
      scopes: ["message:read", "inbox:read"],
      subject: "key:alice-dashboard",
    };
    await expect(queries.summary(alice, SINCE, NOW)).resolves.toEqual({
      pendingApproval: 1,
      outbound: 1,
      delivered: 1,
      problems: 0,
      inbound: 1,
      activeInboxes: 1,
      totalDeliveries: 2,
      totalMessages: 1,
    });

    const legacyUnbound: Caller = {
      ...alice,
      identityId: null,
      subject: "key:legacy-unbound",
    };
    await expect(queries.summary(legacyUnbound, SINCE, NOW)).resolves.toEqual({
      pendingApproval: 2,
      outbound: 2,
      delivered: 1,
      problems: 1,
      inbound: 2,
      activeInboxes: 2,
      totalDeliveries: 4,
      totalMessages: 2,
    });
  });

  it("counts unread mail by inbox, muted and temporary addresses, and excludes muted and deleted addresses from the main count", async () => {
    const createdAt = SINCE.toISOString();
    const identityId = Ulid.parse(id(601));
    const otherIdentity = Ulid.parse(id(602));
    const [watched, muted, expired, deleted, other, quiet, otherQuiet] = [
      611, 612, 613, 614, 615, 616, 617,
    ].map(id);
    for (const [inboxId, overrides] of [
      [watched!, {}],
      [
        muted!,
        { kind: "ephemeral", muted: true, expiresAt: new Date(+NOW + 60_000).toISOString() },
      ],
      [expired!, { kind: "ephemeral", expiresAt: NOW.toISOString() }],
      [deleted!, { deletedAt: NOW.toISOString() }],
      [other!, { identityId: otherIdentity }],
      [quiet!, { muted: true }],
      [otherQuiet!, { muted: true, identityId: otherIdentity }],
      [id(618), { muted: true, deletedAt: NOW.toISOString() }],
    ] as const) {
      await db.insert(schema.inboxes).values({
        id: inboxId,
        accountId: ACCOUNT,
        identityId,
        address: `${inboxId}@mail.example`,
        localPart: inboxId,
        domain: "mail.example",
        kind: "persistent",
        createdAt,
        ...overrides,
      });
    }

    const candidates = [
      { inboxId: watched! },
      { inboxId: watched!, seen: true },
      { inboxId: watched!, archivedAt: createdAt },
      { inboxId: watched!, direction: "outbound" },
      { inboxId: muted! },
      { inboxId: expired! },
      { inboxId: deleted! },
      { inboxId: other!, identityId: otherIdentity },
      { inboxId: watched!, accountId: "different-account" },
    ];
    for (const [index, overrides] of candidates.entries()) {
      await db.insert(schema.messages).values({
        id: id(650 + index),
        accountId: ACCOUNT,
        identityId,
        rfcMessageId: `fixture-${index}@mail.example`,
        threadId: id(650 + index),
        direction: "inbound",
        fromHeader: "sender@example.com",
        toHeader: "support@mail.example",
        toAddrs: [],
        ccAddrs: [],
        bccAddrs: [],
        referencesIds: [],
        trustReasons: [],
        receivedAt: createdAt,
        ...overrides,
      });
    }

    for (const [index, overrides] of [
      { status: "pending_approval" },
      { status: "bounced" },
      { status: "failed", identityId: otherIdentity },
      { status: "failed", accountId: "different-account" },
      { status: "rejected" },
    ].entries()) {
      await db.insert(schema.deliveries).values({
        id: id(660 + index),
        accountId: ACCOUNT,
        identityId,
        recipients: ["person@example.com"],
        createdAt,
        updatedAt: createdAt,
        statusChangedAt: createdAt,
        ...overrides,
      });
    }

    const statuses = ["bounced", "failed"];
    await expect(queries.mailCounts(ADMIN, NOW, statuses)).resolves.toEqual({
      inboxUnread: 3,
      unreadByInbox: { [watched!]: 1, [muted!]: 1, [expired!]: 1, [other!]: 1 },
      activeEphemeralInboxes: 1,
      mutedPersistentInboxes: 2,
      pendingApproval: 1,
      problems: 2,
    });
    const caller: Caller = { ...ADMIN, scopes: ["inbox:read", "message:read"], identityId };
    await expect(queries.mailCounts(caller, NOW, statuses)).resolves.toEqual({
      inboxUnread: 2,
      unreadByInbox: { [watched!]: 1, [muted!]: 1, [expired!]: 1 },
      activeEphemeralInboxes: 1,
      mutedPersistentInboxes: 1,
      pendingApproval: 1,
      problems: 1,
    });
    await expect(queries.mailCounts(caller, NOW, [])).resolves.toMatchObject({ problems: 0 });
  });

  it("returns deliveries only for visible outbound copies and accepts more than 100 IDs", async () => {
    const createdAt = SINCE.toISOString();
    const identityId = Ulid.parse(id(701));
    const otherIdentity = Ulid.parse(id(702));
    const own = Ulid.parse(id(710));
    const other = Ulid.parse(id(711));
    const inbound = Ulid.parse(id(712));
    const withoutDelivery = Ulid.parse(id(713));
    const outboundDifferentAccount = Ulid.parse(id(714));
    for (const [messageId, fields] of [
      [own, {}],
      [other, { identityId: otherIdentity }],
      [inbound, { direction: "inbound" }],
      [withoutDelivery, {}],
      [outboundDifferentAccount, { accountId: "different-account" }],
    ] as const) {
      await db.insert(schema.messages).values({
        id: messageId,
        accountId: ACCOUNT,
        identityId,
        inboxId: id(700),
        rfcMessageId: `${messageId}@mail.example`,
        threadId: messageId,
        direction: "outbound",
        fromHeader: "sender@example.com",
        toHeader: "support@mail.example",
        toAddrs: [],
        ccAddrs: [],
        bccAddrs: [],
        referencesIds: [],
        trustReasons: [],
        receivedAt: createdAt,
        ...fields,
      });
    }
    for (const [index, fields] of [
      { messageId: own },
      { messageId: other, identityId: otherIdentity, status: "bounced" },
      { messageId: inbound },
      { messageId: outboundDifferentAccount, accountId: "different-account" },
    ].entries()) {
      await db.insert(schema.deliveries).values({
        id: id(720 + index),
        accountId: ACCOUNT,
        identityId,
        status: "delivered",
        recipients: ["person@example.com"],
        createdAt,
        updatedAt: createdAt,
        statusChangedAt: createdAt,
        ...fields,
      });
    }
    const ids = [
      own,
      other,
      inbound,
      withoutDelivery,
      outboundDifferentAccount,
      ...Array.from({ length: 100 }, (_, index) => Ulid.parse(id(1000 + index))),
    ];
    const caller: Caller = { ...ADMIN, scopes: ["message:read"], identityId };
    await expect(queries.deliveriesForMessages(caller, ids)).resolves.toEqual(
      new Map([[own, { id: id(720), status: "delivered" }]]),
    );
    await expect(queries.deliveriesForMessages(ADMIN, ids)).resolves.toEqual(
      new Map([
        [own, { id: id(720), status: "delivered" }],
        [other, { id: id(721), status: "bounced" }],
      ]),
    );
    await expect(queries.deliveriesForMessages(caller, [])).resolves.toEqual(new Map());
  });

  it("does not let a read-only projection bypass scopes", async () => {
    const noInboxRead: Caller = { ...ADMIN, scopes: ["message:read"] };
    await expect(queries.mailCounts(noInboxRead, NOW, [])).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      queries.deliveriesForMessages({ ...ADMIN, scopes: ["inbox:read"] }, []),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(queries.summary(noInboxRead, SINCE, NOW)).rejects.toEqual(
      expect.objectContaining<Partial<DomainError>>({ code: "forbidden" }),
    );
  });
});
