import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    testTimeout: 15000,
    hookTimeout: 15000,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html", "json", "lcov"],
      include: ["src/**/*.ts"],
      thresholds: { statements: 95, branches: 90, functions: 95, lines: 95 },
    },
  },
});
