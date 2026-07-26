import { EmailAddress } from "@core/domain/email-address";
import { DomainError } from "@core/domain/errors";

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
