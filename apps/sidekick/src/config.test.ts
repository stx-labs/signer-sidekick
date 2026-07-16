import { describe, expect, it } from "vitest";
import { loadConfig, redactConfig } from "./config.js";

describe("Sidekick configuration", () => {
  it("uses the mainnet Hiro API default and redacts its key", () => {
    const config = loadConfig({
      STACKS_NODE_RPC_URL: "http://127.0.0.1:20443/",
      STACKS_API_KEY: "secret-key",
    });

    expect(config).toMatchObject({
      network: "mainnet",
      nodeRpcUrl: "http://127.0.0.1:20443",
      apiUrl: "https://api.mainnet.hiro.so",
      apiKey: "secret-key",
      apiKeyHeader: "x-api-key",
      maxApiBurnBlockLag: 12,
      forecastHorizonCycles: 6,
      stakerPageLimit: 200,
      eventPageLimit: 100,
      databasePath: expect.stringMatching(/data\/sidekick\.sqlite$/),
    });
    expect(redactConfig(config)).not.toHaveProperty("apiKey");
    expect(redactConfig(config)).toMatchObject({ apiKeyConfigured: true });
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
