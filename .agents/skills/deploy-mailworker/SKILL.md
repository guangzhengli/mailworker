---
name: deploy-mailworker
description: FIRST-TIME provisioning of this Mailworker repo into a Cloudflare account — creates D1, R2, six Queues, the Durable Object namespace, the Worker, the Email Routing catch-all, Email Sending onboarding, the delivery-event subscription and the bootstrap admin secret. Four gated phases (environment → discovery → plan → execute); nothing mutates before the user approves the plan. Use for "deploy to Cloudflare for the first time", "provision the resources", "set up a new account or a new domain", or to resume a partially failed first deploy. Do NOT use to ship a code change to an already-deployed Worker — that is the `update-mailworker` skill.
---

# Deploy Mailworker to Cloudflare (first deploy)

This repo is one Worker with four entrypoints (`fetch`, `email`, `queue`,
`scheduled`) plus eleven Cloudflare resources. `mailworker deploy` and
`mailworker init` are **planned, not built** (see the README layout table), so
deployment is this skill's job, not the CLI's.

## Scope — this is the first-deploy skill

It provisions resources that do not exist yet. Shipping a code change to a
deployment that already exists is **[update-mailworker](../update-mailworker/SKILL.md)**,
and that is the skill to use for the routine case.

Running this skill against a live deployment is not merely redundant; three steps
are actively harmful, which is why each now opens with a guard that must be
checked before the step runs:

| Step | What happens on a live deployment | Guard |
|---|---|---|
| 9 · admin secret | Overwrites `MAILWORKER_ADMIN_KEY` with a fresh random value. The old one is unrecoverable, and because `session.ts:47` falls back to it as the session secret, every dashboard session is invalidated | SKIP unless the user explicitly asked to rotate |
| 14 · event subscription | The POST is not idempotent. A second subscription means every delivery event is delivered **twice** — duplicated rows in the delivery timeline, and it fails silently | `queues subscription list` first |
| 15 · `domains` row | `INSERT` collides with the unique index on `(account_id, name)` and aborts the phase mid-run | `SELECT` first |

Steps 1, 3 and 5 (`d1 create`, `r2 bucket create`, `queues create`) simply error
with "already exists" — treat that as SKIP, not failure
([resources.md](references/resources.md)).

So: use this skill for a **new** account, a **new** zone, or a genuinely
half-finished first deploy (`--resume`). Otherwise use `update-mailworker`.

**Prefer retrieval over pre-training** for any Cloudflare command, flag or API
shape. Every command in [references/](references/) was verified against
wrangler 4.114 in this repo on 2026-07-29 — but verify again rather than
inventing flags. The sibling skills `wrangler`, `cloudflare-email-service`,
`durable-objects` and `workers-best-practices` are the upstream sources; load
them when you need detail this skill does not carry.

## Non-negotiables

1. **Four phases, in order. Phase 4 requires explicit user approval.** Phases
   1–3 are strictly read-only — no `create`, no `deploy`, no `put`, no file
   edits. If the user says "just deploy it", still produce the Phase 3 plan and
   ask; the operations here are outward-facing and several are hard to reverse.
2. **Never commit.** The user has decided: edit files, show the diff, leave the
   working tree for them. No `git commit`, no `git add`.
3. **Never let a secret reach a command line.** Not the admin key, not an API
   token, not a DKIM private value. A shell error echoes the **expanded** command
   line, which is how a token leaked into a transcript in this repo already. So:
   secrets move through files — `wrangler secret put … < file`, and
   `curl -K <config>` for REST. Never `cat .env`, never assign a token to a shell
   variable, never read wrangler's stored OAuth token. Full procedure in
   [references/credentials.md](references/credentials.md).
4. **`DESIGN.md` is local-only and gitignored.** Read it freely, never stage,
   commit or push it.
5. **Every mutating step is followed by its verification command.** A step that
   cannot be verified is reported as unverified, not as done.
6. **Report faithfully.** A skipped step, a fallback taken, a step that failed —
   say so plainly with the actual output. Never claim a resource exists because
   the command "probably" worked.

## The four phases

| Phase | What | Read this | Gate |
|---|---|---|---|
| **1 · Environment** | Toolchain, auth, plan tier, zone, DNS baseline, test suite | [references/01-environment.md](references/01-environment.md) | Any BLOCKER → stop, tell the user exactly what to run |
| **2 · Discovery** | Read config, inventory what already exists, collect the missing inputs | [references/02-discovery.md](references/02-discovery.md) | Missing required input → ask the user |
| **3 · Plan** | Table of create / modify / skip, cost, irreversibility, rollback | [references/03-plan.md](references/03-plan.md) | **Explicit approval required** |
| **4 · Execute** | 16 ordered steps, each verified, resumable from a state file | [references/04-execute.md](references/04-execute.md) | Report at the end |

Supporting references, read as needed:

- **[references/credentials.md](references/credentials.md)** — how the API token
  is detected in `.env`, loaded without ever touching a command line,
  preflight-probed for permissions, and what to tell the user if it is missing.
  **Read before Phase 1's token check and before any REST call.**
