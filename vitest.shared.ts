import { fileURLToPath } from "node:url";

/**
 * The alias map, mirroring `paths` in tsconfig.base.json.
 *
 * Shared rather than per-package because a package that consumes another's
 * SOURCE has to resolve the aliases inside that source too. When `@mailworker/mime`
 * imports `@mailworker/core`, Vite loads core's `.ts` files and hits their
 * `@core/*` specifiers — so every package needs the whole map, not just its own
 * entry. That is exactly what a bare `@/*` cannot express.
 */
export const packageAliases: Record<string, string> = {
  "@core": fileURLToPath(new URL("./packages/core/src", import.meta.url)),
  "@mime": fileURLToPath(new URL("./packages/mime/src", import.meta.url)),
  "@shared": fileURLToPath(new URL("./packages/shared/src", import.meta.url)),
  "@web": fileURLToPath(new URL("./apps/web", import.meta.url)),
};
