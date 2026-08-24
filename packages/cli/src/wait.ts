import { type BodyOptions, bodyFormatOf, writeBody } from "@cli/body";
import type { Client, Query } from "@cli/client";
import { usage } from "@cli/errors";
import { emit, messageDetail, messageLine, type OutputOptions } from "@cli/output";
import type { WaitResponse } from "@mailworker/contract";
import { durationMs, ExitCode } from "@mailworker/contract";
import { Command } from "commander";

const DEFAULT_SERVER_WAIT_MS = 30_000;
const MAX_SERVER_WAIT_MS = 300_000;
const NETWORK_GRACE_MS = 5_000;

interface WaitOptions extends OutputOptions, BodyOptions {
  inbox?: string;
  from?: string;
  subject?: string;
  match?: string;
  after?: string;
  timeout?: string;
}

/**
 * `mailworker wait` — the operation the whole CLI is shaped around.
 *
 * One command completes one whole intent: block until the message arrives, then
 * put it where the caller can use it. `--text` writes the body to stdout bare,
 * so an agent or a script reads it with no second tool and no second parse:
 *
 *     BODY=$(mailworker wait --inbox "$id" --text)
 *
 * The whole body, deliberately — not a code or a link picked out of it. Which
 * part matters is the caller's judgement, and an agent reading "your code is
 * 1234, but it has expired, request another" needs the sentence, not the digits.
 *
 * A timeout leaves stdout empty and exits 4. That is the difference between "no
 * mail yet" and "your request was wrong" (2) or "bad credentials" (3), which is
 * what lets a script branch without parsing prose.
 */
export function waitCommand(client: () => Client): Command {
  return new Command("wait")
    .description("Block until a matching message arrives")
    .option("--inbox <id>", "only this inbox")
    .option("--from <address>", "only from this sender")
    .option("--subject <text>", "case-insensitive substring of the subject")
    .option("--match <regex>", "regular expression over subject and text body")
    .option("--after <id>", "only messages newer than this one")
    .option("--timeout <duration>", "how long to block, e.g. 60s (default 30s)")
    .option("--text", "write the plain-text body to stdout and nothing else")
    .option("--html", "write the sanitized HTML body to stdout and nothing else")
    .option("--raw", "write the original MIME to stdout and nothing else")
    .option("--json", "print the whole outcome as JSON")
    .action(async (options: WaitOptions) => {
      // Validated before the long poll, so a bad flag combination fails now
      // rather than after someone has waited sixty seconds to find out.
      const format = bodyFormatOf(options);
      const requestTimeoutMs = waitRequestTimeout(options.timeout);

      const api = client();
      const result = await api.get<WaitResponse>("/v1/messages/wait", criteriaOf(options), {
        timeoutMs: requestTimeoutMs,
      });

      if (result.outcome === "timeout") {
        if (options.json === true) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          process.stderr.write("Timed out waiting for a matching message.\n");
        }
        process.exitCode = ExitCode.TIMEOUT;
        return;
      }

      if (format !== null) {
        await writeBody(api, result.message, format);
        return;
      }

      emit(result, options, () => messageDetail(result.message));
    });
}

/**
 * `mailworker tail` — `wait` in a loop, carrying the cursor forward.
 *
 * Built on the same long poll rather than on a streaming endpoint of its own,
 * which is what makes it instant with no server-side machinery: each iteration
 * blocks in the Durable Object until something arrives, then asks again for
 * everything after the id it just printed. Nothing is missed in the gap, because
 * `--after` is a position rather than a timestamp.
 */
export function tailCommand(client: () => Client): Command {
  return new Command("tail")
    .description("Print messages as they arrive, until interrupted")
    .option("--inbox <id>", "only this inbox")
    .option("--from <address>", "only from this sender")
    .option("--match <regex>", "regular expression over subject and text body")
    .option("--json", "print one JSON object per message")
    .action(async (options: WaitOptions) => {
      let after = options.after;
      for (;;) {
        const result = await client().get<WaitResponse>(
          "/v1/messages/wait",
          {
            ...criteriaOf(options),
            after,
            // The API ceiling. Re-asking on a timeout costs one request every few
            // minutes and keeps the connection from being killed by an
            // intermediary that dislikes long-open sockets.
            timeout: "300s",
          },
          { timeoutMs: MAX_SERVER_WAIT_MS + NETWORK_GRACE_MS },
        );

        if (result.outcome === "timeout") continue;
        after = result.message.id;

        emit(result.message, options, () => messageLine(result.message));
      }
    });
}

function criteriaOf(options: WaitOptions): Query {
  return {
    inbox: options.inbox,
    from: options.from,
    subject: options.subject,
    match: options.match,
    after: options.after,
    timeout: options.timeout,
  };
}

function waitRequestTimeout(value: string | undefined): number {
  const parsed = durationMs.safeParse(value ?? DEFAULT_SERVER_WAIT_MS);
  if (!parsed.success) {
    throw usage(`--timeout ${parsed.error.issues[0]?.message ?? "is not a valid duration."}`);
  }
  if (parsed.data > MAX_SERVER_WAIT_MS) {
    throw usage(`--timeout cannot exceed ${MAX_SERVER_WAIT_MS / 1000}s.`);
  }
  return parsed.data + NETWORK_GRACE_MS;
}
