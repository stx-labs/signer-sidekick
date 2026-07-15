/// <reference types="vitest" />

import { vitestSetupFilePath } from "@stacks/clarinet-sdk/vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/integration/regtest/lifecycle.test.ts"],
    environment: "clarinet",
    pool: "forks",
    isolate: false,
    maxWorkers: 1,
    setupFiles: [vitestSetupFilePath],
    environmentOptions: {
      clarinet: {
        manifestPath: "test/integration/regtest/Clarinet.toml",
        initBeforeEach: true,
        coverage: false,
        costs: false,
      },
    },
  },
});
