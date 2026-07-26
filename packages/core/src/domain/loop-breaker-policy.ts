/**
 * Stop agents from mailing each other forever.
 *
 * This ships in M1, not later. An agent that reads its inbox and replies
 * automatically can trivially form a cycle with another such agent — or with a
 * vacation autoresponder — and Cloudflare's daily send quota ramps with sender
 * reputation, so the first runaway loop costs both the quota and the domain's
 * standing. Reputation damage is not something you can refund.
 */

export type LoopReason =
  | "references_too_deep"
  | "too_many_exchanges"
  | "replying_to_automated"
  | "self_addressed";

export interface LoopVerdict {
  readonly looping: boolean;
  readonly reason: LoopReason | null;
  readonly detail: string | null;
}

const OK: LoopVerdict = { looping: false, reason: null, detail: null };

/**
 * Cloudflare truncates `References` at 100 entries, so a chain approaching that
 * is already pathological. We stop at half of it: legitimate human threads
 * essentially never pass 50, and the headroom keeps us clear of the provider's
 * own ceiling.
 */
export const MAX_REFERENCES_DEPTH = 50;

/** Messages we will send to one counterparty within `EXCHANGE_WINDOW_MS`. */
export const MAX_EXCHANGES_PER_WINDOW = 10;
export const EXCHANGE_WINDOW_MS = 60 * 60 * 1000;

export interface LoopBreakerInput {
  /** Length of the `References` chain the outbound message would carry. */
  readonly referencesDepth: number;
  /** How many messages we already sent this counterparty inside the window. */
  readonly exchangesInWindow: number;
  /**
   * `Auto-Submitted` header of the message being replied to. Anything other
   * than `no` (per RFC 3834) marks an automated message.
   */
  readonly inboundAutoSubmitted: string | null;
  /** True when a machine, not a human, triggered this send. */
  readonly automated: boolean;
  /** True when the sender and a recipient are the same address. */
  readonly selfAddressed: boolean;
}

export const LoopBreakerPolicy = {
  MAX_REFERENCES_DEPTH,
  MAX_EXCHANGES_PER_WINDOW,
  EXCHANGE_WINDOW_MS,

  /** `Auto-Submitted: no` means human-generated; absent means unknown, so human. */
  isAutomated(autoSubmitted: string | null): boolean {
    if (autoSubmitted === null) return false;
    const value = autoSubmitted.trim().toLowerCase();
    return value !== "" && value !== "no";
  },

  check(input: LoopBreakerInput): LoopVerdict {
    if (input.selfAddressed) {
      return {
        looping: true,
        reason: "self_addressed",
        detail: "Sender and recipient are the same address.",
      };
    }

    if (input.referencesDepth > MAX_REFERENCES_DEPTH) {
      return {
        looping: true,
        reason: "references_too_deep",
        detail: `Reference chain is ${input.referencesDepth} deep (max ${MAX_REFERENCES_DEPTH}).`,
      };
    }

    if (input.exchangesInWindow >= MAX_EXCHANGES_PER_WINDOW) {
      return {
        looping: true,
        reason: "too_many_exchanges",
        detail:
          `Already sent ${input.exchangesInWindow} messages to this recipient in the last hour ` +
          `(max ${MAX_EXCHANGES_PER_WINDOW}).`,
      };
    }

    // An automated reply to an automated message is the classic two-bot loop.
    // A human replying to an autoresponder is fine, so this only trips when both
    // sides are machines.
    if (input.automated && LoopBreakerPolicy.isAutomated(input.inboundAutoSubmitted)) {
      return {
        looping: true,
        reason: "replying_to_automated",
        detail: `Refusing an automated reply to an automated message (Auto-Submitted: ${input.inboundAutoSubmitted}).`,
      };
    }

    return OK;
  },

  /** Header every outbound automated message must carry, so peers can break loops too. */
  autoSubmittedHeader(automated: boolean): string {
    return automated ? "auto-replied" : "no";
  },
} as const;
