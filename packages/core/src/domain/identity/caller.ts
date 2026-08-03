import { DomainError } from "@core/domain/errors";
import type { AccountMode, ProjectId } from "@core/domain/identity/account";
import type { AccountId } from "@core/domain/identity/account-id";
import { Scope } from "@core/domain/identity/scope";
import type { Ulid } from "@core/domain/ulid";

/**
 * Who is making this request, and against which environment.
 *
 * Threaded explicitly through every port call rather than stashed in an
 * async-local: making it a parameter is what stops a query forgetting to filter
 * by tenant, and an environment IS a tenant here.
 */
export interface Caller {
  readonly accountId: AccountId;
  readonly projectId: ProjectId;
  /** The environment's send semantics. Read by SendPolicy and the transport. */
  readonly mode: AccountMode;
  /** The agent identity this credential acts as, if any. */
  readonly identityId: Ulid | null;
  readonly scopes: readonly Scope[];
  /** Stable label for audit trails: `key:mw_live_8fa2c1`, `access:alice@corp`. */
  readonly subject: string;
}

export interface SystemCallerInput {
  readonly accountId: AccountId;
  readonly projectId: ProjectId;
  readonly mode: AccountMode;
  readonly subject: `system:${string}`;
}

export const Caller = {
  /**
   * The deployment acting on its own behalf: inbound mail, a queue consumer, a
   * cron sweep. It carries `admin` because there is nobody to ask for a narrower
   * grant, and the `subject` is required so the audit trail can tell these apart.
   */
  system(input: SystemCallerInput): Caller {
    return {
      accountId: input.accountId,
      projectId: input.projectId,
      mode: input.mode,
      identityId: null,
      scopes: ["admin"],
      subject: input.subject,
    };
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

  /** Same credential, pointed at a sibling environment. Admin only — see `callerForToken`. */
  inEnvironment(ctx: Caller, accountId: AccountId, mode: AccountMode): Caller {
    return { ...ctx, accountId, mode };
  },
} as const;
