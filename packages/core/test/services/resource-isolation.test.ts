import type { Harness } from "@core/testing";
import { createHarness, rawEmail, TEST_DOMAIN } from "@core/testing";
import { beforeEach, describe, expect, it } from "vitest";

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

async function identity(name: string) {
  return await h.services.identity.createIdentity(h.ctx, { name });
}

async function deliver(address: string, messageId: string): Promise<void> {
  const result = await h.services.ingestion.ingest(h.ctx, {
    recipient: address,
    envelopeFrom: "sender@corp.com",
    raw: rawEmail({
      from: "sender@corp.com",
      to: address,
      subject: `For ${address}`,
      body: "identity private",
      messageId,
    }),
  });
  expect(result.outcome).toBe("stored");
}

describe("identity resource isolation", () => {
  it("binds inboxes created by an identity key to that identity", async () => {
    const bot = await identity("bot");
    const caller = h.asIdentity(bot.id, ["inbox:write", "inbox:read"]);

    const inbox = await h.services.mailbox.createInbox(caller, {
      address: `bot@${TEST_DOMAIN}`,
      kind: "persistent",
    });

    expect(inbox.identityId).toBe(bot.id);
    expect((await h.services.mailbox.listInboxes(caller)).items).toEqual([inbox]);
  });

  it("cannot list or fetch another identity's inboxes and messages", async () => {
    const alice = await identity("alice");
    const bob = await identity("bob");
    const aliceInbox = await h.seedInbox(`alice@${TEST_DOMAIN}`, { identityId: alice.id });
    const bobInbox = await h.seedInbox(`bob@${TEST_DOMAIN}`, { identityId: bob.id });
    await deliver(aliceInbox.address, "alice@sender.test");
    await deliver(bobInbox.address, "bob@sender.test");

    const aliceCaller = h.asIdentity(alice.id, ["inbox:read", "message:read"]);
    const inboxes = await h.services.mailbox.listInboxes(aliceCaller);
    const messages = await h.services.mailbox.listMessages(aliceCaller);

    expect(inboxes.items.map((item) => item.id)).toEqual([aliceInbox.id]);
    expect(messages.items).toHaveLength(1);
    expect(messages.items[0]!.identityId).toBe(alice.id);
    await expect(h.services.mailbox.getInbox(aliceCaller, bobInbox.id)).rejects.toMatchObject({
      code: "inbox_not_found",
    });
    await expect(
      h.services.mailbox.getMessage(aliceCaller, h.waiter.notified[1]!.id),
    ).rejects.toMatchObject({ code: "message_not_found" });
  });

  it("limits wait look-back to the caller's identity", async () => {
    const alice = await identity("alice");
    const bob = await identity("bob");
    const aliceInbox = await h.seedInbox(`alice@${TEST_DOMAIN}`, { identityId: alice.id });
    const bobInbox = await h.seedInbox(`bob@${TEST_DOMAIN}`, { identityId: bob.id });
    await deliver(aliceInbox.address, "alice@sender.test");
    await deliver(bobInbox.address, "bob@sender.test");

    const result = await h.services.mailbox.wait(h.asIdentity(alice.id, ["message:read"]), {
      match: "identity private",
      timeoutMs: 1_000,
    });

    expect(result.outcome).toBe("matched");
    if (result.outcome === "matched") expect(result.message.identityId).toBe(alice.id);
  });
});
