import { defineConfig } from "vitest/config";
import { packageAliases } from "../../vitest.shared.ts";

export default defineConfig({
  resolve: { alias: packageAliases },
  test: {
    include: ["test/**/*.test.ts"],
    // The point of the in-memory adapters: no environment, no miniflare, no
    // network. If this ever needs more than `node`, something has leaked.
    environment: "node",
  },
});
