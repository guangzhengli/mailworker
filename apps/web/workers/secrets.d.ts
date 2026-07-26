/**
 * Secrets, which `wrangler types` cannot see.
 *
 * It generates `Env` from wrangler.jsonc, and a secret must not be declared
 * there — anything in that file is committed and deployed in the clear. So the
 * type is stated here and the value is set with `wrangler secret put`.
 *
 * Declared twice because the generated file makes two unrelated `Env` types:
 * the global one that handlers receive, and `Cloudflare.Env`, which is what
 * `cloudflare:test` hands to the suite. They both extend the generated base
 * rather than each other, so augmenting one does not reach the other.
 *
 * Optional, because it genuinely is: a deployment that has minted a real API
 * key should unset it, and the auth path reads an absent or empty value as "no
 * bootstrap credential exists" rather than as a misconfiguration.
 */
interface Env {
  readonly MAILWORKER_ADMIN_KEY?: string;
}

declare namespace Cloudflare {
  interface Env {
    readonly MAILWORKER_ADMIN_KEY?: string;
  }
}
