import type { Caller, Ulid } from "@core/domain";
import {
  AccountId,
  AgentIdentity,
  Delivery,
  EmailAddress,
  Inbox,
  Message,
  ProjectId,
  RfcMessageId,
  ThreadId,
} from "@core/domain";
import type {
  ApiKeyRepository,
  BlobStore,
  DeliveryRepository,
  IdentityRepository,
  InboxRepository,
  MessageRepository,
  SuppressionList,
} from "@core/domain/ports";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * One behavioural suite, run against every implementation of the ports.
 *
 * The in-memory adapters exist so the whole system can be tested without
 * miniflare, a network or a Cloudflare account. That bargain only holds if they
 * behave like the real thing — a fake that quietly disagrees with D1 does not
 * make the suite fast, it makes it lie. So both run these same assertions:
 * `packages/core` against the in-memory adapters in ~200ms, `apps/web` against a
 * real D1 inside workerd.
 *
 * What goes in here is the behaviour both genuinely promise. Where they cannot
 * agree — FTS5 folds diacritics and an in-memory tokenizer does not — the
 * difference is documented at the implementation and left out of these
 * assertions, rather than papered over with a test loose enough to pass twice.
 */

export interface ConformanceSubject {
  readonly inboxes: InboxRepository;
  readonly messages: MessageRepository;
  readonly deliveries: DeliveryRepository;
  readonly identities: IdentityRepository;
  readonly apiKeys: ApiKeyRepository;
  readonly suppressions: SuppressionList;
  readonly blobs: BlobStore;
}

export const CONFORMANCE_DOMAIN = "mail.example.com";
const NOW = new Date("2026-07-01T12:00:00.000Z");

/**
 * Two tenants, so every read can be checked for leaking across the boundary.
 * They share a project, which is exactly the environment case: sibling
 * environments must not see each other's rows either.
 */
const ALICE: Caller = {
  accountId: AccountId.parse("alice"),
  projectId: ProjectId.DEFAULT,
  mode: "live",
  identityId: null,
  scopes: ["admin"],
  subject: "test:alice",
};
const BOB: Caller = {
  accountId: AccountId.parse("bob"),
  projectId: ProjectId.DEFAULT,
  mode: "sandbox",
  identityId: null,
  scopes: ["admin"],
  subject: "test:bob",
};

/**
 * Counter-based ULIDs: valid, monotonic — so keyset pagination behaves exactly
 * as in production — and predictable enough for a test to name one.
 */
function ulidFactory(): () => Ulid {
  let counter = 0;
  return () => {
    counter += 1;
    return `01J${counter.toString(36).toUpperCase().padStart(23, "0")}` as Ulid;
  };
}

