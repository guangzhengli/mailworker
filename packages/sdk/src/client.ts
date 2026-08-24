import {
  MailworkerApiError,
  MailworkerNetworkError,
  MailworkerProtocolError,
  MailworkerTimeoutError,
  MailworkerValidationError,
} from "./errors";
import { type RuntimeSchema, schemas } from "./schemas";
import type {
  AgentIdentity,
  ApiKey,
  Capabilities,
  CreatedWebhook,
  CreateEnvironmentInput,
  CreateIdentityInput,
  CreateInboxInput,
  CreateKeyInput,
  CreateWebhookInput,
  Delivery,
  DeliveryStatus,
  DeliveryTimeline,
  Diagnostics,
  Environment,
  Inbox,
  InjectMessageInput,
  InjectMessageResult,
  ListDeliveriesQuery,
  ListInboxesQuery,
  ListMessagesQuery,
  Message,
  MessageSummary,
  MintedApiKey,
  Page,
  PaginatorOptions,
  RequestOptions,
  SendBatchResult,
  SendInput,
  SendResult,
  Suppression,
  WaitForDeliveryOptions,
  WaitForMessageInput,
  WaitForMessageResult,
  Webhook,
} from "./types";

export interface RetryOptions {
  /** Retries after the first attempt. Default: 2. */
  readonly maxRetries?: number;
  /** Initial exponential-backoff delay. Default: 200 ms. */
  readonly baseDelayMs?: number;
  /** Caps both exponential backoff and Retry-After. Default: 30 seconds. */
  readonly maxDelayMs?: number;
}

export interface MailworkerClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  /** Admin-only sibling environment target. Ordinary keys remain pinned. */
  readonly environment?: string;
  /** Per HTTP attempt. Default: 30 seconds. */
  readonly timeoutMs?: number;
  readonly retry?: RetryOptions;
  /** Injectable for tests and non-browser runtimes. Defaults to global fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

type Query = Readonly<Record<string, string | number | boolean | undefined>>;
type HttpMethod = "GET" | "POST" | "DELETE";

interface InternalRequest extends RequestOptions {
  readonly query?: Query;
  readonly json?: unknown;
  readonly body?: BodyInit;
  readonly contentType?: string;
  readonly schema?: RuntimeSchema;
  readonly idempotencyKey?: string;
  /** True only when the server can deduplicate this exact mutation. */
  readonly idempotentMutation?: boolean;
  readonly expectEmpty?: boolean;
}

interface ResponseLease {
  readonly response: Response;
  readonly deadline: ReturnType<typeof linkedDeadline>;
  readonly timeoutMs: number;
  readonly callerSignal: AbortSignal | undefined;
}

const TRANSIENT_STATUS = new Set([408, 500, 502, 503, 504]);
const TRANSIENT_ERROR_CODE = new Set(["rate_limited", "upstream_error", "internal_error"]);
const DELIVERY_TERMINAL: readonly DeliveryStatus[] = [
  "delivered",
  "bounced",
  "complained",
  "failed",
  "rejected",
];

/**
 * Runtime-validated Mailworker client.
 *
 * Retries are deliberately asymmetric: reads are safe; a write is retried only
 * when its idempotency key makes a repeated submission the same operation.
 */
