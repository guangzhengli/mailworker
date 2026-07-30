import type { BuildMimeSpec, MimeBuilder, OutboundAttachment } from "@mailworker/core";
import { RfcMessageId } from "@mailworker/core";

/**
 * Builds RFC 5322 bytes.
 *
 * Note what this is NOT for: sending. Cloudflare's Email Sending binding takes a
 * structured object (`env.EMAIL.send({ from, to, subject, html })`) and the raw
 * MIME form is legacy, so the transport never needs this.
 *
 * Its one real job is archiving OUR OWN sent copy as `.eml` in R2, so that
 * `mailworker get --raw` and `mailworker inject` behave identically for inbound
 * and delivery messages. Without it, half the mailbox would have no raw form and
 * the fixture-replay loop would only work in one direction.
 */
export class Rfc5322Builder implements MimeBuilder {
  async build(spec: BuildMimeSpec): Promise<Uint8Array> {
    const hasText = spec.text !== null && spec.text !== "";
    const hasHtml = spec.html !== null && spec.html !== "";

    const headers: string[] = [
      `From: ${encodeAddressHeader(spec.from, spec.fromName)}`,
      `To: ${spec.to.join(", ")}`,
      ...(spec.cc.length > 0 ? [`Cc: ${spec.cc.join(", ")}`] : []),
      `Subject: ${encodeHeaderValue(spec.subject)}`,
      `Date: ${formatDate(spec.date)}`,
      `Message-ID: ${RfcMessageId.toHeader(spec.messageId)}`,
      ...(spec.inReplyTo === null
        ? []
        : [`In-Reply-To: ${RfcMessageId.toHeader(spec.inReplyTo)}`]),
      ...(spec.references.length > 0
        ? [foldHeader("References", RfcMessageId.referencesToHeader(spec.references))]
        : []),
      "MIME-Version: 1.0",
    ];

    // Skip reserved headers in the caller-supplied map so a caller cannot emit a
    // second From or Content-Type and produce an ambiguous message.
    for (const [key, value] of Object.entries(spec.headers)) {
      if (RESERVED_HEADERS.has(key.toLowerCase())) continue;
      headers.push(foldHeader(key, encodeHeaderValue(value)));
    }

    // The body, as the lines that would follow a `Content-Type` describing it.
    // Extracted because attachments need it nested one level down rather than at
    // the top of the message.
    const body = bodyLines(spec, hasText, hasHtml);

    if (spec.attachments.length === 0) {
      return encodeLines([...headers, ...body.header, "", ...body.lines, ""]);
    }

    /**
     * `multipart/mixed` wrapping the body and one part per attachment.
     *
     * The nesting matters and is the part that clients disagree about if you get
     * it wrong: a message with both bodies AND attachments is `mixed` at the top
     * with an `alternative` INSIDE it, never the other way round. Inverted, a
     * client that picks the HTML alternative would drop the attachments along
     * with the plain-text branch it discarded.
     */
    const outer = multipartBoundary(`${spec.messageId}mixed`);
    return encodeLines([
      ...headers,
      `Content-Type: multipart/mixed; boundary="${outer}"`,
      "",
      `--${outer}`,
      ...body.header,
      "",
      ...body.lines,
      "",
      ...spec.attachments.flatMap((attachment) => [
        `--${outer}`,
        ...attachmentPart(attachment),
      ]),
      `--${outer}--`,
      "",
    ]);
  }
}

/**
 * The body as a `Content-Type` header plus its lines, so it can sit either at
 * the top of the message or inside a `multipart/mixed` part unchanged.
 */
function bodyLines(
  spec: BuildMimeSpec,
  hasText: boolean,
  hasHtml: boolean,
): { header: string[]; lines: string[] } {
  if (hasText && hasHtml) {
    const boundary = multipartBoundary(spec.messageId);
    return {
      header: [`Content-Type: multipart/alternative; boundary="${boundary}"`],
      lines: [
        // Ordered least-rich first, as RFC 2046 requires: a client picks the
        // last part it understands.
        `--${boundary}`,
        ...bodyPart("text/plain", spec.text!),
        `--${boundary}`,
        ...bodyPart("text/html", spec.html!),
        `--${boundary}--`,
      ],
    };
  }

  const contentType = hasHtml ? "text/html" : "text/plain";
  const encoded = encodeBody((hasHtml ? spec.html : spec.text) ?? "");
  return {
    header: [
      `Content-Type: ${contentType}; charset=utf-8`,
      `Content-Transfer-Encoding: ${encoded.encoding}`,
    ],
    lines: encoded.lines,
  };
}

/**
 * One attachment part. Always base64: an attachment is arbitrary bytes, and
 * guessing that a `text/csv` is safe as 7bit is how a file with a 1000-column
 * row silently arrives truncated.
 */
function attachmentPart(attachment: OutboundAttachment): string[] {
  const disposition =
    attachment.inline && attachment.contentId !== null ? "inline" : "attachment";
  const name = encodeParameter("filename", attachment.filename);
  return [
    `Content-Type: ${attachment.mime}; ${encodeParameter("name", attachment.filename)}`,
    "Content-Transfer-Encoding: base64",
    ...(attachment.contentId === null ? [] : [`Content-ID: <${attachment.contentId}>`]),
    `Content-Disposition: ${disposition}; ${name}`,
    "",
    ...chunk(toBase64(attachment.content), 76),
    "",
  ];
}

