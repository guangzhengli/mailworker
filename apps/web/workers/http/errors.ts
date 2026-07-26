import type { ErrorCode, ErrorResponse } from "@mailworker/contract";
import { httpStatusFor } from "@mailworker/contract";
import { isDomainError } from "@mailworker/core";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * One error shape, `{ error: { code, message, details? } }`, for everything that
 * can go wrong.
 *
 * An agent branches on `code`, so the code has to be stable and has to be
 * present on every failure — including the ones the domain never sees, like a
 * malformed body or an unrouted path. The status number is derived from the
 * code by `@mailworker/contract`, never chosen here: two places deciding that a
 * quota rejection is a 429 is one place too many.
 */
export function failure(
  c: Context,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): Response {
  const body: ErrorResponse = {
    error: { code, message, ...(details === undefined ? {} : { details }) },
  };
  return c.json(body, httpStatusFor(code) as ContentfulStatusCode);
}

/**
 * The last line: anything thrown anywhere under the router lands here.
 *
 * A `DomainError` already carries a code the contract knows, so it passes
 * through with its details intact — that is the whole point of the domain
 * naming its own failures. Everything else is ours and gets a generic 500 with
 * the detail logged rather than returned, because an unexpected exception's
 * message is as likely to contain a binding name or a row of someone's mail as
 * it is to help.
 */
export function onError(err: Error, c: Context): Response {
  if (isDomainError(err)) {
    return failure(c, err.code, err.message, err.details);
  }

  if (err instanceof HTTPException) {
    // Raised by Hono itself — an unparseable body, a payload over the limit.
    const code: ErrorCode = err.status === 413 ? "payload_too_large" : "invalid_argument";
    return failure(c, code, err.message);
  }

  console.error("unhandled", err.stack ?? String(err));
  return failure(c, "internal_error", "Something went wrong on our side.");
}

/**
 * A rejected request body or query string.
 *
 * The issues come back under `details.issues`, because the caller is usually a
 * program that got a field wrong and the fastest way to tell it which field is
 * to say so. `invalid_argument` rather than a per-field code: the code is for
 * branching, and no client branches differently on which key was bad.
 *
 * Typed structurally rather than as a `ZodError`, so this package does not take
 * a direct dependency on zod to read two fields off an object. The schemas live
 * in `@mailworker/contract` and stay there.
 */
export interface ValidationIssues {
  readonly issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly message: string;
  }[];
}

export function invalid(c: Context, error: ValidationIssues): Response {
  return failure(c, "invalid_argument", "The request did not validate.", {
    issues: error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
}

/**
 * Drop keys whose value is `undefined`.
 *
 * `exactOptionalPropertyTypes` is on, so `{ inboxId: undefined }` and `{}` are
 * different types — and a zod schema with optional fields produces the first
 * while every service signature wants the second. Spreading each field behind
 * its own ternary says the same thing eight times; this says it once.
 */
export type Compacted<T> = {
  // Keys that could not be undefined stay required — dropping that would let a
  // missing `name` through to a service signature that promises to have one.
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

export function compact<T extends object>(value: T): Compacted<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Compacted<T>;
}
