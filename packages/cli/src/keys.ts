import type { Client } from "@cli/client";
import { emit, type OutputOptions } from "@cli/output";
import type { AgentIdentityDto, ApiKeyDto, WebhookDto } from "@mailworker/contract";
import { Command } from "commander";

/**
 * `mailworker keys` — minting the credential an agent actually holds.
 *
 * The whole reason this exists is so the thing running unattended is not the
 * bootstrap admin key. A key here carries only the scopes it was given and is
 * bound to an identity whose quota and allowlist it cannot change.
 */
export function keysCommand(client: () => Client): Command {
  const keys = new Command("keys").description("Create, list and revoke API keys");

  keys
    .command("create")
    .description("Mint a key. The token is printed once and never again.")
    .requiredOption("--name <name>", "what this key is for, for the audit trail")
    .requiredOption(
      "--scope <scope...>",
      "inbox:read inbox:write message:read message:send message:inject message:approve admin",
    )
    .option("--identity <name>", "bind to an agent identity, so sends are metered")
    .option("--expires <iso>", "an ISO timestamp after which it stops working")
    .option("--json", "print the whole key object, token included")
    .action(
      async (
        options: OutputOptions & {
          name: string;
          scope: string[];
          identity?: string;
          expires?: string;
        },
      ) => {
        const created = await client().post<ApiKeyDto & { token: string }>("/v1/keys", {
          name: options.name,
          scopes: options.scope,
          ...(options.identity === undefined ? {} : { identityName: options.identity }),
          ...(options.expires === undefined ? {} : { expiresAt: options.expires }),
        });

        // The token alone on stdout, everything else on stderr. That way
        // `mailworker keys create … > token.txt` captures exactly the secret and
        // the human still sees the warning.
        emit(created, options, () => {
          process.stderr.write(
            `Created ${created.prefix} (${created.scopes.join(", ")}).\n` +
              "This token is shown once. Store it now; there is no way to read it back.\n",
          );
          return `${created.token}\n`;
        });
      },
    );

  keys
    .command("ls")
    .option("--json")
    .description("List keys. Secrets are not stored, so none are shown.")
    .action(async (options: OutputOptions) => {
      const page = await client().get<{ items: ApiKeyDto[] }>("/v1/keys");
      emit(page, options, () =>
        page.items.length === 0
          ? "No keys.\n"
          : page.items
              .map(
                (key) =>
                  `${key.id}  ${key.prefix}  ${key.revokedAt === null ? "active " : "revoked"}  ${key.scopes.join(",")}\n`,
              )
              .join(""),
      );
    });

  keys
    .command("rm <id>")
    .description("Revoke a key. The row stays, so the audit trail stays.")
    .action(async (id: string) => {
      await client().delete(`/v1/keys/${id}`);
    });

  return keys;
}

export function identitiesCommand(client: () => Client): Command {
  const identities = new Command("identities").description("Agent identities and their limits");

  identities
    .command("create")
    .requiredOption("--name <name>")
    .option("--send-as <pattern>", "address glob this identity may send FROM")
    .option("--allow <pattern...>", "address globs it may send TO; omit for unrestricted")
    .option("--quota <n>", "messages per rolling 24h")
    .option("--require-approval", "every send waits for a human")
    .option("--json")
    .action(
      async (
        options: OutputOptions & {
          name: string;
          sendAs?: string;
          allow?: string[];
          quota?: string;
          requireApproval?: boolean;
        },
      ) => {
        const created = await client().post<AgentIdentityDto>("/v1/identities", {
          name: options.name,
          ...(options.sendAs === undefined ? {} : { sendAs: options.sendAs }),
          ...(options.allow === undefined ? {} : { recipientAllowlist: options.allow }),
          ...(options.quota === undefined ? {} : { dailySendQuota: Number(options.quota) }),
          ...(options.requireApproval === undefined
            ? {}
            : { requireApproval: options.requireApproval }),
        });
        emit(created, options, () => `${created.id}  ${created.name}\n`);
      },
    );

  identities
    .command("ls")
    .option("--json")
    .action(async (options: OutputOptions) => {
      const page = await client().get<{ items: AgentIdentityDto[] }>("/v1/identities");
      emit(page, options, () =>
        page.items.length === 0
          ? "No identities.\n"
          : page.items
              .map(
                (identity) =>
                  `${identity.id}  ${identity.name}  quota=${identity.dailySendQuota ?? "-"}  approval=${identity.requireApproval}\n`,
              )
              .join(""),
      );
    });

  return identities;
}

export function webhooksCommand(client: () => Client): Command {
  const webhooks = new Command("webhooks").description("Event subscriptions");

  webhooks
    .command("create")
    .requiredOption("--url <url>", "https endpoint to POST events to")
    .option("--event <type...>", "event types; omit for all, including future ones")
    .option("--json")
    .action(async (options: OutputOptions & { url: string; event?: string[] }) => {
      const created = await client().post<WebhookDto & { secret: string }>("/v1/webhooks", {
        url: options.url,
        ...(options.event === undefined ? {} : { events: options.event }),
      });
      emit(created, options, () => {
        // Same split as `keys create`: the secret is the thing a script wants
        // to capture, so it goes to stdout by itself.
        process.stderr.write(`Created ${created.id} for ${created.url}.\nSigning secret:\n`);
        return `${created.secret}\n`;
      });
    });

  webhooks
    .command("ls")
    .option("--json")
    .action(async (options: OutputOptions) => {
      const page = await client().get<{ items: WebhookDto[] }>("/v1/webhooks");
      emit(page, options, () =>
        page.items.length === 0
          ? "No webhooks.\n"
          : page.items
              .map((hook) => `${hook.id}  ${hook.url}  ${hook.events.join(",") || "(all)"}\n`)
              .join(""),
      );
    });

  webhooks.command("rm <id>").action(async (id: string) => {
    await client().delete(`/v1/webhooks/${id}`);
  });

  return webhooks;
}
