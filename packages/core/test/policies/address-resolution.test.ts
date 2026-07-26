import { describe, expect, it } from "vitest";
import type { DomainRouting, Ulid } from "../../src/domain/index.ts";
import { AddressResolutionPolicy, MailboxAddress } from "../../src/domain/index.ts";

const INBOX_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const CATCH_ALL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;

const routing = (overrides: Partial<DomainRouting> = {}): DomainRouting => ({
  domain: "mail.example.com",
  catchAllMode: "reject",
  catchAllInboxId: null,
  autocreatePattern: null,
  ...overrides,
});

describe("AddressResolutionPolicy", () => {
  it("resolves an existing inbox and carries the tag through", () => {
    const result = AddressResolutionPolicy.resolve({
      recipient: MailboxAddress.parse("agent-7+run42@mail.example.com"),
      existingInboxId: INBOX_ID,
      routing: routing(),
    });
    expect(result).toEqual({ kind: "inbox", inboxId: INBOX_ID, tag: "run42" });
  });

  it("needs no separate subaddressing branch", () => {
    // matchKey already stripped `+tag`, so the tagged and untagged forms produce
    // the same lookup. That is why this policy has three cases and not four.
    expect(MailboxAddress.parse("a+x@mail.example.com").matchKey).toBe(
      MailboxAddress.parse("a@mail.example.com").matchKey,
    );
  });

  it("refuses mail for a domain we do not serve", () => {
    const result = AddressResolutionPolicy.resolve({
      recipient: MailboxAddress.parse("someone@not-ours.com"),
      existingInboxId: null,
      routing: null,
    });
    expect(result).toEqual({ kind: "unroutable", reason: "unknown_domain" });
  });

  it("rejects unknown addresses by default", () => {
    const result = AddressResolutionPolicy.resolve({
      recipient: MailboxAddress.parse("nobody@mail.example.com"),
      existingInboxId: null,
      routing: routing({ catchAllMode: "reject" }),
    });
    expect(result).toEqual({ kind: "unroutable", reason: "no_such_inbox" });
  });

  it("files unknown addresses into the catch-all when configured", () => {
    const result = AddressResolutionPolicy.resolve({
      recipient: MailboxAddress.parse("nobody@mail.example.com"),
      existingInboxId: null,
      routing: routing({ catchAllMode: "store", catchAllInboxId: CATCH_ALL_ID }),
    });
    expect(result).toEqual({ kind: "catch_all", inboxId: CATCH_ALL_ID, tag: null });
  });

  it("reports a misconfigured catch-all instead of silently dropping mail", () => {
    const result = AddressResolutionPolicy.resolve({
      recipient: MailboxAddress.parse("nobody@mail.example.com"),
      existingInboxId: null,
      routing: routing({ catchAllMode: "store", catchAllInboxId: null }),
    });
    expect(result).toEqual({ kind: "unroutable", reason: "catch_all_not_configured" });
  });

  it("autocreates only for addresses matching the configured pattern", () => {
    const config = routing({
      catchAllMode: "autocreate",
      autocreatePattern: "agent-*@mail.example.com",
    });

    expect(
      AddressResolutionPolicy.resolve({
        recipient: MailboxAddress.parse("agent-99@mail.example.com"),
        existingInboxId: null,
        routing: config,
      }),
    ).toEqual({ kind: "autocreate", address: "agent-99@mail.example.com", tag: null });

    // The abuse case: autocreate must not become an open relay for any local part.
    expect(
      AddressResolutionPolicy.resolve({
        recipient: MailboxAddress.parse("random@mail.example.com"),
        existingInboxId: null,
        routing: config,
      }),
    ).toEqual({ kind: "unroutable", reason: "autocreate_pattern_mismatch" });
  });
});
