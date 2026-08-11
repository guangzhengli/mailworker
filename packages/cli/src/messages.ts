import { readFileSync } from "node:fs";
import { type BodyOptions, bodyFormatOf, writeBody } from "@cli/body";
import type { Client } from "@cli/client";
import { emit, messageDetail, messageTable, type OutputOptions } from "@cli/output";
import type { MessageDto, MessageSummaryDto, PageDto } from "@mailworker/contract";
import { Command } from "commander";

interface ListOptions extends OutputOptions {
  inbox?: string;
  from?: string;
  q?: string;
  limit?: string;
  unseen?: boolean;
}

type GetOptions = OutputOptions & BodyOptions;

interface InjectOptions extends OutputOptions {
  to: string;
  from?: string;
}

export function lsCommand(client: () => Client): Command {
  return new Command("ls")
    .description("List stored messages")
    .option("--inbox <id>", "only this inbox")
    .option("--from <address>", "only from this sender")
    .option("-q, --q <text>", "substring search over subject, body and sender")
    .option("--unseen", "only messages not yet marked seen")
    .option("--limit <n>", "how many to return")
    .option("--json", "print the page instead of a table")
    .action(async (options: ListOptions) => {
      const page = await client().get<PageDto<MessageSummaryDto>>("/v1/messages", {
        inbox: options.inbox,
        from: options.from,
        q: options.q,
        limit: options.limit,
        ...(options.unseen === true ? { seen: false } : {}),
      });
      emit(page, options, () => messageTable(page.items));
    });
}

/**
 * `mailworker get <id>` — one message, or just its body.
 *
 * The body flags are the same three `wait` takes, because "read what it says"
 * should not depend on whether you blocked for the message or looked it up
 * afterwards. `--raw` writes the stored MIME to stdout untouched, which is also
 * the first half of the loop that makes strange production mail into a
 * regression test: `get --raw > fixture.eml`, commit it, `inject` it back.
 */
export function getCommand(client: () => Client): Command {
  return new Command("get")
    .argument("<id>")
    .description("Show one message")
    .option("--text", "write the plain-text body to stdout and nothing else")
    .option("--html", "write the sanitized HTML body to stdout and nothing else")
    .option("--raw", "write the original MIME to stdout and nothing else")
    .option("--json", "print the DTO instead of a rendering")
    .action(async (id: string, options: GetOptions) => {
      const format = bodyFormatOf(options);
      const api = client();

      // Straight to the bytes: `--raw` is the one body format that does not
      // need the parsed message first, and fetching it would be a wasted round
      // trip on a message that can be several megabytes.
      if (format === "raw") {
        process.stdout.write(await api.bytes(`/v1/messages/${id}/raw`));
        return;
      }

      const message = await api.get<MessageDto>(`/v1/messages/${id}`);
      if (format !== null) {
        await writeBody(api, message, format);
        return;
      }
      emit(message, options, () => messageDetail(message));
    });
}

/**
 * `mailworker inject fixture.eml` — the other half of that loop.
 *
 * It posts the bytes to the same ingest path real mail takes, so a fixture that
 * reproduces a parser bug on a laptop reproduces it on the deployment. That is
 * only true because it is the *same* path: a separate import that skipped the
 * policies would prove nothing.
 */
export function injectCommand(client: () => Client): Command {
  return new Command("inject")
    .argument("<file>", "an .eml file, or - for stdin")
    .description("Replay a raw message through the real ingest path")
    .requiredOption("--to <address>", "the inbox address to deliver it to")
    .option("--from <address>", "envelope sender (diagnostics only)")
    .option("--json", "print the result")
    .action(async (file: string, options: InjectOptions) => {
      const raw = file === "-" ? readFileSync(0) : readFileSync(file);
      const result = await client().postRaw<{ outcome: string; message?: MessageDto }>(
        "/v1/ingest/raw",
        new Uint8Array(raw),
        { to: options.to, from: options.from },
      );
      emit(result, options, () =>
        result.message === undefined
          ? `${result.outcome}\n`
          : `${result.outcome}  ${result.message.id}\n`,
      );
    });
}

export function seenCommand(client: () => Client): Command {
  return new Command("seen")
    .argument("<id>")
    .description("Mark a message as read")
    .option("--unseen", "mark it unread instead")
    .action(async (id: string, options: { unseen?: boolean }) => {
      await client().post(`/v1/messages/${id}/seen`, { seen: options.unseen !== true });
    });
}
