import { DomainError } from "@/domain/errors.ts";

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
 * An address decomposed for routing: `agent-7+run42@mail.example.com` becomes
 * localPart `agent-7`, tag `run42`, domain `mail.example.com`.
 *
 * `matchKey` is the tag-stripped, fully lowercased form used to look an inbox
 * up. Lowercasing the local part is OUR policy for OUR inboxes (see the note on
 * EmailAddress) — it means `Agent-7@` and `agent-7@` land in the same inbox,
 * which is what every caller expects and what avoids near-duplicate inboxes.
 */
export interface MailboxAddress {
  readonly localPart: string;
  /** The `+tag` portion, if any. Carried through as a label on the message. */
  readonly tag: string | null;
  readonly domain: string;
  /** Tag-stripped, lowercased. The inbox lookup key. */
  readonly matchKey: EmailAddress;
  /** The address exactly as it arrived (tag included, original case). */
  readonly original: EmailAddress;
}

export const MailboxAddress = {
  parse(input: string): MailboxAddress {
    const address = EmailAddress.parse(input);
    const at = address.lastIndexOf("@");
    const rawLocal = address.slice(0, at);
    const domain = address.slice(at + 1);

    const plus = rawLocal.indexOf("+");
    const localPart = plus === -1 ? rawLocal : rawLocal.slice(0, plus);
    const tag = plus === -1 ? null : rawLocal.slice(plus + 1);

    if (localPart.length === 0) {
      throw new DomainError(
        "invalid_email_address",
        `Address has an empty local part before its tag: ${input}`,
        { input },
      );
    }

    return {
      localPart,
      tag: tag === null || tag.length === 0 ? null : tag,
      domain,
      matchKey: `${localPart.toLowerCase()}@${domain}` as EmailAddress,
      original: address,
    };
  },

  tryParse(input: string): MailboxAddress | null {
    try {
      return MailboxAddress.parse(input);
    } catch {
      return null;
    }
  },
} as const;

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
