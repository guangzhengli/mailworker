import { createNoteBody, renameLabelBody } from "@contract/annotations";
import { createInboxBody, listInboxesQuery, updateInboxBody } from "@contract/inbox";
import {
  listMessagesQuery,
  updateMessageBody,
  updateMessagesBody,
  waitQuery,
} from "@contract/message";
import { sendBody } from "@contract/send";
import { describe, expect, it } from "vitest";

/**
 * Request schemas exist to hand a use case something it can run without a second
 * parse. So these assert the SHAPE HANDED ON, not merely that validation passed:
 * the wire names, the units, and — because `exactOptionalPropertyTypes` is on —
 * that an absent field is an absent key rather than an explicit `undefined`.
 */

describe("createInboxBody", () => {
  it("translates wire names into the use case's", () => {
    expect(createInboxBody.parse({ prefix: "agent", ttl: "10m", identity: "ci-bot" })).toEqual({
      prefix: "agent",
      ttlMs: 600_000,
      identityName: "ci-bot",
    });
  });

  it("omits absent fields instead of setting them to undefined", () => {
    const parsed = createInboxBody.parse({ address: "a@b.com" });
    expect(Object.keys(parsed)).toEqual(["address"]);
    expect("ttlMs" in parsed).toBe(false);
  });

  it("rejects an unknown key rather than ignoring it", () => {
    // A typo'd `tll: "10m"` that silently created a one-hour inbox would be
    // found hours later, by someone else.
    const failure = createInboxBody.safeParse({ prefix: "agent", tll: "10m" });
    expect(failure.success).toBe(false);
    expect(failure.error?.issues[0]?.code).toBe("unrecognized_keys");
  });

  it("leaves the address-or-prefix rule to the domain", () => {
    // Shape here, rules there. Both are accepted structurally; the service
    // refuses the pair, and it is the only place that knows why.
    expect(createInboxBody.safeParse({ address: "a@b.com", prefix: "agent" }).success).toBe(
      true,
    );
  });

  it("constrains a prefix to what can appear in a local part", () => {
    expect(createInboxBody.safeParse({ prefix: "Agent Smith" }).success).toBe(false);
    expect(createInboxBody.safeParse({ prefix: "agent-7" }).success).toBe(true);
  });
});

