/**
 * D1 caps one row at 2 MB. The authoritative decoded bodies live in R2; these
 * bounded copies are only for previews and FTS. The bound is BYTES, not JS
 * characters, so CJK/emoji-heavy mail is just as safe as ASCII mail.
 */
export const MESSAGE_INDEX_TEXT_BYTES = 64 * 1024;

export interface StoredMessageBody {
  readonly bodyText: string | null;
  readonly bodyHtml: string | null;
}

export function truncateUtf8(value: string | null, maxBytes: number): string | null {
  if (value === null) return null;
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) return value;

  // At most three bytes are removed: UTF-8 code points are no wider than four
  // bytes. `fatal` prevents replacing a split final code point with U+FFFD,
  // which could itself make the result exceed the advertised byte bound.
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maxBytes; end >= Math.max(0, maxBytes - 3); end -= 1) {
    try {
      return decoder.decode(encoded.subarray(0, end));
    } catch {
      // Try the previous UTF-8 boundary.
    }
  }
  return "";
}

export function encodeStoredMessageBody(body: StoredMessageBody): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(body));
}

export function decodeStoredMessageBody(bytes: Uint8Array): StoredMessageBody {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (
    !isRecord(value) ||
    !isNullableString(value["bodyText"]) ||
    !isNullableString(value["bodyHtml"])
  ) {
    throw new Error("Stored message body is not a valid Mailworker body object.");
  }
  return { bodyText: value["bodyText"], bodyHtml: value["bodyHtml"] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
