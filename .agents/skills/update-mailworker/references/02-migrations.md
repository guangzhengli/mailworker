# Phase 2 — Classify the change, and get the order right

Read the diff, put the change in a class, and derive the step list from the class.
Most changes are the first row and need nothing extra.

## The classification table

| What changed | Beyond build + deploy | Approval |
|---|---|---|
| `packages/core` logic, `workers/http/*`, `workers/queue.ts`, `workers/email.ts` | nothing | no |
| Dashboard routes/components/styles under `apps/web/app` | nothing — the build in phase 3 replaces the asset bundle | no |
| `workers/waiter.ts` internals (DO **code**) | nothing. A DO class's implementation is just Worker code | no |
| `workers/adapters/schema.ts` | drizzle generate → review the SQL → apply, ordered per §Ordering | **yes** |
| A new `.sql` in `apps/web/migrations` | apply it, ordered per §Ordering | **yes** |
| DO class **renamed**, added, or deleted | a new migration entry in `wrangler.jsonc` — §Durable Object migrations | **yes** |
| Dispatch/webhook queue **payload shape** | a two-version rollout — §In-flight queue messages | **yes** |
| A new binding (D1, R2, KV, queue, DO) | create the resource before deploying — [03-deploy.md](03-deploy.md) §New bindings | **yes** |
| `triggers.crons` | nothing; `deploy` replaces the trigger set | **yes** (a wrong cron is silent) |
| A new secret referenced by the code | `secret put` from a file, before the deploy | **yes** |
| `compatibility_date` / `compatibility_flags` | nothing mechanical, but runtime behaviour can change under the code | **yes** |
| Anything under `packages/cli` or `packages/sdk` only | **nothing at all** — these do not ship to the Worker. Say so and skip the deploy | no |
| Email Routing, Email Sending, DNS, the `domains` row | not this skill — `deploy-mailworker`'s [dns-and-email.md](../../deploy-mailworker/references/dns-and-email.md) | — |

A diff can be in several classes at once. Take the union of the extra steps and
order them per below.

## Generating a schema migration

drizzle-kit generates, wrangler applies — `drizzle.config.ts` says as much, and it
never talks to D1 directly.

```bash
pnpm --filter @mailworker/web db:generate     # drizzle-kit generate → apps/web/migrations/NNNN_*.sql
```

**Read the generated SQL before applying it.** drizzle's SQLite output is where
the surprises are:

- SQLite cannot `ALTER COLUMN`, so a type or constraint change becomes
  create-new-table → copy → drop-old → rename. That is a full table rewrite, and on
  the `messages` table it is the largest thing in the database.
- A dropped column is generated as a table rebuild too, and the data in it is gone.
- `0001_messages_fts.sql` set up FTS5 tables and triggers by hand. drizzle does not
  know about them, so a change to `messages` can leave the FTS triggers pointing at
  a table that no longer exists. Check the generated SQL against
  `0001_messages_fts.sql` whenever `messages` is touched, and add the trigger
  fix-ups to the migration by hand.

Quote the generated SQL in the plan. Never apply a migration the user has not seen.

## Ordering — this is the part that breaks production

The rule is expand/contract, and the direction depends on the change:

| Change | Order | Why |
|---|---|---|
| **Additive** — new table, new nullable column, new index | migrate **then** deploy | The old code ignores what it does not know about, so the window between the two steps is safe. Deploying first would mean new code querying a column that does not exist yet |
| **Destructive** — drop a column or table, tighten a constraint, rename | deploy **then** migrate | The new code must already have stopped using it. Migrating first means the still-running old code queries something gone — errors for the length of the deploy |
| **Rename** | three steps, across two deploys | Add the new column and migrate; deploy code that writes both and reads the new; then a second migration drops the old. Do not attempt it in one pass |

If the change is both additive and destructive, split the `.sql` into two files and
run the additive half first, the destructive half after the deploy. Say so in the
plan.

## Applying

```bash
WR d1 migrations list mailworker --remote      # confirm exactly what is unapplied
WR d1 migrations apply mailworker --remote
```

What wrangler guarantees, from its own help text: in a non-interactive shell the
confirmation prompt is skipped but **a backup is still captured**, and a migration
that errors is rolled back with the previous one left applied.

What it does not guarantee: a migration that *succeeds* while being semantically
wrong. `DROP COLUMN` completes fine and the data is gone. So for anything
destructive, take an explicit export first — it costs one command and is the only
copy you control:

```bash
WR d1 export mailworker --remote --output "$SCRATCH/mailworker-$(date +%Y%m%d-%H%M).sql"
```

Cloudflare's own safety net is Time Travel, a 30-day point-in-time restore
(`WR d1 time-travel info mailworker`, `… restore mailworker --timestamp …`). It is
real and it works, but a restore rewinds the **whole database** — every message
received since that timestamp goes with it. Mention it as the last resort, not the
plan.

## Durable Object migrations

`wrangler.jsonc` currently has exactly one entry:

```jsonc
{ "tag": "v1", "new_sqlite_classes": ["MessageWaiter"] }
```

That tag is applied on Cloudflare's side. Never edit or remove it — the history is
append-only and rewriting it fails the deploy.

| Change to a DO | What is needed |
|---|---|
| Edit `waiter.ts` internals | nothing. This is by far the common case |
| Rename `MessageWaiter` | append `{"tag": "v2", "renamed_classes": [{"from": "MessageWaiter", "to": "NewName"}]}` |
| Add a second DO class | append `{"tag": "v2", "new_sqlite_classes": ["OtherClass"]}` |
| Delete a DO class | append `{"tag": "v2", "deleted_classes": ["MessageWaiter"]}` — **destroys that namespace's storage** |

Without the new entry the deploy fails with the class not being in any migration.
Note that `deploy-mailworker`'s step 4 says "do not add a second migration entry" —
that instruction is scoped to the first deploy, where no history existed yet. Here
it is inverted.

`wrangler rollback` **cannot undo a DO migration.** A renamed or deleted class
stays renamed or deleted after the code goes back. That alone makes any DO
migration worth its own approval.

## In-flight queue messages

At the moment of a deploy, `mailworker-dispatch` and `mailworker-webhooks` may
still hold messages that the **old** code enqueued, and the **new** consumer will
read them. `max_retries` is 3 for dispatch and 8 for webhooks, so a payload the new
code cannot parse retries and then lands in the DLQ — for dispatch, that is mail
that never went out.

So a payload change is a two-deploy rollout:

1. Deploy a consumer that accepts **both** the old and the new shape, while the
   producer still writes the old one.
2. Once the queue has drained, deploy the producer change, and drop the old-shape
   handling in a later pass.

Check the depth before deciding it is moot:

```bash
WR queues info mailworker-dispatch
WR queues info mailworker-webhooks
```

An empty queue makes this a non-issue — say so and move on. `mailworker-events` is
consumer-only and its shape is Cloudflare's, not yours; the same care applies if
`workers/queue.ts` changes how it reads those six event types.

## Output of this phase

A short plan, in this shape:

1. **Class** — one line naming the classes the diff falls into.
2. **Steps** — the ordered list phase 3 will run, migrations placed per §Ordering.
3. **Risk** — one line per non-code-only item. Name what breaks, not that risk
   exists.
4. **Rollback** — the version id from phase 1 check 9, and anything in this change
   that a rollback would not undo.

Then: proceed if code-only, otherwise ask.
