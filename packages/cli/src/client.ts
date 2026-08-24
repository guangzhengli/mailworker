import type { Config } from "@cli/config";
import type { ErrorCode, ExitCode } from "@mailworker/contract";
import { errorResponse, exitCodeFor } from "@mailworker/contract";

/**
 * A failed API call, carrying the code the server chose.
 *
 * The exit code is derived from that code by the contract's table rather than
 * decided here, which is what keeps `mailworker wait` exiting 4 on the same
 * condition that makes the API answer `wait_timeout`. Two tables would drift,
 * and the drift would only show up in someone's CI script.
 */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> | undefined,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }

  get exitCode(): ExitCode {
    return exitCodeFor(this.code);
  }
}

export interface Client {
  get<T>(path: string, query?: Query, options?: RequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, query?: Query, options?: RequestOptions): Promise<T>;
  postRaw<T>(
    path: string,
    body: Uint8Array | string,
    query?: Query,
    options?: RequestOptions,
  ): Promise<T>;
  delete(path: string, query?: Query, options?: RequestOptions): Promise<void>;
  /** For `get --raw`: the original bytes, not JSON. */
  bytes(path: string, options?: RequestOptions): Promise<Uint8Array>;
}

export type Query = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  /** Caller cancellation is combined with, rather than replaced by, the deadline. */
  readonly signal?: AbortSignal;
  /** Covers receiving and consuming the response, not only response headers. */
  readonly timeoutMs?: number;
}

type Body = string | Uint8Array;
const DEFAULT_TIMEOUT_MS = 30_000;

export function createClient(config: Config): Client {
  async function send(
    method: string,
    path: string,
    query: Query | undefined,
    body: Body | undefined,
    contentType: string | undefined,
    options: RequestOptions,
  ): Promise<ResponseLease> {
    const url = new URL(config.url + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const timeoutMs = positiveTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const deadline = linkedDeadline(options.signal, timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        // An API endpoint should be canonical. Refusing redirects also ensures
        // the bearer token can never be forwarded to a redirected origin.
        redirect: "error",
        headers: {
          Authorization: `Bearer ${config.token}`,
          ...(config.environment === null
            ? {}
            : { "X-Mailworker-Environment": config.environment }),
          ...(contentType === undefined ? {} : { "Content-Type": contentType }),
        },
        ...(body === undefined ? {} : { body }),
        signal: deadline.signal,
      });
    } catch (cause) {
      deadline.dispose();
      if (options.signal?.aborted === true) throw abortReason(options.signal);
      if (deadline.timedOut()) throw timeoutError(url, timeoutMs);
      // A DNS failure or a refused connection is not something the server said,
      // so it has no code of its own. `upstream_error` is the closest true
      // thing: we could not reach the deployment.
      throw new ApiError(
        "upstream_error",
        `Could not reach ${config.url}: ${cause instanceof Error ? cause.message : String(cause)}`,
        undefined,
        0,
      );
    }

    if (!response.ok) {
      try {
        const error = await toApiError(response);
        if (options.signal?.aborted === true) throw abortReason(options.signal);
        if (deadline.timedOut()) throw timeoutError(url, timeoutMs);
        throw error;
      } finally {
        deadline.dispose();
      }
    }
    return { response, deadline, timeoutMs, url, callerSignal: options.signal };
  }

  return {
    async get<T>(path: string, query?: Query, options: RequestOptions = {}): Promise<T> {
      return consume(
        await send("GET", path, query, undefined, undefined, options),
        readJson<T>,
      );
    },

    async post<T>(
      path: string,
      body?: unknown,
      query?: Query,
      options: RequestOptions = {},
    ): Promise<T> {
      return consume(
        await send(
          "POST",
          path,
          query,
          body === undefined ? "{}" : JSON.stringify(body),
          "application/json",
          options,
        ),
        readJson<T>,
      );
    },

    async postRaw<T>(
      path: string,
      body: Uint8Array | string,
      query?: Query,
      options: RequestOptions = {},
    ): Promise<T> {
      return consume(
        await send("POST", path, query, body, "message/rfc822", options),
        readJson<T>,
      );
    },

    async delete(path: string, query?: Query, options: RequestOptions = {}): Promise<void> {
      await consume(
        await send("DELETE", path, query, undefined, undefined, options),
        async () => {},
      );
    },

    async bytes(path: string, options: RequestOptions = {}): Promise<Uint8Array> {
      return consume(
        await send("GET", path, undefined, undefined, undefined, options),
        async (response) => new Uint8Array(await response.arrayBuffer()),
      );
    },
  };
}

interface ResponseLease {
  readonly response: Response;
  readonly deadline: Deadline;
  readonly timeoutMs: number;
  readonly url: URL;
  readonly callerSignal: AbortSignal | undefined;
}

interface Deadline {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly dispose: () => void;
}

async function consume<T>(
  lease: ResponseLease,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  try {
    const value = await read(lease.response);
    if (lease.callerSignal?.aborted === true) throw abortReason(lease.callerSignal);
    if (lease.deadline.timedOut()) throw timeoutError(lease.url, lease.timeoutMs);
    return value;
  } catch (cause) {
    if (lease.callerSignal?.aborted === true) throw abortReason(lease.callerSignal);
    if (lease.deadline.timedOut()) throw timeoutError(lease.url, lease.timeoutMs);
    throw cause;
  } finally {
    lease.deadline.dispose();
  }
}

/**
 * Every failure the server produces carries `{ error: { code, message } }`, so
 * this normally just unwraps it. The fallback is for the layers we do not
 * control — a proxy 502, a gateway timeout — which answer HTML or nothing.
 */
async function toApiError(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  const parsed = errorResponse.safeParse(body);
  if (parsed.success) {
    return new ApiError(
      parsed.data.error.code,
      parsed.data.error.message,
      parsed.data.error.details,
      response.status,
    );
  }

  return new ApiError(
    response.status === 401 ? "unauthorized" : "upstream_error",
    `HTTP ${response.status} from the deployment.`,
    undefined,
    response.status,
  );
}

async function readJson<T>(response: Response): Promise<T> {
  // Mutation endpoints such as `messages/:id/seen` intentionally return 204.
  // `Response.json()` rejects on an empty body even though the request worked.
  if (response.status === 204 || response.headers.get("Content-Length") === "0") {
    return undefined as T;
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(
      "upstream_error",
      `HTTP ${response.status} from the deployment did not contain valid JSON.`,
      undefined,
      response.status,
    );
  }
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Request timeoutMs must be a positive integer.");
  }
  return value;
}

function linkedDeadline(signal: AbortSignal | undefined, timeoutMs: number): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted === true) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Request timed out.", "TimeoutError"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function timeoutError(url: URL, timeoutMs: number): ApiError {
  return new ApiError(
    "upstream_error",
    `Request to ${url.origin}${url.pathname} timed out after ${timeoutMs} ms.`,
    { timeoutMs },
    0,
  );
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}
