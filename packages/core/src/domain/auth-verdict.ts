/**
 * Sender authentication results, and the trust assessment derived from them.
 *
 * The derivation (what used to be a separate "TrustPolicy") lives here because
 * it is nothing but a pure reading of the verdict — splitting it into its own
 * file would only add an import.
 */

export type AuthResult =
  | "pass"
  | "fail"
  | "softfail"
  | "neutral"
  | "none"
  | "temperror"
  | "permerror"
  | "unknown";

const KNOWN_RESULTS = new Set<string>([
  "pass",
  "fail",
  "softfail",
  "neutral",
  "none",
  "temperror",
  "permerror",
]);

export interface AuthVerdict {
  readonly spf: AuthResult;
  readonly dkim: AuthResult;
  readonly dmarc: AuthResult;
}

export const UNKNOWN_VERDICT: AuthVerdict = {
  spf: "unknown",
  dkim: "unknown",
  dmarc: "unknown",
};

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

export type TrustReason =
  | "dmarc_pass"
  | "spf_dkim_pass"
  | "unauthenticated_sender"
  | "dmarc_fail"
  | "instruction_like_content";

export const AuthVerdict = {
  parseResult(input: string | null | undefined): AuthResult {
    if (input === null || input === undefined) return "unknown";
    const value = input.trim().toLowerCase();
    return KNOWN_RESULTS.has(value) ? (value as AuthResult) : "unknown";
  },

  /**
   * Read an `Authentication-Results` header, e.g.
   * `mx.cloudflare.net; spf=pass ...; dkim=pass ...; dmarc=fail ...`
   *
   * Only the first occurrence of each method is taken: a relay may prepend its
   * own results, and a forged downstream `dkim=pass` must not override the
   * verdict recorded by the host that actually did the check.
   */
  fromAuthenticationResults(header: string | null | undefined): AuthVerdict {
    if (!header) return UNKNOWN_VERDICT;
    const read = (method: "spf" | "dkim" | "dmarc"): AuthResult => {
      const match = new RegExp(`(?:^|[;\\s])${method}\\s*=\\s*([a-zA-Z]+)`).exec(header);
      return AuthVerdict.parseResult(match?.[1]);
    };
    return { spf: read("spf"), dkim: read("dkim"), dmarc: read("dmarc") };
  },

  assess(verdict: AuthVerdict, signals: ContentSignals = {}): TrustAssessment {
    const reasons: TrustReason[] = [];

    let trusted = false;
    if (verdict.dmarc === "pass") {
      trusted = true;
      reasons.push("dmarc_pass");
    } else if (verdict.spf === "pass" && verdict.dkim === "pass") {
      trusted = true;
      reasons.push("spf_dkim_pass");
    } else if (verdict.dmarc === "fail") {
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
