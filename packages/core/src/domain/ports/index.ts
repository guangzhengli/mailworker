/**
 * Everything the application layer needs from the outside world, expressed as
 * interfaces it owns.
 *
 * Two rules keep this honest:
 *
 * 1. Every method takes an `Caller` first. An AccountId is never read from
 *    env, a module constant, or defaulted inside an adapter — that discipline is
 *    what makes the eventual multi-tenant migration a configuration change
 *    rather than an audit of every query (DESIGN.md §6).
 * 2. No Cloudflare type appears here. `D1Database`, `R2Bucket` and `Queue` exist
 *    only in the adapters that implement these.
 */

export * from "@core/domain/ports/messaging";
export * from "@core/domain/ports/repositories";
export * from "@core/domain/ports/storage";
export * from "@core/domain/ports/system";
export * from "@core/domain/ports/transport";
