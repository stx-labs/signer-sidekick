import { describe, expect, it } from "vitest";
import { StacksApiClient, StacksNodeClient } from "../../../apps/sidekick/src/chain-clients.js";
import { loadConfig } from "../../../apps/sidekick/src/config.js";
import { runOperatorPreflight } from "../../../apps/sidekick/src/preflight.js";

const enabled = process.env.RUN_REGTEST === "1";
const suite = enabled ? describe : describe.skip;

suite("Epoch 4.0 external regtest/devnet", () => {
  it("passes the production preflight boundary with PoX-5 available", async () => {
    const config = loadConfig({
      SIDEKICK_NETWORK: process.env.SIDEKICK_NETWORK ?? "regtest",
      STACKS_NODE_RPC_URL: process.env.STACKS_NODE_RPC_URL ?? "http://127.0.0.1:20443",
      STACKS_API_URL: process.env.STACKS_API_URL ?? "http://127.0.0.1:3999",
      STACKS_API_KEY: process.env.STACKS_API_KEY,
      STACKS_API_KEY_HEADER: process.env.STACKS_API_KEY_HEADER,
      SIDEKICK_MAX_API_BURN_BLOCK_LAG: process.env.SIDEKICK_MAX_API_BURN_BLOCK_LAG,
    });
    const node = new StacksNodeClient(config.nodeRpcUrl);
    const api = new StacksApiClient(config.apiUrl, config.apiKey, config.apiKeyHeader);
    const result = await runOperatorPreflight(config, node, api);

    expect(result.status).not.toBe("fail");
    expect(result.pox.pox5Available).toBe(true);
    expect(result.checks.find((check) => check.id === "node-network")?.status).toBe("pass");
    expect(result.checks.find((check) => check.id === "api-network")?.status).toBe("pass");
  });
});
