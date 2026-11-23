import { readFileSync } from "node:fs";
import { type BodyOptions, bodyFormatOf, readTextBody, writeBody } from "@cli/body";
import type { Client } from "@cli/client";
import { flagPair, usage } from "@cli/errors";
import {
  emit,
  emitJsonLines,
  messageDetail,
  messageLine,
  messageTable,
  type OutputOptions,
} from "@cli/output";
import { fetchPage, type PaginationOptions } from "@cli/pagination";
import type {
  LabelUsageDto,
  MessageDto,
  MessageSummaryDto,
  NoteDto,
  UpdateMessageBody,
} from "@mailworker/contract";
import { Command } from "commander";

interface ListOptions extends OutputOptions, PaginationOptions {
  inbox?: string;
  from?: string;
  q?: string;
  limit?: string;
  unseen?: boolean;
  label?: string;
  starred?: boolean;
  archived?: boolean;
  unarchived?: boolean;
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
    .option("--label <name>", "only messages with this label")
    .option("--starred", "only starred messages")
    .option("--archived", "only archived messages")
    .option("--unarchived", "only unarchived messages")
    .option("--limit <n>", "how many to return")
    .option("--cursor <id>", "continue after this cursor")
    .option("--all", "follow cursors until --max-items is reached")
    .option("--max-items <n>", "required safety bound for --all")
    .option("--json", "print the page instead of a table")
    .option("--jsonl", "print one compact message object per line")
    .action(async (options: ListOptions) => {
      const archived = flagPair(options, "archived", "unarchived");
      const page = await fetchPage<MessageSummaryDto>(
        client(),
        "/v1/messages",
        {
          inbox: options.inbox,
          from: options.from,
          q: options.q,
          label: options.label,
          starred: options.starred,
          archived,
          limit: options.limit,
          ...(options.unseen === true ? { seen: false } : {}),
        },
        options,
      );
      if (options.jsonl === true)
        emitJsonLines(page.items, options, () => messageTable(page.items));
      else emit(page, options, () => messageTable(page.items));
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

interface UpdateOptions extends OutputOptions {
  read?: boolean;
  unread?: boolean;
  star?: boolean;
  unstar?: boolean;
  archive?: boolean;
  unarchive?: boolean;
  label?: string[];
  unlabel?: string[];
}

function collectLabel(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function updateCommand(client: () => Client): Command {
  return new Command("update")
    .argument("<id...>")
    .description("Change message state or labels")
    .option("--read", "mark read")
    .option("--unread", "mark unread")
    .option("--star", "star messages")
    .option("--unstar", "remove stars")
    .option("--archive", "archive messages")
    .option("--unarchive", "move messages out of the archive")
    .option("--label <name>", "add a label (repeatable)", collectLabel, [])
    .option("--unlabel <name>", "remove a label (repeatable)", collectLabel, [])
    .option("--json", "print the API response")
    .action(async (ids: string[], options: UpdateOptions) => {
      const seen = flagPair(options, "read", "unread");
      const starred = flagPair(options, "star", "unstar");
      const archived = flagPair(options, "archive", "unarchive");
      const add = options.label ?? [];
      const remove = options.unlabel ?? [];
      const change: UpdateMessageBody = {
        ...(seen === undefined ? {} : { seen }),
        ...(starred === undefined ? {} : { starred }),
        ...(archived === undefined ? {} : { archived }),
        ...(add.length === 0 && remove.length === 0
          ? {}
          : {
              labels: {
                ...(add.length === 0 ? {} : { add }),
                ...(remove.length === 0 ? {} : { remove }),
              },
            }),
      };
      if (Object.keys(change).length === 0) throw usage("Pass at least one message change.");
      if (ids.length === 1) {
        const updated = await client().patch<MessageSummaryDto>(
          `/v1/messages/${encodeURIComponent(ids[0]!)}`,
          change,
        );
        emit(updated, options, () => messageLine(updated));
      } else {
        const updated = await client().patch<{ updated: number }>("/v1/messages", {
          ids,
          ...change,
        });
        emit(updated, options, () => `Updated ${updated.updated} messages.\n`);
      }
    });
}

export function labelsCommand(client: () => Client): Command {
  return new Command("labels")
    .description("List labels and their usage")
    .option("--json", "print the API response")
    .action(async (options: OutputOptions) => {
      const result = await client().get<{ items: LabelUsageDto[] }>("/v1/labels");
      emit(result, options, () =>
        result.items.length === 0
          ? "No labels.\n"
          : result.items
              .map(
                (label) =>
                  `${label.name}  ${label.messageCount} messages  ${label.unreadCount} unread\n`,
              )
              .join(""),
      );
    });
}

export function noteCommand(client: () => Client): Command {
  return new Command("note")
    .argument("<id>")
    .argument("[text]")
    .description("Add a plain-text note to a message")
    .option("--body-file <file>", "read the note from a file (or - for stdin)")
    .option("--json", "print the note")
    .action(
      async (
        id: string,
        text: string | undefined,
        options: OutputOptions & { bodyFile?: string },
      ) => {
        if ((text === undefined) === (options.bodyFile === undefined)) {
          throw usage("Pass note text or --body-file.");
        }
        const body = options.bodyFile === undefined ? text : readTextBody(options.bodyFile);
        const note = await client().post<NoteDto>(
          `/v1/messages/${encodeURIComponent(id)}/notes`,
          { body },
        );
        emit(note, options, () => noteLine(note));
      },
    );
}

export function notesCommand(client: () => Client): Command {
  return new Command("notes")
    .argument("<id>")
    .description("List notes on a message")
    .option("--json", "print the API response")
    .action(async (id: string, options: OutputOptions) => {
      const result = await client().get<{ items: NoteDto[] }>(
        `/v1/messages/${encodeURIComponent(id)}/notes`,
      );
      emit(result, options, () =>
        result.items.length === 0 ? "No notes.\n" : result.items.map(noteLine).join(""),
      );
    });
}

function noteLine(note: NoteDto): string {
  return `${note.id}  ${note.createdAt}  ${note.authorSubject}\n${note.body}\n`;
}
