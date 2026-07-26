import type { AccountId } from "./account-id.ts";
import { DomainError } from "./errors.ts";
import type { Scope } from "./scope.ts";
import { Scope as ScopeVO } from "./scope.ts";
import type { Ulid } from "./ulid.ts";

/**
 * Who is making this request. Built once per request by an `Authenticator` and
 * threaded explicitly through every port call.
 *
 * Explicit threading is the point. It would be less typing to stash this in an
 * async-local or a module singleton, and that is exactly how systems end up with
 * a query that forgot to filter by tenant. Making it a parameter means the
 * compiler asks the question at every call site.
 */
export interface AuthContext {
  readonly accountId: AccountId;
  /** The agent identity this credential acts as, if any. */
  readonly identityId: Ulid | null;
  readonly scopes: readonly Scope[];
  /** Stable label for audit trails: `key:mw_live_8fa2c1`, `access:alice@corp`. */
  readonly subject: string;
}

export const AuthContext = {
  has(ctx: AuthContext, scope: Scope): boolean {
    return ScopeVO.satisfies(ctx.scopes, scope);
  },

  require(ctx: AuthContext, scope: Scope): void {
    if (!AuthContext.has(ctx, scope)) {
      throw new DomainError("forbidden", `This credential lacks the ${scope} scope.`, {
        required: scope,
        subject: ctx.subject,
      });
    }
  },
} as const;
