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
        embed: { type: "live", publicApiUrl: "https://public-api.example.com/" },
        payoutPolicy: current.payoutPolicy,
        automation: current.automation,
        alerts: current.alerts,
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
      payoutPolicy: current.payoutPolicy,
      automation: current.automation,
      alerts: current.alerts,
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
  });

  it("rejects the manager admin and wrong-network gas-payer principals", async () => {
    const runtime = await controller();
    const current = runtime.publicSettings();
    const input = {
      pool: current.pool,
      display: current.display,
      dataSources: {
        nodeRpcUrl: current.dataSources.nodeRpcUrl,
        apiUrl: current.dataSources.apiUrl,
        apiKeyHeader: current.dataSources.apiKeyHeader,
        apiKeyAction: { action: "keep" as const },
      },
      forecast: current.forecast,
      embed: current.embed,
      payoutPolicy: current.payoutPolicy,
      automation: {
        ...current.automation,
        gasPayerPrincipal: "SP000000000000000000002Q6VF78",
      },
      alerts: current.alerts,
    };

    await expect(runtime.update(input)).rejects.toThrow(
      "Gas-payer principal must not be the manager admin principal",
    );
    await expect(
      runtime.update({
        ...input,
        automation: {
          ...input.automation,
          gasPayerPrincipal: "ST000000000000000000002AMW42H",
        },
      }),
    ).rejects.toThrow("Gas-payer principal does not match the configured network");
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
        payoutPolicy: current.payoutPolicy,
        automation: current.automation,
        alerts: current.alerts,
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
        payoutPolicy: current.payoutPolicy,
        automation: current.automation,
        alerts: current.alerts,
      }),
    ).rejects.toThrow("Expected an HTTP(S) URL");
  });
});
