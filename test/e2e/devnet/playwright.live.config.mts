import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "live-dashboard.spec.mts",
  outputDir: "./test-results/live",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [
    ["line"],
    ["junit", { outputFile: "./test-results/live/junit.xml" }],
    ["html", { outputFolder: "./playwright-report/live", open: "never" }],
  ],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:3998",
    // The live login credential necessarily crosses the browser boundary. Do not retain browser
    // state artifacts that can serialize typed values or Authorization headers; JUnit, HTML, page
    // assertions, and the separately scrubbed service logs remain available for diagnosis.
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
