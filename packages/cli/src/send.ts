import { readFileSync } from "node:fs";
import type { Client } from "@cli/client";
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
    .option("--interactive", "declare this as human-initiated, not automated")
    .option("--dry-run", "print what would be sent and stop")
    .option("--json", "print the outcome as JSON")
    .action(async (options: SendOptions & { interactive?: boolean }) => {
      const body = options.bodyFile === undefined ? undefined : readBody(options.bodyFile);

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
        automated: options.interactive !== true,
      };

      if (options.dryRun === true) {
        // Locally, deliberately. A dry run that called the API would still
        // consume an idempotency key and still show up in the audit log, which
        // is not what anyone means by "show me what you would send".
        emit(request, options, () => `${JSON.stringify(request, null, 2)}\n`);
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
