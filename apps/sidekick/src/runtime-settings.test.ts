import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { InteractiveRequestCancelledError, withOperatorRequestSignal } from "./request-context.js";
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
  it("loads persisted v1 settings with the migrated indexed credential", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-15T12:00:00.000Z");
    stores.push(store);
    store.runtimeSettings.put({
      settings: {
        schemaVersion: 1,
        pool: {
          displayName: "Existing pool",
          websiteUrl: "",
          supportContact: "",
          leatherUrl: "https://earn.leather.io",
        },
        display: { defaultTheme: "system" },
        dataSources: {
          nodeRpcUrl: "http://127.0.0.1:20443",
          apiUrl: "https://api.mainnet.hiro.so",
          apiKeyHeader: "x-api-key",
          apiKeyMode: "database",
          nodeMetricsUrl: "",
          signerMonitoringUrl: "",
          hiroReferenceApiUrl: "https://api.mainnet.hiro.so",
        },
        forecast: { horizonCycles: 6 },
        embed: { publicApiUrl: "https://api.mainnet.hiro.so" },
      },
      apiCredentials: {
        "indexed-api": {
          value: "migrated-secret",
          boundUrl: "https://api.mainnet.hiro.so",
        },
      },
      changedFields: ["dataSources.apiKey"],
      observedAt: "2026-07-15T12:00:00.000Z",
    });

    const runtime = new RuntimeSettingsController(
      loadConfig({ STACKS_NODE_RPC_URL: "http://127.0.0.1:20443" }),
      store,
      "SP000000000000000000002Q6VF78.signer-manager",
      async () => {},
    );
    expect(runtime.publicSettings()).toMatchObject({
      schemaVersion: 2,
      pool: { displayName: "Existing pool" },
      dataSources: {
        apiKeySource: "database",
        hiroReferenceApiKeySource: "indexed-api",
        hiroReferenceApiKeyHeader: "x-api-key",
      },
    });
    expect(runtime.effectiveConfig().apiKey).toBe("migrated-secret");
  });

  it("applies independent source credentials without returning either secret", async () => {
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
          hiroReferenceApiUrl: "https://reference.example.com/",
          hiroReferenceApiKeyHeader: "authorization",
          hiroReferenceApiKeyAction: {
            action: "replace",
            value: "Bearer reference-secret",
          },
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
        hiroReferenceApiUrl: "https://reference.example.com",
        hiroReferenceApiKeyConfigured: true,
        hiroReferenceApiKeySource: "database",
      },
      forecast: { horizonCycles: 24 },
      embed: { publicApiUrl: "https://public-api.example.com" },
    });
    expect(JSON.stringify(updated)).not.toContain("database-secret");
    expect(JSON.stringify(updated)).not.toContain("reference-secret");
    expect(runtime.effectiveConfig()).toMatchObject({
      nodeRpcUrl: "https://node.example.com",
      apiUrl: "https://api.example.com",
      apiKey: "database-secret",
      apiKeyHeader: "x-custom-key",
      hiroReferenceApiKey: "Bearer reference-secret",
      hiroReferenceApiKeyHeader: "authorization",
      forecastHorizonCycles: 24,
    });
    expect(updated.audit[0]?.changedFields).toContain("dataSources.apiKey");
    expect(updated.audit[0]?.changedFields).toContain("dataSources.hiroReferenceApiKey");
  });

  it("rejects credential-bearing URLs and falls back to the environment after removing an override", async () => {
    const runtime = await controller();
    const current = runtime.publicSettings();
    const replaced = await runtime.update({
      pool: current.pool,
      display: current.display,
      dataSources: {
        nodeRpcUrl: current.dataSources.nodeRpcUrl,
        apiUrl: current.dataSources.apiUrl,
        apiKeyHeader: current.dataSources.apiKeyHeader,
        apiKeyAction: { action: "replace" as const, value: "saved-secret" },
      },
      forecast: current.forecast,
      embed: current.embed,
    });
    expect(replaced.dataSources.apiKeySource).toBe("database");
    const input = {
      pool: replaced.pool,
      display: replaced.display,
      dataSources: {
        nodeRpcUrl: replaced.dataSources.nodeRpcUrl,
        apiUrl: replaced.dataSources.apiUrl,
        apiKeyHeader: replaced.dataSources.apiKeyHeader,
        apiKeyAction: { action: "remove-override" as const },
      },
      forecast: replaced.forecast,
      embed: replaced.embed,
    };
    expect((await runtime.update(input)).dataSources).toMatchObject({
      apiKeyConfigured: true,
      apiKeySource: "environment",
    });
    expect(runtime.effectiveConfig()).toMatchObject({ apiKey: "environment-secret" });
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

  it("reuses an indexed key only for a same-origin reference and drops saved keys on origin changes", async () => {
    const runtime = await controller();
    expect(runtime.publicSettings().dataSources).toMatchObject({
      apiKeySource: "environment",
      hiroReferenceApiKeyConfigured: true,
      hiroReferenceApiKeySource: "indexed-api",
    });
    const current = runtime.publicSettings();
    await runtime.update({
      pool: current.pool,
      display: current.display,
      dataSources: {
        nodeRpcUrl: current.dataSources.nodeRpcUrl,
        apiUrl: current.dataSources.apiUrl,
        apiKeyHeader: current.dataSources.apiKeyHeader,
        apiKeyAction: { action: "replace", value: "origin-bound-secret" },
        hiroReferenceApiUrl: "https://reference.example.com",
      },
      forecast: current.forecast,
      embed: current.embed,
    });
    const withOverride = runtime.publicSettings();
    expect(withOverride.dataSources).toMatchObject({
      apiKeySource: "database",
      hiroReferenceApiKeyConfigured: false,
      hiroReferenceApiKeySource: "none",
    });

    const changed = await runtime.update({
      pool: withOverride.pool,
      display: withOverride.display,
      dataSources: {
        nodeRpcUrl: withOverride.dataSources.nodeRpcUrl,
        apiUrl: "https://other-indexer.example.com",
        apiKeyHeader: withOverride.dataSources.apiKeyHeader,
        apiKeyAction: { action: "keep" },
        hiroReferenceApiUrl: withOverride.dataSources.hiroReferenceApiUrl,
      },
      forecast: withOverride.forecast,
      embed: withOverride.embed,
    });

    expect(changed.dataSources).toMatchObject({
      apiKeyConfigured: false,
      apiKeySource: "none",
    });
    expect(runtime.effectiveConfig()).not.toHaveProperty("apiKey");
    expect(JSON.stringify(changed)).not.toContain("origin-bound-secret");
  });

  it("drops a saved reference key when its URL is cleared", async () => {
    const runtime = await controller();
    const current = runtime.publicSettings();
    const configured = await runtime.update({
      pool: current.pool,
      display: current.display,
      dataSources: {
        nodeRpcUrl: current.dataSources.nodeRpcUrl,
        apiUrl: current.dataSources.apiUrl,
        apiKeyHeader: current.dataSources.apiKeyHeader,
        apiKeyAction: { action: "keep" },
        hiroReferenceApiUrl: "https://reference.example.com",
        hiroReferenceApiKeyAction: { action: "replace", value: "reference-secret" },
      },
      forecast: current.forecast,
      embed: current.embed,
    });
    expect(configured.dataSources.hiroReferenceApiKeySource).toBe("database");

    const cleared = await runtime.update({
      pool: configured.pool,
      display: configured.display,
      dataSources: {
        nodeRpcUrl: configured.dataSources.nodeRpcUrl,
        apiUrl: configured.dataSources.apiUrl,
        apiKeyHeader: configured.dataSources.apiKeyHeader,
        apiKeyAction: { action: "keep" },
        hiroReferenceApiUrl: "",
        hiroReferenceApiKeyAction: { action: "keep" },
      },
      forecast: configured.forecast,
      embed: configured.embed,
    });

    expect(cleared.dataSources).toMatchObject({
      hiroReferenceApiUrl: "",
      hiroReferenceApiKeyConfigured: false,
      hiroReferenceApiKeySource: "none",
    });
    expect(runtime.effectiveConfig()).not.toHaveProperty("hiroReferenceApiKey");
    expect(JSON.stringify(cleared)).not.toContain("reference-secret");
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

  it("does not commit an unrelated update after health validation is cancelled", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-15T12:00:00.000Z");
    stores.push(store);
    const runtime = new RuntimeSettingsController(
      loadConfig({
        STACKS_NODE_RPC_URL: "http://127.0.0.1:20443",
        STACKS_NODE_METRICS_URL: "http://127.0.0.1:9153",
      }),
      store,
      "SP000000000000000000002Q6VF78.signer-manager",
      async () => {},
    );
    const current = runtime.publicSettings();
    const controller = new AbortController();
    const update = withOperatorRequestSignal(controller.signal, async () =>
      runtime.update({
        pool: { ...current.pool, displayName: "Cancelled pool name" },
        display: current.display,
        dataSources: {
          nodeRpcUrl: current.dataSources.nodeRpcUrl,
          apiUrl: current.dataSources.apiUrl,
          apiKeyHeader: current.dataSources.apiKeyHeader,
          apiKeyAction: { action: "keep" },
          nodeMetricsUrl: current.dataSources.nodeMetricsUrl,
          signerMonitoringUrl: current.dataSources.signerMonitoringUrl,
          hiroReferenceApiUrl: current.dataSources.hiroReferenceApiUrl,
        },
        forecast: current.forecast,
        embed: current.embed,
      }),
    );
    controller.abort(new InteractiveRequestCancelledError());

    await expect(update).rejects.toBeInstanceOf(InteractiveRequestCancelledError);
    expect(runtime.publicSettings()).toMatchObject({
      revision: 0,
      pool: { displayName: current.pool.displayName },
      audit: [],
    });
    expect(store.runtimeSettings.get()).toBeNull();
  });

  it("rechecks cancellation after validation before committing settings", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-07-15T12:00:00.000Z");
    stores.push(store);
    let validationStarted = () => {};
    const started = new Promise<void>((resolve) => {
      validationStarted = resolve;
    });
    let finishValidation = () => {};
    const validationFinished = new Promise<void>((resolve) => {
      finishValidation = resolve;
    });
    const runtime = new RuntimeSettingsController(
      loadConfig({
        SIDEKICK_NETWORK: "devnet",
        STACKS_NODE_RPC_URL: "http://127.0.0.1:20443",
        STACKS_API_URL: "http://127.0.0.1:3999",
      }),
      store,
      "ST000000000000000000002AMW42H.signer-manager",
      async () => {
        validationStarted();
        await validationFinished;
      },
    );
    const current = runtime.publicSettings();
    const controller = new AbortController();
    const update = withOperatorRequestSignal(controller.signal, async () =>
      runtime.update({
        pool: current.pool,
        display: current.display,
        dataSources: {
          nodeRpcUrl: current.dataSources.nodeRpcUrl,
          apiUrl: "http://127.0.0.1:4000",
          apiKeyHeader: current.dataSources.apiKeyHeader,
          apiKeyAction: { action: "keep" },
          nodeMetricsUrl: current.dataSources.nodeMetricsUrl,
          signerMonitoringUrl: current.dataSources.signerMonitoringUrl,
          hiroReferenceApiUrl: current.dataSources.hiroReferenceApiUrl,
        },
        forecast: current.forecast,
        embed: current.embed,
      }),
    );
    await started;
    controller.abort(new InteractiveRequestCancelledError());
    finishValidation();

    await expect(update).rejects.toBeInstanceOf(InteractiveRequestCancelledError);
    expect(runtime.publicSettings()).toMatchObject({ revision: 0, audit: [] });
    expect(store.runtimeSettings.get()).toBeNull();
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
