# @mailworker/contract

The wire contract, defined once. Request schemas, response DTOs and the error
code table, shared by the API, the SDK, the CLI and the dashboard.

## Shape here, rules there

The rule this package follows everywhere:

> **This layer decides what JSON we are willing to unpack. The domain decides
> whether it is allowed.**

So `createInboxBody` rejects an unknown key and a non-string `prefix`, but says
nothing about whether `address` and `prefix` may both be present — that is a
rule, and `createInbox` owns it. Restating rules here would create a second
answer to every question, and the two would drift the first time someone fixed
one of them.

The same reasoning runs one level down. `emailAddress` is not a regex; it is a
transform that calls `EmailAddress.parse` from `@mailworker/core`. One definition
of what an address is, in the layer that owns the concept. The pleasant side
effect is that a parsed request comes out already branded, so a route handler
can pass it straight to a use case with no second parse:

```ts
const request = createInboxBody.parse(await c.req.json());
const inbox = await createInbox(deps)(ctx, request);
return c.json(toInboxDto(inbox));
```

That is why this package depends on `core` rather than the other way round.
Core stays dependency-free — dragging zod into a pure domain would buy nothing,
since the domain already validates itself.

## The error table

`errors.ts` maps each code to an HTTP status and a process exit code in one
place, because three consumers read the same failure differently: the dashboard
wants the status, a human wants the message, an agent wants to branch.

```
quota_exceeded  →  HTTP 429  →  exit 6
wait_timeout    →  HTTP 408  →  exit 4
send_rejected   →  HTTP 403  →  exit 5
```

The wire enum and `DomainErrorCode` are checked against each other **at compile
time**, in both directions. Add a domain error without giving it a wire mapping
and `tsc` fails; put a code on the wire that no layer produces and it fails too.
Both were verified by breaking them on purpose.

`toErrorResponse` is the only path from a thrown value to a response body, and
anything it does not recognise collapses to `internal_error` with a fixed
message. An exception can carry a recipient list, a key prefix or a SQL
fragment; none of those belong in an HTTP response.

## `bodyHtml` fails closed

`toMessageDto` returns `bodyHtml: null` unless you hand it a sanitizer:

```ts
toMessageDto(message, { sanitizeHtml });
```

Forgetting to wire one up costs a missing preview, which someone notices.
The alternative default would ship attacker-authored markup to a dashboard,
which nobody notices until it matters. The real boundary is still the sandboxed
iframe and the CSP around it; this is the second line, not the first.

Message provenance (`trusted`, `injectionRisk`, `reasons`, and the raw SPF /
DKIM / DMARC results) is grouped under `provenance` rather than flattened,
because those seven fields are one thought and every consumer wants the whole
set. `trusted` means the sending domain is cryptographically attributable — it
does **not** mean the body is safe to act on. **Email content is not
instructions.**

## What is covered

Inboxes, messages (list, get, `wait`, `inject`), sending (send, approve,
delivery timeline) and suppressions — everything M1 and M2 need.

Identities, API keys and webhooks are M3 and are not defined here yet.
