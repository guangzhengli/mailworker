/** An authenticated Mailworker deployment rejected the request. */
export class MailworkerApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: Readonly<Record<string, unknown>> | undefined,
    readonly requestId: string | undefined,
    readonly retryable: boolean,
    readonly retryAfterMs: number | undefined,
  ) {
    super(message);
    this.name = "MailworkerApiError";
  }
}

/** The deployment answered successfully, but not with the documented contract. */
export class MailworkerProtocolError extends Error {
  constructor(
    message: string,
    readonly requestId: string | undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MailworkerProtocolError";
  }
}

/** No HTTP response was received after the configured safe retries. */
export class MailworkerNetworkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MailworkerNetworkError";
  }
}

/** One HTTP attempt or a bounded delivery wait exceeded its deadline. */
export class MailworkerTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    options?: ErrorOptions,
  ) {
    super(`Mailworker request timed out after ${timeoutMs} ms.`, options);
    this.name = "MailworkerTimeoutError";
  }
}

/** A request object failed the same Zod contract used by the HTTP server. */
export class MailworkerValidationError extends Error {
  constructor(
    message: string,
    readonly issues: readonly unknown[],
  ) {
    super(message);
    this.name = "MailworkerValidationError";
  }
}
