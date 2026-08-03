/**
 * Addresses: the vocabulary every context speaks.
 *
 * Not a mailbox concept. Identity constrains who may send as one, delivery
 * meters recipients, ingestion routes by one. Only the *decomposition* of an
 * address into an inbox lookup is mailbox-specific, and that lives next to the
 * inbox as `MailboxAddress`.
 */
import { DomainError } from "@core/domain/errors";

/**
 * A bare, normalized address: `local@domain`, domain lowercased.
 *
 * The local part is NOT lowercased — RFC 5321 says it is case sensitive and
 * only the receiving host may interpret it. We normalize the domain (which is
 * safely case insensitive) and leave the local part alone; matching against
 * stored inboxes is done case-insensitively by `MailboxAddress`, which is our
 * own local policy rather than a claim about other hosts.
 */
export type EmailAddress = string & { readonly __brand: "EmailAddress" };

/**
 * One entry of an address header, decomposed.
 *
 * The display name is carried separately rather than folded into a single
 * string because it is unauthenticated: nothing in SPF, DKIM or DMARC covers
 * it, so a caller that renders it has to be able to tell it apart from the
 * address that those checks *do* cover.
 */
export interface HeaderAddress {
  /** The display name, unquoted, or null when the entry had none. */
  readonly name: string | null;
  /** The bare address, or null when the entry could not be parsed. */
  readonly address: EmailAddress | null;
  /** The entry as it appeared, for when `address` is null. */
  readonly raw: string;
}

// Deliberately not RFC 5322 complete (that grammar admits quoted strings and
// comments no real MTA emits). This accepts the dot-atom form everyone uses and
// rejects the shapes that would corrupt routing: no spaces, exactly one @,
// non-empty both sides, a dotted domain.
const LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export const MAX_ADDRESS_LENGTH = 320; // 64 local + @ + 255 domain

export const EmailAddress = {
  parse(input: string): EmailAddress {
    const trimmed = input.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_ADDRESS_LENGTH) {
      throw new DomainError("invalid_email_address", `Not a valid email address: ${input}`, {
        input,
      });
    }
    const at = trimmed.lastIndexOf("@");
    if (at <= 0 || at === trimmed.length - 1) {
      throw new DomainError("invalid_email_address", `Not a valid email address: ${input}`, {
        input,
      });
    }
    const local = trimmed.slice(0, at);
    const domain = trimmed.slice(at + 1).toLowerCase();
    if (local.length > 64 || !LOCAL.test(local) || !DOMAIN.test(domain)) {
      throw new DomainError("invalid_email_address", `Not a valid email address: ${input}`, {
        input,
      });
    }
    return `${local}@${domain}` as EmailAddress;
  },

  tryParse(input: string): EmailAddress | null {
    try {
      return EmailAddress.parse(input);
    } catch {
      return null;
    }
  },

  /**
   * Pull the bare address out of an RFC 5322 header value such as
   * `"Cloudflare" <noreply@notify.cloudflare.com>`.
   *
   * We store the *raw* header on the message (display name preserved) and use
   * this only when we need something routable. Note this is the From HEADER,
   * never the SMTP envelope sender — for VERP/bounce senders those differ, and
   * a reply must go to the header address.
   */
  fromHeader(header: string): EmailAddress | null {
    const angled = /<([^<>]+)>\s*$/.exec(header.trim());
    return EmailAddress.tryParse(angled?.[1] ?? header);
  },

  /** All bare addresses in a comma-separated header value. */
  listFromHeader(header: string): EmailAddress[] {
    if (header.trim() === "") return [];
    return splitHeaderList(header)
      .map((part) => EmailAddress.fromHeader(part))
      .filter((a): a is EmailAddress => a !== null);
  },

  /**
   * Every entry of a header value, kept whole rather than reduced to addresses.
   *
   * `listFromHeader` throws away two things a reader needs: the display name,
   * and the entries that did not parse. A viewer that silently drops an
   * unparseable recipient is showing a smaller To: line than the one that
   * actually arrived, which is the kind of quiet omission this tool exists to
   * not do — so every entry comes back, with `raw` as the fallback.
   */
  parseHeaderList(header: string): HeaderAddress[] {
    if (header.trim() === "") return [];
    return splitHeaderList(header).map((raw) => ({
      name: displayNameFrom(raw),
      address: EmailAddress.fromHeader(raw),
      raw,
    }));
  },

  domain(address: EmailAddress): string {
    return address.slice(address.lastIndexOf("@") + 1);
  },

  localPart(address: EmailAddress): string {
    return address.slice(0, address.lastIndexOf("@"));
  },
} as const;

/**
 * A glob over addresses, used for `sendAs` and recipient allowlists:
 * `*@example.com`, `agent-*@mail.example.com`, `alice@example.com`.
 *
 * `*` matches any run of characters, but never across the `@` — so
 * `*@example.com` cannot be tricked by `evil@attacker.com@example.com`
 * (which is not a valid address anyway) or by `x@example.com.attacker.com`.
 */
export const AddressPattern = {
  matches(pattern: string, address: EmailAddress): boolean {
    const at = pattern.lastIndexOf("@");
    if (at <= 0) return false;
    const localGlob = pattern.slice(0, at);
    const domainGlob = pattern.slice(at + 1).toLowerCase();

    const local = EmailAddress.localPart(address);
    const domain = EmailAddress.domain(address);

    return globMatches(localGlob, local) && globMatches(domainGlob, domain);
  },

  matchesAny(patterns: readonly string[], address: EmailAddress): boolean {
    return patterns.some((pattern) => AddressPattern.matches(pattern, address));
  },
} as const;

function globMatches(glob: string, value: string): boolean {
  if (glob === "*") return true;
  const source = glob
    .split("*")
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`, "i").test(value);
}

/**
 * The display name of a single entry, or null.
 *
 * Only the `Name <addr>` form has one — a bare `addr` does not. Quotes come off
 * and backslash escapes are resolved, so `"Doe, John"` reads as `Doe, John`.
 * Encoded words are already decoded by the time a header reaches us; the parser
 * stores the decoded display form (see `mime/src/parse.ts`).
 */
function displayNameFrom(entry: string): string | null {
  const angled = /^([\s\S]*)<[^<>]+>$/.exec(entry.trim());
  if (angled === null) return null;
  const name = angled[1]!.trim();
  const unquoted = /^"([\s\S]*)"$/.exec(name)?.[1] ?? name;
  const unescaped = unquoted.replace(/\\([\s\S])/g, "$1").trim();
  return unescaped === "" ? null : unescaped;
}

/**
 * Split on commas that are not inside a quoted display name.
 * `"Doe, John" <j@x.com>, a@b.com` must yield two entries, not three.
 */
function splitHeaderList(header: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < header.length; i++) {
    const ch = header[i]!;
    if (ch === '"' && header[i - 1] !== "\\") {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === "," && !inQuotes) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}
