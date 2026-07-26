import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the CLI is pointed and what it authenticates with.
 *
 * Resolved from three places, most specific first: an explicit flag, the
 * environment, then a config file. The environment sits in the middle because
 * that is how CI passes secrets — a token in argv shows up in `ps` and in shell
 * history, and an agent shelling out should not have to know that.
 *
 * The project-local file comes before the home one so a checkout can point at a
 * staging deployment without changing anything global, which is the same
 * precedence git and node use for their own config.
 */
export interface Config {
  readonly url: string;
  readonly token: string;
}

export interface ConfigOverrides {
  readonly url?: string;
  readonly token?: string;
}

const PROJECT_FILE = join(process.cwd(), ".mailworker", "config.json");
const HOME_FILE = join(homedir(), ".mailworker", "config.json");

export class ConfigError extends Error {}

export function resolveConfig(overrides: ConfigOverrides = {}, env = process.env): Config {
  const file = { ...readConfigFile(HOME_FILE), ...readConfigFile(PROJECT_FILE) };

  const url = overrides.url ?? env["MAILWORKER_URL"] ?? file.url;
  const token = overrides.token ?? env["MAILWORKER_TOKEN"] ?? file.token;

  if (url === undefined || url.length === 0) {
    throw new ConfigError(
      "No deployment URL. Set MAILWORKER_URL, pass --url, or run `mailworker init`.",
    );
  }
  if (token === undefined || token.length === 0) {
    throw new ConfigError(
      "No API token. Set MAILWORKER_TOKEN, pass --token, or run `mailworker init`.",
    );
  }

  return { url: url.replace(/\/+$/, ""), token };
}

/**
 * A missing file is the normal case, not an error — most invocations are
 * configured entirely by environment. A malformed one is worth complaining
 * about, though: silently ignoring it would present as "wrong credentials" much
 * later and somewhere else.
 */
function readConfigFile(path: string): Partial<Config> {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(contents);
    if (typeof parsed !== "object" || parsed === null) return {};
    const { url, token } = parsed as Partial<Config>;
    return {
      ...(typeof url === "string" ? { url } : {}),
      ...(typeof token === "string" ? { token } : {}),
    };
  } catch {
    throw new ConfigError(`${path} is not valid JSON.`);
  }
}
