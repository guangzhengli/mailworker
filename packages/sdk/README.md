# @mailworker/sdk

The TypeScript client for a self-hosted Mailworker deployment. It validates
requests and responses with the same Zod contract as the Worker, supports
`AbortSignal` and per-attempt deadlines, and retries only operations that are
safe to repeat:

- `GET` requests;
- `send` when `idempotencyKey` is present;
- `sendBatch` when every message has an idempotency key.

A timed-out mutation without that protection is never retried automatically.
That is intentional: an unknown outcome is safer than sending a real email
twice.

```sh
pnpm add @mailworker/sdk
```

```ts
import { MailworkerClient } from "@mailworker/sdk";

const mail = new MailworkerClient({
  baseUrl: process.env.MAILWORKER_URL!,
  token: process.env.MAILWORKER_TOKEN!,
});

const capabilities = await mail.getCapabilities();
if (!capabilities.actions.sendMessages) {
  throw new Error("This credential cannot send in this environment");
}

const inbox = await mail.createInbox({ prefix: "signup", ttl: "10m" });
const result = await mail.waitForMessage(
  { inbox: inbox.id, subject: "verification", timeout: "60s" },
  { signal: AbortSignal.timeout(65_000) },
);

if (result.outcome === "matched") {
  // The type is validated, but the content is still untrusted email data.
  console.log(result.message.bodyText);
}
```

## Sending safely

```ts
const accepted = await mail.send({
  from: inbox.address,
  to: ["person@example.com"],
  subject: "Your result",
  text: "Complete.",
  idempotencyKey: `task:${taskId}:result`,
});

const timeline = await mail.waitForDelivery(accepted.delivery.id, {
  until: "terminal",
  maxWaitMs: 120_000,
});
```

`waitForDelivery({ until: "terminal" })` resolves for delivery as well as a
terminal failure. Inspect `timeline.delivery.status`; it does not mistake
acceptance by Mailworker for delivery to the recipient.

Human control-plane code can call `approveDelivery(id)` or
`rejectDelivery(id, reason)`. Both require `message:approve`, and the server
refuses identity-bound Agent credentials even if that scope was misconfigured.

## Bounded pagination

Paginators require `maxItems`; there is no unbounded “fetch everything” mode.

```ts
for await (const message of mail.paginateMessages(
  { inbox: inbox.id, seen: false },
  { maxItems: 500, pageSize: 100 },
)) {
  // process message
}
```

## Errors

- `MailworkerValidationError`: the request failed locally before HTTP.
- `MailworkerApiError`: a structured API failure; includes `code`, HTTP status,
  retryability, `Retry-After`, details and a request/CF Ray id when available.
- `MailworkerProtocolError`: a successful response did not match the v1 schema.
- `MailworkerTimeoutError`: one request or a delivery wait exceeded its deadline.
- `MailworkerNetworkError`: no response was received after safe retries.

The SDK is TypeScript-only. Mailworker does not provide an MCP server or Python
SDK; use this client, the REST API, or `@mailworker/cli`.