/**
 * A header parameter value, RFC 2231 when it needs to be.
 *
 * NOT `encodeHeaderValue`. RFC 2047 encoded-words are forbidden inside a
 * quoted-string (RFC 2047 §5), which is exactly where a filename lives, and
 * although most clients decode one there anyway, "most clients" is how you end
 * up with `=?UTF-8?B?5oql5ZGKLmNzdg==?=` as the literal name on someone's disk.
 * RFC 2231's `filename*=UTF-8''…` is the form that is actually specified for
 * this position.
 *
 * ASCII names take the plain quoted form, because RFC 2231 is the newer syntax
 * and there is no reason to make an ancient client work for `report.csv`.
 */
function encodeParameter(key: string, value: string): string {
  if (isAscii(new TextEncoder().encode(value)) && !/["\\]/.test(value)) {
    return `${key}="${value}"`;
  }
  // encodeURIComponent leaves RFC 2231's `attribute-char` exceptions unescaped,
  // so the few it misses are escaped by hand.
  const encoded = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${key}*=UTF-8''${encoded}`;
}

const RESERVED_HEADERS = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "subject",
  "date",
  "message-id",
  "in-reply-to",
  "references",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
]);

function bodyPart(contentType: string, body: string): string[] {
  const encoded = encodeBody(body);
  return [
    `Content-Type: ${contentType}; charset=utf-8`,
    `Content-Transfer-Encoding: ${encoded.encoding}`,
    "",
    ...encoded.lines,
    "",
  ];
}

/**
 * ASCII bodies go out as-is; anything else is base64.
 *
 * Base64 rather than quoted-printable because it is unambiguous for CJK text —
 * quoted-printable would escape most of a Chinese message byte by byte, tripling
 * its size and reading as line noise in any client that mishandles it.
 */
function encodeBody(body: string): { encoding: string; lines: string[] } {
  const bytes = new TextEncoder().encode(body);
  if (isAscii(bytes) && !hasOverlongLine(body)) {
    return { encoding: "7bit", lines: body.split(/\r?\n/) };
  }
  return { encoding: "base64", lines: chunk(toBase64(bytes), 76) };
}

function isAscii(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte > 127) return false;
  }
  return true;
}

/** RFC 5322 caps a line at 998 octets. */
function hasOverlongLine(body: string): boolean {
  return body.split(/\r?\n/).some((line) => line.length > 998);
}

/**
 * RFC 2047 encoded-word for a header value containing non-ASCII.
 *
 * The subtle requirement: an encoded word may not exceed 75 characters, and a
 * multi-byte character must never be split across two words — a Chinese subject
 * that gets chopped mid-codepoint renders as mojibake in every client. So the
 * split happens over CODE POINTS while measuring encoded length, not over bytes.
 */
export function encodeHeaderValue(value: string): string {
  if (isAscii(new TextEncoder().encode(value))) return value;

  const PREFIX = "=?UTF-8?B?";
  const SUFFIX = "?=";
  // 75 total, minus the wrapper, rounded down to a multiple of 4 so each word is
  // a whole number of base64 quanta.
  const maxBase64 = Math.floor((75 - PREFIX.length - SUFFIX.length) / 4) * 4;
  const maxBytes = (maxBase64 / 4) * 3;

  const words: string[] = [];
  let buffer: number[] = [];
  const encoder = new TextEncoder();

  for (const char of value) {
    const charBytes = encoder.encode(char);
    if (buffer.length + charBytes.length > maxBytes) {
      words.push(`${PREFIX}${toBase64(new Uint8Array(buffer))}${SUFFIX}`);
      buffer = [];
    }
    buffer.push(...charBytes);
  }
  if (buffer.length > 0) {
    words.push(`${PREFIX}${toBase64(new Uint8Array(buffer))}${SUFFIX}`);
  }

  // Continuation words go on folded lines; a space between them is the fold.
  return words.join("\r\n ");
}

function encodeAddressHeader(address: string, name: string | null): string {
  if (name === null || name.trim() === "") return address;
  return `${encodeHeaderValue(name)} <${address}>`;
}

/** Fold a long header at 78 columns on whitespace, per RFC 5322 §2.2.3. */
export function foldHeader(key: string, value: string): string {
  const line = `${key}: ${value}`;
  if (line.length <= 78 || value.includes("\r\n")) return line;

  const parts = value.split(" ");
  const lines: string[] = [];
  let current = `${key}:`;
  for (const part of parts) {
    if (`${current} ${part}`.length > 78 && current !== `${key}:`) {
      lines.push(current);
      current = ` ${part}`;
    } else {
      current = `${current} ${part}`;
    }
  }
  lines.push(current);
  return lines.join("\r\n");
}

/** RFC 5322 date, e.g. `Tue, 01 Jul 2026 12:00:00 +0000`. */
function formatDate(date: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:` +
    `${pad(date.getUTCSeconds())} +0000`
  );
}

/** Derived from the Message-ID so the same input always builds the same bytes. */
function multipartBoundary(messageId: string): string {
  const cleaned = messageId.replace(/[^A-Za-z0-9]/g, "").slice(0, 24);
  return `--=_mailworker_${cleaned}`;
}

function chunk(value: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < value.length; i += size) {
    out.push(value.slice(i, i + size));
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  // Chunked so a large body does not build one enormous intermediate string.
  let binary = "";
  const STRIDE = 0x8000;
  for (let i = 0; i < bytes.length; i += STRIDE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STRIDE));
  }
  return btoa(binary);
}

/** RFC 5322 requires CRLF. Getting this wrong breaks header parsing downstream. */
function encodeLines(lines: readonly string[]): Uint8Array {
  return new TextEncoder().encode(lines.join("\r\n"));
}
