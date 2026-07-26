/**
 * Domain errors carry a stable `code`. Interface layers map that code to an
 * HTTP status and a CLI exit code, so an agent can branch on it forever without
 * parsing prose. Never change a code once released; add a new one instead.
 */
export type DomainErrorCode =
  // validation
  | "invalid_email_address"
  | "invalid_ulid"
  | "invalid_message_id"
  | "invalid_argument"
  // mailbox
  | "inbox_not_found"
  | "inbox_expired"
  | "address_taken"
  | "unroutable_address"
  | "message_not_found"
  | "identity_not_found"
  | "api_key_not_found"
  | "webhook_not_found"
  // delivery
  | "invalid_state_transition"
  | "send_rejected"
  | "quota_exceeded"
  | "loop_detected"
  | "suppressed_recipient"
  | "approval_required"
  // access
  | "unauthorized"
  | "forbidden"
  // waiting
  | "wait_timeout";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: DomainErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }

  toJSON(): { code: DomainErrorCode; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: { ...this.details } };
  }
}

export const invalidArgument = (
  message: string,
  details?: Record<string, unknown>,
): DomainError => new DomainError("invalid_argument", message, details);

export const notFound = (
  code: Extract<DomainErrorCode, `${string}_not_found`>,
  message: string,
  details?: Record<string, unknown>,
): DomainError => new DomainError(code, message, details);

export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError;
}
