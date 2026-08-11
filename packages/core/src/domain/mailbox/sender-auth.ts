/**
 * What the receiving MTA reported about the sender: SPF, DKIM, DMARC.
 *
 * Pure data. Whether that adds up to "trusted" is a judgement, and judgements
 * live in the ingestion context — see `SenderTrust`.
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

export interface SenderAuth {
  readonly spf: AuthResult;
  readonly dkim: AuthResult;
  readonly dmarc: AuthResult;
}

export const UNKNOWN_SENDER_AUTH: SenderAuth = {
  spf: "unknown",
  dkim: "unknown",
  dmarc: "unknown",
};

/**
 * Why we did or did not believe the sender. Stored verbatim on every message,
 * so it lives with the data; the rule that PRODUCES it is `SenderTrust`, in the
 * ingestion context, and can change without a migration.
 */
export type TrustReason =
  | "dmarc_pass"
  | "spf_dkim_pass"
  | "unauthenticated_sender"
  | "dmarc_fail";

export const SenderAuth = {
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
  fromHeader(header: string | null | undefined): SenderAuth {
    if (!header) return UNKNOWN_SENDER_AUTH;
    const read = (method: "spf" | "dkim" | "dmarc"): AuthResult => {
      const match = new RegExp(`(?:^|[;\\s])${method}\\s*=\\s*([a-zA-Z]+)`).exec(header);
      return SenderAuth.parseResult(match?.[1]);
    };
    return { spf: read("spf"), dkim: read("dkim"), dmarc: read("dmarc") };
  },
} as const;
