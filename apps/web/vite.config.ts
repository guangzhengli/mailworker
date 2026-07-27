import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import { packageAliases } from "../../vitest.shared";

/**
 * The dashboard and the Worker are one build (ADR-6).
 *
 * `cloudflare()` runs the SSR environment inside workerd during `vite dev`,
 * with the real bindings from wrangler.jsonc — so a loader that queries D1 is
 * doing in development exactly what it does in production, against a local D1
 * rather than a stub. `viteEnvironment.name: "ssr"` is what tells it to host
 * React Router's server build rather than a second, separate Worker.
 */
export default defineConfig({
  plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), reactRouter()],
  resolve: { alias: packageAliases },
});
