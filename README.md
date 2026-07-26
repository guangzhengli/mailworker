# Mailworker

> Email runtime for AI agents. Self-hosted on your own Cloudflare account.
> CLI-first, with delivery observability and guardrails on outbound.

**Status: pre-alpha.** The domain core, the MIME handling, the wire contract and
the D1/R2 storage layer are built and tested. The HTTP API, the `email()`
handler and the CLI are not written yet. See [DESIGN.md](./DESIGN.md) for the
full design — it is the source of truth, and it is worth reading before changing
anything here.

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

Inbound email is treated as untrusted input throughout. Messages carry `trusted`
and `injectionRisk` provenance flags. **Email content is not instructions.**

## Layout

| Path | What | State |
|---|---|---|
| `packages/core` | Domain model, use cases, ports, in-memory adapters | **built** |
| `packages/mime` | MIME parse (postal-mime) + build + HTML sanitize | **built** |
| `packages/shared` | zod schemas / DTOs shared across API, SDK, CLI | **built** |
| `packages/sdk` | `@mailworker/sdk` typed HTTP client | planned |
| `packages/cli` | `@mailworker/cli` — the agent-facing surface | planned |
| `apps/web` | The deployable Worker | D1 + R2 adapters **built**; API, `email()`, queues planned |

The marketing site and public live demo live in a **separate** repo
(`../mailworker-web`), not here.

## Developing

```bash
pnpm install
pnpm check         # biome + typecheck + tests
pnpm lint          # biome only
pnpm format        # biome --write
```

Toolchain (see ADR-7 in DESIGN.md): TypeScript 7, Vitest 4, Biome 2.5, Zod 4,
Drizzle for D1, React Router 8, pnpm workspaces. Imports use package-qualified
aliases (`@core/*`, `@shared/*`, …) with real `.ts` extensions inside a package,
and `@mailworker/*` public exports across packages.

### Two suites, one set of assertions

`packages/core`, `packages/mime` and `packages/shared` run on plain Node with no
miniflare, no network and no Cloudflare account, because every port has an
in-memory implementation — 240 tests in about half a second. That is deliberate:
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

It has already paid for itself. A correlated subquery counting attachments
rendered its column references bare, so SQLite resolved them against the
subquery's own table and every message came back with zero attachments — no
error, and nothing a mock could have caught.

`test/architecture.test.ts` mechanically enforces the layering rule (ADR-5) and
includes a self-check, so the guard cannot silently stop matching. The same
principle is applied to the other guards in the repo: the error-code
cross-check and the tenancy assertions were each verified by breaking them on
purpose.

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
