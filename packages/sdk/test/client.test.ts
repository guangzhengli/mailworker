import { describe, expect, it, vi } from "vitest";
import {
  MailworkerClient,
  MailworkerProtocolError,
  MailworkerValidationError,
} from "../src/index";

function client(fetch: typeof globalThis.fetch, maxRetries = 2) {
  return new MailworkerClient({
    baseUrl: "https://mailworker.test",
    token: "mw_sbx_public_secret",
    fetch,
    retry: { maxRetries, baseDelayMs: 0 },
  });
}

const inbox = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  address: "agent@mail.example.com",
  localPart: "agent",
  domain: "mail.example.com",
  displayName: null,
  kind: "persistent",
  identityId: null,
  metadata: null,
  expiresAt: null,
  createdAt: "2026-08-12T00:00:00.000Z",
} as const;

const delivery = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  inboxId: null,
  identityId: null,
  messageId: null,
  idempotencyKey: "task-42",
  metadata: {},
  status: "queued",
  attempts: 0,
  recipients: ["person@example.com"],
  providerMessageId: null,
  rejectReason: null,
  lastError: null,
  approvedBy: null,
  approvedAt: null,
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
} as const;

function stalledResponse(signal: AbortSignal | null | undefined, status = 200): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const onAbort = () => controller.error(signal?.reason);
        if (signal?.aborted === true) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

