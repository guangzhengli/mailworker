import type { Inbox } from "@core/domain/inbox";
import { Inbox as InboxVO } from "@core/domain/inbox";

/**
 * When does an expired inbox actually go away?
 *
 * Expiry and deletion are separate on purpose. A test that times out one second
 * after its inbox expired should be told "expired", not "not found" — the first
 * is diagnosable, the second sends someone hunting a bug that isn't there. So an
 * expired inbox goes read-only, stays queryable for the grace period, and only
 * then gets erased.
 *
 * Erasure is two-phase because D1 and R2 cannot be written atomically together:
 * drop the rows first, then sweep the blobs. A blob whose row is already gone is
 * an orphan the sweeper collects; a row whose blob is already gone would be a
 * message that renders as an error, which is worse.
 */

export const DEFAULT_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

export type RetentionAction =
  /** Still live. */
  | { readonly action: "keep" }
  /** Past expiry, inside the grace period: readable, refuses new mail. */
  | { readonly action: "read_only"; readonly deleteAfter: Date }
  /** Past the grace period: delete the rows, then queue the blobs for sweeping. */
  | { readonly action: "purge" };

export interface RetentionInput {
  readonly inbox: Inbox;
  readonly now: Date;
  readonly gracePeriodMs?: number;
}

export const RetentionPolicy = {
  DEFAULT_GRACE_PERIOD_MS,

  decide(input: RetentionInput): RetentionAction {
    const grace = input.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;

    // An explicit delete skips the grace period — the caller already said so.
    if (InboxVO.isDeleted(input.inbox)) {
      return { action: "purge" };
    }

    if (!InboxVO.isExpired(input.inbox, input.now)) {
      return { action: "keep" };
    }

    const expiresAt = input.inbox.expiresAt;
    /* c8 ignore next -- isExpired already guarantees a non-null expiry */
    if (expiresAt === null) return { action: "keep" };

    const deleteAfter = new Date(expiresAt.getTime() + grace);
    return input.now.getTime() >= deleteAfter.getTime()
      ? { action: "purge" }
      : { action: "read_only", deleteAfter };
  },
} as const;
