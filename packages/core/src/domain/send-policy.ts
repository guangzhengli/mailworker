import type { EmailAddress } from "@/domain/address.ts";
import type { AgentIdentity as AgentIdentityType } from "@/domain/agent-identity.ts";
import { AgentIdentity } from "@/domain/agent-identity.ts";
import type { DomainErrorCode } from "@/domain/errors.ts";
import { DomainError } from "@/domain/errors.ts";
import type { LoopVerdict } from "@/domain/loop-breaker-policy.ts";
import type { Scope } from "@/domain/scope.ts";
import { Scope as ScopeVO } from "@/domain/scope.ts";

export type SendDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "require_approval"; readonly reason: string }
  | {
      readonly kind: "reject";
      readonly code: DomainErrorCode;
      readonly reason: string;
      readonly details: Readonly<Record<string, unknown>>;
    };

export interface SendPolicyInput {
  readonly scopes: readonly Scope[];
  /** Null when the credential is not bound to an agent identity (e.g. a human admin). */
  readonly identity: AgentIdentityType | null;
  readonly from: EmailAddress;
  readonly recipients: readonly EmailAddress[];
  /** Recipients found on the suppression list. Resolved by the caller. */
  readonly suppressedRecipients: readonly EmailAddress[];
  /** Messages this identity has already sent in the current quota window. */
  readonly sentInWindow: number;
  readonly loop: LoopVerdict;
}

/**
 * The five gates between an agent and the outside world.
 *
 * Ordering is deliberate. Approval is evaluated LAST, after every rejecting
 * gate: if a send would be refused anyway, an agent should get that refusal
 * immediately rather than a human being paged to approve something that is
 * going to fail. Approval queues only stay useful if everything in them is
 * actually sendable.
 *
 * Cheap and unambiguous checks come first (scope, identity) so that a
 * misconfigured caller gets a precise error without us consulting the
 * suppression list or counting quota.
 */
export const SendPolicy = {
  evaluate(input: SendPolicyInput): SendDecision {
    // Gate 1 — scope.
    if (!ScopeVO.satisfies(input.scopes, "message:send")) {
      return reject("forbidden", "This credential lacks the message:send scope.", {
        required: "message:send",
      });
    }

    // Gate 2 — is this identity allowed to be this sender?
    if (input.identity !== null && !AgentIdentity.canSendAs(input.identity, input.from)) {
      return reject(
        "send_rejected",
        `Identity "${input.identity.name}" may not send as ${input.from}.`,
        { from: input.from, sendAs: input.identity.sendAs },
      );
    }

    // Gate 3 — recipient allowlist.
    const identity = input.identity;
    if (identity !== null) {
      const blocked = input.recipients.filter(
        (recipient) => !AgentIdentity.canSendTo(identity, recipient),
      );
      if (blocked.length > 0) {
        return reject(
          "send_rejected",
          `Identity "${identity.name}" may not send to ${blocked.join(", ")}.`,
          { blocked, allowlist: identity.recipientAllowlist },
        );
      }
    }

    // Gate 4 — suppression list. Sending here would bounce or draw a complaint,
    // and both damage the account's sending reputation.
    if (input.suppressedRecipients.length > 0) {
      return reject(
        "suppressed_recipient",
        `Recipients are suppressed: ${input.suppressedRecipients.join(", ")}.`,
        { suppressed: input.suppressedRecipients },
      );
    }

    // Gate 5 — quota.
    const quota = input.identity?.dailySendQuota ?? null;
    if (quota !== null && input.sentInWindow >= quota) {
      return reject(
        "quota_exceeded",
        `Identity "${input.identity?.name}" reached its quota of ${quota} messages.`,
        { quota, sent: input.sentInWindow },
      );
    }

    // Gate 6 — loop breaker.
    if (input.loop.looping) {
      return reject("loop_detected", input.loop.detail ?? "Send would form a mail loop.", {
        reason: input.loop.reason,
      });
    }

    if (input.identity?.requireApproval === true) {
      return {
        kind: "require_approval",
        reason: `Identity "${input.identity.name}" requires human approval for every send.`,
      };
    }

    return { kind: "allow" };
  },

  /** Turn a rejection into the error the API and CLI surface. */
  toError(decision: Extract<SendDecision, { kind: "reject" }>): DomainError {
    return new DomainError(decision.code, decision.reason, { ...decision.details });
  },
} as const;

function reject(
  code: DomainErrorCode,
  reason: string,
  details: Record<string, unknown>,
): SendDecision {
  return { kind: "reject", code, reason, details };
}
