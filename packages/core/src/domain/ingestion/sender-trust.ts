import type { SenderAuth, TrustReason } from "@core/domain/mailbox/sender-auth";

/**
 * Does the sender authentication add up to "this domain really sent it"?
 *
 * Separated from `SenderAuth` on purpose: that type is a fact reported by the
 * receiving MTA, this is our reading of it. The fact is stored on every message
 * forever; the reading can change when we learn more, without a migration.
 *
 * Only authentication is assessed here. There is deliberately no content
 * scoring: a keyword list that flags "looks like prompt injection" is trivially
 * rephrased around, silent on every language it was not written in, and — worst
 * of the three — reads as an all-clear when it does not fire. The real control
 * is that an email body is never treated as instructions in the first place,
 * and that control does not need a heuristic to hold.
 */

export interface TrustAssessment {
  /**
   * The sending domain is cryptographically attributable: DMARC passed, or both
   * SPF and DKIM passed. False means the From address could be forged.
   *
   * True says who sent it, and nothing about whether the body is safe to act
   * on. Nothing makes inbound email safe to act on.
   */
  readonly trusted: boolean;
  /** Machine-readable reasons, for logs and for the API response. */
  readonly reasons: readonly TrustReason[];
}

export const SenderTrust = {
  assess(auth: SenderAuth): TrustAssessment {
    const reasons: TrustReason[] = [];

    let trusted = false;
    if (auth.dmarc === "pass") {
      trusted = true;
      reasons.push("dmarc_pass");
    } else if (auth.spf === "pass" && auth.dkim === "pass") {
      trusted = true;
      reasons.push("spf_dkim_pass");
    } else if (auth.dmarc === "fail") {
      reasons.push("dmarc_fail");
    } else {
      reasons.push("unauthenticated_sender");
    }

    return { trusted, reasons };
  },
} as const;
