import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Mirrors `paths` in tsconfig.json. Declared here rather than via a
  // tsconfig-paths plugin to keep the resolution rule in one obvious place and
  // one dependency lighter.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // The point of the in-memory adapters: no environment, no miniflare, no
    // network. If this ever needs more than `node`, something has leaked.
    environment: "node",
  },
});
