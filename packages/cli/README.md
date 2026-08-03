# @mailworker/cli

Programmatic inboxes that send and receive real email, aimed at agents and test
automation rather than at humans reading mail. Installs one command, `mailworker`.

```sh
npx @mailworker/cli@latest help --agent
```

This CLI talks to **your own** [Mailworker](https://github.com/guangzhengli/mailworker)
deployment on Cloudflare. It is not a hosted service: point it at a deployment you
control with `MAILWORKER_URL` and `MAILWORKER_TOKEN`.

## Why a CLI and not an MCP server

There is no MCP server by design; agents drive Mailworker through this CLI and the
REST API. That raises the bar on its design, since it has to work for humans and
machines at once:

- `--json` on everything, with a schema kept stable within a major version
- zero interaction when stdin is not a TTY — never block waiting for input
- one command completes one whole intent (`wait --extract otp` prints the code
  itself, not a message to parse)
- exit codes carry meaning, so a script or agent can branch without reading text

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | generic error |
| 2 | usage error |
| 3 | authentication failed |
| 4 | wait timed out |
| 5 | rejected by policy — quota, allowlist, loop breaker or suppression |
| 6 | quota or rate limit |

`mailworker help --agent` prints the whole surface in one page, which is what an
agent should read instead of this file.

## Configuration

```sh
export MAILWORKER_URL=https://mailworker.your-worker.dev
export MAILWORKER_TOKEN=mw_live_…
```

Both may also come from `.mailworker/config.json`, project directory first then
home. Prefer the environment: a token in argv is visible in `ps` and in shell
history.

## The shape of a test

```sh
id=$(mailworker inbox create --prefix signup --json | jq -r .id)
# … drive your signup flow against the printed address …
CODE=$(mailworker wait --inbox "$id" --extract otp --timeout 60s) || exit $?
```

`get --raw > fixture.eml` into `inject fixture.eml` is the loop that turns a
strange production message into a regression test.

## Using it from a coding agent

```sh
npx skills add guangzhengli/mailworker
```

Installs the `mailworker` skill into Claude Code, Codex, Cursor and other
skills-compatible agents.

## License

MIT