export function runRepositoryConformance(
  label: string,
  createSubject: () => ConformanceSubject | Promise<ConformanceSubject>,
): void {
  describe(`${label} — port conformance`, () => {
    let s: ConformanceSubject;
    let nextId: () => Ulid;

    beforeEach(async () => {
      s = await createSubject();
      nextId = ulidFactory();
    });

    const anInbox = (address: string, overrides: Partial<Inbox> = {}): Inbox => ({
      ...Inbox.create({
        id: nextId(),
        accountId: ALICE.accountId,
        address,
        kind: "persistent",
        now: NOW,
      }),
      ...overrides,
    });

    const aMessage = (overrides: Partial<Message> = {}): Message =>
      Message.create({
        id: nextId(),
        accountId: ALICE.accountId,
        inboxId: nextId(),
        rfcMessageId: RfcMessageId.parse(`m${nextId()}@corp.com`),
        threadId: ThreadId.parse(`m${nextId()}@corp.com`),
        direction: "inbound",
        fromHeader: '"Corp" <noreply@corp.com>',
        from: EmailAddress.parse("noreply@corp.com"),
        toHeader: `agent@${CONFORMANCE_DOMAIN}`,
        receivedAt: NOW,
        ...overrides,
      });

    const aDelivery = (overrides: Partial<Delivery> = {}): Delivery => ({
      ...Delivery.create({
        id: nextId(),
        accountId: ALICE.accountId,
        recipients: [EmailAddress.parse("human@corp.com")],
        now: NOW,
      }),
      ...overrides,
    });

    describe("inboxes", () => {
      it("round-trips every field", async () => {
        const inbox = anInbox(`agent@${CONFORMANCE_DOMAIN}`, {
          displayName: "Agent One",
          metadata: { run: "42", ticket: "PROJ-7" },
        });
        await s.inboxes.insert(ALICE, inbox);
        expect(await s.inboxes.findById(ALICE, inbox.id)).toEqual(inbox);
      });

      it("finds by the tag-stripped address and skips soft-deleted rows", async () => {
        const inbox = anInbox(`agent@${CONFORMANCE_DOMAIN}`);
        await s.inboxes.insert(ALICE, inbox);
        expect(await s.inboxes.findByAddress(ALICE, inbox.address)).toEqual(inbox);

        await s.inboxes.update(ALICE, Inbox.markDeleted(inbox, NOW));
        expect(await s.inboxes.findByAddress(ALICE, inbox.address)).toBeNull();
        // Still addressable by id: a deleted inbox must read as "deleted", not
        // as "never existed", or the diagnosis of a failed test goes wrong.
        expect(await s.inboxes.findById(ALICE, inbox.id)).not.toBeNull();
      });

      it("filters a listing by kind and domain", async () => {
        await s.inboxes.insert(ALICE, anInbox(`a@${CONFORMANCE_DOMAIN}`));
        await s.inboxes.insert(
          ALICE,
          anInbox(`b@${CONFORMANCE_DOMAIN}`, {
            kind: "ephemeral",
            expiresAt: new Date(NOW.getTime() + 60_000),
          }),
        );
        await s.inboxes.insert(ALICE, anInbox("c@other.example.com"));

        const ephemeral = await s.inboxes.list(ALICE, { kind: "ephemeral" });
        expect(ephemeral.items.map((i) => i.localPart)).toEqual(["b"]);

        const byDomain = await s.inboxes.list(ALICE, { domain: CONFORMANCE_DOMAIN });
        expect(byDomain.items.map((i) => i.localPart).sort()).toEqual(["a", "b"]);
      });

      it("excludes inboxes already expired at the given instant", async () => {
        const live = anInbox(`live@${CONFORMANCE_DOMAIN}`, {
          kind: "ephemeral",
          expiresAt: new Date(NOW.getTime() + 60_000),
        });
        const dead = anInbox(`dead@${CONFORMANCE_DOMAIN}`, {
          kind: "ephemeral",
          expiresAt: new Date(NOW.getTime() - 60_000),
        });
        await s.inboxes.insert(ALICE, live);
        await s.inboxes.insert(ALICE, dead);

        const active = await s.inboxes.list(ALICE, { activeAt: NOW });
        expect(active.items.map((i) => i.localPart)).toEqual(["live"]);
        // No instant supplied means no filter, not "now".
        expect((await s.inboxes.list(ALICE, {})).items).toHaveLength(2);
      });

      it("paginates by cursor with neither a gap nor an overlap", async () => {
        const created: Inbox[] = [];
        for (let i = 0; i < 5; i++) {
          const inbox = anInbox(`inbox-${i}@${CONFORMANCE_DOMAIN}`);
          created.push(inbox);
          await s.inboxes.insert(ALICE, inbox);
        }

        const first = await s.inboxes.list(ALICE, { limit: 2 });
        expect(first.items).toHaveLength(2);
        expect(first.cursor).toBe(first.items[1]!.id);

        const second = await s.inboxes.list(ALICE, { limit: 2, cursor: first.cursor! });
        const third = await s.inboxes.list(ALICE, { limit: 2, cursor: second.cursor! });

        const walked = [...first.items, ...second.items, ...third.items].map((i) => i.id);
        expect(new Set(walked).size).toBe(5);
        // Newest first by default, and the ULIDs were minted in order.
        expect(walked).toEqual([...created].reverse().map((i) => i.id));
        // A short page ends the walk rather than costing one more round trip.
        expect(third.cursor).toBeNull();
      });

      it("returns expired inboxes oldest first, so a sweep drains the backlog in order", async () => {
        const older = anInbox(`older@${CONFORMANCE_DOMAIN}`, {
          kind: "ephemeral",
          expiresAt: new Date(NOW.getTime() - 120_000),
        });
        const newer = anInbox(`newer@${CONFORMANCE_DOMAIN}`, {
          kind: "ephemeral",
          expiresAt: new Date(NOW.getTime() - 60_000),
        });
        const future = anInbox(`future@${CONFORMANCE_DOMAIN}`, {
          kind: "ephemeral",
          expiresAt: new Date(NOW.getTime() + 60_000),
        });
        await s.inboxes.insert(ALICE, newer);
        await s.inboxes.insert(ALICE, older);
        await s.inboxes.insert(ALICE, future);

        const expired = await s.inboxes.findExpired(ALICE, NOW, 10);
        expect(expired.map((i) => i.localPart)).toEqual(["older", "newer"]);
      });

      it("deletes by id", async () => {
        const inbox = anInbox(`gone@${CONFORMANCE_DOMAIN}`);
        await s.inboxes.insert(ALICE, inbox);
        await s.inboxes.deleteById(ALICE, inbox.id);
        expect(await s.inboxes.findById(ALICE, inbox.id)).toBeNull();
      });

      it("shows one account nothing belonging to another", async () => {
        const inbox = anInbox(`shared-name@${CONFORMANCE_DOMAIN}`);
        await s.inboxes.insert(ALICE, inbox);

        expect(await s.inboxes.findById(BOB, inbox.id)).toBeNull();
        expect(await s.inboxes.findByAddress(BOB, inbox.address)).toBeNull();
        expect((await s.inboxes.list(BOB, {})).items).toEqual([]);
        expect(await s.inboxes.findExpired(BOB, new Date(NOW.getTime() + 1e9), 10)).toEqual([]);
      });

      it("refuses to let one account delete or overwrite another's row", async () => {
        const inbox = anInbox(`victim@${CONFORMANCE_DOMAIN}`);
        await s.inboxes.insert(ALICE, inbox);

        await s.inboxes.deleteById(BOB, inbox.id);
        await s.inboxes.update(BOB, { ...inbox, displayName: "owned" });

        const after = await s.inboxes.findById(ALICE, inbox.id);
        expect(after).toEqual(inbox);
      });
    });

    describe("messages", () => {
      it("round-trips every field, attachments included", async () => {
        const message = aMessage({
          subject: "Your code is 483920",
          bodyText: "Your verification code is 483920.",
          bodyHtml: "<p>Your verification code is 483920.</p>",
          to: [EmailAddress.parse(`agent@${CONFORMANCE_DOMAIN}`)],
          cc: [EmailAddress.parse("cc@corp.com")],
          bcc: [],
          replyTo: EmailAddress.parse("support@corp.com"),
          inReplyTo: RfcMessageId.parse("parent@corp.com"),
          references: [RfcMessageId.parse("root@corp.com")],
          auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
          trusted: true,
          injectionRisk: false,
          trustReasons: ["dmarc_pass"],
          tag: "run42",
          autoSubmitted: "auto-generated",
          rawKey: "raw/alice/01J.eml",
          size: 4096,
          seen: false,
          sentAt: new Date("2026-06-30T09:00:00.000Z"),
          attachments: [
            {
              id: nextId(),
              filename: "invoice.pdf",
              mime: "application/pdf",
              contentId: null,
              size: 1024,
              inline: false,
              storageKey: "att/alice/01J/att1",
            },
          ],
        });
        await s.messages.insert(ALICE, message);
        expect(await s.messages.findById(ALICE, message.id)).toEqual(message);
      });

      it("treats a repeated Message-ID as a duplicate, not an error or an overwrite", async () => {
        const first = aMessage({ subject: "original" });
        expect(await s.messages.insert(ALICE, first)).toEqual({ stored: true });

        const replay = aMessage({ subject: "tampered", rfcMessageId: first.rfcMessageId });
        expect(await s.messages.insert(ALICE, replay)).toEqual({ stored: false });

        // The first one stands. A redelivery must not be able to rewrite history.
        expect((await s.messages.findById(ALICE, first.id))?.subject).toBe("original");
        expect(await s.messages.findById(ALICE, replay.id)).toBeNull();
      });

      it("lets two accounts hold the same Message-ID", async () => {
        const rfcMessageId = RfcMessageId.parse("shared@corp.com");
        expect(await s.messages.insert(ALICE, aMessage({ rfcMessageId }))).toEqual({
          stored: true,
        });
        expect(
          await s.messages.insert(BOB, aMessage({ rfcMessageId, accountId: BOB.accountId })),
        ).toEqual({ stored: true });
      });

      it("resolves thread ids for known ancestors in one call", async () => {
        const root = aMessage({ rfcMessageId: RfcMessageId.parse("root@corp.com") });
        await s.messages.insert(ALICE, root);

        const found = await s.messages.findThreadIds(ALICE, [
          root.rfcMessageId,
          RfcMessageId.parse("never-seen@corp.com"),
        ]);
        expect(found.get(root.rfcMessageId)).toBe(root.threadId);
        expect(found.has("never-seen@corp.com")).toBe(false);
        expect(await s.messages.findThreadIds(ALICE, [])).toEqual(new Map());
      });

      it("summarizes without the bodies", async () => {
        const message = aMessage({
          subject: "Weekly digest",
          bodyText: "  Here   is\n\n  the digest.  ",
          bodyHtml: "<p>Here is the digest.</p>",
          attachments: [
            {
              id: nextId(),
              filename: "report.csv",
              mime: "text/csv",
              contentId: null,
              size: 12,
              inline: false,
              storageKey: "att/alice/01J/a",
            },
          ],
        });
        await s.messages.insert(ALICE, message);

        const [summary] = (await s.messages.list(ALICE, {})).items;
        expect(summary?.preview).toBe("Here is the digest.");
        expect(summary?.hasText).toBe(true);
        expect(summary?.hasHtml).toBe(true);
        expect(summary?.attachmentCount).toBe(1);
        expect(summary).not.toHaveProperty("bodyText");
      });

      it("reports an empty body as having no text", async () => {
        await s.messages.insert(ALICE, aMessage({ bodyText: "   ", bodyHtml: null }));
        const [summary] = (await s.messages.list(ALICE, {})).items;
        expect(summary?.hasText).toBe(false);
        expect(summary?.hasHtml).toBe(false);
        expect(summary?.preview).toBe("");
      });

      it("filters a listing by inbox, direction, seen and sender", async () => {
        const inboxId = nextId();
        const other = nextId();
        const mine = aMessage({ inboxId, seen: false });
        const read = aMessage({ inboxId, seen: true });
        const sent = aMessage({
          inboxId,
          direction: "outbound",
          from: EmailAddress.parse(`agent@${CONFORMANCE_DOMAIN}`),
        });
        const elsewhere = aMessage({ inboxId: other });
        for (const m of [mine, read, sent, elsewhere]) await s.messages.insert(ALICE, m);

        const byInbox = await s.messages.list(ALICE, { inboxId });
        expect(byInbox.items).toHaveLength(3);

        // Only the one inbound message we left unread: our own sent copy is
        // created already seen, which is the rule in `Message.create`.
        const unread = await s.messages.list(ALICE, { inboxId, seen: false });
        expect(unread.items.map((m) => m.id)).toEqual([mine.id]);

        const outboundPage = await s.messages.list(ALICE, { direction: "outbound" });
        expect(outboundPage.items.map((m) => m.id)).toEqual([sent.id]);

        const bySender = await s.messages.list(ALICE, {
          from: EmailAddress.parse("noreply@corp.com"),
        });
        expect(bySender.items).toHaveLength(3);
      });

      it("returns only messages after a given id, which is how wait cannot miss one", async () => {
        const first = aMessage();
        const second = aMessage();
        await s.messages.insert(ALICE, first);
        await s.messages.insert(ALICE, second);

        const after = await s.messages.list(ALICE, { after: first.id });
        expect(after.items.map((m) => m.id)).toEqual([second.id]);
      });

      it("finds messages by whole words in the subject or body", async () => {
        const hit = aMessage({ subject: "Invoice 4821", bodyText: "Payment is overdue." });
        const miss = aMessage({ subject: "Welcome", bodyText: "Nothing to see." });
        await s.messages.insert(ALICE, hit);
        await s.messages.insert(ALICE, miss);

        expect((await s.messages.list(ALICE, { q: "invoice" })).items.map((m) => m.id)).toEqual(
          [hit.id],
        );
        expect((await s.messages.list(ALICE, { q: "overdue" })).items.map((m) => m.id)).toEqual(
          [hit.id],
        );
        // Every term has to match, not just one of them.
        expect((await s.messages.list(ALICE, { q: "invoice welcome" })).items).toEqual([]);
        expect((await s.messages.list(ALICE, { q: "unrelated" })).items).toEqual([]);
      });

      it("survives punctuation in a search term instead of failing the query", async () => {
        await s.messages.insert(ALICE, aMessage({ subject: "hello", bodyText: "world" }));
        // A stray quote or operator is text a user typed, not FTS syntax.
        for (const q of ['"', "AND", "* OR *", "((", "-"]) {
          await expect(s.messages.list(ALICE, { q })).resolves.toBeDefined();
        }
      });

      it("reads a thread oldest first", async () => {
        const threadId = ThreadId.parse("root@corp.com");
        const first = aMessage({ threadId });
        const second = aMessage({ threadId });
        await s.messages.insert(ALICE, second);
        await s.messages.insert(ALICE, first);

        const thread = await s.messages.listThread(ALICE, threadId);
        expect(thread.map((m) => m.id)).toEqual([first.id, second.id]);
      });

      it("marks a message seen and back again", async () => {
        const message = aMessage({ seen: false });
        await s.messages.insert(ALICE, message);
        await s.messages.setSeen(ALICE, message.id, true);
        expect((await s.messages.findById(ALICE, message.id))?.seen).toBe(true);
        await s.messages.setSeen(ALICE, message.id, false);
        expect((await s.messages.findById(ALICE, message.id))?.seen).toBe(false);
      });

      it("counts exchanges by exact address, not by substring", async () => {
        const from = EmailAddress.parse(`agent@${CONFORMANCE_DOMAIN}`);
        const bob = EmailAddress.parse("bob@corp.com");
        const notBob = EmailAddress.parse("notbob@corp.com");
        const since = new Date(NOW.getTime() - 3_600_000);

        await s.messages.insert(
          ALICE,
          aMessage({ direction: "outbound", from, to: [bob], receivedAt: NOW }),
        );
        await s.messages.insert(
          ALICE,
          aMessage({ direction: "outbound", from, to: [notBob], receivedAt: NOW }),
        );
        // Inbound from the same pair must not count — the loop breaker meters
        // what WE send.
        await s.messages.insert(
          ALICE,
          aMessage({ direction: "inbound", from, to: [bob], receivedAt: NOW }),
        );
        await s.messages.insert(
          ALICE,
          aMessage({
            direction: "outbound",
            from,
            to: [bob],
            receivedAt: new Date(since.getTime() - 1000),
          }),
        );

        // The naive `LIKE '%bob@corp.com%'` would report 2 here and throttle
        // sends to an innocent recipient.
        expect(await s.messages.countSentBetween(ALICE, from, bob, since)).toBe(1);
        expect(await s.messages.countSentBetween(ALICE, from, notBob, since)).toBe(1);
      });

      it("counts a recipient found in a multi-address to list", async () => {
        const from = EmailAddress.parse(`agent@${CONFORMANCE_DOMAIN}`);
        const target = EmailAddress.parse("second@corp.com");
        await s.messages.insert(
          ALICE,
          aMessage({
            direction: "outbound",
            from,
            to: [EmailAddress.parse("first@corp.com"), target],
            receivedAt: NOW,
          }),
        );
        expect(
          await s.messages.countSentBetween(
            ALICE,
            from,
            target,
            new Date(NOW.getTime() - 1000),
          ),
        ).toBe(1);
      });

      it("hands back every blob key when an inbox is emptied", async () => {
        const inboxId = nextId();
        const withAttachment = aMessage({
          inboxId,
          rawKey: "raw/alice/one.eml",
          attachments: [
            {
              id: nextId(),
              filename: "a.pdf",
              mime: "application/pdf",
              contentId: null,
              size: 1,
              inline: false,
              storageKey: "att/alice/one/a",
            },
          ],
        });
        const plain = aMessage({ inboxId, rawKey: "raw/alice/two.eml" });
        const elsewhere = aMessage({ rawKey: "raw/alice/three.eml" });
        for (const m of [withAttachment, plain, elsewhere]) await s.messages.insert(ALICE, m);

        const { storageKeys } = await s.messages.deleteByInbox(ALICE, inboxId);
        // Missing a key here does not break anything visibly — it just leaves an
        // object paid for forever, which is why it is asserted exactly.
        expect(storageKeys.sort()).toEqual(
          ["att/alice/one/a", "raw/alice/one.eml", "raw/alice/two.eml"].sort(),
        );
        expect(await s.messages.findById(ALICE, plain.id)).toBeNull();
        expect(await s.messages.findById(ALICE, elsewhere.id)).not.toBeNull();
      });

      it("shows one account nothing belonging to another", async () => {
        const message = aMessage();
        await s.messages.insert(ALICE, message);

        expect(await s.messages.findById(BOB, message.id)).toBeNull();
        expect(await s.messages.findByRfcMessageId(BOB, message.rfcMessageId)).toBeNull();
        expect((await s.messages.list(BOB, {})).items).toEqual([]);
        expect(await s.messages.listThread(BOB, message.threadId)).toEqual([]);
        expect(await s.messages.findThreadIds(BOB, [message.rfcMessageId])).toEqual(new Map());
        expect((await s.messages.deleteByInbox(BOB, message.inboxId)).storageKeys).toEqual([]);
        expect(await s.messages.findById(ALICE, message.id)).not.toBeNull();
      });
    });

    describe("deliveries", () => {
      it("round-trips every field and persists a transition", async () => {
        const delivery = aDelivery({
          idempotencyKey: "run-42",
          payloadKey: "out/alice/01J.json",
        });
        await s.deliveries.insert(ALICE, delivery);
        expect(await s.deliveries.findById(ALICE, delivery.id)).toEqual(delivery);

        const queued = Delivery.enqueue(delivery, NOW);
        const dispatched = Delivery.markDispatched(queued, "prov-1", NOW);
        await s.deliveries.update(ALICE, dispatched);

        const stored = await s.deliveries.findById(ALICE, delivery.id);
        expect(stored?.status).toBe("dispatched");
        expect(stored?.attempts).toBe(1);
        expect(stored?.providerMessageId).toBe("prov-1");
      });

      it("finds a send by its idempotency key and by the provider's id", async () => {
        const delivery = Delivery.markDispatched(
          Delivery.enqueue(aDelivery({ idempotencyKey: "run-42" }), NOW),
          "prov-9",
          NOW,
        );
        await s.deliveries.insert(ALICE, delivery);

        expect((await s.deliveries.findByIdempotencyKey(ALICE, "run-42"))?.id).toBe(
          delivery.id,
        );
        expect((await s.deliveries.findByProviderMessageId(ALICE, "prov-9"))?.id).toBe(
          delivery.id,
        );
        expect(await s.deliveries.findByIdempotencyKey(ALICE, "never-used")).toBeNull();
      });

      it("allows many sends with no idempotency key at all", async () => {
        // NULLs are distinct under a unique constraint; if they were not, the
        // second send without a key would fail.
        await s.deliveries.insert(ALICE, aDelivery());
        await s.deliveries.insert(ALICE, aDelivery());
        expect((await s.deliveries.list(ALICE, {})).items).toHaveLength(2);
      });

      it("filters a listing by status", async () => {
        const queued = Delivery.enqueue(aDelivery(), NOW);
        const rejected = Delivery.reject(aDelivery(), "suppressed", NOW);
        await s.deliveries.insert(ALICE, queued);
        await s.deliveries.insert(ALICE, rejected);

        const listed = await s.deliveries.list(ALICE, { status: "rejected" });
        expect(listed.items.map((o) => o.id)).toEqual([rejected.id]);
      });

      it("counts against quota without charging for refusals", async () => {
        const identityId = nextId();
        const since = new Date(NOW.getTime() - 3_600_000);

        await s.deliveries.insert(ALICE, Delivery.enqueue(aDelivery({ identityId }), NOW));
        await s.deliveries.insert(
          ALICE,
          Delivery.reject(aDelivery({ identityId }), "policy", NOW),
        );
        await s.deliveries.insert(
          ALICE,
          aDelivery({ identityId, createdAt: new Date(since.getTime() - 1000) }),
        );

        // One counted: the rejection never left, and one is outside the window.
        // Metering an agent for sends the policy itself refused would let a
        // single misconfiguration burn a day's allowance with nothing delivered.
        expect(await s.deliveries.countSince(ALICE, identityId, since)).toBe(1);
      });

      it("gives an unbound credential its own quota bucket", async () => {
        const since = new Date(NOW.getTime() - 3_600_000);
        await s.deliveries.insert(ALICE, aDelivery({ identityId: null }));
        await s.deliveries.insert(ALICE, aDelivery({ identityId: nextId() }));

        // `null` means "the credential bound to no identity", not "any of them".
        expect(await s.deliveries.countSince(ALICE, null, since)).toBe(1);
      });

      it("keeps delivery events in the order they happened", async () => {
        const delivery = aDelivery();
        await s.deliveries.insert(ALICE, delivery);

        const at = (offset: number) => new Date(NOW.getTime() + offset);
        // Appended out of order, as a queue consumer would receive them.
        for (const [id, type, offset] of [
          ["c", "delivered", 2000],
          ["a", "deferred", 0],
          ["b", "deferred", 1000],
        ] as const) {
          await s.deliveries.appendDeliveryEvent(ALICE, {
            id: `01JEVT${id.toUpperCase().padStart(20, "0")}` as Ulid,
            deliveryId: delivery.id,
            providerMessageId: "prov-1",
            recipient: EmailAddress.parse("human@corp.com"),
            type,
            terminal: type === "delivered",
            smtpCode: "250",
            smtpResponse: "ok",
            occurredAt: at(offset),
            raw: '{"provider":"payload"}',
          });
        }

        const events = await s.deliveries.listDeliveryEvents(ALICE, delivery.id);
        expect(events.map((e) => e.occurredAt.getTime())).toEqual([
          at(0).getTime(),
          at(1000).getTime(),
          at(2000).getTime(),
        ]);
        expect(events[2]?.terminal).toBe(true);
        expect(events[0]?.raw).toBe('{"provider":"payload"}');
      });

      it("shows one account nothing belonging to another", async () => {
        const delivery = Delivery.markDispatched(
          Delivery.enqueue(aDelivery({ idempotencyKey: "k" }), NOW),
          "prov-1",
          NOW,
        );
        await s.deliveries.insert(ALICE, delivery);

        expect(await s.deliveries.findById(BOB, delivery.id)).toBeNull();
        expect(await s.deliveries.findByIdempotencyKey(BOB, "k")).toBeNull();
        expect(await s.deliveries.findByProviderMessageId(BOB, "prov-1")).toBeNull();
        expect((await s.deliveries.list(BOB, {})).items).toEqual([]);
        expect(await s.deliveries.countSince(BOB, null, new Date(0))).toBe(0);
      });
    });

    describe("identities", () => {
      const anIdentity = (name: string, overrides: Partial<AgentIdentity> = {}) => ({
        ...AgentIdentity.create({
          id: nextId(),
          accountId: ALICE.accountId,
          name,
          now: NOW,
        }),
        ...overrides,
      });

      it("round-trips, keeping an empty allowlist distinct from no allowlist", async () => {
        const unrestricted = anIdentity("free", { recipientAllowlist: null });
        const parked = anIdentity("parked", { recipientAllowlist: [] });
        await s.identities.insert(ALICE, unrestricted);
        await s.identities.insert(ALICE, parked);

        // `null` means "may send anywhere"; `[]` means "may send nowhere". A
        // store that collapsed one into the other would either muzzle an agent
        // or unleash one.
        expect((await s.identities.findByName(ALICE, "free"))?.recipientAllowlist).toBeNull();
        expect((await s.identities.findByName(ALICE, "parked"))?.recipientAllowlist).toEqual(
          [],
        );
      });

      it("round-trips quotas and the approval flag", async () => {
        const identity = anIdentity("ci-bot", {
          sendAs: `agent-*@${CONFORMANCE_DOMAIN}`,
          recipientAllowlist: ["*@corp.com"],
          dailySendQuota: 25,
          requireApproval: true,
        });
        await s.identities.insert(ALICE, identity);
        expect(await s.identities.findById(ALICE, identity.id)).toEqual(identity);
      });

      it("shows one account nothing belonging to another", async () => {
        const identity = anIdentity("ci-bot");
        await s.identities.insert(ALICE, identity);
        expect(await s.identities.findById(BOB, identity.id)).toBeNull();
        expect(await s.identities.findByName(BOB, "ci-bot")).toBeNull();
        expect(await s.identities.list(BOB)).toEqual([]);
      });
    });

    describe("suppressions", () => {
      const bounced = EmailAddress.parse("gone@corp.com");
      const fine = EmailAddress.parse("live@corp.com");

      it("answers for a batch of addresses at once", async () => {
        await s.suppressions.add(ALICE, {
          address: bounced,
          reason: "hard_bounce",
          source: "cf_sync",
          createdAt: NOW,
        });
        expect(await s.suppressions.filterSuppressed(ALICE, [fine, bounced])).toEqual([
          bounced,
        ]);
        expect(await s.suppressions.filterSuppressed(ALICE, [fine])).toEqual([]);
        expect(await s.suppressions.filterSuppressed(ALICE, [])).toEqual([]);
      });

      it("keeps the first reason an address was suppressed for", async () => {
        await s.suppressions.add(ALICE, {
          address: bounced,
          reason: "hard_bounce",
          source: "cf_sync",
          createdAt: NOW,
        });
        await s.suppressions.add(ALICE, {
          address: bounced,
          reason: "manual",
          source: "local",
          createdAt: new Date(NOW.getTime() + 1000),
        });
        // The original reason is what explains why the address is here, which is
        // the question anyone looking at the list is asking.
        const [entry] = await s.suppressions.list(ALICE);
        expect(entry?.reason).toBe("hard_bounce");
        expect(await s.suppressions.list(ALICE)).toHaveLength(1);
      });

      it("removes an address", async () => {
        await s.suppressions.add(ALICE, {
          address: bounced,
          reason: "manual",
          source: "local",
          createdAt: NOW,
        });
        await s.suppressions.remove(ALICE, bounced);
        expect(await s.suppressions.list(ALICE)).toEqual([]);
      });

      it("shows one account nothing belonging to another", async () => {
        await s.suppressions.add(ALICE, {
          address: bounced,
          reason: "manual",
          source: "local",
          createdAt: NOW,
        });
        expect(await s.suppressions.filterSuppressed(BOB, [bounced])).toEqual([]);
        expect(await s.suppressions.list(BOB)).toEqual([]);
      });
    });

    describe("blobs", () => {
      const key = "raw/alice/01J.eml";
      const body = new TextEncoder().encode("From: a@b.com\r\n\r\nHello.");

      it("round-trips bytes unchanged", async () => {
        await s.blobs.put(ALICE, key, body, { contentType: "message/rfc822" });
        expect(await s.blobs.get(ALICE, key)).toEqual(body);
      });

      it("returns null rather than throwing for a key that is not there", async () => {
        expect(await s.blobs.get(ALICE, "raw/alice/missing.eml")).toBeNull();
      });

      it("deletes, and tolerates deleting what is already gone", async () => {
        await s.blobs.put(ALICE, key, body);
        await s.blobs.delete(ALICE, [key, "raw/alice/never-existed.eml"]);
        expect(await s.blobs.get(ALICE, key)).toBeNull();
      });

      it("refuses a key belonging to another account", async () => {
        await s.blobs.put(ALICE, key, body);
        // Blob keys are assembled from ids that arrive in requests, so a key
        // naming someone else's account is the shape a path traversal takes.
        await expect(s.blobs.get(BOB, key)).rejects.toThrow();
        await expect(s.blobs.put(BOB, "raw/alice/planted.eml", body)).rejects.toThrow();

        // Delete filters instead of throwing, so a sweep over a mixed key list
        // removes what it may and leaves the rest.
        await s.blobs.delete(BOB, [key]);
        expect(await s.blobs.get(ALICE, key)).toEqual(body);
      });

      it("preserves bytes that are not valid text", async () => {
        // Attachments are arbitrary binary. A store that round-tripped through a
        // string would corrupt every PDF it ever held.
        const binary = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x01]);
        await s.blobs.put(ALICE, "att/alice/01J/a", binary);
        expect(await s.blobs.get(ALICE, "att/alice/01J/a")).toEqual(binary);
      });
    });
  });
}
