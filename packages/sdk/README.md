# @mailworker/sdk — not planned

A typed HTTP client was going to live here. It is not being built, because
neither consumer needs it:

- **Agents** drive the `mailworker` CLI, which is the deliberate alternative to
  shipping an MCP server. `mailworker help --agent` gives a model the whole
  callable surface in one read, and exit codes let it branch without parsing
  prose. A client library would sit under that, not replace it.
- **Application code** has the `/v1` REST API, whose request and response shapes
  are the zod schemas in `@mailworker/contract`. Generating types from those is
  a smaller thing than maintaining a client.

If it comes back, it comes back for a reason that does not exist yet — a
long-lived connection, or a language where shelling out is genuinely worse than
a dependency.
