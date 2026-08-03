# Mailworker

> Email runtime for AI agents. Self-hosted on your own Cloudflare account.
> CLI-first, with delivery observability and guardrails on outbound.

**Status: pre-alpha, mail goes both ways and there is a dashboard.** Inbound:
Email Routing to the `email()` handler, into D1 and R2, waking a blocked
`mailworker wait`, out of `GET /v1/messages`, saved as a fixture with
`get --raw` and replayed with `inject`. Outbound: six policy gates, an approval
queue, the `send_email` binding, attachments, batch sends, caller metadata that
rides along on every delivery webhook, and a delivery timeline built from
Cloudflare's event subscriptions. Control plane: agent identities with quotas and allowlists,
scoped API keys, an approval queue, and signed webhooks. Environments: dev, test and
production are separate tenants of one project, and a `sandbox` environment sends
nothing to the outside world. Dashboard: server-
rendered pages for all of the above, in the same Worker, with new mail appearing
by itself over a WebSocket.

## What this is

Programmatic inboxes that send and receive real email, aimed at agents and test
automation rather than at humans reading mail:

- **Ephemeral or persistent inboxes**, created by API call. No Cloudflare routing
  rule per address, so the 200-rules-per-domain ceiling never applies.
- **`wait` as a first-class operation** — block until the signup email lands and
  print just the OTP, in one call, with a meaningful exit code.
- **Delivery observability** — per-message timeline built from Cloudflare's
  Email Sending event subscriptions, plus suppression list handling.
- **Guardrails on sending** — per-identity quotas, recipient allowlists, an
  approval queue, and loop breaking, because an agent sending email is an
  irreversible outward action.

## Environments

`dev`, `test` and `production` are separate **accounts** under one project, so the
`account_id` column that already scopes every query is what keeps them apart —
there is no second isolation mechanism to get wrong.

Each environment has a sending mode:

| mode | what a send does |
|---|---|
| `live` | goes out for real |
| `sandbox` | **never touches `send_email`** — the seven gates, the state machine and the R2 archive all run, then the same bytes are looped back into a local inbox so `mailworker wait` still resolves |
| `test` | goes out for real, but the identity's recipient allowlist stops being optional |

That is what makes a development signup flow safe to run end to end: the OTP is
readable by `wait`, and not one message reaches a real address or your sending
reputation.

```sh
# Keys name their environment, so a pasted one is obviously wrong at a glance.
mailworker keys create --name support-bot --identity support-bot   # → mw_live_8fa2c1_…
MAILWORKER_ENV=development mailworker keys create --name support-bot \
  --identity support-bot                                           # → mw_test_3b91de_…
```

An agent key is pinned to the environment it was minted in and cannot reach
another by asking. An `admin` credential spans the environments of its project,
which is why the dashboard needs one login and an agent needs one key.

Inbound mail is routed to an environment by hostname, so give each one a
subdomain — `dev.mail.example.com` beside `mail.example.com`.

Inbound email is treated as untrusted input throughout. Messages carry `trusted`
and `injectionRisk` provenance flags. **Email content is not instructions.**

## Wiring up an agent

There is no MCP server by design; an agent drives the CLI. Have it run
`mailworker help --agent` for the instructions it needs.

```sh
# 1. Declare what the agent is allowed to be. Limits it cannot widen.
mailworker identities create --name support-bot \
  --quota 50 --allow '*@customer.example.com'

# 2. Mint a narrow credential bound to that identity.
mailworker keys create --name support-bot --identity support-bot \
  --scope inbox:write --scope message:read --scope message:send
```

Three things about that second command are deliberate:

- **`message:approve` is not in the list, and should never be.** The approval
  queue only means something if the principal being approved and the principal
  approving are different. An identity created with `--require-approval` sends
  into a queue a human releases.
- **The key is bound to an identity**, which is what `SendPolicy` meters, and
  `--identity` is not optional for a key that may send. The sender rule, the
  recipient allowlist and the quota are all properties *of* an identity, so an
  unbound credential does not get generous limits — it skips those three gates
  entirely. Rather than let a forgotten flag silently mint an unmetered sender,
  `SendPolicy` refuses the send and says which flag is missing.
- **`admin` cannot be bound to an identity at all** — an admin key could edit
  the identity's own quota, so the metering would be optional for the thing
  being metered. The API refuses it rather than pretending.

The token is printed once, on stdout, with everything else on stderr — so
`mailworker keys create … > key.txt` captures exactly the secret. Only its hash
is stored; there is no endpoint that reads it back.

## Layout