describe("query schemas", () => {
  it("coerces the strings a URL actually carries", () => {
    const parsed = listMessagesQuery.parse({
      limit: "25",
      seen: "false",
      inbox: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
    expect(parsed.limit).toBe(25);
    expect(parsed.seen).toBe(false);
    expect(parsed.inbox).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
  });

  it("caps limit at the domain's page ceiling", () => {
    expect(listMessagesQuery.safeParse({ limit: "5000" }).success).toBe(false);
    expect(listInboxesQuery.safeParse({ limit: "200" }).success).toBe(true);
  });

  it("rejects a cursor that is not a ULID", () => {
    // A cursor is a position, and a bogus one must fail loudly rather than
    // paginating from the beginning forever.
    expect(listMessagesQuery.safeParse({ cursor: "page-2" }).success).toBe(false);
  });
});

describe("waitQuery", () => {
  it("renames to the use case's fields and normalizes the timeout", () => {
    expect(waitQuery.parse({ inbox: "01ARZ3NDEKTSV4RRFFQ69G5FAV", timeout: "45s" })).toEqual({
      inboxId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      timeoutMs: 45_000,
    });
  });

  it("accepts an empty query — wait on anything", () => {
    expect(waitQuery.parse({})).toEqual({});
  });

  it("leaves regex validity to the use case, which compiles it once", () => {
    expect(waitQuery.safeParse({ match: "[unclosed" }).success).toBe(true);
  });
});

describe("sendBody", () => {
  it("renames inReplyTo to the ULID field it really is", () => {
    const parsed = sendBody.parse({
      from: "agent@mail.example.com",
      to: ["human@corp.com"],
      subject: "Re: ticket",
      text: "on it",
      inReplyTo: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      automated: true,
    });
    expect(parsed.inReplyToMessageId).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect("inReplyTo" in parsed).toBe(false);
    expect(parsed.automated).toBe(true);
  });

  it("normalizes recipient addresses on the way in", () => {
    const parsed = sendBody.parse({
      from: "agent@Mail.Example.COM",
      to: ["Human@CORP.com"],
      subject: "hi",
      text: "hi",
    });
    expect(parsed.from).toBe("agent@mail.example.com");
    expect(parsed.to).toEqual(["Human@corp.com"]);
  });

  it("requires at least one recipient", () => {
    expect(
      sendBody.safeParse({ from: "a@b.com", to: [], subject: "s", text: "t" }).success,
    ).toBe(false);
  });

  it("refuses more recipients than Cloudflare accepts", () => {
    const many = Array.from({ length: 51 }, (_, i) => `r${i}@corp.com`);
    expect(
      sendBody.safeParse({ from: "a@b.com", to: many, subject: "s", text: "t" }).success,
    ).toBe(false);
  });

  it("leaves the text-or-html rule to the domain", () => {
    expect(sendBody.safeParse({ from: "a@b.com", to: ["c@d.com"], subject: "s" }).success).toBe(
      true,
    );
  });
});

describe("mail client state requests", () => {
  const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

  it("retains explicit mute, false flags and null display names", () => {
    expect(createInboxBody.parse({ muted: false })).toEqual({ muted: false });
    expect(updateInboxBody.parse({ muted: false, displayName: null })).toEqual({
      muted: false,
      displayName: null,
    });
    expect(updateInboxBody.safeParse({}).success).toBe(false);
    expect(updateInboxBody.safeParse({ expiresAt: null }).success).toBe(false);
    expect(updateInboxBody.safeParse({ displayName: "x".repeat(256) }).success).toBe(false);
    expect(listInboxesQuery.parse({ muted: "true" })).toMatchObject({ muted: true });
    expect(
      listMessagesQuery.parse({
        label: "Bug",
        seen: "false",
        starred: "true",
        archived: "false",
        muted: "false",
      }),
    ).toMatchObject({
      label: "Bug",
      seen: false,
      starred: true,
      archived: false,
      muted: false,
    });
  });

  it("keeps label operations nested and validates batch IDs", () => {
    const change = {
      starred: true,
      archived: false,
      labels: { add: ["Bug"], remove: ["Question"] },
    };
    expect(updateMessageBody.parse(change)).toEqual(change);
    expect(updateMessageBody.safeParse({ labels: { unknown: [] } }).success).toBe(false);
    expect(updateMessageBody.safeParse({ ids: [id], ...change }).success).toBe(false);
    expect(updateMessagesBody.parse({ ids: [id.toLowerCase()], ...change })).toEqual({
      ids: [id],
      ...change,
    });
    expect(updateMessagesBody.safeParse({ ids: [], ...change }).success).toBe(false);
    expect(updateMessagesBody.safeParse({ ids: ["bad"], ...change }).success).toBe(false);
    expect(
      updateMessagesBody.safeParse({ ids: Array.from({ length: 101 }, () => id), ...change })
        .success,
    ).toBe(false);
  });

  it("parses plain-text notes and label renames", () => {
    expect(createNoteBody.parse({ body: "  <b>Needs review</b>  " })).toEqual({
      body: "<b>Needs review</b>",
    });
    expect(createNoteBody.safeParse({ body: " " }).success).toBe(false);
    expect(createNoteBody.safeParse({ body: "x".repeat(4001) }).success).toBe(false);
    expect(renameLabelBody.parse({ name: "Bug" })).toEqual({ name: "Bug" });
    expect(renameLabelBody.safeParse({ name: "Bug", id }).success).toBe(false);
  });
});
