import type { Client } from "@cli/client";
import { emit, emitJsonLines, inboxLine, inboxTable, type OutputOptions } from "@cli/output";
import { fetchPage, type PaginationOptions } from "@cli/pagination";
import type { InboxDto } from "@mailworker/contract";
import { Command } from "commander";

interface CreateOptions extends OutputOptions {
  ttl?: string;
  name?: string;
  prefix?: string;
  domain?: string;
  address?: string;
  persistent?: boolean;
  identity?: string;
}

interface ListOptions extends OutputOptions, PaginationOptions {
  limit?: string;
  includeExpired?: boolean;
}

/**
 * `mailworker inbox` — the address lifecycle.
 *
 * Creating one is a database insert, not a Cloudflare API call, because every
 * address lives behind a single catch-all routing rule. That is what makes it
 * reasonable for a test suite to mint a fresh inbox per case rather than share
 * one and clean up afterwards.
 */
export function inboxCommand(client: () => Client): Command {
  const inbox = new Command("inbox").description("Create, list and remove inboxes");

  inbox
    .command("create")
    .description("Mint a receiving address")
    .option("--address <address>", "use this exact address instead of generating one")
    .option("--name <name>", "use <name>@<domain> verbatim — no random suffix")
    .option("--prefix <prefix>", "generate <prefix>-<random>@<domain>")
    .option("--domain <domain>", "required only when the deployment serves several")
    .option("--ttl <duration>", "how long it lives, e.g. 10m, 2h (default 1h)")
    .option("--persistent", "never expires")
    .option("--identity <name>", "act as this agent identity when sending")
    .option("--json", "print the DTO instead of a line")
    .action(async (options: CreateOptions) => {
      const created = await client().post<InboxDto>("/v1/inboxes", {
        ...(options.address === undefined ? {} : { address: options.address }),
        ...(options.name === undefined ? {} : { localPart: options.name }),
        ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
        ...(options.domain === undefined ? {} : { domain: options.domain }),
        ...(options.ttl === undefined ? {} : { ttl: options.ttl }),
        ...(options.identity === undefined ? {} : { identity: options.identity }),
        ...(options.persistent === true ? { kind: "persistent" } : {}),
      });
      emit(created, options, () => inboxLine(created));
    });

  inbox
    .command("ls")
    .description("List inboxes")
    .option("--limit <n>", "how many to return")
    .option("--cursor <id>", "continue after this cursor")
    .option("--all", "follow cursors until --max-items is reached")
    .option("--max-items <n>", "required safety bound for --all")
    .option("--include-expired", "show inboxes whose TTL has passed")
    .option("--json", "print the page instead of a table")
    .option("--jsonl", "print one compact inbox object per line")
    .action(async (options: ListOptions) => {
      const page = await fetchPage<InboxDto>(
        client(),
        "/v1/inboxes",
        {
          limit: options.limit,
          includeExpired: options.includeExpired,
        },
        options,
      );
      if (options.jsonl === true)
        emitJsonLines(page.items, options, () => inboxTable(page.items));
      else emit(page, options, () => inboxTable(page.items));
    });

  inbox
    .command("rm <id>")
    .description("Delete an inbox and every message in it")
    .action(async (id: string) => {
      await client().delete(`/v1/inboxes/${id}`);
    });

  return inbox;
}
