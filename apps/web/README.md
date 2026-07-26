# apps/web — planned (M1 API, M4 dashboard)

The single deployable Worker. One `wrangler deploy`, one URL, one origin shared
by the CLI, the SDK and the dashboard:

- `fetch`  — React Router v7 (framework mode) SSR + Hono API under `/v1`
- `email`  — inbound handler behind one catch-all Email Routing rule
- `queue`  — outbound dispatch, Email Sending event subscriptions, webhooks
- `scheduled` — retention sweep, suppression sync

`workers/infrastructure/` holds the D1, R2, Queues, Durable Object and Cloudflare
Email adapters for the ports declared in `@mailworker/core`. Nothing here defines
business rules; if a rule needs changing it belongs in `core`.

NOT the marketing site — that is a separate repo (`../mailworker-web`).
