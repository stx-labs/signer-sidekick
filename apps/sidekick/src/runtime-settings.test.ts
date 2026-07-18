import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { RuntimeSettingsController } from "./runtime-settings.js";
import { openSidekickStore, type SidekickStore } from "./storage/store.js";

const stores: SidekickStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function controller() {
  const { store } = await openSidekickStore(":memory:", "2026-07-15T12:00:00.000Z");
  stores.push(store);
  const config = loadConfig({
    STACKS_NODE_RPC_URL: "http://127.0.0.1:20443",
    STACKS_API_KEY: "environment-secret",
  });
  return new RuntimeSettingsController(
    config,
    store,
    "SP000000000000000000002Q6VF78.signer-manager",
    async () => {},
  );
}

describe("runtime settings", () => {
  it("applies provider and API-key replacement without returning the secret", async () => {
    const runtime = await controller();
    const current = runtime.publicSettings();
    const updated = await runtime.update(
      {
        pool: { ...current.pool, displayName: "Live node pool" },
        display: current.display,
        dataSources: {
          nodeRpcUrl: "https://node.example.com/",
          apiUrl: "https://api.example.com/",
          apiKeyHeader: "x-custom-key",
          apiKeyAction: { action: "replace", value: "database-secret" },
        },
        forecast: { horizonCycles: 24 },
        embed: { publicApiUrl: "https://public-api.example.com/" },
      },
      "2026-07-15T12:01:00.000Z",
    );

    expect(updated).toMatchObject({
      revision: 1,
      pool: { displayName: "Live node pool" },
      dataSources: {
        nodeRpcUrl: "https://node.example.com",
        apiUrl: "https://api.example.com",
        apiKeyConfigured: true,
        apiKeySource: "database",
      },
      forecast: { horizonCycles: 24 },
      embed: { publicApiUrl: "https://public-api.example.com" },
    });
    expect(JSON.stringify(updated)).not.toContain("database-secret");
    expect(runtime.effectiveConfig()).toMatchObject({
      nodeRpcUrl: "https://node.example.com",
      apiUrl: "https://api.example.com",
      apiKey: "database-secret",
      apiKeyHeader: "x-custom-key",
      forecastHorizonCycles: 24,
    });
    expect(updated.audit[0]?.changedFields).toContain("dataSources.apiKey");
  });

  it("rejects credential-bearing URLs and supports clearing an environment API key", async () => {
    const runtime = await controller();
    const current = runtime.publicSettings();
    const input = {
      pool: current.pool,
      display: current.display,
      dataSources: {
        nodeRpcUrl: current.dataSources.nodeRpcUrl,
        apiUrl: current.dataSources.apiUrl,
        apiKeyHeader: current.dataSources.apiKeyHeader,
        apiKeyAction: { action: "clear" as const },
      },
      forecast: current.forecast,
      embed: current.embed,
    };
    expect((await runtime.update(input)).dataSources.apiKeyConfigured).toBe(false);
    expect(runtime.effectiveConfig()).not.toHaveProperty("apiKey");
    await expect(
      runtime.update({
        ...input,
        dataSources: {
          ...input.dataSources,
          nodeRpcUrl: "https://user:password@node.example.com",
          apiKeyAction: { action: "keep" },
        },
      }),
    ).rejects.toThrow("must not contain credentials");
    await expect(
      runtime.update({
        ...input,
        dataSources: {
          ...input.dataSources,
          nodeMetricsUrl: "http://169.254.169.254/latest/meta-data",
          apiKeyAction: { action: "keep" },
        },
      }),
    ).rejects.toThrow("blocked address");
  });

  it("loads legacy settings after stripping removed fields and drops them on the next save", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-15T12:00:00.000Z");
    stores.push(store);
    store.putRuntimeSettings({
      settings: {
        schemaVersion: 1,
        pool: {
          displayName: "Legacy pool",
          websiteUrl: "",
          supportContact: "",
          leatherUrl: "https://earn.leather.io",
        },
        display: {
          timezone: "America/Denver",
          timeFormat: "both",
          numberFormat: "1 234,5678",
          defaultTheme: "dark",
        },
        dataSources: {
          nodeRpcUrl: "http://127.0.0.1:20443",
          apiUrl: "https://api.mainnet.hiro.so",
          apiKeyHeader: "x-api-key",
          apiKeyMode: "none",
          nodeMetricsUrl: "",
          signerMonitoringUrl: "",
          hiroReferenceApiUrl: "",
        },
        forecast: { horizonCycles: 12 },
        embed: { type: "static", publicApiUrl: "https://pool.example.com" },
        payoutPolicy: {
          minimumDirectSbtcSats: "10000",
          maxTransactionFeeUstx: "100000",
          rollingGasBudgetUstx: "10000000",
        },
        automation: { mode: "observe", gasPayerPrincipal: "" },
        alerts: { webhookUrl: "https://hooks.example.com", criticalOnly: true },
      },
      apiKeySecret: null,
      changedFields: ["pool.displayName"],
      observedAt: "2026-07-15T12:00:00.000Z",
    });
    const runtime = new RuntimeSettingsController(
      loadConfig({ STACKS_NODE_RPC_URL: "http://127.0.0.1:20443" }),
      store,
      "SP000000000000000000002Q6VF78.signer-manager",
      async () => {},
    );

    const current = runtime.publicSettings();
    expect(current.display).toEqual({ defaultTheme: "dark" });
    expect(current.embed).toEqual({ publicApiUrl: "https://pool.example.com" });
    expect(current).not.toHaveProperty("payoutPolicy");
    expect(current).not.toHaveProperty("automation");
    expect(current).not.toHaveProperty("alerts");

    await expect(
      runtime.update({
        pool: current.pool,
        display: current.display,
        dataSources: {
          nodeRpcUrl: current.dataSources.nodeRpcUrl,
          apiUrl: current.dataSources.apiUrl,
          apiKeyHeader: current.dataSources.apiKeyHeader,
          apiKeyAction: { action: "keep" },
        },
        forecast: current.forecast,
        embed: current.embed,
        alerts: { webhookUrl: "https://hooks.example.com", criticalOnly: true },
      }),
    ).rejects.toThrow();

    await runtime.update({
      pool: { ...current.pool, displayName: "Current pool" },
      display: current.display,
      dataSources: {
        nodeRpcUrl: current.dataSources.nodeRpcUrl,
        apiUrl: current.dataSources.apiUrl,
        apiKeyHeader: current.dataSources.apiKeyHeader,
        apiKeyAction: { action: "keep" },
      },
      forecast: current.forecast,
      embed: current.embed,
    });
    expect(JSON.stringify(store.getRuntimeSettings()?.settings)).not.toMatch(
      /payoutPolicy|automation|alerts|timezone|timeFormat|numberFormat|"type"/,
    );
  });

  it("validates changed node and API sources before committing them", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-15T12:00:00.000Z");
    stores.push(store);
    const config = loadConfig({ STACKS_NODE_RPC_URL: "http://127.0.0.1:20443" });
    const candidates: string[] = [];
    const runtime = new RuntimeSettingsController(
      config,
      store,
      "SP000000000000000000002Q6VF78.signer-manager",
      async (candidate) => {
        candidates.push(candidate.apiUrl);
        throw new Error("Candidate sources are unavailable");
      },
    );
    const current = runtime.publicSettings();

    await expect(
      runtime.update({
        pool: current.pool,
        display: current.display,
        dataSources: {
          nodeRpcUrl: "https://node.example.com",
          apiUrl: "https://api.example.com",
          apiKeyHeader: current.dataSources.apiKeyHeader,
          apiKeyAction: { action: "keep" },
        },
        forecast: current.forecast,
        embed: current.embed,
      }),
    ).rejects.toThrow("Candidate sources are unavailable");
    expect(candidates).toEqual(["https://api.example.com"]);
    expect(runtime.publicSettings()).toMatchObject({
      revision: 0,
      dataSources: { nodeRpcUrl: "http://127.0.0.1:20443" },
    });
  });

  it("rejects non-HTTP pool links", async () => {
    const runtime = await controller();
    const current = runtime.publicSettings();
    await expect(
      runtime.update({
        pool: { ...current.pool, websiteUrl: "javascript:alert(1)" },
        display: current.display,
        dataSources: {
          nodeRpcUrl: current.dataSources.nodeRpcUrl,
          apiUrl: current.dataSources.apiUrl,
          apiKeyHeader: current.dataSources.apiKeyHeader,
          apiKeyAction: { action: "keep" },
        },
        forecast: current.forecast,
        embed: current.embed,
      }),
    ).rejects.toThrow("Expected an HTTP(S) URL");
  });
});
