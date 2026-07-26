import { DomainError } from "@core/domain/errors";
import type { AccountId } from "@core/domain/identity/account-id";
import { Scope } from "@core/domain/identity/scope";
import type { Ulid } from "@core/domain/ulid";

/**
 * Who is making this request. Built once per request by an `Authenticator` and
 * threaded explicitly through every port call.
 *
 * Explicit threading is the point. It would be less typing to stash this in an
 * async-local or a module singleton, and that is exactly how systems end up with
 * a query that forgot to filter by tenant. Making it a parameter means the
 * compiler asks the question at every call site.
 */
export interface Caller {
  readonly accountId: AccountId;
  /** The agent identity this credential acts as, if any. */
  readonly identityId: Ulid | null;
  readonly scopes: readonly Scope[];
  /** Stable label for audit trails: `key:mw_live_8fa2c1`, `access:alice@corp`. */
  readonly subject: string;
}

export const Caller = {
  /**
   * The deployment acting on its own behalf, for work that no credential asked
   * for: inbound mail arriving from Email Routing, a queue consumer draining a
   * batch, a cron sweeping expired inboxes.
   *
   * These are the only callers that may be minted without authenticating, so
   * the constructor is deliberately narrow and the `subject` is required —
   * `system:email` and `system:queue` have to be told apart in an audit trail,
   * and a shared "system" label would make that impossible after the fact.
   *
   * It carries `admin`, because there is nobody to ask for a narrower grant and
   * the alternative — exempting these paths from scope checks entirely — would
   * put a second authorization rule in the codebase.
   */
  system(accountId: AccountId, subject: `system:${string}`): Caller {
    return { accountId, identityId: null, scopes: ["admin"], subject };
  },

  has(ctx: Caller, scope: Scope): boolean {
    return Scope.satisfies(ctx.scopes, scope);
  },

  require(ctx: Caller, scope: Scope): void {
    if (!Caller.has(ctx, scope)) {
      throw new DomainError("forbidden", `This credential lacks the ${scope} scope.`, {
        required: scope,
        subject: ctx.subject,
      });
    }
  },
} as const;
