import type { Client } from "@cli/client";
import { emit, type OutputOptions } from "@cli/output";
import type { EnvironmentDto } from "@mailworker/contract";
import { Command } from "commander";

/**
 * `mailworker env` — the dev, test and production tenants of this deployment.
 *
 * An environment is an account, so switching is a tenancy change rather than a
 * flag: nothing in one is visible from another. `--mode sandbox` is the one
 * worth reaching for by default — it runs every gate and writes every row, and
 * then does not touch the network.
 */
export function envCommand(client: () => Client): Command {
  const env = new Command("env").description("List and create environments");

  env
    .command("create")
    .description("Add an environment to this project.")
    .requiredOption("--name <name>", "e.g. development, staging")
    .option(
      "--mode <mode>",
      "live | sandbox | test — sandbox sends nothing to the outside world",
      "sandbox",
    )
    .option("--domain <host>", "the hostname it receives on, e.g. dev.mail.example.com")
    .option("--json")
    .action(
      async (options: OutputOptions & { name: string; mode: string; domain?: string }) => {
        const created = await client().post<EnvironmentDto>("/v1/environments", {
          env: options.name,
          mode: options.mode,
          ...(options.domain === undefined ? {} : { domain: options.domain }),
        });

        emit(created, options, () => {
          const note =
            created.mode === "sandbox"
              ? "Sends loop back to it and are never delivered."
              : created.mode === "test"
                ? "It sends for real, and every identity in it needs a recipient allowlist."
                : "It sends for real.";
          return (
            `Created ${created.env} (${created.mode}). ${note}\n` +
            `Mint it a key with: MAILWORKER_ENV=${created.id} mailworker keys create …\n`
          );
        });
      },
    );

  env
    .command("ls")
    .option("--json")
    .description("List the environments of this project.")
    .action(async (options: OutputOptions) => {
      const { items } = await client().get<{ items: EnvironmentDto[] }>("/v1/environments");
      emit({ items }, options, () =>
        items.length === 0
          ? "No environments yet.\n"
          : `${items.map((item) => `${item.env}\t${item.mode}\t${item.id}`).join("\n")}\n`,
      );
    });

  return env;
}
