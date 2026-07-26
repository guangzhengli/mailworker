import { defineConfig } from "vitest/config";
import { packageAliases } from "../../vitest.shared";

export default defineConfig({
  resolve: { alias: packageAliases },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
