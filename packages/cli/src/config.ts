import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the CLI is pointed and what it authenticates with.
 *
 * Resolved from three trust levels, most specific first: this process (explicit
 * flags over environment variables), the project config, then the home config.
 * URL and token are a credential pair: whichever level first supplies either
 * one must supply both.
 * This prevents an untrusted checkout from pointing the CLI at its own server
 * while silently inheriting a token from the environment or home directory.
 *
 * The project-local file comes before the home one so a checkout can point at a
 * staging deployment without changing anything global, which is the same
 * precedence git and node use for their own config.
 */
export interface Config {
  readonly url: string;
  readonly token: string;
  /**
   * Target a sibling environment. Usually unnecessary: a key already belongs to
   * exactly one environment, and its `mw_live_` / `mw_sbx_` / `mw_test_`
   * prefix says which.
   * This is for an admin credential driving another one.
   */
  readonly environment: string | null;
}

export interface ConfigOverrides {
  readonly url?: string;
  readonly token?: string;
  readonly environment?: string;
}

const PROJECT_FILE = join(process.cwd(), ".mailworker", "config.json");
const HOME_FILE = join(homedir(), ".mailworker", "config.json");

export class ConfigError extends Error {}

export function resolveConfig(overrides: ConfigOverrides = {}, env = process.env): Config {
  const processSource: ConfigSource = {
    name: "command-line flags and environment variables",
    url: overrides.url ?? env["MAILWORKER_URL"],
    token: overrides.token ?? env["MAILWORKER_TOKEN"],
    environment: overrides.environment ?? env["MAILWORKER_ENV"],
  };
  let connection: ConfigSource | undefined;

  if (hasCredentials(processSource)) {
    // Do not even read a lower-trust checkout config when this invocation is
    // fully configured. A malformed project file must not override flags/CI.
    connection = processSource;
  } else {
    const project = readConfigFile(PROJECT_FILE);
    const projectSource: ConfigSource = {
      name: PROJECT_FILE,
      url: project.url,
      token: project.token,
      environment: project.environment,
    };
    if (hasCredentials(projectSource)) {
      connection = projectSource;
    } else {
      const home = readConfigFile(HOME_FILE);
      const homeSource: ConfigSource = {
        name: HOME_FILE,
        url: home.url,
        token: home.token,
        environment: home.environment,
      };
      if (hasCredentials(homeSource)) connection = homeSource;
    }
  }

  if (connection === undefined) {
    throw new ConfigError(
      `No deployment credentials. Set both MAILWORKER_URL and MAILWORKER_TOKEN, pass both --url and --token, or put both in ${PROJECT_FILE}.`,
    );
  }
  if (connection.url === undefined || connection.url.length === 0) {
    throw new ConfigError(
      `${connection.name} specifies a token but no deployment URL. URL and token must come from the same source.`,
    );
  }
  if (connection.token === undefined || connection.token.length === 0) {
    throw new ConfigError(
      `${connection.name} specifies a deployment URL but no token. URL and token must come from the same source.`,
    );
  }

  return {
    url: normalizeUrl(connection.url, connection.name),
    token: connection.token,
    // A high-trust explicit environment may override a file profile. A file's
    // environment, however, never leaks upward into process credentials.
    environment:
      overrides.environment ?? env["MAILWORKER_ENV"] ?? connection.environment ?? null,
  };
}

interface ConfigSource {
  readonly name: string;
  readonly url: string | undefined;
  readonly token: string | undefined;
  readonly environment: string | null | undefined;
}

function hasCredentials(source: ConfigSource): boolean {
  return source.url !== undefined || source.token !== undefined;
}

function normalizeUrl(value: string, source: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`${source} contains an invalid deployment URL.`);
  }

  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new ConfigError(`${source} must not put credentials in the deployment URL.`);
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new ConfigError(
      `${source} must not put a query string or fragment in the deployment URL.`,
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  const isLoopback =
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    throw new ConfigError(
      `${source} must use HTTPS. Plain HTTP is allowed only for localhost, 127.0.0.1, or [::1].`,
    );
  }

  return parsed.toString().replace(/\/+$/, "");
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
    const { url, token, environment } = parsed as Partial<Config>;
    return {
      ...(typeof url === "string" ? { url } : {}),
      ...(typeof token === "string" ? { token } : {}),
      ...(typeof environment === "string" ? { environment } : {}),
    };
  } catch {
    throw new ConfigError(`${path} is not valid JSON.`);
  }
}
