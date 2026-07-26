# Mailworker

> Email runtime for AI agents. Self-hosted on your own Cloudflare account.
> CLI-first, with delivery observability and guardrails on outbound.

**Status: pre-alpha.** The domain core is built and tested; the Cloudflare
adapters, HTTP API and CLI are not written yet. See [DESIGN.md](./DESIGN.md) for
the full design — it is the source of truth, and it is worth reading before
changing anything here.

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
| `packages/mime` | MIME parse (postal-mime) + build + HTML sanitize | planned |
| `packages/shared` | zod schemas / DTOs shared across API, SDK, CLI | planned |
| `packages/sdk` | `@mailworker/sdk` typed HTTP client | planned |
| `packages/cli` | `@mailworker/cli` — the agent-facing surface | planned |
| `apps/web` | The deployable Worker: RRv7 SSR + API + `email()` + queues | planned |

The marketing site and public live demo live in a **separate** repo
(`../mailworker-web`), not here.

## Developing

```bash
pnpm install
pnpm test          # every package
pnpm typecheck
```

`packages/core` tests run on plain Node with no miniflare, no network and no
Cloudflare account, because every port has an in-memory implementation. That is
deliberate: a project that sells email testing has to be able to test its own
mail handling fast enough that people keep running the suite.

```bash
cd packages/core && pnpm test:watch
```

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
