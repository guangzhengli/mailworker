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
- one command completes one whole intent (`wait --text` blocks for the message
  and writes its body to stdout, with nothing to parse off it afterwards)
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

URL and token are resolved as one credential profile, in this order:

1. the current process (`--url` / `--token` over their environment variables)
2. the project `.mailworker/config.json`
3. the home `~/.mailworker/config.json`

A profile that sets either value must set both, and its optional target
environment stays with that profile. In particular, a checkout cannot put its
own URL or target environment in project config and inherit your environment or
home token.
Deployment URLs must use HTTPS; plain HTTP is accepted only for the exact local
development hosts `localhost`, `127.0.0.1`, and `[::1]`.

Start an automated run with `mailworker capabilities --json`. It tells the
caller which environment and identity the key belongs to, its scopes and usable
actions, the deployment features, domains and server-side limits. Unlike
`doctor`, it is available to an ordinary scoped Agent key; `doctor` is an
administrative DNS and deployment diagnostic.

List commands accept `--cursor`. `--all` deliberately requires
`--max-items <n>` so an unattended caller cannot turn a list into an unbounded
database scan and stdout stream.
Use `inbox ls --jsonl` or `ls --jsonl` to emit one compact DTO per line;
`--jsonl` and `--json` are mutually exclusive.

Ordinary HTTP requests have a 30-second network deadline. `wait` and `tail`
extend that deadline to the requested server wait plus five seconds for the
timeout response to travel back. A server-reported wait timeout still exits `4`;
a network deadline is an upstream failure and exits `1`, so automation does not
mistake a broken connection for “no message yet.”

## The shape of a test

```sh
id=$(mailworker inbox create --prefix signup --json | jq -r .id)
# … drive your signup flow against the printed address …
BODY=$(mailworker wait --inbox "$id" --text --timeout 60s) || exit $?
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
