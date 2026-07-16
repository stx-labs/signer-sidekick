import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e/dashboard",
  outputDir: "./test/e2e/devnet/test-results",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI
    ? [
        ["line"],
        ["junit", { outputFile: "test/e2e/devnet/test-results/junit.xml" }],
        ["html", { outputFolder: "test/e2e/devnet/playwright-report", open: "never" }],
      ]
    : "line",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command:
      "pnpm --filter @stx-labs/signer-sidekick-dashboard dev --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "tablet", use: { viewport: { width: 768, height: 1024 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
  ],
});
