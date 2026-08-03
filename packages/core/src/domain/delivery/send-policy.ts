import type { LoopVerdict } from "@core/domain/delivery/loop-breaker-policy";
import type { EmailAddress } from "@core/domain/email-address";
import type { DomainErrorCode } from "@core/domain/errors";
import { DomainError } from "@core/domain/errors";
import type { AccountMode } from "@core/domain/identity/account";
import { Account } from "@core/domain/identity/account";
import { AgentIdentity } from "@core/domain/identity/agent-identity";
import { Scope } from "@core/domain/identity/scope";

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
  /** The environment's send semantics. `test` makes the allowlist mandatory. */
  readonly mode: AccountMode;
  /**
   * Null when the credential is not bound to an agent identity. Gate 2 then
   * allows the send only for `admin`, which cannot be bound by construction —
   * for anything else an unbound credential is a misconfiguration, not a
   * permission level.
   */
  readonly identity: AgentIdentity | null;
  readonly from: EmailAddress;
  readonly recipients: readonly EmailAddress[];
  /** Recipients found on the suppression list. Resolved by the caller. */
  readonly suppressedRecipients: readonly EmailAddress[];
  /** Messages this identity has already sent in the current quota window. */
  readonly sentInWindow: number;
  readonly loop: LoopVerdict;
}

/**
 * The seven gates between an agent and the outside world, then the approval hold.
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
    if (!Scope.satisfies(input.scopes, "message:send")) {
      return reject("forbidden", "This credential lacks the message:send scope.", {
        required: "message:send",
      });
    }

    // Gates 3, 4 and 6 are all properties OF an identity, so an unbound
    // credential does not merely have generous limits, it skips those gates
    // entirely: any From address, any recipient, unlimited volume. `--identity`
    // is an optional flag on `keys create`, which made forgetting it the
    // difference between a metered agent and an unmetered one — with no error at
    // any point to say so.
    //
    // `admin` is exempt because an admin key cannot be bound to an identity by
    // construction (it could edit that identity's own quota, so the metering
    // would be optional for the thing being metered — see IdentityService).
    // Metering the principal that can rewrite the meter is theatre; the honest
    // split is that `admin` is a human with the keys to the deployment, and
    // every credential handed to an agent carries an identity.
    if (input.identity === null && !Scope.satisfies(input.scopes, "admin")) {
      return reject(
        "forbidden",
        "This credential may send but is not bound to an agent identity, so no " +
          "quota, sender rule or recipient allowlist applies to it. Mint it with " +
          "`keys create --identity <name>`.",
        { required: "identity" },
      );
    }

    if (input.identity !== null && !AgentIdentity.canSendAs(input.identity, input.from)) {
      return reject(
        "send_rejected",
        `Identity "${input.identity.name}" may not send as ${input.from}.`,
        { from: input.from, sendAs: input.identity.sendAs },
      );
    }

    const identity = input.identity;
    if (identity !== null) {
      // In a `test` environment the allowlist stops being optional. The whole
      // point of that mode is that it sends for real, which makes an identity
      // with no allowlist a development agent that can mail a customer.
      if (Account.requiresAllowlist(input.mode) && identity.recipientAllowlist === null) {
        return reject(
          "send_rejected",
          `Identity "${identity.name}" has no recipient allowlist, and a test ` +
            "environment sends for real. Give it one, or move it to a sandbox environment.",
          { mode: input.mode, identity: identity.name },
        );
      }

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

    // Sending here would bounce or draw a complaint, and both damage the
    // account's sending reputation.
    if (input.suppressedRecipients.length > 0) {
      return reject(
        "suppressed_recipient",
        `Recipients are suppressed: ${input.suppressedRecipients.join(", ")}.`,
        { suppressed: input.suppressedRecipients },
      );
    }

    const quota = input.identity?.dailySendQuota ?? null;
    if (quota !== null && input.sentInWindow >= quota) {
      return reject(
        "quota_exceeded",
        `Identity "${input.identity?.name}" reached its quota of ${quota} messages.`,
        { quota, sent: input.sentInWindow },
      );
    }

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
