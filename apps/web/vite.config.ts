import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
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
 *
 * Plugin order is load-bearing, not alphabetical. `tailwindcss()` has to scan
 * and generate before `reactRouter()` takes over the module graph and decides
 * which stylesheets belong to which route — put it after, and `app/styles.css`
 * is already claimed by the time Tailwind would have rewritten it, so `vite
 * dev` serves the pre-generation file and utility classes silently do nothing.
 * Tailwind is build-time only: it emits a CSS asset and adds nothing to the
 * Worker bundle, so ADR-8's budget is not involved.
 */
export default defineConfig({
  plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), tailwindcss(), reactRouter()],
  resolve: { alias: packageAliases },
});
