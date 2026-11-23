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
  muted: false,
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

  it("parses an inbox from a Worker that predates muting", async () => {
    const { muted: _muted, ...older } = inbox;
    const fetch = vi.fn(async () => Response.json(older));
    expect(await client(fetch).getInbox(inbox.id)).toEqual(inbox);
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

describe("mail client state", () => {
  const message = {
    id: inbox.id,
    inboxId: inbox.id,
    identityId: null,
    messageId: "request@example.com",
    threadId: "request@example.com",
    direction: "inbound",
    origin: "email",
    contentTrust: "untrusted",
    fromHeader: "sender@example.com",
    from: "sender@example.com",
    toHeader: inbox.address,
    to: [inbox.address],
    cc: [],
    bcc: [],
    replyTo: null,
    subject: "Support",
    inReplyTo: null,
    references: [],
    provenance: {
      trusted: false,
      reasons: [],
      spf: "unknown",
      dkim: "unknown",
      dmarc: "unknown",
    },
    tag: null,
    autoSubmitted: null,
    size: 0,
    seen: false,
    starred: true,
    archivedAt: null,
    labels: ["Bug"],
    sentAt: null,
    receivedAt: inbox.createdAt,
    noteCount: 1,
    attachmentCount: 0,
    hasText: true,
    hasHtml: false,
    preview: "Help",
  };

  it("creates and patches inboxes and forwards false and true list filters", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
      Response.json(
        init?.method === "GET" ? { items: [message], cursor: null } : { ...inbox, muted: true },
      ),
    );
    const sdk = client(fetch);
    await expect(sdk.createInbox({ muted: true })).resolves.toMatchObject({ muted: true });
    expect(fetch).toHaveBeenLastCalledWith(
      new URL("https://mailworker.test/v1/inboxes"),
      expect.objectContaining({ method: "POST", body: '{"muted":true}' }),
    );
    await expect(
      sdk.updateInbox(inbox.id, { muted: true, displayName: null }),
    ).resolves.toMatchObject({ muted: true });
    expect(fetch).toHaveBeenLastCalledWith(
      new URL(`https://mailworker.test/v1/inboxes/${inbox.id}`),
      expect.objectContaining({ method: "PATCH", body: '{"muted":true,"displayName":null}' }),
    );
    await expect(
      sdk.listMessages({ muted: false, starred: true, archived: false, label: "Bug report" }),
    ).resolves.toMatchObject({ items: [message] });
    const [url] = fetch.mock.lastCall!;
    expect(Object.fromEntries(new URL(String(url)).searchParams)).toEqual({
      muted: "false",
      starred: "true",
      archived: "false",
      label: "Bug report",
    });
  });

  it("uses PATCH with typed summaries or a batch count and validates input", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      Response.json(String(url).endsWith("/v1/messages") ? { updated: 1 } : message),
    );
    const sdk = client(fetch);
    await expect(
      sdk.updateMessage(message.id, { starred: true, labels: { add: ["Bug"] } }),
    ).resolves.toEqual(message);
    expect(fetch).toHaveBeenLastCalledWith(
      new URL(`https://mailworker.test/v1/messages/${message.id}`),
      expect.objectContaining({
        method: "PATCH",
        body: '{"starred":true,"labels":{"add":["Bug"]}}',
      }),
    );
    await expect(sdk.updateMessages([message.id], { archived: false })).resolves.toEqual({
      updated: 1,
    });
    expect(fetch).toHaveBeenLastCalledWith(
      new URL("https://mailworker.test/v1/messages"),
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ archived: false, ids: [message.id] }),
      }),
    );
    await expect(sdk.updateMessages([], { archived: false })).rejects.toBeInstanceOf(
      MailworkerValidationError,
    );
    await expect(sdk.updateInbox(inbox.id, {})).rejects.toBeInstanceOf(
      MailworkerValidationError,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("validates label and note responses and sends their writes to the intended routes", async () => {
    const label = { id: inbox.id, name: "Bug", createdAt: inbox.createdAt };
    const usage = { ...label, messageCount: 1, unreadCount: 0, lastUsedAt: inbox.createdAt };
    const note = {
      id: inbox.id,
      messageId: message.id,
      authorSubject: "key:agent",
      authorIdentityId: null,
      body: "Investigate",
      createdAt: inbox.createdAt,
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ items: [usage] }))
      .mockResolvedValueOnce(Response.json({ ...label, name: "Incident" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json(note, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ items: [note] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const sdk = client(fetch);
    await expect(sdk.listLabels()).resolves.toEqual([usage]);
    await expect(sdk.renameLabel(label.id, "Incident")).resolves.toEqual({
      ...label,
      name: "Incident",
    });
    await expect(sdk.deleteLabel(label.id)).resolves.toBeUndefined();
    await expect(sdk.addNote(message.id, note.body)).resolves.toEqual(note);
    await expect(sdk.listNotes(message.id)).resolves.toEqual([note]);
    await expect(sdk.deleteNote(note.id)).resolves.toBeUndefined();
    expect(
      fetch.mock.calls.map(([url, init]) => [
        new URL(String(url)).pathname,
        init?.method,
        init?.body,
      ]),
    ).toEqual([
      ["/v1/labels", "GET", undefined],
      [`/v1/labels/${label.id}`, "PATCH", '{"name":"Incident"}'],
      [`/v1/labels/${label.id}`, "DELETE", undefined],
      [`/v1/messages/${message.id}/notes`, "POST", '{"body":"Investigate"}'],
      [`/v1/messages/${message.id}/notes`, "GET", undefined],
      [`/v1/notes/${note.id}`, "DELETE", undefined],
    ]);
  });
});
