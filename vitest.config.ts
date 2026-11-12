import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/**/*.ts"],
      provider: "v8",
    },
    environment: "node",
    include: ["test/**/*.test.ts"],
    maxWorkers: 8,
    testTimeout: 10_000,
  },
});
