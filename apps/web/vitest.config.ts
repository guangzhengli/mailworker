import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { packageAliases } from "../../vitest.shared.ts";

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
      miniflare: {
        compatibilityDate: "2026-07-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        r2Buckets: ["BLOBS"],
        // Handed to the setup file, which applies them once per suite. Storage
        // is isolated per test and rolled back afterwards, so every test starts
        // from a migrated but empty database.
        bindings: { TEST_MIGRATIONS: migrations },
      },
    }),
  ],
  resolve: { alias: packageAliases },
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
