import type { DomainErrorCode } from "@mailworker/core";
import { isDomainError } from "@mailworker/core";
import { z } from "zod";

/**
 * The error contract, in one table, for three consumers.
 *
 * An agent branches on `code` and on the process exit status; a human reads the
 * message; the dashboard reads the HTTP status. Deriving all three from one
 * table is what stops them disagreeing about whether a quota rejection is a
 * client error or a server one.
 *
 * A code is a permanent promise. Once released it never changes meaning and
 * never disappears — add a new one instead.
 */

/**
 * Codes that exist only at the HTTP boundary. Everything else comes from
 * `DomainErrorCode`: the domain names the failures it can actually produce, and
 * these cover the ones it never sees because they happen before or beneath it.
 */
const TRANSPORT_ONLY_CODES = [
  "not_found",
  "method_not_allowed",
  "unsupported_media_type",
  "payload_too_large",
  "rate_limited",
  "internal_error",
  "upstream_error",
] as const;

export const ERROR_CODES = [
  "invalid_email_address",
  "invalid_ulid",
  "invalid_message_id",
  "invalid_argument",
  "inbox_not_found",
  "inbox_expired",
  "address_taken",
  "unroutable_address",
  "message_not_found",
  "identity_not_found",
  "api_key_not_found",
  "webhook_not_found",
  "environment_not_found",
  "invalid_state_transition",
  "send_rejected",
  "quota_exceeded",
  "loop_detected",
  "suppressed_recipient",
  "approval_required",
  "message_too_large",
  "unauthorized",
  "forbidden",
  "wait_timeout",
  ...TRANSPORT_ONLY_CODES,
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * The wire enum and the domain enum must stay in lockstep, so tsc checks both
 * directions rather than a reviewer doing it.
 *
 * Add a `DomainErrorCode` without listing it here and the first line fails; put
 * a code on the wire that is neither a domain code nor a declared transport code
 * and the second one does. Either way the failure lands at build time, not on
 * the agent that was branching on the code that quietly stopped being sent.
 */
type AssertTrue<T extends true> = T;
type _EveryDomainCodeIsOnTheWire = AssertTrue<
  [Exclude<DomainErrorCode, ErrorCode>] extends [never] ? true : false
>;
type _NoWireCodeIsInvented = AssertTrue<
  [Exclude<ErrorCode, DomainErrorCode | (typeof TRANSPORT_ONLY_CODES)[number]>] extends [never]
    ? true
    : false
>;

export const errorCode = z.enum(ERROR_CODES);

/** `{ error: { code, message, details? } }` — the shape of every failed response. */
export const errorResponse = z.object({
  error: z.object({
    code: errorCode,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type ErrorResponse = z.infer<typeof errorResponse>;

const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  invalid_email_address: 400,
  invalid_ulid: 400,
  invalid_message_id: 400,
  invalid_argument: 400,

  inbox_not_found: 404,
  message_not_found: 404,
  identity_not_found: 404,
  api_key_not_found: 404,
  webhook_not_found: 404,
  environment_not_found: 404,
  // Gone, not missing: the inbox existed and its address is still spoken for.
  // 404 would send someone hunting for a bug in their address generation.
  inbox_expired: 410,
  address_taken: 409,
  unroutable_address: 422,

  invalid_state_transition: 409,
  // The three policy rejections are 403: the request was well-formed and
  // authenticated, and we are refusing it anyway. Retrying it unchanged will
  // fail the same way, which 4xx-not-429 is exactly how a client learns.
  send_rejected: 403,
  loop_detected: 403,
  suppressed_recipient: 403,
  quota_exceeded: 429,
  // The ordinary approval path is not an error at all — `POST /v1/send` answers
  // 202 with `status: "pending_approval"`. This code is for acting on a message
  // that is still waiting for a human.
  approval_required: 409,
  // 413 rather than 400: the request was valid in every way except that there
  // was too much of it, and that is the one thing a caller can act on without
  // re-reading the schema.
  message_too_large: 413,

  unauthorized: 401,
  forbidden: 403,

  wait_timeout: 408,

  not_found: 404,
  method_not_allowed: 405,
  unsupported_media_type: 415,
  payload_too_large: 413,
  rate_limited: 429,
  internal_error: 500,
  upstream_error: 502,
};

/**
 * Process exit codes. The point of these is that a shell script
 * or an agent can branch without parsing prose:
 *
 * ```sh
 * mailworker wait --inbox "$id" --extract otp || case $? in
 *   4) echo "no mail yet" ;;
 *   3) echo "bad credentials" ;;
 * esac
 * ```
 */
export const ExitCode = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  AUTH: 3,
  TIMEOUT: 4,
  REJECTED: 5,
  QUOTA: 6,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

const EXIT_CODE: Readonly<Record<ErrorCode, ExitCode>> = {
  // A malformed address or id is the caller getting the call wrong, which is
  // what USAGE means — same class as a missing flag.
  invalid_email_address: ExitCode.USAGE,
  invalid_ulid: ExitCode.USAGE,
  invalid_message_id: ExitCode.USAGE,
  invalid_argument: ExitCode.USAGE,
  // Not REJECTED: no policy refused this. The caller attached too much, and the
  // fix is in the call rather than in the account's configuration.
  message_too_large: ExitCode.USAGE,

  inbox_not_found: ExitCode.ERROR,
  inbox_expired: ExitCode.ERROR,
  address_taken: ExitCode.ERROR,
  unroutable_address: ExitCode.ERROR,
  message_not_found: ExitCode.ERROR,
  identity_not_found: ExitCode.ERROR,
  api_key_not_found: ExitCode.ERROR,
  webhook_not_found: ExitCode.ERROR,
  environment_not_found: ExitCode.ERROR,
  invalid_state_transition: ExitCode.ERROR,

  send_rejected: ExitCode.REJECTED,
  loop_detected: ExitCode.REJECTED,
  suppressed_recipient: ExitCode.REJECTED,
  approval_required: ExitCode.REJECTED,
  quota_exceeded: ExitCode.QUOTA,
  rate_limited: ExitCode.QUOTA,

  unauthorized: ExitCode.AUTH,
  forbidden: ExitCode.AUTH,

  wait_timeout: ExitCode.TIMEOUT,

  not_found: ExitCode.ERROR,
  method_not_allowed: ExitCode.ERROR,
  unsupported_media_type: ExitCode.USAGE,
  payload_too_large: ExitCode.USAGE,
  internal_error: ExitCode.ERROR,
  upstream_error: ExitCode.ERROR,
};

export function httpStatusFor(code: ErrorCode): number {
  return HTTP_STATUS[code];
}

export function exitCodeFor(code: ErrorCode): ExitCode {
  return EXIT_CODE[code];
}

/**
 * Any thrown value to the wire shape.
 *
 * Unrecognised throws collapse to `internal_error` with a fixed message. That is
 * deliberate: an exception's message can carry a query fragment, a key prefix or
 * a recipient list, and this is the one function standing between all of them
 * and an HTTP response body.
 */
export function toErrorResponse(error: unknown): ErrorResponse {
  if (isDomainError(error)) {
    const details = { ...error.details };
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(Object.keys(details).length > 0 ? { details } : {}),
      },
    };
  }
  if (error instanceof z.ZodError) {
    return {
      error: {
        code: "invalid_argument",
        message: z.prettifyError(error),
        details: { issues: error.issues },
      },
    };
  }
  return { error: { code: "internal_error", message: "Internal error." } };
}
