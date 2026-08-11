import { invalidArgument } from "@core/domain/errors";
import type { AccountId } from "@core/domain/identity/account-id";

/**
 * A project groups the environments that belong to one deployment. Environments
 * are accounts, so every existing `account_id` filter is already the isolation
 * boundary between them.
 */
export type ProjectId = string & { readonly __brand: "ProjectId" };

const PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const ProjectId = {
  DEFAULT: "default" as ProjectId,

  parse(input: string): ProjectId {
    if (!PROJECT_PATTERN.test(input)) {
      throw invalidArgument(`Not a valid project id: ${input}`, { input });
    }
    return input as ProjectId;
  },
} as const;

/**
 * What happens when this environment sends.
 *
 * - `live` — the transport is real.
 * - `sandbox` — nothing leaves the building; sends are recorded and looped back
 *   into local inboxes so `wait` still resolves.
 * - `test` — the transport is real but the identity's recipient allowlist stops
 *   being optional.
 */
export type AccountMode = "live" | "sandbox" | "test";

/**
 * The public head of an API key token, one per mode. `mw_test` remains valid on
 * keys minted for a sandbox environment before the prefixes were split.
 */
export type KeyPrefix = "mw_live" | "mw_sbx" | "mw_test";

export const ACCOUNT_MODES: readonly AccountMode[] = ["live", "sandbox", "test"];

export function isAccountMode(value: string): value is AccountMode {
  return (ACCOUNT_MODES as readonly string[]).includes(value);
}

export interface Account {
  readonly id: AccountId;
  readonly projectId: ProjectId;
  /** Slug shown in the environment switcher: `production`, `development`, … */
  readonly env: string;
  readonly name: string;
  readonly mode: AccountMode;
  readonly createdAt: Date;
}

export interface CreateAccountInput {
  readonly id: AccountId;
  readonly projectId: ProjectId;
  readonly env: string;
  readonly name: string;
  readonly mode: AccountMode;
  readonly now: Date;
}

const ENV_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export const Account = {
  create(input: CreateAccountInput): Account {
    if (!ENV_PATTERN.test(input.env)) {
      throw invalidArgument(`Not a valid environment name: ${input.env}`, { env: input.env });
    }
    if (input.name.trim().length === 0) {
      throw invalidArgument("An environment needs a name.");
    }
    return {
      id: input.id,
      projectId: input.projectId,
      env: input.env,
      name: input.name.trim(),
      mode: input.mode,
      createdAt: input.now,
    };
  },

  sendsForReal(mode: AccountMode): boolean {
    return mode !== "sandbox";
  },

  requiresAllowlist(mode: AccountMode): boolean {
    return mode === "test";
  },

  /**
   * One prefix per mode, because the three modes are not two.
   *
   * `sandbox` and `test` used to share `mw_test`, which made the token unable
   * to answer the only question anyone asks it in a hurry: does this thing send
   * real mail? A sandbox key sends nothing outside the deployment; a test key
   * sends for real and merely insists on the identity's recipient allowlist.
   * Pasting one where the other was meant is the difference between a no-op and
   * mail arriving in someone's inbox, and a prefix that reads the same in both
   * cases cannot warn anybody.
   *
   * Keys minted before this returns `mw_test` for a sandbox environment keep
   * working: authentication looks the prefix up as stored rather than deriving
   * it from the mode, so this changes what is minted next, not what is valid.
   */
  keyPrefix(mode: AccountMode): KeyPrefix {
    if (mode === "live") return "mw_live";
    return mode === "sandbox" ? "mw_sbx" : "mw_test";
  },
} as const;
