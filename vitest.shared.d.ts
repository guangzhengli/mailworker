/**
 * The alias map, mirroring `paths` in tsconfig.base.json.
 *
 * Shared rather than per-package because a package that consumes another's
 * SOURCE has to resolve the aliases inside that source too. When `@mailworker/mime`
 * imports `@mailworker/core`, Vite loads core's `.ts` files and hits their
 * `@core/*` specifiers — so every package needs the whole map, not just its own
 * entry. That is exactly what a bare `@/*` cannot express.
 */
export declare const packageAliases: Record<string, string>;
