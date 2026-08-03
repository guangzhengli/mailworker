# `.agents/` — operating instructions for AI coding agents

Mailworker is deployed and maintained largely by coding agents, so the knowledge
needed to do that lives in the repo rather than in one maintainer's head. These
are plain Markdown files with YAML frontmatter. Nothing here is specific to a
single agent product: point whatever you use at the file that matches the task.

## Which file to read

| You want to | Read |
|---|---|
| Provision this repo into a Cloudflare account for the first time | [skills/deploy-mailworker/SKILL.md](skills/deploy-mailworker/SKILL.md) |
| Ship a code change to a Worker that is already deployed | [skills/update-mailworker/SKILL.md](skills/update-mailworker/SKILL.md) |
| Get a `wrangler` command or config field right | [skills/wrangler/SKILL.md](skills/wrangler/SKILL.md) |
| Write or review Worker code | [skills/workers-best-practices/SKILL.md](skills/workers-best-practices/SKILL.md) |
| Work on the `MessageWaiter` Durable Object | [skills/durable-objects/SKILL.md](skills/durable-objects/SKILL.md) |
| Understand Email Routing / Email Sending | [skills/cloudflare-email-service/SKILL.md](skills/cloudflare-email-service/SKILL.md) |

Each `SKILL.md` is the entry point and stays short; the detail is split across
`references/`, loaded only when the phase needs it. Read the SKILL.md first —
the reference files assume its rules are already in force.

## `<PLACEHOLDER>` values

The deployment skills describe operations against **your** Cloudflare account,
which nobody else's copy of this repo knows anything about. So every
account-specific value appears as `<ACCOUNT_ID>`, `<ZONE>`, `<MAIL_HOST>` and so
on, and each one comes with the command that produces it — see the "Facts to
establish" table at the top of either deployment skill.

Two rules, both load-bearing:

- **Discover, do not assume.** Run the command. A value that comes back empty is
  a question for the human, not a blank to fill in with something plausible.
- **Never paste a literal `<ZONE>` into a shell.** If a command errors with a
  placeholder still in it, the substitution step was skipped.

## What is deliberately not here

`.claude/` is gitignored and holds the maintainer's own copy of these skills,
with the real account id, zone and hostnames filled in. That directory is
personal, and `.agents/` is the copy everyone else uses. If you change a
deployment skill here, the maintainer's copy needs the same change.

Also gitignored, and off-limits to commit: `.env`, `.mailworker/` (contains the
admin credential) and `.private/` (local-only project notes).

One value is committed as a placeholder **on purpose**:
`apps/web/wrangler.jsonc` ships `"database_id": "PLACEHOLDER_RUN_MAILWORKER_DEPLOY"`.
The first deploy rewrites it in the working tree, and that edit is never
committed — so `git diff` on that file being permanently dirty is the expected
state, not a mistake to clean up.

## Provenance

`deploy-mailworker` and `update-mailworker` are written for this repo and
verified against it (wrangler 4.114, 2026-07-29).

`wrangler`, `durable-objects`, `workers-best-practices` and
`cloudflare-email-service` are vendored copies of Cloudflare's published agent
skills, included so a fresh clone can deploy without hunting them down. They are
Cloudflare's work, not this project's; check upstream for the current version
and the terms they are published under before redistributing them further. All
four tell the agent to prefer live retrieval from Cloudflare's docs over both
their own contents and the model's training data — which is the right instinct
for anything in this directory.
