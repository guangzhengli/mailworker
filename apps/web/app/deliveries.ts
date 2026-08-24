import type { DeliveryStatus } from "@mailworker/core";
import type { MessageKey } from "@web/app/i18n";

/**
 * The four questions a person actually has about a send, and which wire statuses
 * answer each.
 *
 * The ten-status state machine is the right vocabulary for a log and the wrong
 * one for a filter bar: it makes someone learn the machine before they can pick
 * a tab. The human-facing label is shown on each row; the raw wire status stays
 * available in technical details for log and API correlation.
 */
export type Bucket = "waiting" | "moving" | "problem" | "done";

export const BUCKETS: readonly Bucket[] = ["waiting", "moving", "problem", "done"];

const MEMBERS: Readonly<Record<Bucket, readonly DeliveryStatus[]>> = {
  waiting: ["pending_approval"],
  moving: ["draft", "queued", "dispatching", "dispatched", "deferred"],
  // `complained` sits here rather than in `done`: the message arrived, but a
  // recipient marked it spam, and that is a problem to act on.
  problem: ["bounced", "failed", "rejected", "complained"],
  done: ["delivered"],
};

const OF_STATUS = new Map<DeliveryStatus, Bucket>(
  BUCKETS.flatMap((bucket) => MEMBERS[bucket].map((status) => [status, bucket] as const)),
);

export function statusesIn(bucket: Bucket): readonly DeliveryStatus[] {
  return MEMBERS[bucket];
}

export function bucketOf(status: DeliveryStatus): Bucket {
  return OF_STATUS.get(status) ?? "moving";
}

export function isBucket(value: string | null): value is Bucket {
  return value !== null && (BUCKETS as readonly string[]).includes(value);
}

export const BUCKET_LABEL = {
  waiting: "sent.bucket.waiting",
  moving: "sent.bucket.moving",
  problem: "sent.bucket.problem",
  done: "sent.bucket.done",
} as const satisfies Record<Bucket, MessageKey>;

/**
 * What to do about a delivery that ended badly.
 *
 * The timeline says what the provider said; this says what it means for the
 * person reading it. Absent for the endings that need no action.
 */
const NEXT_STEP = {
  dispatching: "delivery.next.dispatching",
  bounced: "delivery.next.bounced",
  complained: "delivery.next.complained",
  rejected: "delivery.next.rejected",
  failed: "delivery.next.failed",
  deferred: "delivery.next.deferred",
} as const satisfies Partial<Record<DeliveryStatus, MessageKey>>;

/**
 * The key is looked up rather than indexed so the narrow literal union survives:
 * `t()` derives a message's required variables from its key, and a widened
 * `MessageKey` would make every call demand an interpolation argument.
 */
export function nextStepFor(
  status: DeliveryStatus,
): (typeof NEXT_STEP)[keyof typeof NEXT_STEP] | null {
  return status in NEXT_STEP ? NEXT_STEP[status as keyof typeof NEXT_STEP] : null;
}
