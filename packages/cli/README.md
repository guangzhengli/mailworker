# @mailworker/cli — planned (M1–M2)

**This is the agent interface.** There is no MCP server by design; agents drive
Mailworker through this CLI and the REST API.

That raises the bar on its design, since it has to work for humans and machines
at once:

- `--json` on everything, with a schema kept stable across versions
- zero interaction when stdin is not a TTY — never block waiting for input
- one command completes one whole intent (`wait --extract otp` prints the code
  itself, not a message to parse)
- exit codes carry meaning, so a script or agent can branch without reading text:

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | generic error |
| 2 | usage error |
| 3 | authentication failed |
| 4 | wait timed out |
| 5 | rejected by SendPolicy |
| 6 | quota or rate limit |

Planned commands: `init` `deploy` `doctor` `inbox` `send` `status` `approve`
`tail` `wait` `ls` `get` `open` `inject` `keys` `help --agent`.

`get --raw > fixture.eml` into `inject fixture.eml` is the loop that turns a
strange production message into a regression test.