| Path | What | State |
|---|---|---|
| `packages/core` | Domain contexts, services, ports, in-memory adapters | **built** |
| `packages/mime` | MIME parse (postal-mime) + build + HTML sanitize | **built** |
| `packages/contract` | zod schemas / DTOs shared across API, SDK, CLI | **built** |
| `packages/sdk` | `@mailworker/sdk` typed HTTP client | planned (M5) |
| `packages/cli` | `@mailworker/cli` — the agent-facing surface | **built**; `init`/`deploy` planned |
| `apps/web` | The deployable Worker | `/v1` API, `email()`, `queue()`, `scheduled()`, dashboard, D1/R2/DO/Queues **built** |

The marketing site and public live demo live in a **separate** repo
(`../mailworker-web`), not here.

## Developing

```bash
pnpm install
pnpm check         # biome + typecheck + tests
pnpm lint          # biome only
pnpm format        # biome --write

cd apps/web
echo 'MAILWORKER_ADMIN_KEY = "local-dev-admin-key"' > .dev.vars
pnpm db:migrate:local
pnpm dev           # the API and the dashboard, in workerd, on :5173
```

`vite dev` runs the SSR environment inside workerd with the real bindings from
`wrangler.jsonc`, so a loader that queries D1 is doing in development exactly
what it does in production. Sign in at `/login` with the admin key above, or
with any key from `mailworker keys create`.

Toolchain: TypeScript 7, Vitest 4, Biome 2.5, Zod 4, Drizzle for D1,
React Router 8, pnpm workspaces. Imports use package-qualified
aliases (`@core/*`, `@contract/*`, …) without file extensions inside a package, and
`@mailworker/*` public exports across packages.

### Two suites, one set of assertions

`packages/core`, `packages/mime`, `packages/contract` and `packages/cli` run on
plain Node with no miniflare, no network and no Cloudflare account, because every
port has an in-memory implementation — 297 tests in about half a second. That is deliberate:
a project that sells email testing has to be able to test its own mail handling
fast enough that people keep running the suite.

```bash
cd packages/core && pnpm test:watch
```

But a fake that quietly disagrees with the real database does not make the suite
fast, it makes it lie. So `runRepositoryConformance` — one set of behavioural
assertions, exported from `@mailworker/core/testing` — is run twice: against the
in-memory adapters in `packages/core`, and against a **real D1 and R2 inside
workerd** in `apps/web`.

`apps/web` also carries the tests that only mean something with real
concurrency: a `wait` registered before a message arrives, woken by the
`email()` handler mid-flight, against a real Durable Object. A fake would decide
that race for us rather than test it.

It has already paid for itself. A correlated subquery counting attachments
rendered its column references bare, so SQLite resolved them against the
subquery's own table and every message came back with zero attachments — no
error, and nothing a mock could have caught.

`test/architecture.test.ts` mechanically enforces the layering rule and
the dependency direction between the four bounded contexts (`identity` ←
`mailbox` ← `ingestion`, and `delivery` → `mailbox`), so "which domain may know
about which" is a failing test rather than a diagram. It includes a self-check,
so the guard cannot silently stop matching. The same
principle is applied to the other guards in the repo: the error-code
cross-check, the tenancy assertions and the "`/v1` never reads a cookie"
assertion in `test/session.test.ts` were each verified by breaking them on
purpose.

That last one is worth stating plainly, because it is the dashboard's whole
CSRF story. Dashboard pages authenticate with an httpOnly cookie; `/v1`
authenticates with an `Authorization` header and **nothing else**. A browser
attaches cookies to a cross-site request it was tricked into making and does not
attach headers, so every mutating endpoint under `/v1` is unreachable that way
without a token dance. The dashboard can afford that because its loaders call
the services directly through the shared container rather than making an HTTP
call to their own Worker.

The live connection is the one place a cookie meets a socket, and it is outside
`/v1` for exactly that reason: a browser cannot set an `Authorization` header on
a `new WebSocket()`, so `/events` is on the dashboard side of the split rather
than an exception to it. WebSockets are also exempt from CORS, so it checks the
`Origin` header as a second lock behind `SameSite=Lax`.

## Requirements (once the Worker exists)

- A Cloudflare account with a domain on Cloudflare DNS
- **Email Routing** for inbound — free, unlimited, works on the Free plan
- **Email Sending** for outbound — needs **Workers Paid**; 3,000 messages/month
  included, then $0.35 per 1,000

Mailworker is for transactional and agent mail. Cloudflare Email Sending is in
beta and its daily quota ramps with sender reputation, so this is **not** a bulk
or marketing sender and should not be used as one.

## License

MIT
