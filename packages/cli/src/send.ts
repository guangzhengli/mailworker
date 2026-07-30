import { readFileSync } from "node:fs";
import type { Client } from "@cli/client";
import { usage } from "@cli/errors";
import {
  deliveryDetail,
  deliveryLine,
  diagnosticsReport,
  emit,
  type OutputOptions,
} from "@cli/output";
import type {
  DeliveryDto,
  DeliveryTimelineDto,
  DiagnosticsDto,
  SendResponse,
} from "@mailworker/contract";
import { ExitCode } from "@mailworker/contract";
import { Command } from "commander";

interface SendOptions extends OutputOptions {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  bodyFile?: string;
  replyTo?: string;
  inReplyTo?: string;
  idempotencyKey?: string;
  attach?: string[];
  inline?: string[];
  automated?: boolean;
  dryRun?: boolean;
}

/**
 * `mailworker send` — an irreversible outward action, treated as one.
 *
 * `--automated` defaults to TRUE here and nowhere else. A human typing this at
 * a terminal is the rare case; the normal caller is a script or an agent, and
 * the flag feeds the loop breaker and sets `Auto-Submitted`. Defaulting it the
 * other way would mean two agents mailing each other could do so until the
 * quota ran out, because each had truthfully declared itself a person.
 * `--interactive` is there for the human.
 */
export function sendCommand(client: () => Client): Command {
  return new Command("send")
    .description("Send a message from one of your inboxes")
    .requiredOption("--from <address>", "an inbox you own")
    .requiredOption("--to <address...>", "one or more recipients")
    .requiredOption("--subject <text>")
    .option("--cc <address...>")
    .option("--bcc <address...>")
    .option("--text <body>", "plain text body")
    .option("--html <body>", "HTML body")
    .option("--body-file <path>", "read the body from a file, or - for stdin")
    .option("--reply-to <address>")
    .option("--in-reply-to <id>", "continue a thread, by our message ULID")
    .option("--idempotency-key <key>", "repeat submissions return the original send")
    .option("--attach <path...>", "attach a file")
    .option("--inline <cid=path...>", "attach a file referenced from the HTML as cid:<cid>")
    .option("--interactive", "declare this as human-initiated, not automated")
    .option("--dry-run", "print what would be sent and stop")
    .option("--json", "print the outcome as JSON")
    .action(async (options: SendOptions & { interactive?: boolean }) => {
      const body = options.bodyFile === undefined ? undefined : readBody(options.bodyFile);
      const attachments = [
        ...(options.attach ?? []).map((path) => readAttachment(path, null)),
        ...(options.inline ?? []).map((pair) => {
          const [cid, ...rest] = pair.split("=");
          if (cid === undefined || rest.length === 0) {
            throw usage(`--inline wants cid=path, got "${pair}".`);
          }
          return readAttachment(rest.join("="), cid);
        }),
      ];

      const request = {
        from: options.from,
        to: options.to,
        subject: options.subject,
        ...(options.cc === undefined ? {} : { cc: options.cc }),
        ...(options.bcc === undefined ? {} : { bcc: options.bcc }),
        ...(options.text === undefined ? {} : { text: options.text }),
        ...(options.html === undefined ? {} : { html: options.html }),
        ...(body === undefined ? {} : { text: body }),
        ...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
        ...(options.inReplyTo === undefined ? {} : { inReplyTo: options.inReplyTo }),
        ...(options.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: options.idempotencyKey }),
        ...(attachments.length === 0 ? {} : { attachments }),
        automated: options.interactive !== true,
      };

      if (options.dryRun === true) {
        // Locally, deliberately. A dry run that called the API would still
        // consume an idempotency key and still show up in the audit log, which
        // is not what anyone means by "show me what you would send".
        //
        // Attachment bytes are summarised rather than printed: a dry run is
        // something a person reads, and 3 MiB of base64 on their terminal is
        // not it.
        const preview = {
          ...request,
          ...(attachments.length === 0
            ? {}
            : {
                attachments: attachments.map((one) => ({
                  filename: one.filename,
                  type: one.type,
                  bytes: Math.floor((one.content.length * 3) / 4),
                  ...(one.contentId === undefined ? {} : { contentId: one.contentId }),
                })),
              }),
        };
        emit(preview, options, () => `${JSON.stringify(preview, null, 2)}\n`);
        return;
      }

      const result = await client().post<SendResponse>("/v1/send", request);
      emit(result, options, () => {
        const held = result.outcome === "pending_approval";
        return held
          ? `${result.delivery.id}  pending_approval  (needs \`mailworker approve ${result.delivery.id}\`)\n`
          : `${result.delivery.id}  ${result.outcome}\n`;
      });
    });
}

