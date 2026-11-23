import { readFileSync } from "node:fs";
import type { Client } from "@cli/client";
import { UsageError } from "@cli/errors";
import type { OutputOptions } from "@cli/output";
import type { MessageDto } from "@mailworker/contract";
import { ExitCode } from "@mailworker/contract";

/**
 * Putting a message body on stdout and nothing else.
 *
 * This is what `wait` and `get` both need and the reason neither of them has a
 * server-side "just give me the interesting part" mode. Which part of an email
 * matters — a code, a link, a due date, the sentence that says the code already
 * expired — depends entirely on the flow, and the caller is an agent or a
 * script that can read. So the whole body goes to stdout, bare, and the caller
 * decides:
 *
 *     BODY=$(mailworker wait --inbox "$id" --text) || exit $?
 *
 * `--json` remains the way to get the body alongside its metadata. These flags
 * exist for the case where a second parsing step would be pure overhead.
 */
export type BodyFormat = "text" | "html" | "raw";

export interface BodyOptions extends OutputOptions {
  readonly text?: boolean;
  readonly html?: boolean;
  readonly raw?: boolean;
}

/**
 * Which single body flag was asked for, if any.
 *
 * Combining them is a usage error rather than a precedence rule, because every
 * precedence rule here would be a guess: someone writing `--text --json` has
 * two different outputs in mind and silently picking one produces a script that
 * works until it does not.
 */
export function bodyFormatOf(options: BodyOptions): BodyFormat | null {
  const asked = (["text", "html", "raw"] as const).filter((key) => options[key] === true);
  if (asked.length > 1) {
    throw new UsageError(`--${asked[0]} and --${asked[1]} cannot be combined.`);
  }
  if (asked.length === 1 && options.json === true) {
    throw new UsageError(`--${asked[0]} and --json cannot be combined.`);
  }
  return asked[0] ?? null;
}

/**
 * Write one body to stdout. Returns false when there was nothing to write,
 * having already explained why on stderr.
 *
 * `raw` costs a second request: `wait` answers with the parsed message, not the
 * original bytes, and asking every long poll to carry a MIME blob nobody
 * usually wants would be the wrong trade.
 */
export async function writeBody(
  client: Client,
  message: MessageDto,
  format: BodyFormat,
): Promise<boolean> {
  if (format === "raw") {
    process.stdout.write(await client.bytes(`/v1/messages/${message.id}/raw`));
    return true;
  }

  const body = format === "text" ? message.bodyText : message.bodyHtml;
  if (body === null) {
    process.stderr.write(
      format === "text"
        ? `Message ${message.id} has no text body. Try --raw.\n`
        : `Message ${message.id} has no HTML body. Try --text, or --raw for the original bytes.\n`,
    );
    process.exitCode = ExitCode.ERROR;
    return false;
  }

  // A trailing newline only when the body does not already end in one, so
  // `$(...)` sees the body and nothing appended to it.
  process.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
  return true;
}

export function readTextBody(path: string): string {
  return path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
}
