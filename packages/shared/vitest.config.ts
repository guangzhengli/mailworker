import { defineConfig } from "vitest/config";
import { packageAliases } from "../../vitest.shared.ts";

export default defineConfig({
  resolve: { alias: packageAliases },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
