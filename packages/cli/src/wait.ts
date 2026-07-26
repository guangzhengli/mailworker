import type { Client, Query } from "@cli/client";
import { emit, messageDetail, messageLine, type OutputOptions } from "@cli/output";
import type { WaitResponse } from "@mailworker/contract";
import { ExitCode } from "@mailworker/contract";
import { Command } from "commander";

interface WaitOptions extends OutputOptions {
  inbox?: string;
  from?: string;
  subject?: string;
  match?: string;
  after?: string;
  timeout?: string;
  extract?: "otp" | "link" | "none";
}

/**
 * `mailworker wait` — the operation the whole CLI is shaped around.
 *
 * One command completes one whole intent. `--extract otp` prints the code
 * itself on stdout, not a JSON document containing the code, because the caller
 * is usually a shell script or an agent that would otherwise need a second tool
 * to dig it out:
 *
 *     CODE=$(mailworker wait --inbox "$id" --extract otp)
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
    .option("--extract <kind>", "print just the otp or link instead of the message")
    .option("--json", "print the whole outcome as JSON")
    .action(async (options: WaitOptions) => {
      const result = await client().get<WaitResponse>("/v1/messages/wait", criteriaOf(options));

      if (result.outcome === "timeout") {
        if (options.json === true) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          process.stderr.write("Timed out waiting for a matching message.\n");
        }
        process.exitCode = ExitCode.TIMEOUT;
        return;
      }

      if (
        options.extract !== undefined &&
        options.extract !== "none" &&
        options.json !== true
      ) {
        if (result.extracted === null) {
          process.stderr.write(`A message arrived but had no ${options.extract} in it.\n`);
          process.exitCode = ExitCode.ERROR;
          return;
        }
        // Bare, with a trailing newline and nothing else. `$(...)` strips it.
        process.stdout.write(`${result.extracted}\n`);
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
        const result = await client().get<WaitResponse>("/v1/messages/wait", {
          ...criteriaOf(options),
          after,
          // The API ceiling. Re-asking on a timeout costs one request every few
          // minutes and keeps the connection from being killed by an
          // intermediary that dislikes long-open sockets.
          timeout: "300s",
        });

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
    extract: options.extract,
  };
}
