import { invalidArgument } from "@/domain/errors.ts";

/**
 * What a credential is allowed to do. Granted to an API key, carried on the
 * request-scoped AuthContext, checked by SendPolicy and the HTTP layer.
 *
 * Kept coarse on purpose: an agent should be handed the narrowest useful set
 * (typically `inbox:write` + `message:read` + `message:send`) and never
 * `message:approve`, so that a human stays in the approval loop.
 */
export type Scope =
  | "inbox:read"
  | "inbox:write"
  | "message:read"
  | "message:send"
  | "message:approve"
  | "admin";

export const ALL_SCOPES: readonly Scope[] = [
  "inbox:read",
  "inbox:write",
  "message:read",
  "message:send",
  "message:approve",
  "admin",
];

export const Scope = {
  parse(input: string): Scope {
    if (!(ALL_SCOPES as readonly string[]).includes(input)) {
      throw invalidArgument(`Unknown scope: ${input}`, { input });
    }
    return input as Scope;
  },

  parseList(input: readonly string[]): Scope[] {
    return input.map((s) => Scope.parse(s));
  },

  /** `admin` implies every other scope. */
  satisfies(granted: readonly Scope[], required: Scope): boolean {
    return granted.includes("admin") || granted.includes(required);
  },
} as const;
