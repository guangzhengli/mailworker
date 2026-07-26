import type { AccountId } from "@core/domain/account-id.ts";
import type { EmailAddress } from "@core/domain/address.ts";
import { AddressPattern } from "@core/domain/address.ts";
import { invalidArgument } from "@core/domain/errors.ts";
import type { Ulid } from "@core/domain/ulid.ts";

/**
 * Who an agent is allowed to be, and how much rope it gets.
 *
 * This is the unit SendPolicy meters and the reason an agent sending email is
 * different from a human doing it: the limits are declared up front, by someone
 * else, and the agent cannot widen them.
 */
export interface AgentIdentity {
  readonly id: Ulid;
  readonly accountId: AccountId;
  readonly name: string;
  /** Address glob this identity may put in `From`. Null means "any owned address". */
  readonly sendAs: string | null;
  /**
   * Address globs this identity may send TO. Null means unrestricted.
   *
   * An empty array is meaningfully different from null: it means "may send to
   * nobody", which is a useful way to park an identity without deleting it.
   */
  readonly recipientAllowlist: readonly string[] | null;
  /** Messages per rolling 24h. Null means only the account-level limit applies. */
  readonly dailySendQuota: number | null;
  /** When true every send lands in `pending_approval` for a human to release. */
  readonly requireApproval: boolean;
  readonly createdAt: Date;
}

export interface CreateAgentIdentityInput {
  readonly id: Ulid;
  readonly accountId: AccountId;
  readonly name: string;
  readonly now: Date;
  readonly sendAs?: string | null;
  readonly recipientAllowlist?: readonly string[] | null;
  readonly dailySendQuota?: number | null;
  readonly requireApproval?: boolean;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const AgentIdentity = {
  create(input: CreateAgentIdentityInput): AgentIdentity {
    if (!NAME_PATTERN.test(input.name)) {
      throw invalidArgument(
        `Identity name must be lowercase alphanumeric with - or _ (got "${input.name}").`,
        { name: input.name },
      );
    }
    const quota = input.dailySendQuota ?? null;
    if (quota !== null && (!Number.isInteger(quota) || quota < 0)) {
      throw invalidArgument("dailySendQuota must be a non-negative integer or null.", {
        quota,
      });
    }
    return {
      id: input.id,
      accountId: input.accountId,
      name: input.name,
      sendAs: input.sendAs ?? null,
      recipientAllowlist: input.recipientAllowlist ? [...input.recipientAllowlist] : null,
      dailySendQuota: quota,
      requireApproval: input.requireApproval ?? false,
      createdAt: input.now,
    };
  },

  /** May this identity put `from` in the From header? */
  canSendAs(identity: AgentIdentity, from: EmailAddress): boolean {
    if (identity.sendAs === null) return true;
    return AddressPattern.matches(identity.sendAs, from);
  },

  /** May this identity send to `recipient`? */
  canSendTo(identity: AgentIdentity, recipient: EmailAddress): boolean {
    if (identity.recipientAllowlist === null) return true;
    return AddressPattern.matchesAny(identity.recipientAllowlist, recipient);
  },
} as const;