export class MailworkerClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #environment: string | undefined;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: MailworkerClientOptions) {
    if (options.token.length === 0) throw new TypeError("Mailworker token must not be empty.");
    const url = new URL(options.baseUrl);
    if (url.username !== "" || url.password !== "") {
      throw new TypeError("Put credentials in token, not in the Mailworker URL.");
    }
    if (
      url.protocol !== "https:" &&
      url.hostname !== "localhost" &&
      url.hostname !== "127.0.0.1"
    ) {
      throw new TypeError("Mailworker baseUrl must use HTTPS outside localhost.");
    }

    this.#baseUrl = url.href.replace(/\/+$/, "");
    this.#token = options.token;
    this.#environment = options.environment;
    this.#timeoutMs = positive(options.timeoutMs ?? 30_000, "timeoutMs");
    this.#maxRetries = nonnegative(options.retry?.maxRetries ?? 2, "retry.maxRetries");
    this.#baseDelayMs = nonnegative(options.retry?.baseDelayMs ?? 200, "retry.baseDelayMs");
    this.#maxDelayMs = positive(options.retry?.maxDelayMs ?? 30_000, "retry.maxDelayMs");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async getCapabilities(options: RequestOptions = {}): Promise<Capabilities> {
    return await this.#request("GET", "/v1/capabilities", {
      ...options,
      schema: schemas.capabilities,
    });
  }

  async createInbox(input: CreateInboxInput, options: RequestOptions = {}): Promise<Inbox> {
    validateInput(schemas.createInbox, input);
    return await this.#request("POST", "/v1/inboxes", {
      ...options,
      json: input,
      schema: schemas.inbox,
    });
  }

  async listInboxes(
    query: ListInboxesQuery = {},
    options: RequestOptions = {},
  ): Promise<Page<Inbox>> {
    return await this.#request("GET", "/v1/inboxes", {
      ...options,
      query: compactQuery(query),
      schema: schemas.inboxPage,
    });
  }

  paginateInboxes(
    query: Omit<ListInboxesQuery, "limit" | "cursor"> = {},
    options: PaginatorOptions,
  ): AsyncGenerator<Inbox, void, undefined> {
    return this.#paginate("/v1/inboxes", schemas.inboxPage, query, options);
  }

  async getInbox(id: string, options: RequestOptions = {}): Promise<Inbox> {
    return await this.#request("GET", `/v1/inboxes/${encodeURIComponent(id)}`, {
      ...options,
      schema: schemas.inbox,
    });
  }

  async deleteInbox(id: string, options: RequestOptions = {}): Promise<void> {
    await this.#request("DELETE", `/v1/inboxes/${encodeURIComponent(id)}`, {
      ...options,
      expectEmpty: true,
    });
  }

  async listMessages(
    query: ListMessagesQuery = {},
    options: RequestOptions = {},
  ): Promise<Page<MessageSummary>> {
    return await this.#request("GET", "/v1/messages", {
      ...options,
      query: compactQuery(query),
      schema: schemas.messagePage,
    });
  }

  paginateMessages(
    query: Omit<ListMessagesQuery, "limit" | "cursor"> = {},
    options: PaginatorOptions,
  ): AsyncGenerator<MessageSummary, void, undefined> {
    return this.#paginate("/v1/messages", schemas.messagePage, query, options);
  }

  async getMessage(id: string, options: RequestOptions = {}): Promise<Message> {
    return await this.#request("GET", `/v1/messages/${encodeURIComponent(id)}`, {
      ...options,
      schema: schemas.message,
    });
  }

  async getThread(id: string, options: RequestOptions = {}): Promise<readonly Message[]> {
    const result = await this.#request<{ readonly items: readonly Message[] }>(
      "GET",
      `/v1/threads/${encodeURIComponent(id)}`,
      { ...options, schema: schemas.thread },
    );
    return result.items;
  }

  async getRawMessage(id: string, options: RequestOptions = {}): Promise<Uint8Array> {
    return await this.#requestBytes(
      "GET",
      `/v1/messages/${encodeURIComponent(id)}/raw`,
      options,
    );
  }

  async getAttachment(
    messageId: string,
    attachmentId: string,
    options: RequestOptions = {},
  ): Promise<Uint8Array> {
    return await this.#requestBytes(
      "GET",
      `/v1/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      options,
    );
  }

  async markMessageSeen(id: string, seen = true, options: RequestOptions = {}): Promise<void> {
    await this.#request("POST", `/v1/messages/${encodeURIComponent(id)}/seen`, {
      ...options,
      json: { seen },
      expectEmpty: true,
    });
  }

  async waitForMessage(
    input: WaitForMessageInput = {},
    options: RequestOptions = {},
  ): Promise<WaitForMessageResult> {
    const parsed = validateInput(schemas.waitQuery, input);
    const serverWaitMs = parsed.timeoutMs ?? 30_000;
    return await this.#request("GET", "/v1/messages/wait", {
      ...options,
      // Leave room for the server to serialize its timeout answer.
      timeoutMs: options.timeoutMs ?? serverWaitMs + 5_000,
      query: compactQuery(input),
      schema: schemas.waitResponse,
    });
  }

  async injectMessage(
    input: InjectMessageInput,
    options: RequestOptions = {},
  ): Promise<InjectMessageResult> {
    const body =
      typeof input.raw === "string"
        ? input.raw
        : input.raw instanceof ArrayBuffer
          ? input.raw
          : Uint8Array.from(input.raw).buffer;
    return await this.#request("POST", "/v1/ingest/raw", {
      ...options,
      query: compactQuery({ to: input.to, from: input.from }),
      body,
      contentType: "message/rfc822",
      schema: schemas.injectedMessage,
    });
  }

  async send(input: SendInput, options: RequestOptions = {}): Promise<SendResult> {
    validateInput(schemas.send, input);
    return await this.#request("POST", "/v1/send", {
      ...options,
      json: input,
      schema: schemas.sendResponse,
      ...(input.idempotencyKey === undefined
        ? {}
        : {
            idempotencyKey: input.idempotencyKey,
            idempotentMutation: true,
          }),
    });
  }

  async sendBatch(
    messages: readonly SendInput[],
    options: RequestOptions = {},
  ): Promise<SendBatchResult> {
    const body = { messages };
    validateInput(schemas.sendBatch, body);
    assertUniqueBatchIdempotencyKeys(messages);
    const idempotent = messages.every((message) => message.idempotencyKey !== undefined);
    return await this.#request("POST", "/v1/send/batch", {
      ...options,
      json: body,
      schema: schemas.sendBatchResponse,
      ...(idempotent ? { idempotentMutation: true } : {}),
    });
  }

  async listDeliveries(
    query: ListDeliveriesQuery = {},
    options: RequestOptions = {},
  ): Promise<Page<Delivery>> {
    return await this.#request("GET", "/v1/send", {
      ...options,
      query: compactQuery(query),
      schema: schemas.deliveryPage,
    });
  }

  paginateDeliveries(
    query: Omit<ListDeliveriesQuery, "limit" | "cursor"> = {},
    options: PaginatorOptions,
  ): AsyncGenerator<Delivery, void, undefined> {
    return this.#paginate("/v1/send", schemas.deliveryPage, query, options);
  }

  async getDelivery(id: string, options: RequestOptions = {}): Promise<DeliveryTimeline> {
    return await this.#request("GET", `/v1/send/${encodeURIComponent(id)}`, {
      ...options,
      schema: schemas.deliveryTimeline,
    });
  }

  async waitForDelivery(
    id: string,
    options: WaitForDeliveryOptions = {},
  ): Promise<DeliveryTimeline> {
    const maxWaitMs = positive(options.maxWaitMs ?? 120_000, "maxWaitMs");
    const pollIntervalMs = positive(options.pollIntervalMs ?? 1_000, "pollIntervalMs");
    const requestTimeoutMs = positive(options.timeoutMs ?? this.#timeoutMs, "timeoutMs");
    const wanted = deliveryStatuses(options.until ?? "terminal");
    const started = Date.now();
    const overall = linkedDeadline(options.signal, maxWaitMs);

    try {
      for (;;) {
        const remainingBeforeRequest = maxWaitMs - (Date.now() - started);
        if (remainingBeforeRequest <= 0) throw new MailworkerTimeoutError(maxWaitMs);

        const timeline = await this.getDelivery(id, {
          signal: overall.signal,
          // A single poll must never own more than the remaining overall budget.
          timeoutMs: Math.max(1, Math.min(requestTimeoutMs, remainingBeforeRequest)),
        });
        if (wanted.has(timeline.delivery.status)) return timeline;

        const remainingBeforeSleep = maxWaitMs - (Date.now() - started);
        if (remainingBeforeSleep <= 0) throw new MailworkerTimeoutError(maxWaitMs);
        await sleep(Math.min(pollIntervalMs, remainingBeforeSleep), overall.signal);
      }
    } catch (cause) {
      if (isAborted(options.signal)) throw abortReason(options.signal!);
      if (overall.timedOut()) throw new MailworkerTimeoutError(maxWaitMs, { cause });
      throw cause;
    } finally {
      overall.dispose();
    }
  }

  async approveDelivery(id: string, options: RequestOptions = {}): Promise<Delivery> {
    return await this.#request("POST", `/v1/send/${encodeURIComponent(id)}/approve`, {
      ...options,
      json: {},
      schema: schemas.delivery,
    });
  }

  async rejectDelivery(
    id: string,
    reason?: string,
    options: RequestOptions = {},
  ): Promise<Delivery> {
    const body = reason === undefined ? {} : { reason };
    validateInput(schemas.rejectDelivery, body);
    return await this.#request("POST", `/v1/send/${encodeURIComponent(id)}/reject`, {
      ...options,
      json: body,
      schema: schemas.delivery,
    });
  }

  async getDiagnostics(options: RequestOptions = {}): Promise<Diagnostics> {
    return await this.#request("GET", "/v1/diagnostics", {
      ...options,
      schema: schemas.diagnostics,
    });
  }

  async listEnvironments(options: RequestOptions = {}): Promise<readonly Environment[]> {
    const result = await this.#request<{ readonly items: readonly Environment[] }>(
      "GET",
      "/v1/environments",
      { ...options, schema: schemas.environments },
    );
    return result.items;
  }

  async createEnvironment(
    input: CreateEnvironmentInput,
    options: RequestOptions = {},
  ): Promise<Environment> {
    validateInput(schemas.createEnvironment, input);
    return await this.#request("POST", "/v1/environments", {
      ...options,
      json: input,
      schema: schemas.environment,
    });
  }

  async listIdentities(options: RequestOptions = {}): Promise<readonly AgentIdentity[]> {
    const result = await this.#request<{ readonly items: readonly AgentIdentity[] }>(
      "GET",
      "/v1/identities",
      { ...options, schema: schemas.identities },
    );
    return result.items;
  }

  async createIdentity(
    input: CreateIdentityInput,
    options: RequestOptions = {},
  ): Promise<AgentIdentity> {
    validateInput(schemas.createIdentity, input);
    return await this.#request("POST", "/v1/identities", {
      ...options,
      json: input,
      schema: schemas.agentIdentity,
    });
  }

  async listKeys(options: RequestOptions = {}): Promise<readonly ApiKey[]> {
    const result = await this.#request<{ readonly items: readonly ApiKey[] }>(
      "GET",
      "/v1/keys",
      { ...options, schema: schemas.apiKeys },
    );
    return result.items;
  }

  async createKey(input: CreateKeyInput, options: RequestOptions = {}): Promise<MintedApiKey> {
    validateInput(schemas.createKey, input);
    return await this.#request("POST", "/v1/keys", {
      ...options,
      json: input,
      schema: schemas.mintedApiKey,
    });
  }

  async revokeKey(id: string, options: RequestOptions = {}): Promise<ApiKey> {
    return await this.#request("DELETE", `/v1/keys/${encodeURIComponent(id)}`, {
      ...options,
      schema: schemas.apiKey,
    });
  }

  async listWebhooks(options: RequestOptions = {}): Promise<readonly Webhook[]> {
    const result = await this.#request<{ readonly items: readonly Webhook[] }>(
      "GET",
      "/v1/webhooks",
      { ...options, schema: schemas.webhooks },
    );
    return result.items;
  }

  async createWebhook(
    input: CreateWebhookInput,
    options: RequestOptions = {},
  ): Promise<CreatedWebhook> {
    validateInput(schemas.createWebhook, input);
    return await this.#request("POST", "/v1/webhooks", {
      ...options,
      json: input,
      schema: schemas.createdWebhook,
    });
  }

  async deleteWebhook(id: string, options: RequestOptions = {}): Promise<void> {
    await this.#request("DELETE", `/v1/webhooks/${encodeURIComponent(id)}`, {
      ...options,
      expectEmpty: true,
    });
  }

  async listSuppressions(options: RequestOptions = {}): Promise<readonly Suppression[]> {
    const result = await this.#request<{ readonly items: readonly Suppression[] }>(
      "GET",
      "/v1/suppressions",
      { ...options, schema: schemas.suppressions },
    );
    return result.items;
  }

  async addSuppression(
    address: string,
    reason: Suppression["reason"] = "manual",
    options: RequestOptions = {},
  ): Promise<void> {
    await this.#request("POST", "/v1/suppressions", {
      ...options,
      json: { address, reason },
      expectEmpty: true,
    });
  }

  async deleteSuppression(address: string, options: RequestOptions = {}): Promise<void> {
    await this.#request("DELETE", `/v1/suppressions/${encodeURIComponent(address)}`, {
      ...options,
      expectEmpty: true,
    });
  }

  async *#paginate<T>(
    path: string,
    schema: RuntimeSchema,
    query: Query,
    options: PaginatorOptions,
  ): AsyncGenerator<T, void, undefined> {
    const maxItems = positive(options.maxItems, "maxItems");
    const pageSize = Math.min(200, positive(options.pageSize ?? 100, "pageSize"));
    let cursor: string | undefined;
    let emitted = 0;

    while (emitted < maxItems) {
      const page = await this.#request<Page<T>>("GET", path, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        query: { ...query, cursor, limit: Math.min(pageSize, maxItems - emitted) },
        schema,
      });
      for (const item of page.items) {
        yield item;
        emitted += 1;
        if (emitted >= maxItems) return;
      }
      if (page.cursor === null) return;
      if (page.cursor === cursor || page.items.length === 0) {
        throw new MailworkerProtocolError("Pagination cursor did not advance.", undefined);
      }
      cursor = page.cursor;
    }
  }

  async #request<T>(method: HttpMethod, path: string, request: InternalRequest): Promise<T> {
    const lease = await this.#fetchResponse(method, path, request);
    const { response } = lease;
    try {
      if (request.expectEmpty === true) {
        try {
          await response.body?.cancel();
        } catch (cause) {
          assertLeaseActive(lease, cause);
          throw cause;
        }
        assertLeaseActive(lease);
        return undefined as T;
      }

      let value: unknown;
      try {
        value = await response.json();
      } catch (cause) {
        assertLeaseActive(lease, cause);
        throw new MailworkerProtocolError(
          `Mailworker returned non-JSON for ${method} ${path}.`,
          requestIdOf(response),
          { cause },
        );
      }
      assertLeaseActive(lease);

      if (request.schema === undefined) return value as T;
      const parsed = request.schema.safeParse(value);
      // Keep cancellation and the deadline live through runtime validation too.
      assertLeaseActive(lease);
      if (!parsed.success) {
        throw new MailworkerProtocolError(
          `Mailworker response did not match the v1 contract for ${method} ${path}.`,
          requestIdOf(response),
          { cause: parsed.error },
        );
      }
      return parsed.data as T;
    } finally {
      lease.deadline.dispose();
    }
  }

  async #requestBytes(
    method: "GET",
    path: string,
    options: RequestOptions,
  ): Promise<Uint8Array> {
    const lease = await this.#fetchResponse(method, path, options);
    try {
      let bytes: ArrayBuffer;
      try {
        bytes = await lease.response.arrayBuffer();
      } catch (cause) {
        assertLeaseActive(lease, cause);
        throw cause;
      }
      assertLeaseActive(lease);
      return new Uint8Array(bytes);
    } finally {
      lease.deadline.dispose();
    }
  }

  async #fetchResponse(
    method: HttpMethod,
    path: string,
    request: InternalRequest | RequestOptions,
  ): Promise<ResponseLease> {
    const extended = request as InternalRequest;
    const url = new URL(`${this.#baseUrl}${path}`);
    for (const [name, value] of Object.entries(extended.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }

    const body = extended.json === undefined ? extended.body : JSON.stringify(extended.json);
    const contentType = extended.json === undefined ? extended.contentType : "application/json";
    const retryAllowed = method === "GET" || extended.idempotentMutation === true;
    const attempts = retryAllowed ? this.#maxRetries + 1 : 1;
    const timeoutMs = positive(extended.timeoutMs ?? this.#timeoutMs, "timeoutMs");

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (isAborted(extended.signal)) throw abortReason(extended.signal!);
      const deadline = linkedDeadline(extended.signal, timeoutMs);
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${this.#token}`,
            ...(this.#environment === undefined
              ? {}
              : { "X-Mailworker-Environment": this.#environment }),
            ...(contentType === undefined ? {} : { "Content-Type": contentType }),
            ...(extended.idempotencyKey === undefined
              ? {}
              : { "Idempotency-Key": extended.idempotencyKey }),
          },
          ...(body === undefined ? {} : { body }),
          signal: deadline.signal,
        });
      } catch (cause) {
        deadline.dispose();
        if (isAborted(extended.signal)) throw abortReason(extended.signal!);
        if (deadline.timedOut()) {
          if (attempt + 1 < attempts) {
            await this.#backoff(attempt, undefined, extended.signal);
            continue;
          }
          throw new MailworkerTimeoutError(timeoutMs, { cause });
        }
        if (attempt + 1 < attempts) {
          await this.#backoff(attempt, undefined, extended.signal);
          continue;
        }
        throw new MailworkerNetworkError(`Could not reach ${this.#baseUrl}.`, { cause });
      }
      if (response.ok) {
        // The caller owns this lease until it has consumed and validated the
        // response. Disposing here would make timeoutMs cover headers only.
        return { response, deadline, timeoutMs, callerSignal: extended.signal };
      }

      const retryAfterMs = retryAfter(response.headers.get("Retry-After"));
      const error = await apiError(response, retryAfterMs, retryAllowed);
      if (isAborted(extended.signal)) {
        deadline.dispose();
        throw abortReason(extended.signal!);
      }
      if (deadline.timedOut()) {
        deadline.dispose();
        if (attempt + 1 < attempts) {
          await this.#backoff(attempt, undefined, extended.signal);
          continue;
        }
        throw new MailworkerTimeoutError(timeoutMs);
      }
      deadline.dispose();

      if (error.retryable && attempt + 1 < attempts) {
        await this.#backoff(attempt, retryAfterMs, extended.signal);
        continue;
      }
      throw error;
    }

    throw new MailworkerNetworkError(`Could not reach ${this.#baseUrl}.`);
  }

  async #backoff(
    attempt: number,
    retryAfterMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const jittered = this.#baseDelayMs * 2 ** attempt * (0.5 + Math.random());
    const delay = Math.min(this.#maxDelayMs, Math.max(jittered, retryAfterMs ?? 0));
    await sleep(delay, signal);
  }
}

