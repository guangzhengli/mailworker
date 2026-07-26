import { invalidArgument } from "@core/domain/errors.ts";

/**
 * Tenant root. Single-tenant deployments have exactly one: `default`.
 *
 * The discipline that makes the eventual multi-tenant migration cheap
 * (DESIGN.md §6): an AccountId is only ever read from a request-scoped
 * AuthContext. Never from env, never a module-level constant, never
 * defaulted inside a repository.
 */
export type AccountId = string & { readonly __brand: "AccountId" };

const PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const AccountId = {
  /** The single account of a single-tenant deployment. */
  DEFAULT: "default" as AccountId,

  parse(input: string): AccountId {
    if (!PATTERN.test(input)) {
      throw invalidArgument(`Not a valid account id: ${input}`, { input });
    }
    return input as AccountId;
  },
} as const;
