/**
 * Pulling the useful bit out of an email.
 *
 * This exists because of how agents and CI actually use a mailbox: they do not
 * want "the message", they want the six-digit code or the confirmation link. A
 * caller that has to fetch a body and regex it themselves has to re-solve
 * quoted-printable, HTML entities and link wrapping every time — so
 * `mailworker wait --extract otp` prints the code on stdout and nothing else.
 */

export type ExtractKind = "otp" | "link" | "none";

/**
 * Verification codes. Ordered most-specific first: a labelled code ("code:
 * 123456") beats a bare number elsewhere in the body, which is what keeps us
 * from returning a street number or a year.
 */
const OTP_PATTERNS: readonly RegExp[] = [
  /(?:code|otp|pin|token|password)\D{0,20}?\b([0-9]{4,8})\b/i,
  /\b([0-9]{4,8})\b(?:\s+is\s+your|\s*(?:is|as)\s+the\s+(?:code|otp|pin))/i,
  /\b([0-9]{6})\b/,
  /\b([0-9]{4,8})\b/,
];

export const Extract = {
  /** First plausible one-time code, or null. */
  otp(text: string): string | null {
    const normalized = text.replace(/[ ​]/g, " ");
    for (const pattern of OTP_PATTERNS) {
      const match = pattern.exec(normalized);
      if (match?.[1] !== undefined) return match[1];
    }
    return null;
  },

  /**
   * All http(s) URLs, in order, deduplicated.
   *
   * Trailing punctuation is trimmed because a URL at the end of a sentence
   * ("visit https://x.com/verify?t=abc.") otherwise carries the period into the
   * token and 404s. Balanced trailing parens are kept, since they occur inside
   * real query strings.
   */
  links(text: string): string[] {
    const found = text.match(/https?:\/\/[^\s<>"'`]+/gi) ?? [];
    const cleaned = found.map((url) => {
      let value = url;
      while (value.length > 0 && TRAILING_PUNCTUATION.has(value[value.length - 1]!)) {
        if (value.endsWith(")") && countChar(value, "(") >= countChar(value, ")")) break;
        value = value.slice(0, -1);
      }
      return value;
    });
    return [...new Set(cleaned)].filter((url) => url.length > "https://".length);
  },

  /** First link, or null. What `--extract link` prints. */
  firstLink(text: string): string | null {
    return Extract.links(text)[0] ?? null;
  },
} as const;

const TRAILING_PUNCTUATION = new Set([
  ".",
  ",",
  ";",
  ":",
  "!",
  "?",
  ")",
  "]",
  "}",
  ">",
  "'",
  '"',
]);

function countChar(value: string, char: string): number {
  let count = 0;
  for (const ch of value) if (ch === char) count++;
  return count;
}
