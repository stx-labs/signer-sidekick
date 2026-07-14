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
    });
    expect(redactConfig(config)).not.toHaveProperty("apiKey");
    expect(redactConfig(config)).toMatchObject({ apiKeyConfigured: true });
  });

  it("requires an explicit API URL for regtest", () => {
    expect(() =>
      loadConfig({ SIDEKICK_NETWORK: "regtest", STACKS_NODE_RPC_URL: "http://node:20443" }),
    ).toThrow("STACKS_API_URL is required for regtest");
  });

  it("rejects credentials embedded in endpoint URLs", () => {
    expect(() =>
      loadConfig({ STACKS_NODE_RPC_URL: "http://user:password@127.0.0.1:20443" }),
    ).toThrow("must not contain credentials");
  });
});
