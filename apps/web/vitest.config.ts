import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { packageAliases } from "../../vitest.shared";

/**
 * These tests run inside workerd, against a real D1 and a real R2 — not a
 * SQLite stand-in and not a mock.
 *
 * That is the whole point of them. `packages/core` proves the business rules in
 * ~250ms against in-memory adapters, which is only worth anything if those
 * adapters behave like the real thing. Proving THAT needs the real thing, and no
 * cheaper substitute would: it is exactly the differences between a Map and
 * SQLite — unique constraints, NULL comparison, JSON functions, text collation —
 * that this suite is looking for.
 *
 * Slower, so it is a separate project. The fast suite stays the one people run
 * on every save.
 */
const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      // The deployed entry point, loaded in the same isolate as the tests. That
      // is what makes `SELF.fetch` exercise the real router — middleware, error
      // translation and all — instead of a handler imported in isolation, and
      // what lets the Durable Object below resolve without a script name.
      main: "./workers/entry.ts",
      miniflare: {
        compatibilityDate: "2026-07-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        r2Buckets: ["BLOBS"],
        // The waiter is a real Durable Object here, not a stand-in. Half of
        // what `wait` has to get right — that a message arriving mid-wait wakes
        // the caller, that the look-back and the listener do not both answer —
        // is about two things happening at once, which a fake would decide for
        // us rather than test.
        durableObjects: { WAITER: "MessageWaiter" },
        bindings: {
          // Handed to the setup file, which applies them once per suite.
          TEST_MIGRATIONS: migrations,
          // The two the container reads. Bound here rather than taken from
          // wrangler.jsonc because one of them is a secret in production and
          // must not be declared in a file that gets deployed.
          MAILWORKER_ACCOUNT_ID: "default",
          MAILWORKER_ADMIN_KEY: "test-bootstrap-key",
        },
      },
    }),
  ],
  resolve: { alias: packageAliases },
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