async function apiError(
  response: Response,
  retryAfterMs: number | undefined,
  retryAllowed: boolean,
) {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  const parsed = schemas.error.safeParse(body);
  if (parsed.success) {
    const transient = isTransientFailure(
      response.status,
      parsed.data.error.code,
      retryAfterMs,
      true,
    );
    return new MailworkerApiError(
      parsed.data.error.code,
      parsed.data.error.message,
      response.status,
      parsed.data.error.details,
      requestIdOf(response),
      retryAllowed && transient,
      retryAfterMs,
    );
  }

  const transient = isTransientFailure(response.status, undefined, retryAfterMs, false);
  return new MailworkerApiError(
    response.status === 401 ? "unauthorized" : "upstream_error",
    `HTTP ${response.status} from Mailworker.`,
    response.status,
    undefined,
    requestIdOf(response),
    retryAllowed && transient,
    retryAfterMs,
  );
}

function isTransientFailure(
  status: number,
  code: string | undefined,
  retryAfterMs: number | undefined,
  structured: boolean,
): boolean {
  // A daily/identity quota does not become available after HTTP backoff. It is
  // deliberately 429 on the wire, but unlike rate limiting it is permanent for
  // this request and must not consume the SDK's automatic retry budget.
  if (code === "quota_exceeded") return false;
  if (structured && code !== undefined && TRANSIENT_ERROR_CODE.has(code)) return true;
  if (TRANSIENT_STATUS.has(status)) return true;
  // For an unstructured gateway 429, Retry-After is the only evidence that this
  // is rate limiting rather than a durable application quota.
  return status === 429 && retryAfterMs !== undefined;
}