describe("MailworkerClient safety", () => {
  it("validates input before making a request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(client(fetch).createInbox({ ttl: -1 })).rejects.toBeInstanceOf(
      MailworkerValidationError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("validates wait criteria before starting a long poll", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      client(fetch).waitForMessage({ timeout: "eventually" }),
    ).rejects.toBeInstanceOf(MailworkerValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("validates successful response bodies", async () => {
    const fetch = vi.fn(async () => Response.json({ id: "missing fields" }));
    await expect(client(fetch).getInbox(inbox.id)).rejects.toBeInstanceOf(
      MailworkerProtocolError,
    );
  });

  it("keeps the request timeout active while consuming the response body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) =>
      stalledResponse(init?.signal),
    );

    await expect(client(fetch, 0).getCapabilities({ timeoutMs: 20 })).rejects.toMatchObject({
      name: "MailworkerTimeoutError",
      timeoutMs: 20,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the request timeout active while consuming an error body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) =>
      stalledResponse(init?.signal, 503),
    );

    await expect(client(fetch, 0).getCapabilities({ timeoutMs: 20 })).rejects.toMatchObject({
      name: "MailworkerTimeoutError",
      timeoutMs: 20,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the request timeout active while consuming a byte response", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) =>
      stalledResponse(init?.signal),
    );

    await expect(
      client(fetch, 0).getRawMessage(inbox.id, { timeoutMs: 20 }),
    ).rejects.toMatchObject({
      name: "MailworkerTimeoutError",
      timeoutMs: 20,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("detects a deadline crossed during synchronous schema validation", async () => {
    const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const slowInbox = {
      ...inbox,
      get id() {
        Atomics.wait(gate, 0, 0, 20);
        return inbox.id;
      },
    };
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        ({
          ok: true,
          headers: new Headers(),
          body: null,
          json: async () => slowInbox,
        }) as unknown as Response,
    );

    await expect(client(fetch, 0).getInbox(inbox.id, { timeoutMs: 5 })).rejects.toMatchObject({
      name: "MailworkerTimeoutError",
      timeoutMs: 5,
    });
  });

  it("keeps the caller AbortSignal active while consuming the response body", async () => {
    const controller = new AbortController();
    const stop = new Error("stop after headers");
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) =>
      stalledResponse(init?.signal),
    );

    const request = client(fetch, 0).getCapabilities({
      signal: controller.signal,
      timeoutMs: 1_000,
    });
    queueMicrotask(() => controller.abort(stop));

    await expect(request).rejects.toBe(stop);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries GET after a transient status", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ error: { code: "upstream_error", message: "busy" } }, { status: 503 }),
      )
      .mockResolvedValueOnce(Response.json(inbox));

    await expect(client(fetch).getInbox(inbox.id)).resolves.toEqual(inbox);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry a permanent quota 429 even for an idempotent send", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        { error: { code: "quota_exceeded", message: "Daily quota exhausted" } },
        { status: 429 },
      ),
    );

    await expect(
      client(fetch).send({
        from: "agent@mail.example.com",
        to: ["person@example.com"],
        subject: "Hello",
        text: "Body",
        idempotencyKey: "task-42",
      }),
    ).rejects.toMatchObject({ code: "quota_exceeded", retryable: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries an idempotent send for the explicit rate_limited code", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "rate_limited", message: "Slow down" } },
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ outcome: "queued", delivery }, { status: 202 }));

    await expect(
      client(fetch).send({
        from: "agent@mail.example.com",
        to: ["person@example.com"],
        subject: "Hello",
        text: "Body",
        idempotencyKey: "task-42",
      }),
    ).resolves.toMatchObject({ outcome: "queued" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses Retry-After as evidence that an unstructured 429 is retryable", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response("temporarily throttled", {
          status: 429,
          headers: { "Retry-After": "0" },
        }),
      )
      .mockResolvedValueOnce(Response.json(inbox));

    await expect(client(fetch).getInbox(inbox.id)).resolves.toEqual(inbox);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry a mutation without an idempotency key", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ error: { code: "upstream_error", message: "busy" } }, { status: 503 }),
    );

    await expect(
      client(fetch).send({
        from: "agent@mail.example.com",
        to: ["person@example.com"],
        subject: "Hello",
        text: "Body",
      }),
    ).rejects.toMatchObject({ retryable: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries a send with an idempotency key and forwards the header", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(Response.json({ outcome: "queued", delivery }, { status: 202 }));

    await client(fetch).send({
      from: "agent@mail.example.com",
      to: ["person@example.com"],
      subject: "Hello",
      text: "Body",
      idempotencyKey: "task-42",
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    const init = fetch.mock.calls[1]![1]!;
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe("task-42");
  });

  it("rejects duplicate idempotency keys within a batch before fetching", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const message = {
      from: "agent@mail.example.com",
      to: ["person@example.com"],
      subject: "Hello",
      text: "Body",
      idempotencyKey: "task-42",
    } as const;

    await expect(
      client(fetch).sendBatch([message, { ...message, subject: "Different intent" }]),
    ).rejects.toMatchObject({
      name: "MailworkerValidationError",
      issues: [
        {
          path: ["messages", 1, "idempotencyKey"],
        },
      ],
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("treats waitForDelivery maxWaitMs as one overall deadline", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) =>
      stalledResponse(init?.signal),
    );
    const started = Date.now();

    await expect(
      client(fetch, 0).waitForDelivery(delivery.id, {
        maxWaitMs: 30,
        pollIntervalMs: 1,
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ name: "MailworkerTimeoutError", timeoutMs: 30 });

    expect(Date.now() - started).toBeLessThan(500);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a zero waitForDelivery poll interval before fetching", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();

    await expect(
      client(fetch).waitForDelivery(delivery.id, { pollIntervalMs: 0 }),
    ).rejects.toThrow("pollIntervalMs must be positive");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("follows cursors but never exceeds maxItems", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ items: [inbox], cursor: "next" }))
      .mockResolvedValueOnce(
        Response.json({
          items: [{ ...inbox, id: "01ARZ3NDEKTSV4RRFFQ69G5FAW" }],
          cursor: null,
        }),
      );

    const items = [];
    for await (const item of client(fetch).paginateInboxes({}, { maxItems: 2 })) {
      items.push(item);
    }

    expect(items).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[1]![0])).toContain("cursor=next");
  });

  it("passes AbortSignal through to fetch", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const fetch = vi.fn<typeof globalThis.fetch>();

    await expect(client(fetch).getCapabilities({ signal: controller.signal })).rejects.toThrow(
      "stop",
    );
  });

  it("posts a human rejection reason without retrying", async () => {
    const delivery = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      inboxId: null,
      identityId: null,
      messageId: null,
      idempotencyKey: null,
      metadata: {},
      status: "rejected",
      attempts: 0,
      recipients: ["person@example.com"],
      providerMessageId: null,
      rejectReason: "Wrong recipient",
      lastError: null,
      approvedBy: null,
      approvedAt: null,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:01.000Z",
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(delivery));

    await client(fetch).rejectDelivery(delivery.id, "Wrong recipient");

    expect(fetch).toHaveBeenCalledTimes(1);
    const init = fetch.mock.calls[0]![1]!;
    expect(JSON.parse(String(init.body))).toEqual({ reason: "Wrong recipient" });
  });
});
