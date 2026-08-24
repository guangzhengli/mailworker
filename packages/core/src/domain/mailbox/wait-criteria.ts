import type { EmailAddress } from "@core/domain/email-address";
import { invalidArgument } from "@core/domain/errors";
import type { Message, MessageSummary } from "@core/domain/mailbox/message";
import type { Ulid } from "@core/domain/ulid";

/**
 * What a caller is waiting for. The shape behind `GET /v1/messages/wait` and
 * `mailworker wait`.
 *
 * Every field narrows; an empty criteria matches the next message to arrive
 * anywhere in the account.
 */
export interface WaitCriteria {
  readonly inboxId?: Ulid;
  /** Identity-bound callers only see placements owned by their identity. */
  readonly identityId?: Ulid;
  readonly from?: EmailAddress;
  /** Case-insensitive substring of the subject. */
  readonly subject?: string;
  /** Regular expression source tested against subject and text body. */
  readonly match?: string;
  /** Only consider messages newer than this id, so a caller cannot miss one. */
  readonly after?: Ulid;
}

/** Maximum text inspected by one waiter, keeping notification work bounded. */
export const WAIT_MATCH_TEXT_BYTES = 64 * 1024;

export const WaitCriteria = {
  /**
   * Validate the deliberately small regular-expression subset accepted by
   * `wait --match`.
   *
   * JavaScript regexes run on the Worker's main thread. Even one unanchored
   * variable quantifier (`a+b`) is quadratic on a long non-match in V8, so the
   * safe subset allows character classes, anchors and small fixed repetitions
   * only. OTPs (`\\d{6}`) and dates (`\\d{4}-\\d{2}`) remain expressible.
   */
  assertSafeMatch(source: string): void {
    if (source.length > 128) {
      throw invalidArgument("`match` is longer than the 128 character safety limit.", {
        length: source.length,
        max: 128,
      });
    }
    if (/[()|]/.test(source) || /\\[1-9]/.test(source) || /\(\?/.test(source)) {
      throw invalidArgument(
        "`match` uses grouping, alternation, lookaround, or a backreference; use a linear pattern.",
        { match: source },
      );
    }
    assertFixedWidthRepetitions(source);

    try {
      new RegExp(source, "i");
    } catch {
      throw invalidArgument(`\`match\` is not a valid regular expression: ${source}`, {
        match: source,
      });
    }
  },

  /**
   * Does this message satisfy the wait?
   *
   * This lives in the domain rather than in an adapter because there are two
   * waiters — the in-memory one that every service test runs against, and the
   * Durable Object that runs in production — and the whole value of the fake is
   * that it answers this question identically. Two copies of these seven lines
   * would agree on the day they were written and drift on the first edit.
   *
   * `match` is a regular expression rather than a search query, which is also
   * why this cannot be pushed into SQL: the D1 waiter narrows by inbox and
   * cursor in the query, then filters the candidates through here.
   */
  matches(message: Message, criteria: WaitCriteria): boolean {
    if (criteria.inboxId !== undefined && message.inboxId !== criteria.inboxId) return false;
    if (criteria.identityId !== undefined && message.identityId !== criteria.identityId)
      return false;
    if (criteria.from !== undefined && message.from !== criteria.from) return false;
    if (criteria.after !== undefined && message.id <= criteria.after) return false;
    if (
      criteria.subject !== undefined &&
      !message.subject.toLowerCase().includes(criteria.subject.toLowerCase())
    ) {
      return false;
    }
    if (criteria.match !== undefined) {
      // Tested against the text body, never the HTML: matching `<b>code</b>`
      // against `code` would depend on the sender's markup. `bodyText` is
      // always populated — the parser derives it from HTML when a message
      // ships no text part.
      WaitCriteria.assertSafeMatch(criteria.match);
      const pattern = new RegExp(criteria.match, "i");
      const boundedBody = prefixUtf8(message.bodyText ?? "", WAIT_MATCH_TEXT_BYTES);
      if (!pattern.test(message.subject) && !pattern.test(boundedBody)) return false;
    }
    return true;
  },

  /**
   * The part of the check a `MessageSummary` can answer — everything but
   * `match`, which needs a body the summary does not carry.
   *
   * This exists for the look-back half of a wait: the D1 waiter lists summaries
   * to find candidates cheaply, and a candidate that survives this still has to
   * be loaded and put through `matches` when `criteria.match` is set. Skipping
   * `match` here rather than testing it against the subject alone is
   * deliberate — a regex that only hits the body would otherwise be dropped
   * before anyone read the body.
   */
  couldMatch(summary: MessageSummary, criteria: WaitCriteria): boolean {
    if (criteria.inboxId !== undefined && summary.inboxId !== criteria.inboxId) return false;
    if (criteria.identityId !== undefined && summary.identityId !== criteria.identityId)
      return false;
    if (criteria.from !== undefined && summary.from !== criteria.from) return false;
    if (criteria.after !== undefined && summary.id <= criteria.after) return false;
    if (
      criteria.subject !== undefined &&
      !summary.subject.toLowerCase().includes(criteria.subject.toLowerCase())
    ) {
      return false;
    }
    return true;
  },
} as const;

function prefixUtf8(value: string, maximumBytes: number): string {
  if (value.length <= maximumBytes / 3) return value;
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maximumBytes) return value;
  return new TextDecoder().decode(bytes.subarray(0, maximumBytes));
}

/**
 * Reject every syntactic variable-width quantifier while still allowing a
 * literal `+` (`\\+`) or one inside a character class (`[+]`).
 *
 * A look-behind such as `(?<!\\)` is not enough here: in `\\\\+b` the first
 * slash escapes the second, leaving `+` as a real quantifier. Walking escapes
 * in pairs is what makes the decision match the RegExp parser's decision.
 */
function assertFixedWidthRepetitions(source: string): void {
  let inClass = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === "\\") {
      // Whatever follows is data for the escape, not regex syntax. If there is
      // nothing after it, `new RegExp` below reports the malformed expression.
      index += 1;
      continue;
    }
    if (char === "[" && !inClass) {
      inClass = true;
      continue;
    }
    if (char === "]" && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) continue;

    if (char === "*" || char === "+" || char === "?") {
      throw invalidArgument("`match` cannot use a variable repetition; use a fixed `{n}`.", {
        match: source,
      });
    }
    if (char !== "{") continue;

    const closing = source.indexOf("}", index + 1);
    if (closing === -1) {
      // Let RegExp validation produce the ordinary malformed-pattern error.
      continue;
    }
    const repetition = source.slice(index + 1, closing);
    if (!/^\d+$/.test(repetition)) {
      throw invalidArgument("`match` cannot use a variable repetition; use a fixed `{n}`.", {
        match: source,
      });
    }
    if (Number(repetition) > 64) {
      throw invalidArgument("A fixed repetition in `match` cannot exceed 64.", {
        match: source,
        max: 64,
      });
    }
    index = closing;
  }
}
