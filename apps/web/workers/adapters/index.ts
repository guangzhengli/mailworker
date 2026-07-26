/**
 * DRIVEN adapters: Cloudflare implementations of the ports `@mailworker/core`
 * declares. These are things the application calls out to.
 *
 * The DRIVING side — the HTTP routes, the `email()` handler, the `queue()`
 * consumer, all the things that call INTO the application — are siblings of
 * this directory, not neighbours inside it. Mixing the two is how "where does a
 * request enter" stops being answerable by reading the file tree.
 *
 * Flat within, with a `d1-` / `r2-` prefix instead of a folder per technology:
 * the prefix already answers "which service is this". Nothing here decides
 * anything; if a rule needs changing it belongs in `core`.
 */

export type { Db } from "@web/workers/adapters/d1";
export { createDb, toDate, toIsoText } from "@web/workers/adapters/d1";
export { D1Deliveries } from "@web/workers/adapters/d1-deliveries";
export {
  D1ApiKeys,
  D1Domains,
  D1Identities,
} from "@web/workers/adapters/d1-identity";
export { D1Inboxes } from "@web/workers/adapters/d1-inboxes";
export { D1Messages } from "@web/workers/adapters/d1-messages";
export { D1Suppressions } from "@web/workers/adapters/d1-suppressions";
export { LoggingEventBus } from "@web/workers/adapters/events";
export { R2Blobs } from "@web/workers/adapters/r2-blobs";
export * as schema from "@web/workers/adapters/schema";
export { SystemClock, UlidGenerator, WebCryptoSecrets } from "@web/workers/adapters/system";
export { UnconfiguredTransport } from "@web/workers/adapters/transport";
