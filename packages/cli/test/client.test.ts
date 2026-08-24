import { ApiError, createClient } from "@cli/client";
import type { Config } from "@cli/config";
import { ExitCode } from "@mailworker/contract";
import { afterEach, describe, expect, it, vi } from "vitest";

const config: Config = {
  url: "https://mailworker.test",
  token: "secret-token",
  environment: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("HTTP client", () => {
  it("accepts a successful 204 response without trying to parse JSON", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(
      createClient(config).post("/v1/messages/01J/seen", { seen: true }),
    ).resolves.toBe(undefined);
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://mailworker.test/v1/messages/01J/seen"),
      expect.objectContaining({ redirect: "error" }),
    );
    const request = fetch.mock.calls[0]?.[1];
    expect(request?.headers).toMatchObject({ Authorization: "Bearer secret-token" });
  });

  it("maps a valid error response through the shared exit-code contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { code: "quota_exceeded", message: "Daily quota reached." } },
          { status: 429 },
        ),
      ),
    );

    const error = await createClient(config)
      .get("/v1/messages")
      .catch((cause) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).exitCode).toBe(ExitCode.QUOTA);
  });

  it("turns an unknown server error code into a guaranteed nonzero generic error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { code: "future_server_code", message: "A newer server response." } },
          { status: 400 },
        ),
      ),
    );

    const error = await createClient(config)
      .get("/v1/messages")
      .catch((cause) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("upstream_error");
    expect((error as ApiError).exitCode).toBe(ExitCode.ERROR);
    expect((error as ApiError).exitCode).not.toBe(ExitCode.OK);
  });

  it("rejects a success response whose advertised JSON is malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("not json", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    const error = await createClient(config)
      .get("/v1/messages")
      .catch((cause) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("upstream_error");
    expect((error as ApiError).exitCode).toBe(ExitCode.ERROR);
  });

  it("aborts a hanging ordinary request at the default 30 second deadline", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_input: string | URL | Request, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            requestSignal = init?.signal;
            requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), {
              once: true,
            });
          }),
      ),
    );

    const request = createClient(config).get("/v1/messages");
    const rejected = expect(request).rejects.toMatchObject({
      code: "upstream_error",
      message: "Request to https://mailworker.test/v1/messages timed out after 30000 ms.",
      details: { timeoutMs: 30_000 },
      exitCode: ExitCode.ERROR,
    });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(requestSignal?.aborted).toBe(true);
  });

  it("combines an external AbortSignal with its own deadline and preserves its reason", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled the request");
    let requestSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_input: string | URL | Request, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            requestSignal = init?.signal;
            requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), {
              once: true,
            });
          }),
      ),
    );

    const request = createClient(config).get("/v1/messages", undefined, {
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    expect(requestSignal).not.toBe(controller.signal);
    controller.abort(reason);

    await expect(request).rejects.toBe(reason);
    expect(requestSignal?.aborted).toBe(true);
  });
});
