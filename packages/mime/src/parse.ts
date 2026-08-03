import type {
  EmailAddress,
  MimeParser,
  ParsedAttachment,
  ParsedInbound,
} from "@mailworker/core";
import { EmailAddress as Address, RfcMessageId, SenderAuth } from "@mailworker/core";
import { htmlToText } from "@mime/to-text";
import type { Attachment, Email, Header, Address as PostalAddress } from "postal-mime";
import PostalMime from "postal-mime";

/**
 * The real inbound parser: multipart, transfer encodings, RFC 2047 encoded
 * words, attachments, inline images.
 *
 * `core/testing`'s SimpleMimeParser handles single-part messages only and exists
 * so use-case tests do not depend on this package. This is the one that runs in
 * production, and the one that has to survive whatever the internet sends.
 */
export class PostalMimeParser implements MimeParser {
  constructor(private readonly options: PostalMimeParserOptions = {}) {}

  async parse(raw: Uint8Array): Promise<ParsedInbound> {
    const email: Email = await PostalMime.parse(raw, {
      // Uniform binary attachments; the alternative shapes force every consumer
      // to branch on the encoding.
      attachmentEncoding: "arraybuffer",
      maxNestingDepth: this.options.maxNestingDepth ?? 32,
    });

    const headers = firstOccurrenceOf(email.headers);
    const fromHeader = renderAddress(email.from);

    return {
      rfcMessageId: RfcMessageId.tryParse(email.messageId ?? ""),
      fromHeader,
      from: mailboxAddress(email.from),
      toHeader: (email.to ?? []).map((entry) => renderAddress(entry)).join(", "),
      to: addressList(email.to),
      cc: addressList(email.cc),
      replyTo: mailboxAddress(email.replyTo?.[0]),
      subject: email.subject ?? "",
      // An HTML-only message still needs a text body: it is what the preview,
      // the FTS index, `wait --match` and `--extract otp` all read. Deriving it
      // here means every consumer sees one shape and none of them has to know
      // whether the sender bothered with a `text/plain` alternative.
      bodyText: emptyToNull(email.text) ?? deriveText(email.html),
      bodyHtml: emptyToNull(email.html),
      inReplyTo: RfcMessageId.tryParse(email.inReplyTo ?? ""),
      // postal-mime hands back the raw `References` header as ONE string, not a
      // list. Splitting it here is what keeps ThreadingPolicy working on the
      // typed form it expects.
      references: RfcMessageId.parseReferences(email.references ?? ""),
      auth: SenderAuth.fromHeader(headers["authentication-results"] ?? null),
      sentAt: parseDate(email.date),
      autoSubmitted: headers["auto-submitted"] ?? null,
      headers,
      attachments: email.attachments.map((attachment) => toAttachment(attachment)),
    };
  }
}

export interface PostalMimeParserOptions {
  /** Guards against deeply nested multipart bombs. */
  readonly maxNestingDepth?: number;
}

/**
 * Collapse the header array into a record, keeping the FIRST occurrence.
 *
 * This matters for `Authentication-Results`. Each hop PREPENDS its own, so the
 * first entry belongs to the host that most recently handled the message — for
 * inbound mail that is Cloudflare's MX, the only one whose verdict we have any
 * reason to believe. Taking the last would let a forged header further down the
 * message override the real check.
 */
function firstOccurrenceOf(headers: readonly Header[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const header of headers) {
    if (!(header.key in record)) {
      record[header.key] = header.value;
    }
  }
  return record;
}

/**
 * A display form: `"Alice Smith" <alice@corp.com>`.
 *
 * Deliberately the DECODED form, not the literal header bytes: a real subject or
 * display name arrives RFC 2047 encoded (`=?UTF-8?B?…?=`), and storing that
 * would make every consumer decode it again. Byte-exact fidelity is not lost —
 * the untouched original is in R2 under the message's `rawKey`.
 */
function renderAddress(address: PostalAddress | undefined): string {
  if (address === undefined) return "";
  if (address.address === undefined) {
    return address.group.map((member) => renderMailbox(member.name, member.address)).join(", ");
  }
  return renderMailbox(address.name, address.address);
}

function renderMailbox(name: string, address: string): string {
  const trimmed = name.trim();
  return trimmed === "" ? address : `"${trimmed.replaceAll('"', "'")}" <${address}>`;
}

function mailboxAddress(address: PostalAddress | undefined): EmailAddress | null {
  if (address === undefined) return null;
  if (address.address === undefined) {
    return address.group[0] === undefined ? null : Address.tryParse(address.group[0].address);
  }
  return Address.tryParse(address.address);
}

function addressList(addresses: readonly PostalAddress[] | undefined): EmailAddress[] {
  const result: EmailAddress[] = [];
  for (const entry of addresses ?? []) {
    if (entry.address === undefined) {
      for (const member of entry.group) {
        const parsed = Address.tryParse(member.address);
        if (parsed !== null) result.push(parsed);
      }
    } else {
      const parsed = Address.tryParse(entry.address);
      if (parsed !== null) result.push(parsed);
    }
  }
  return result;
}

function toAttachment(attachment: Attachment): ParsedAttachment {
  return {
    filename: attachment.filename,
    mime: attachment.mimeType,
    contentId: normalizeContentId(attachment.contentId),
    // `related` marks a part referenced from the HTML body (an inline image).
    // Treat either signal as inline so a logo does not show up as a download.
    inline: attachment.disposition === "inline" || attachment.related === true,
    content: toBytes(attachment.content),
  };
}

/** Content-IDs arrive bracketed (`<abc@x>`); `cid:` URLs reference them without. */
function normalizeContentId(contentId: string | undefined): string | null {
  if (contentId === undefined) return null;
  const stripped = contentId.trim().replace(/^</, "").replace(/>$/, "");
  return stripped === "" ? null : stripped;
}

function toBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  if (content instanceof Uint8Array) return content;
  return new Uint8Array(content);
}

function emptyToNull(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

function parseDate(value: string | undefined): Date | null {
  if (value === undefined) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function deriveText(html: string | undefined): string | null {
  if (html === undefined || html.trim() === "") return null;
  return emptyToNull(htmlToText(html));
}
