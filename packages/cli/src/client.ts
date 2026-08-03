import type { Config } from "@cli/config";
import type { ErrorCode, ErrorResponse, ExitCode } from "@mailworker/contract";
import { exitCodeFor } from "@mailworker/contract";

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
  get<T>(path: string, query?: Query): Promise<T>;
  post<T>(path: string, body?: unknown, query?: Query): Promise<T>;
  postRaw<T>(path: string, body: Uint8Array | string, query?: Query): Promise<T>;
  delete(path: string, query?: Query): Promise<void>;
  /** For `get --raw`: the original bytes, not JSON. */
  bytes(path: string): Promise<Uint8Array>;
}

export type Query = Record<string, string | number | boolean | undefined>;

type Body = string | Uint8Array;

export function createClient(config: Config): Client {
  async function send(
    method: string,
    path: string,
    query: Query | undefined,
    body: Body | undefined,
    contentType: string | undefined,
  ): Promise<Response> {
    const url = new URL(config.url + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${config.token}`,
          ...(config.environment === null
            ? {}
            : { "X-Mailworker-Environment": config.environment }),
          ...(contentType === undefined ? {} : { "Content-Type": contentType }),
        },
        ...(body === undefined ? {} : { body }),
      });
    } catch (cause) {
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

    if (!response.ok) throw await toApiError(response);
    return response;
  }

  return {
    async get<T>(path: string, query?: Query): Promise<T> {
      return (await (await send("GET", path, query, undefined, undefined)).json()) as T;
    },

    async post<T>(path: string, body?: unknown, query?: Query): Promise<T> {
      const response = await send(
        "POST",
        path,
        query,
        body === undefined ? "{}" : JSON.stringify(body),
        "application/json",
      );
      return (await response.json()) as T;
    },

    async postRaw<T>(path: string, body: Uint8Array | string, query?: Query): Promise<T> {
      const response = await send("POST", path, query, body, "message/rfc822");
      return (await response.json()) as T;
    },

    async delete(path: string, query?: Query): Promise<void> {
      await send("DELETE", path, query, undefined, undefined);
    },

    async bytes(path: string): Promise<Uint8Array> {
      const response = await send("GET", path, undefined, undefined, undefined);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
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

  const parsed = body as ErrorResponse | null;
  if (parsed?.error?.code !== undefined) {
    return new ApiError(
      parsed.error.code,
      parsed.error.message,
      parsed.error.details,
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
