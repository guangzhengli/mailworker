import type { SenderAuth, TrustReason } from "@core/domain/mailbox/sender-auth";

/**
 * Does the sender authentication add up to "this domain really sent it", and
 * does the body look like it is trying to steer an agent?
 *
 * Separated from `SenderAuth` on purpose: that type is a fact reported by the
 * receiving MTA, this is our reading of it. The fact is stored on every message
 * forever; the reading can change when we learn more, without a migration.
 */

export interface TrustAssessment {
  /**
   * The sending domain is cryptographically attributable: DMARC passed, or both
   * SPF and DKIM passed. False means the From address could be forged.
   */
  readonly trusted: boolean;
  /**
   * Elevated risk that the body is crafted to steer an agent.
   *
   * IMPORTANT: `injectionRisk === false` does NOT mean the content is safe to
   * treat as instructions. Nothing makes inbound email safe to treat as
   * instructions. This is a provenance signal for ranking and for warning a
   * human — never an authorization to act on what the email says.
   */
  readonly injectionRisk: boolean;
  /** Machine-readable reasons, for logs and for the API response. */
  readonly reasons: readonly TrustReason[];
}

export interface ContentSignals {
  readonly bodyText?: string;
}

/**
 * A deliberately short, high-signal pattern list. This is a hint for humans and
 * for ranking, not a filter — treating it as a security control would be a
 * mistake, since any real attacker just rephrases. The actual control is that
 * we never feed email bodies to a model as instructions.
 */
const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above)\s+instructions/i,
  /disregard\s+(?:all\s+|any\s+)?(?:previous|prior|above)/i,
  /you\s+are\s+now\s+(?:a|an|in)\b/i,
  /\bsystem\s*prompt\b/i,
  /<\s*\/?\s*(?:system|assistant)\s*>/i,
];

function looksLikeInstructions(bodyText: string): boolean {
  return INSTRUCTION_PATTERNS.some((pattern) => pattern.test(bodyText));
}

export const SenderTrust = {
  assess(auth: SenderAuth, signals: ContentSignals = {}): TrustAssessment {
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

    let injectionRisk = !trusted;
    if (signals.bodyText !== undefined && looksLikeInstructions(signals.bodyText)) {
      injectionRisk = true;
      reasons.push("instruction_like_content");
    }

    return { trusted, injectionRisk, reasons };
  },
} as const;