/**
 * `mailworker status <id>` — did it actually arrive?
 *
 * The send response cannot answer that, and this is the command that admits it:
 * at send time nothing has happened yet, and the provider's own reply is a
 * handoff receipt. The timeline fills in over the following minutes to days.
 *
 * A terminal failure exits 5, so a script can tell "bounced" from "still in
 * flight" without reading the status string.
 */
export function statusCommand(client: () => Client): Command {
  return new Command("status")
    .argument("<id>")
    .description("The delivery timeline for one send")
    .option("--json", "print the timeline as JSON")
    .action(async (id: string, options: OutputOptions) => {
      const timeline = await client().get<DeliveryTimelineDto>(`/v1/send/${id}`);
      emit(timeline, options, () => deliveryDetail(timeline));

      if (["bounced", "failed", "rejected", "complained"].includes(timeline.delivery.status)) {
        process.exitCode = ExitCode.REJECTED;
      }
    });
}

export function approveCommand(client: () => Client): Command {
  return new Command("approve")
    .argument("<id>")
    .description("Release a send that a policy gate held for a human")
    .option("--json")
    .action(async (id: string, options: OutputOptions) => {
      const delivery = await client().post<DeliveryDto>(`/v1/send/${id}/approve`);
      emit(delivery, options, () => deliveryLine(delivery));
    });
}

/**
 * `mailworker doctor` — the command none of the reference projects has.
 *
 * Everything it checks fails silently otherwise. Exit 1 on any hard failure, so
 * it can be a deployment gate rather than something a person is supposed to
 * remember to read.
 */
export function doctorCommand(client: () => Client): Command {
  return new Command("doctor")
    .description("Check DNS, sending status and bindings")
    .option("--json", "print the full report as JSON")
    .action(async (options: OutputOptions) => {
      const report = await client().get<DiagnosticsDto>("/v1/diagnostics");
      emit(report, options, () => diagnosticsReport(report));

      const failed =
        report.domains.some((domain) => domain.status === "fail") ||
        !report.deployment.dispatchQueueConfigured;
      if (failed) process.exitCode = ExitCode.ERROR;
    });
}

function readBody(path: string): string {
  return path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
}

interface AttachmentInput {
  filename: string;
  type: string;
  content: string;
  contentId?: string;
}

/**
 * A file, read and base64-encoded for the JSON body.
 *
 * No stdin form (`-`) on purpose, unlike `--body-file`: stdin can be read once,
 * and an attachment is one of several things a send may want from it. Silently
 * attaching an empty file to everything after the first would be worse than not
 * offering it.
 *
 * The type is guessed from the extension and falls back to
 * `application/octet-stream`. A wrong guess is not fatal — it changes how a
 * client offers the file, not whether it arrives — so `--attach` stays a path
 * rather than becoming a path plus a MIME type nobody wants to look up.
 */
function readAttachment(path: string, contentId: string | null): AttachmentInput {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw usage(`Cannot read attachment "${path}".`);
  }
  const filename = path.split("/").pop() ?? path;
  return {
    filename,
    type: mimeOf(filename),
    content: bytes.toString("base64"),
    ...(contentId === null ? {} : { contentId }),
  };
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  csv: "text/csv",
  gif: "image/gif",
  html: "text/html",
  ics: "text/calendar",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain",
  webp: "image/webp",
  xml: "application/xml",
  zip: "application/zip",
};

function mimeOf(filename: string): string {
  const extension = filename.includes(".") ? filename.split(".").pop() : undefined;
  return MIME_BY_EXTENSION[(extension ?? "").toLowerCase()] ?? "application/octet-stream";
}
