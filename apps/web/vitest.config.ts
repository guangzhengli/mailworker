import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { packageAliases } from "../../vitest.shared";

/**
 * `virtual:react-router/server-build` only exists once React Router's Vite
 * plugin has run, and running it here would mean building the whole client
 * bundle before a single assertion — seconds per run, to test `/v1`, `email()`
 * and a Durable Object, none of which the dashboard touches.
 *
 * So the module is stubbed, and the stub THROWS. A stub that returned an empty
 * build would make `SELF.fetch("/")` quietly render nothing and pass, which is
 * the failure mode this whole suite exists to avoid (see the conformance note
 * above). If a test ever does reach the dashboard, it gets this sentence.
 */
function stubServerBuild(): Plugin {
  const id = "virtual:react-router/server-build";
  return {
    name: "mailworker:stub-server-build",
    resolveId: (source) => (source === id ? `\0${id}` : null),
    load: (resolved) =>
      resolved === `\0${id}`
        ? `export const routes = {};
           export const entry = {
             module: {
               default() {
                 throw new Error(
                   "The dashboard is not built in the workerd suite. Test route loaders " +
                     "directly, or add a Vitest project that runs the React Router plugin."
                 );
               },
             },
           };
           export const assets = { entry: { module: "", imports: [] }, routes: {}, url: "", version: "test" };
           export const publicPath = "/";
           export const assetsBuildDirectory = "build/client";
           export const future = {};
           export const isSpaMode = false;
           export const ssr = true;
           export const basename = "/";`
        : null,
  };
}

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
    stubServerBuild(),
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
        // Bound, because `mailworker deploy` creates it alongside D1 — a
        // deployment without it is not a state that exists. `send_email` is
        // deliberately NOT bound: "can receive, cannot send" IS a real
        // deployment (Email Routing is free, Email Sending needs Workers Paid),
        // so the suite runs in that shape and proves the send path is durable
        // right up to the network call.
        queueProducers: { DISPATCH_QUEUE: "mailworker-dispatch" },
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