- **[references/resources.md](references/resources.md)** — the eleven resources,
  what each is for, idempotency, and the teardown order.
- **[references/dns-and-email.md](references/dns-and-email.md)** — why the
  catch-all goes on the zone but sending goes on the subdomain, the apex MX
  hazard, and which DNS record each service owns. **Read before any
  `wrangler email` command.**
- **[references/rest-api.md](references/rest-api.md)** — the two operations with
  no CLI coverage (Email Routing subdomain, delivery-event subscription), their
  endpoints, and the dashboard fallback.
- **[references/troubleshooting.md](references/troubleshooting.md)** — the known
  failure modes, including three that are pre-existing repo blockers.

## Placeholders

Every `<NAME>` in these files is a value **you must discover or ask for**. None
of them is known in advance, and none has a default you may invent. Substitute
the real value everywhere before running a command — never paste a literal
`<ZONE>` into a shell.

| Placeholder | What it is |
|---|---|
| `<ACCOUNT_ID>` | Cloudflare account id, 32 hex chars |
| `<ZONE>` | The apex domain on Cloudflare, e.g. `example.com`. Email Routing is zone-level, so the catch-all lives here |
| `<ZONE_ID>` | Zone id for `<ZONE>`, 32 hex chars |
| `<MAIL_HOST>` | Hostname mail is received at and sent from. Convention is `mail.<ZONE>` |
| `<D1_DATABASE_ID>` | uuid of the D1 database, produced by step 1 |
| `<WORKER_URL>` | Deployed Worker origin, printed by `wrangler deploy` |

## Facts to establish before Phase 3

Run these in Phase 1 and 2 and record the answers in the plan. A value that
comes back empty is a question for the user, not a blank to fill in yourself.

| Fact | How to get it | If it is missing |
|---|---|---|
| `<ACCOUNT_ID>` | `npx wrangler whoami` → "Account ID" | Not logged in → BLOCKER, tell the user to run `npx wrangler login` |
| `<ZONE>` | Ask the user which domain should receive mail, then confirm it is on Cloudflare | Cannot be guessed — always ask |
| `<ZONE_ID>` | `GET /zones?name=<ZONE>` → `.result[0].id`, or `wrangler whoami`'s zone table | Zone not on Cloudflare → BLOCKER; the domain must be moved to Cloudflare first |
| `<MAIL_HOST>` | Ask. Offer `mail.<ZONE>` as the default and say why: it keeps the apex free for the user's existing mail provider | Default to `mail.<ZONE>` only after the user agrees |
| Workers Paid? | `wrangler queues list` exits 0 | Free plan → Queues and Email Sending are unavailable. Receiving still works; say so and stop before step 5 |
| Zone's current Email Routing state | `wrangler email routing settings <ZONE>` | Errors when routing is not enabled — that *is* the answer, record `unconfigured` |
| Zone's current MX | `dig +short MX <ZONE>` | Empty is fine and means step 10 breaks nothing. **Non-empty is a hazard** — see below |

The one question with a wrong answer: **if `dig +short MX <ZONE>` already
returns a real provider** (Google, Zoho, Fastmail, Lark…), enabling Email
Routing on the apex replaces those records and locks them, which silently breaks
the user's existing mail. Stop and confirm before step 10, every time.

## Decisions the user must make

These have no default. Ask in Phase 2, record the answer in the Phase 3 plan.

| Decision | Options | Note |
|---|---|---|
| `<MAIL_HOST>` | subdomain (`mail.<ZONE>`) vs apex | Subdomain is strongly preferred: the apex stays free for their existing mail |
| apex MX after routing is enabled | leave on Cloudflare, or unlock and restore | If they had MX records before, this is the step that overwrote them. `wrangler email routing dns unlock <ZONE>` restores their control; `<MAIL_HOST>` is unaffected either way |
| The two CLI-less steps | REST with an API token, or the dashboard by hand | Token path needs `CLOUDFLARE_API_TOKEN` in `.env` — see [credentials.md](references/credentials.md) for the exact permissions. Missing token is a Phase 1 BLOCKER only if they chose the automated path |

Two decisions are **not** the user's, and hold regardless:

| Fixed | Why |
|---|---|
| Repo file edits are allowed, commits are not | Two edits are hard prerequisites (Phase 4 steps 1 and 4). Show the diff, leave the working tree |
| `wrangler login` is enough for every wrangler command | Its OAuth token carries `workers`, `d1`, `queues`, `email_routing`, `email_sending` (write) and `zone` (read). A separate API token is needed only for the two REST-only steps |

## Invocation

Load this skill and run all four phases from the top. It also accepts:

- `--phase N` — run only that phase (useful after fixing a Phase 1 blocker).
- `--resume` — read `.mailworker/deploy-state.json` and continue Phase 4 from
  the first incomplete step. Re-verify the last completed step before moving on.
  This is the right flag for anything short of a genuinely empty account.
- `--dry-run` — Phases 1–3 only. Never touches Phase 4 even with approval.

If `.mailworker/deploy-state.json` already exists and its steps are `done`, this
account is already provisioned: say so in Phase 1 and recommend
`update-mailworker` before going further. Continue only if the user confirms
they really mean to re-provision.
