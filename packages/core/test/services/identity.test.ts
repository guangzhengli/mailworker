import { ApiKeyToken } from "@core/domain";
import { createHarness, type Harness } from "@core/testing";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * The context that makes the other three safe to hand to an agent.
 *
 * Everything here is about a limit that the thing being limited must not be
 * able to move. The tests are written from that angle rather than as CRUD
 * coverage, because CRUD is not what this service is for.
 */

let h: Harness;
beforeEach(() => {
  h = createHarness();
});

describe("createIdentity", () => {
  it("needs admin, so an agent cannot widen its own limits", async () => {
    // The credential that declares limits has to be a different one from the
    // credential that acts under them. Otherwise the quota is a suggestion.
    await expect(
      h.services.identity.createIdentity(h.withScopes(["message:send"]), { name: "bot" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("keeps an empty allowlist distinct from an absent one", async () => {
    const parked = await h.services.identity.createIdentity(h.ctx, {
      name: "parked",
      recipientAllowlist: [],
    });
    const open = await h.services.identity.createIdentity(h.ctx, { name: "open" });

    // `[]` means "may send to nobody", which is how an identity is parked
    // without being deleted. Collapsing it to null would turn parked into
    // unrestricted — in the direction that matters.
    expect(parked.recipientAllowlist).toEqual([]);
    expect(open.recipientAllowlist).toBeNull();
  });

  it("refuses a duplicate name", async () => {
    await h.services.identity.createIdentity(h.ctx, { name: "bot" });
    await expect(
      h.services.identity.createIdentity(h.ctx, { name: "bot" }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });
});

describe("createKey", () => {
  it("returns the token once, and stores only a hash", async () => {
    const minted = await h.services.identity.createKey(h.ctx, {
      name: "ci",
      scopes: ["message:read"],
    });

    // Round-trips through the real parser, which is the assertion that matters:
    // a fake minting a token shape `ApiKeyToken` rejects would make every
    // in-memory auth test exercise something that cannot exist in production.
    const split = ApiKeyToken.split(minted.token);
    expect(split).not.toBeNull();
    // The prefix is the public head of the token: enough to identify which key
    // leaked, and useless for authenticating.
    expect(split?.prefix).toBe(minted.key.prefix);
    expect(minted.key).not.toHaveProperty("token");
    expect(minted.key.hash).not.toContain(minted.token);

    // And there is no way back to it. `listKeys` is the only reader, and it
    // returns entities that genuinely do not have the secret.
    const listed = await h.services.identity.listKeys(h.ctx);
    expect(JSON.stringify(listed)).not.toContain(minted.token);
  });

  it("refuses to bind an admin key to an identity", async () => {
    await h.services.identity.createIdentity(h.ctx, { name: "bot", dailySendQuota: 5 });
    // An admin key can edit the identity's own limits, so binding one produces
    // a credential whose metering it can simply remove. Refusing is clearer
    // than metering something that can opt out.
    await expect(
      h.services.identity.createKey(h.ctx, {
        name: "oops",
        scopes: ["admin"],
        identityName: "bot",
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("binds a scoped key to an identity so SendPolicy has something to meter", async () => {
    const identity = await h.services.identity.createIdentity(h.ctx, {
      name: "bot",
      dailySendQuota: 5,
    });
    const minted = await h.services.identity.createKey(h.ctx, {
      name: "bot key",
      scopes: ["message:send"],
      identityName: "bot",
    });
    expect(minted.key.identityId).toBe(identity.id);
  });

  it("reports a missing identity rather than minting an unmetered key", async () => {
    await expect(
      h.services.identity.createKey(h.ctx, {
        name: "k",
        scopes: ["message:send"],
        identityName: "nope",
      }),
    ).rejects.toMatchObject({ code: "identity_not_found" });
  });
});

describe("revokeKey", () => {
  it("revokes without deleting, so the audit trail survives", async () => {
    const minted = await h.services.identity.createKey(h.ctx, {
      name: "leaked",
      scopes: ["message:read"],
    });

    const revoked = await h.services.identity.revokeKey(h.ctx, minted.key.id);
    expect(revoked.revokedAt).not.toBeNull();

    // The row is still there. The question after a leak is what the key did
    // before anyone noticed, and deleting it is how that becomes unanswerable.
    const listed = await h.services.identity.listKeys(h.ctx);
    expect(listed.map((key) => key.id)).toContain(minted.key.id);
  });
});
