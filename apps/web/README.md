# apps/web

The single deployable Worker. One `wrangler deploy`, one URL, one origin shared
by the CLI, the SDK and the dashboard:

- `fetch` — React Router SSR + Hono API under `/v1` — **not written yet**
- `email` — inbound handler behind one catch-all Email Routing rule — **not written yet**
- `queue` — delivery dispatch, Email Sending event subscriptions, webhooks — **not written yet**
- `scheduled` — retention sweep, suppression sync — **not written yet**

**Built so far:** the D1 and R2 adapters for the storage ports declared in
`@mailworker/core`, the schema they read, and the migrations that create it.
Nothing here defines business rules; if a rule needs changing it belongs in
`core`.

NOT the marketing site — that is a separate repo (`../mailworker-web`).

## The schema

`workers/adapters/schema.ts` is the source of truth. `drizzle-kit generate`
turns it into `migrations/`, and `wrangler d1 migrations apply` runs them — the
same command locally and remotely, which is also what `mailworker deploy` will
call.

`0001_messages_fts.sql` is the one hand-written migration, because drizzle-kit
cannot model a virtual table or a trigger. Its journal entry was added by hand so
a later `generate` numbers from 0002 instead of overwriting it.

```bash
pnpm db:generate        # schema.ts -> migrations/
pnpm db:migrate:local
pnpm cf-typegen         # wrangler.jsonc -> worker-configuration.d.ts
```

Three conventions run through every table:

- **`account_id` on everything, first in every composite index.** One row in
  `accounts` today; the discipline is what makes multi-tenancy a configuration
  change later rather than an audit of every query.
- **ULID primary keys.** Lexicographic order is arrival order, so `id` is also
  the pagination cursor and is never reused. No `OFFSET` anywhere.
- **Timestamps are ISO 8601 UTC text.** Fixed-width UTC ISO sorts
  lexicographically in chronological order, so range queries work as-is — and
  `wrangler d1 execute` output is readable, which matters for a product people
  reach for when debugging mail.

## Tests run against a real D1

`packages/core` proves the business rules in about 250ms against in-memory
adapters. That is only worth something if those adapters behave like the real
thing — a fake that quietly disagrees with D1 does not make the suite fast, it
makes it lie.

So the same suite runs twice. `runRepositoryConformance` lives in
`@mailworker/core/testing`; `packages/core` runs it against the in-memory
adapters, and `apps/web/test/conformance.test.ts` runs the identical assertions
against a real D1 and R2 inside workerd, via `@cloudflare/vitest-pool-workers`.

That pairing has already earned itself. The correlated subquery counting
attachments rendered its column references **bare** — `WHERE "message_id" = "id"`
— because the outer query had no join, so SQLite resolved both names against the
subquery's own table. Every message reported zero attachments. No error, no
warning, and nothing a mock would ever have noticed.

The migrations are applied from the actual migration files rather than a schema
fixture, so the suite also proves the migrations themselves work — including that
wrangler splits `CREATE TRIGGER … BEGIN … END;` correctly.

`test/fts.test.ts` covers what conformance cannot: the in-memory store has no
index to fall out of sync, so the FTS5 triggers are tested only here, using
FTS5's own `integrity-check` — which walks every posting against the content
table and is stronger than any search assertion.

```bash
pnpm test           # workerd + real D1/R2, ~1s
pnpm typecheck      # regenerates Env types, then checks worker and node configs
```

Two tsconfigs on purpose: `tsconfig.json` for code that runs in workerd,
`tsconfig.node.json` for the build tooling that runs in Node. The two runtimes
disagree about globals — the same `setTimeout` returns a `NodeJS.Timeout` in one
and a number in the other — and a single `types` list would have to lie to one of
them.

## Layout

`workers/adapters/` is flat, with a `d1-` / `r2-` prefix instead of a
folder per technology. The prefix already answers "which service is this", so a
directory answering it again would only add a level to every path.
