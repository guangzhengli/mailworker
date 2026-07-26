/**
 * `Env` is generated from wrangler.jsonc by `wrangler types`, so anything bound
 * only for tests has to be merged in here rather than added there — bindings in
 * wrangler.jsonc would be deployed.
 */
declare namespace Cloudflare {
  interface Env {
    readonly TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
