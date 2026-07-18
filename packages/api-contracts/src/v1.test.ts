import { describe, expect, it } from "vitest";
import { runtimeSettingsSchema } from "./v1.js";

describe("V1 runtime settings contract", () => {
  it("strips retired settings from legacy-shaped responses", () => {
    const parsed = runtimeSettingsSchema.parse({
      schemaVersion: 1,
      revision: 2,
      updatedAt: "2026-07-17T12:00:00.000Z",
      pool: {
        displayName: "Pool",
        websiteUrl: "",
        supportContact: "",
        leatherUrl: "https://earn.leather.io",
      },
      display: {
        timezone: "UTC",
        timeFormat: "relative",
        numberFormat: "1,234.5678",
        defaultTheme: "system",
      },
      dataSources: {
        nodeRpcUrl: "http://127.0.0.1:20443",
        apiUrl: "https://api.mainnet.hiro.so",
        apiKeyHeader: "x-api-key",
        apiKeyConfigured: false,
        apiKeySource: "none",
        nodeMetricsUrl: "",
        signerMonitoringUrl: "",
        hiroReferenceApiUrl: "",
      },
      forecast: { horizonCycles: 12 },
      embed: { type: "live", publicApiUrl: "https://pool.example.com" },
      payoutPolicy: { maxTransactionFeeUstx: "100000" },
      automation: { mode: "observe", gasPayerPrincipal: "" },
      alerts: { webhookUrl: "", criticalOnly: false },
      audit: [],
    });

    expect(parsed.display).toEqual({ defaultTheme: "system" });
    expect(parsed.embed).toEqual({ publicApiUrl: "https://pool.example.com" });
    expect(parsed).not.toHaveProperty("payoutPolicy");
    expect(parsed).not.toHaveProperty("automation");
    expect(parsed).not.toHaveProperty("alerts");
  });
});
