# Phase 3 — Plan and approval gate

The plan is the last cheap moment. Everything after it either costs money,
changes DNS, or is annoying to undo. Make it complete enough that approving it
is an informed decision, and short enough that it gets read.

## Rules

- One row per operation, in execution order, with the exact command.
- Mark reversibility honestly: `easy` / `manual cleanup` / `affects external
  mail flow`.
- Show the two file edits as a real diff, not a description.
- Name the costs. Do not bury them.
- List the manual/fallback steps separately so the user knows where they may be
  interrupted.
- End with an explicit approval question. Do not proceed on silence, and do not
  treat vague approval as consent for the DNS steps unless they say so.

## Section 1 — Operations table

Sixteen rows, matching [04-execute.md](04-execute.md) exactly. Columns: number,
operation, command, reversibility.

| # | Operation | Reversibility |
|---|---|---|
| 1 | Create D1 `mailworker` | manual delete |
| 2 | Write the real `database_id` into `wrangler.jsonc` | easy |
| 3 | Create R2 `mailworker-blobs` | manual delete |
| 4 | Switch the DO to `new_sqlite_classes` | easy while undeployed |
| 5 | Create six queues | manual delete |
| 6 | Build the client bundle | easy |
| 7 | `wrangler deploy` | `wrangler rollback` |
| 8 | Apply D1 migrations `--remote` | irreversible (creates tables) |
| 9 | Set `MAILWORKER_ADMIN_KEY` | easy |
| 10 | **Enable Email Routing on the zone** | **replaces + locks the apex MX** |
| 11 | Add `mail` as a routing subdomain | manual delete |
| 12 | Point the catch-all at the Worker | easy |
| 13 | Onboard `mail.<zone>` to Email Sending | manual remove |
| 14 | Subscribe `mailworker-events` to delivery events | manual delete |
| 15 | Insert the `domains` row | easy (`DELETE`) |
| 16 | End-to-end verification | read-only |

## Section 2 — File edits

Show the diff. Both hunks are in `apps/web/wrangler.jsonc`:

```diff
- "database_id": "PLACEHOLDER_RUN_MAILWORKER_DEPLOY",
+ "database_id": "<uuid from step 1>",

- "new_classes": ["MessageWaiter"]
+ "new_sqlite_classes": ["MessageWaiter"]
```

State why the second one is not optional: new accounts can no longer create
key-value-backed Durable Object namespaces, so `deploy` fails without it.
`MessageWaiter` never touches `ctx.storage`, so the SQLite backend is a
zero-behaviour-change swap.

## Section 3 — What happens to DNS

A table of record → current value (as measured in Phase 1) → value after →
which step adds it. Cover all eight:

| Record | Added by |
|---|---|
| `<zone>` MX | step 10 |
| `<zone>` TXT SPF | step 10 |
| `cf2024-1._domainkey.<zone>` | step 10 |
| `mail.<zone>` MX | step 11 |
| `cf-bounce.mail.<zone>` MX | step 13 |
| `cf-bounce.mail.<zone>` TXT SPF | step 13 |
| `cf-bounce._domainkey.mail.<zone>` | step 13 |
| `_dmarc.mail.<zone>` | step 13 |

Then the apex warning: step 10 takes over the apex MX and locks it. Per the
recorded decision the apex stays on Cloudflare for now; when the user wants a
hosted mailbox provider there, they run `WR email routing dns unlock <zone>`,
swap the MX in the dashboard, and `mail.<zone>` is unaffected.

## Section 4 — Costs

- Workers Paid $5/month — the hard gate, required by Queues. Receiving itself is
  free.
- Email Sending: 3,000 messages/month included, then $0.35 per 1,000.
- D1 / R2 / Durable Objects land inside the free allowances at this usage.
- A new sending domain's daily quota ramps with reputation; there is no fixed
  number to quote.

## Section 5 — Automation status of steps 11 and 14

Neither has a CLI command; both run over REST with the `.env` token. Report what
the Phase 1 probes actually found, so the user knows before approving whether any
clicking is left:

- Both probes `200` → fully automated, no interaction.
- `email/routing/subdomains` returned `404` → step 11 has no API at all. Say so,
  and that it is the one manual click in the run. This is a Cloudflare gap, not a
  token problem — do not imply the user misconfigured something.
- Any `403` → this should have stopped Phase 1. If it somehow reaches the plan,
  the plan is not approvable; go back to credentials.md §4.

## Section 6 — Explicitly not doing

- Not committing anything.
- Not unlocking the apex MX.
- Not touching `DESIGN.md`.
- Not enabling `catchall_mode=autocreate` — it stays `reject`.

## The gate

Ask for approval, and offer a partial run as a real option ("stop after step 9
and leave the DNS for later"). Wait for an answer.

## After approval

Write `.mailworker/deploy-state.json` before the first mutating command:

```json
{
  "startedAt": "<iso>",
  "accountId": "<id>",
  "zoneId": "<id>",
  "zone": "<zone>",
  "mailDomain": "mail.<zone>",
  "steps": {}
}
```

`.mailworker/` is gitignored. Each step appends
`"<n>": {"status": "done|failed|skipped|manual", "at": "<iso>", "note": "..."}`.
Never put the admin key or the API token in this file.
