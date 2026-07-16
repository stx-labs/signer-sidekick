import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/sidekick/src/**/*.test.ts",
      "packages/core/**/*.test.ts",
      "packages/protocol/**/*.test.ts",
    ],
    exclude: ["**/dist/**", "**/node_modules/**"],
    coverage: {
      provider: "v8",
      include: [
        "apps/sidekick/src/**/*.ts",
        "packages/core/src/**/*.ts",
        "packages/protocol/src/**/*.ts",
      ],
      exclude: [
        "**/*.test.ts",
        "apps/sidekick/src/main.ts",
        "packages/protocol/src/generate-manager.ts",
      ],
      reporter: ["text-summary", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      thresholds: {
        statements: 77,
        branches: 70,
        functions: 81,
        lines: 79,
      },
    },
  },
});
