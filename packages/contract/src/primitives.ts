import {
  EmailAddress,
  MAX_PAGE_SIZE,
  RfcMessageId,
  Scope,
  ThreadId,
  Ulid,
} from "@mailworker/core";
import { z } from "zod";

/**
 * Scalars, defined once.
 *
 * These wrap the domain's own parsers rather than restating their rules in zod.
 * A second address grammar here would be a second answer to "is this valid",
 * and the two would drift the first time someone fixed one of them. The domain
 * decides what an address is; this layer decides what JSON we accept, and hands
 * the string over.
 *
 * The pleasant side effect is that a parsed request comes out already branded —
 * `EmailAddress`, `Ulid` — so a use case does not re-parse what the HTTP layer
 * just validated.
 */
function domainScalar<T>(parse: (input: string) => T, label: string) {
  return z.string().transform((value, ctx): T => {
    try {
      return parse(value);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : `Not a valid ${label}.`,
      });
      return z.NEVER;
    }
  });
}

export const ulid = domainScalar<Ulid>((v) => Ulid.parse(v), "ULID");
export const emailAddress = domainScalar<EmailAddress>(
  (v) => EmailAddress.parse(v),
  "email address",
);
export const rfcMessageId = domainScalar<RfcMessageId>(
  (v) => RfcMessageId.parse(v),
  "Message-ID",
);
export const threadId = domainScalar<ThreadId>((v) => ThreadId.parse(v), "thread id");
export const scope = domainScalar<Scope>((v) => Scope.parse(v), "scope");

/** Opaque caller-supplied labels: a test run id, a ticket number. */
export const metadata = z.record(z.string().min(1).max(64), z.string().max(512));

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;
const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * A span of time, as either milliseconds or `10m` / `1h` / `36h`.
 *
 * Both forms exist because both callers are real: an SDK passes a number it
 * computed, and a human types `--ttl 10m` and should not have to reach for a
 * calculator. Parsing lives here so the CLI and the API cannot disagree about
 * what `1d` means.
 */
export const durationMs = z
  .union([z.number().int().positive(), z.string()])
  .transform((value, ctx): number => {
    if (typeof value === "number") return value;
    const match = DURATION.exec(value.trim());
    if (match === null) {
      ctx.addIssue({
        code: "custom",
        message: `Not a duration: "${value}". Use milliseconds or a suffixed value like 10m, 2h, 7d.`,
      });
      return z.NEVER;
    }
    const ms = Number(match[1]) * DURATION_UNIT_MS[match[2]!]!;
    if (ms <= 0) {
      ctx.addIssue({ code: "custom", message: "A duration must be positive." });
      return z.NEVER;
    }
    return Math.round(ms);
  });

/**
 * Keyset pagination (ADR-2). The cursor is the ULID of the last item seen, so it
 * stays a valid position even after rows around it are deleted.
 */
export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  cursor: ulid.optional(),
  order: z.enum(["asc", "desc"]).optional(),
});

export type PageQuery = z.infer<typeof pageQuery>;

/** `{ items, cursor }` — every list response. `cursor: null` means exhausted. */
export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    cursor: z.string().nullable(),
  });
}

export interface PageDto<T> {
  readonly items: readonly T[];
  readonly cursor: string | null;
}

/**
 * Query strings carry `?seen=true`, not a boolean. Accepts the spellings people
 * and shells actually produce, and rejects the rest rather than treating any
 * non-empty string as true — `?seen=false` silently meaning "seen" would be a
 * nasty way to lose a bug report.
 */
export const queryBool = z.stringbool();

/** Dates cross the wire as ISO 8601 in UTC, always. */
export const isoDate = z.iso.datetime();

export function toIso(date: Date): string;
export function toIso(date: Date | null): string | null;
export function toIso(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

export function fromIso(value: string): Date;
export function fromIso(value: string | null): Date | null;
export function fromIso(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}