function assertLeaseActive(lease: ResponseLease, cause?: unknown): void {
  if (isAborted(lease.callerSignal)) throw abortReason(lease.callerSignal!);
  if (lease.deadline.timedOut()) {
    throw new MailworkerTimeoutError(
      lease.timeoutMs,
      cause === undefined ? undefined : { cause },
    );
  }
}

function validateInput<Output>(schema: RuntimeSchema<Output>, input: unknown): Output {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new MailworkerValidationError("Request does not match the Mailworker contract.", [
      ...parsed.error.issues,
    ]);
  }
  return parsed.data;
}

function assertUniqueBatchIdempotencyKeys(messages: readonly SendInput[]): void {
  const firstIndexByKey = new Map<string, number>();
  for (const [index, message] of messages.entries()) {
    const key = message.idempotencyKey;
    if (key === undefined) continue;
    const firstIndex = firstIndexByKey.get(key);
    if (firstIndex !== undefined) {
      throw new MailworkerValidationError(
        "Each sendBatch message must use a unique idempotencyKey.",
        [
          {
            code: "custom",
            path: ["messages", index, "idempotencyKey"],
            message: `Duplicates messages[${firstIndex}].idempotencyKey.`,
          },
        ],
      );
    }
    firstIndexByKey.set(key, index);
  }
}

function compactQuery(value: object): Query {
  const query: Record<string, string | number | boolean | undefined> = {};
  for (const [key, one] of Object.entries(value)) {
    if (one === undefined) continue;
    if (typeof one === "string" || typeof one === "number" || typeof one === "boolean") {
      query[key] = one;
    }
  }
  return query;
}

function deliveryStatuses(until: WaitForDeliveryOptions["until"]): ReadonlySet<DeliveryStatus> {
  if (until === undefined || until === "terminal") return new Set(DELIVERY_TERMINAL);
  return new Set(Array.isArray(until) ? until : [until as DeliveryStatus]);
}

function retryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function requestIdOf(response: Response): string | undefined {
  return response.headers.get("X-Request-Id") ?? response.headers.get("CF-Ray") ?? undefined;
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${name} must be positive.`);
  return value;
}

function nonnegative(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer.`);
  }
  return value;
}

function linkedDeadline(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timeout = false;
  const expiresAt = Date.now() + timeoutMs;
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted === true) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort(new DOMException("Request timed out.", "TimeoutError"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    // Date.now() also catches a deadline crossed inside synchronous schema
    // validation, where the timer callback cannot run until JavaScript yields.
    timedOut: () => timeout || Date.now() >= expiresAt,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortReason(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
