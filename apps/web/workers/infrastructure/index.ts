/**
 * Cloudflare implementations of the ports declared in `@mailworker/core`.
 *
 * Flat, with a `d1-` / `r2-` prefix instead of a folder per technology. The
 * prefix already answers "which service is this", so a directory that answers it
 * again would only add a level to every path. Nothing here decides anything: if
 * a rule needs changing it belongs in `core`.
 */

export type { Db } from "@web/workers/infrastructure/d1.ts";
export { createDb, toDate, toIsoText } from "@web/workers/infrastructure/d1.ts";
export {
  D1ApiKeys,
  D1Domains,
  D1Identities,
} from "@web/workers/infrastructure/d1-identity.ts";
export { D1Inboxes } from "@web/workers/infrastructure/d1-inboxes.ts";
export { D1Messages } from "@web/workers/infrastructure/d1-messages.ts";
export { D1Outbound } from "@web/workers/infrastructure/d1-outbound.ts";
export { D1Suppressions } from "@web/workers/infrastructure/d1-suppressions.ts";
export { R2Blobs } from "@web/workers/infrastructure/r2-blobs.ts";
export * as schema from "@web/workers/infrastructure/schema.ts";
