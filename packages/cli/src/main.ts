import { AGENT_HELP } from "@cli/agent-help";
import { ApiError, type Client, createClient } from "@cli/client";
import { ConfigError, resolveConfig } from "@cli/config";
import { envCommand } from "@cli/environments";
import { UsageError } from "@cli/errors";
import { inboxCommand } from "@cli/inbox";
import { identitiesCommand, keysCommand, webhooksCommand } from "@cli/keys";
import { getCommand, injectCommand, lsCommand, seenCommand } from "@cli/messages";
import { approveCommand, doctorCommand, sendCommand, statusCommand } from "@cli/send";
import { tailCommand, waitCommand } from "@cli/wait";
import { ExitCode } from "@mailworker/contract";
import { Command, CommanderError } from "commander";

/**
 * The agent interface.
 *
 * Because there is no MCP server, this has to work for a person and a program
 * at the same time. The rules that follow from that (DESIGN §7.2) are all
 * visible in this file: exit codes carry meaning so a script can branch without
 * reading text, nothing ever prompts, and every failure — including the ones
 * that happen before a request is sent — maps onto the same table the API uses.
 */
export function buildProgram(makeClient: (options: GlobalOptions) => Client): Command {
  const program = new Command("mailworker")
    .description("Programmatic inboxes that send and receive real email")
    .option("--url <url>", "the deployment to talk to (or MAILWORKER_URL)")
    .option("--token <token>", "API key (or MAILWORKER_TOKEN, which is safer)")
    // Rarely needed: a key already belongs to one environment and its
    // `mw_live_` / `mw_sbx_` / `mw_test_` prefix says which. This is for an admin
    // credential driving a sibling environment.
    .option("--env <name>", "target another environment of this project (or MAILWORKER_ENV)")
    .enablePositionalOptions()
    .showHelpAfterError();

  // Resolved lazily, so `--help` and `help --agent` work on a machine that has
  // never been configured. Making configuration a precondition of reading the
  // help is a good way to make a tool feel broken on first contact.
  const client = () => makeClient(program.opts<GlobalOptions>());

  program.addCommand(inboxCommand(client));
  program.addCommand(lsCommand(client));
  program.addCommand(getCommand(client));
  program.addCommand(seenCommand(client));
  program.addCommand(waitCommand(client));
  program.addCommand(tailCommand(client));
  program.addCommand(injectCommand(client));
  program.addCommand(sendCommand(client));
  program.addCommand(statusCommand(client));
  program.addCommand(approveCommand(client));
  program.addCommand(doctorCommand(client));
  program.addCommand(envCommand(client));
  program.addCommand(keysCommand(client));
  program.addCommand(identitiesCommand(client));
  program.addCommand(webhooksCommand(client));

  program
    .command("help")
    .description("Show help; --agent prints the compact reference for an LLM")
    .option("--agent", "the whole surface in one page, with exit codes")
    .action((options: { agent?: boolean }) => {
      process.stdout.write(options.agent === true ? AGENT_HELP : program.helpInformation());
    });

  return program;
}

export interface GlobalOptions {
  url?: string;
  token?: string;
  env?: string;
}

/**
 * Every exit from the process, in one place.
 *
 * `commander` throws for a usage error, `resolveConfig` throws when it cannot
 * find a token, and the API throws an `ApiError` carrying the server's code.
 * All three land here and become a number, so "how did this fail" and "what
 * does the shell see" cannot disagree.
 */
export async function run(argv: readonly string[]): Promise<number> {
  const program = buildProgram((options) =>
    createClient(
      resolveConfig({
        ...options,
        ...(options.env === undefined ? {} : { environment: options.env }),
      }),
    ),
  );

  try {
    await program.parseAsync(argv, { from: "user" });
    return process.exitCode === undefined ? ExitCode.OK : Number(process.exitCode);
  } catch (error) {
    if (error instanceof CommanderError) {
      // `--help` and `--version` come through here as "errors" with code 0.
      return error.exitCode === 0 ? ExitCode.OK : ExitCode.USAGE;
    }
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      return ExitCode.AUTH;
    }
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      return ExitCode.USAGE;
    }
    if (error instanceof ApiError) {
      process.stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return ExitCode.ERROR;
  }
}
