import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The point of the in-memory adapters: no environment, no miniflare, no
    // network. If this ever needs more than `node`, something has leaked.
    environment: "node",
  },
});
