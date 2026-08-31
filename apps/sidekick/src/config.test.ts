import { describe, expect, it } from "vitest";
import {
  hiroReferenceApiCredential,
  indexedApiCredential,
  loadConfig,
  loadManagerPrincipal,
  redactConfig,
} from "./config.js";

describe("Sidekick configuration", () => {
  it("requires a syntactically valid configured manager contract principal", () => {
    expect(() => loadManagerPrincipal({})).toThrow("SIDEKICK_MANAGER_PRINCIPAL is required");
    expect(() => loadManagerPrincipal({ SIDEKICK_MANAGER_PRINCIPAL: "not-a-contract" })).toThrow(
      "must be a valid contract principal",
    );
    expect(
      loadManagerPrincipal({
        SIDEKICK_MANAGER_PRINCIPAL: " SP000000000000000000002Q6VF78.signer-manager ",
      }),
    ).toBe("SP000000000000000000002Q6VF78.signer-manager");
  });

  it("uses the mainnet Hiro API default and redacts its key", () => {
    const config = loadConfig({
      STACKS_NODE_RPC_URL: "http://127.0.0.1:20443/",
      STACKS_API_KEY: "secret-key",
    });

    expect(config).toMatchObject({
      network: "mainnet",
      nodeRpcUrl: "http://127.0.0.1:20443",
      apiUrl: "https://api.mainnet.hiro.so",
      hiroReferenceApiUrl: "https://api.mainnet.hiro.so",
      apiKey: "secret-key",
      apiKeyOrigin: "https://api.mainnet.hiro.so",
      apiKeyHeader: "x-api-key",
      hiroReferenceApiKeyHeader: "x-api-key",
      maxApiBurnBlockLag: 12,
      forecastHorizonCycles: 6,
      stakerPageLimit: 200,
      eventPageLimit: 100,
      databasePath: expect.stringMatching(/data\/sidekick\.sqlite$/),
    });
    expect(redactConfig(config)).not.toHaveProperty("apiKey");
    expect(redactConfig(config)).toMatchObject({ apiKeyConfigured: true });
    expect(indexedApiCredential(config)).toEqual({
      headerName: "x-api-key",
      value: "secret-key",
    });
    expect(hiroReferenceApiCredential(config)).toEqual({
      headerName: "x-api-key",
      value: "secret-key",
    });
  });

  it("loads optional node and signer health endpoints", () => {
    expect(
      loadConfig({
        STACKS_NODE_RPC_URL: "http://node:20443",
        STACKS_NODE_METRICS_URL: "http://node:9153/metrics",
        STACKS_SIGNER_MONITORING_URL: "http://signer:9153",
        HIRO_REFERENCE_API_URL: "https://reference.example.com",
        HIRO_REFERENCE_API_KEY: "reference-secret",
        HIRO_REFERENCE_API_KEY_HEADER: "authorization",
      }),
    ).toMatchObject({
      nodeMetricsUrl: "http://node:9153/metrics",
      signerMonitoringUrl: "http://signer:9153",
      hiroReferenceApiUrl: "https://reference.example.com",
      hiroReferenceApiKey: "reference-secret",
      hiroReferenceApiKeyOrigin: "https://reference.example.com",
      hiroReferenceApiKeyHeader: "authorization",
    });
  });

  it("does not reuse an API key across origins", () => {
    const config = loadConfig({
      STACKS_NODE_RPC_URL: "http://node:20443",
      STACKS_API_KEY: "indexed-secret",
      HIRO_REFERENCE_API_URL: "https://reference.example.com",
    });

    expect(indexedApiCredential(config)?.value).toBe("indexed-secret");
    expect(hiroReferenceApiCredential(config)).toBeUndefined();
  });

  it("requires an explicit API URL for regtest", () => {
    expect(() =>
      loadConfig({ SIDEKICK_NETWORK: "regtest", STACKS_NODE_RPC_URL: "http://node:20443" }),
    ).toThrow("STACKS_API_URL is required for regtest");
  });

  it("treats an empty Compose API override as absent", () => {
    const config = loadConfig({
      SIDEKICK_NETWORK: "testnet",
      STACKS_NODE_RPC_URL: "http://node:20443",
      STACKS_API_URL: "",
    });

    expect(config.network).toBe("testnet");
    expect(config.apiUrl).toBe("https://api.testnet.hiro.so");
  });

  it("maps the deprecated pox5-testnet selector to testnet", () => {
    const config = loadConfig({
      SIDEKICK_NETWORK: "pox5-testnet",
      STACKS_NODE_RPC_URL: "http://node:20443",
    });

    expect(config.network).toBe("testnet");
    expect(config.apiUrl).toBe("https://api.testnet.hiro.so");
  });

  it("accepts a custom unsigned 32-bit network ID", () => {
    expect(
      loadConfig({
        STACKS_NODE_RPC_URL: "http://node:20443",
        SIDEKICK_NETWORK_ID: "256",
      }).expectedNetworkId,
    ).toBe(256);
    expect(
      loadConfig({
        STACKS_NODE_RPC_URL: "http://node:20443",
        SIDEKICK_NETWORK_ID: "0",
      }).expectedNetworkId,
    ).toBe(0);
  });

  it("resolves an optional installed trusted-manager profile directory", () => {
    const config = loadConfig({
      STACKS_NODE_RPC_URL: "http://node:20443",
      SIDEKICK_TRUSTED_MANAGER_PROFILES_DIR: "./trusted-managers",
    });
    expect(config.trustedManagerProfilesDirectory).toMatch(/trusted-managers$/);
    expect(redactConfig(config).trustedManagerProfilesDirectory).toBe(
      config.trustedManagerProfilesDirectory,
    );
  });

  it("resolves the operator-provided network compatibility directory", () => {
    const config = loadConfig({
      STACKS_NODE_RPC_URL: "http://node:20443",
      SIDEKICK_COMPATIBILITY_PROFILES_DIR: "./network-compatibility",
    });
    expect(config).toMatchObject({
      compatibilityProfilesDirectory: expect.stringMatching(/network-compatibility$/),
    });
  });

  it.each([
    "-1",
    "1.5",
    "4294967296",
    "not-a-number",
  ])("rejects invalid custom network ID %s", (networkId) => {
    expect(() =>
      loadConfig({
        STACKS_NODE_RPC_URL: "http://node:20443",
        SIDEKICK_NETWORK_ID: networkId,
      }),
    ).toThrow();
  });

  it("rejects credentials embedded in endpoint URLs", () => {
    expect(() =>
      loadConfig({ STACKS_NODE_RPC_URL: "http://user:password@127.0.0.1:20443" }),
    ).toThrow("must not contain credentials");
  });

  it("rejects endpoint query parameters so tokens cannot leak through redacted output", () => {
    expect(() =>
      loadConfig({ STACKS_NODE_RPC_URL: "http://127.0.0.1:20443?token=secret" }),
    ).toThrow("must not contain query parameters or a fragment");
  });

  it("rejects non-HTTP endpoint schemes", () => {
    expect(() => loadConfig({ STACKS_NODE_RPC_URL: "data:text/plain,not-a-node" })).toThrow(
      "must use http or https",
    );
  });

  it("rejects API key headers that override HTTP transport headers", () => {
    expect(() =>
      loadConfig({
        STACKS_NODE_RPC_URL: "http://127.0.0.1:20443",
        STACKS_API_KEY_HEADER: "Host",
      }),
    ).toThrow("STACKS_API_KEY_HEADER is invalid");
  });

  it("bounds the operator forecast horizon to the PoX-5 lock period", () => {
    expect(() =>
      loadConfig({
        STACKS_NODE_RPC_URL: "http://127.0.0.1:20443",
        SIDEKICK_FORECAST_HORIZON_CYCLES: "97",
      }),
    ).toThrow();
  });

  it("allows bounded pagination sizes for deterministic reconciliation testing", () => {
    const config = loadConfig({
      STACKS_NODE_RPC_URL: "http://127.0.0.1:20443",
      SIDEKICK_STAKER_PAGE_LIMIT: "2",
      SIDEKICK_EVENT_PAGE_LIMIT: "1",
    });
    expect(config).toMatchObject({ stakerPageLimit: 2, eventPageLimit: 1 });
    expect(() =>
      loadConfig({
        STACKS_NODE_RPC_URL: "http://127.0.0.1:20443",
        SIDEKICK_STAKER_PAGE_LIMIT: "201",
      }),
    ).toThrow();
    expect(() =>
      loadConfig({
        STACKS_NODE_RPC_URL: "http://127.0.0.1:20443",
        SIDEKICK_EVENT_PAGE_LIMIT: "0",
      }),
    ).toThrow();
  });

  it.each([
    "SIDEKICK_ADMIN_PRIVATE_KEY",
    "MANAGER_ADMIN_KEY",
    "SIGNER_PRIVATE_KEY",
    "STACKS_PRIVATE_KEY",
    "SIDEKICK_GAS_PAYER_PRIVATE_KEY",
    "SIDEKICK_GAS_PAYER_MNEMONIC",
    "SIGNER_MNEMONIC",
    "SEED_PHRASE",
  ])("rejects forbidden key material supplied as %s", (name) => {
    expect(() =>
      loadConfig({
        STACKS_NODE_RPC_URL: "http://127.0.0.1:20443",
        [name]: "must-never-be-loaded",
      }),
    ).toThrow(`${name} is forbidden`);
  });

  it("does not reject empty forbidden fields inherited from an environment template", () => {
    expect(
      loadConfig({
        STACKS_NODE_RPC_URL: "http://127.0.0.1:20443",
        SIGNER_PRIVATE_KEY: "  ",
      }).network,
    ).toBe("mainnet");
  });
});
