import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit only generates migrations here; it never talks to D1 directly.
 * Applying them is `wrangler d1 migrations apply`, which is also what
 * `mailworker deploy` will call — one code path for local and remote.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./workers/infrastructure/schema.ts",
  out: "./migrations",
});
