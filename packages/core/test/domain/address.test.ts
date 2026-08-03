import { AddressPattern, EmailAddress, MailboxAddress } from "@core/domain";
import { describe, expect, it } from "vitest";

describe("EmailAddress", () => {
  it("lowercases the domain but preserves the local part", () => {
    // RFC 5321 makes the local part case sensitive and only the receiving host
    // may interpret it, so we must not rewrite it for other people's addresses.
    expect(EmailAddress.parse("Alice.Smith@EXAMPLE.COM")).toBe("Alice.Smith@example.com");
  });

  it("rejects shapes that would corrupt routing", () => {
    for (const bad of [
      "",
      "no-at-sign",
      "@example.com",
      "a@",
      "a b@example.com",
      "a@example",
    ]) {
      expect(EmailAddress.tryParse(bad)).toBeNull();
    }
  });

  it("extracts the angle address from a display-name header", () => {
    expect(EmailAddress.fromHeader('"Cloudflare" <noreply@notify.cloudflare.com>')).toBe(
      "noreply@notify.cloudflare.com",
    );
    expect(EmailAddress.fromHeader("bare@example.com")).toBe("bare@example.com");
  });

  it("splits a header list without breaking on commas inside quotes", () => {
    const parsed = EmailAddress.listFromHeader('"Doe, John" <j@x.com>, a@b.com');
    expect(parsed).toEqual(["j@x.com", "a@b.com"]);
  });

  it("keeps the display name separate from the address it decorates", () => {
    expect(EmailAddress.parseHeaderList('"Doe, John" <j@x.com>, a@b.com')).toEqual([
      { name: "Doe, John", address: "j@x.com", raw: '"Doe, John" <j@x.com>' },
      { name: null, address: "a@b.com", raw: "a@b.com" },
    ]);
  });

  it("unquotes and unescapes a display name", () => {
    expect(EmailAddress.parseHeaderList('"He said \\"hi\\"" <a@b.com>')[0]?.name).toBe(
      'He said "hi"',
    );
    expect(EmailAddress.parseHeaderList("Acme Security <a@b.com>")[0]?.name).toBe(
      "Acme Security",
    );
    expect(EmailAddress.parseHeaderList('"" <a@b.com>')[0]?.name).toBeNull();
  });

  it("keeps an entry it cannot parse rather than dropping it", () => {
    // `listFromHeader` filters this away, which would silently show a shorter
    // recipient list than the one that arrived.
    const parsed = EmailAddress.parseHeaderList("undisclosed-recipients:;, a@b.com");
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ name: null, address: null, raw: "undisclosed-recipients:;" });
  });

  it("returns nothing for an empty header", () => {
    expect(EmailAddress.parseHeaderList("   ")).toEqual([]);
  });
});

describe("MailboxAddress", () => {
  it("strips +tag into matchKey and keeps the tag as a label", () => {
    const parsed = MailboxAddress.parse("agent-7+run42@Mail.Example.com");
    expect(parsed.localPart).toBe("agent-7");
    expect(parsed.tag).toBe("run42");
    expect(parsed.matchKey).toBe("agent-7@mail.example.com");
    expect(parsed.original).toBe("agent-7+run42@mail.example.com");
  });

  it("lowercases the local part for OUR inboxes so near-duplicates collapse", () => {
    expect(MailboxAddress.parse("Agent-7@mail.example.com").matchKey).toBe(
      "agent-7@mail.example.com",
    );
  });

  it("treats an empty tag as no tag", () => {
    expect(MailboxAddress.parse("agent-7+@mail.example.com").tag).toBeNull();
  });

  it("refuses an address that is nothing but a tag", () => {
    expect(MailboxAddress.tryParse("+tag@mail.example.com")).toBeNull();
  });
});

describe("AddressPattern", () => {
  it("matches wildcards on either side of the @", () => {
    const address = EmailAddress.parse("agent-7@mail.example.com");
    expect(AddressPattern.matches("*@mail.example.com", address)).toBe(true);
    expect(AddressPattern.matches("agent-*@mail.example.com", address)).toBe(true);
    expect(AddressPattern.matches("agent-7@*", address)).toBe(true);
    expect(AddressPattern.matches("other-*@mail.example.com", address)).toBe(false);
  });

  it("never lets a wildcard cross the @", () => {
    // The attack this guards: a domain glob must not be satisfied by a
    // lookalike domain that merely contains the expected one.
    const lookalike = EmailAddress.parse("x@mail.example.com.attacker.com");
    expect(AddressPattern.matches("*@mail.example.com", lookalike)).toBe(false);
  });

  it("treats regex metacharacters in the pattern as literals", () => {
    const address = EmailAddress.parse("axc@example.com");
    expect(AddressPattern.matches("a.c@example.com", address)).toBe(false);
  });
});
