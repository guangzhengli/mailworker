import type { EmailAddress } from "@core/domain/email-address";
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
  readonly from?: EmailAddress;
  /** Case-insensitive substring of the subject. */
  readonly subject?: string;
  /** Regular expression source tested against subject and text body. */
  readonly match?: string;
  /** Only consider messages newer than this id, so a caller cannot miss one. */
  readonly after?: Ulid;
}

export const WaitCriteria = {
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
      const pattern = new RegExp(criteria.match, "i");
      if (!pattern.test(message.subject) && !pattern.test(message.bodyText ?? "")) return false;
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
