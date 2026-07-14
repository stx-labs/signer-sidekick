import { StacksApiClient, StacksNodeClient } from "./chain-clients.js";
import { loadConfig, redactConfig } from "./config.js";
import { evaluatePreflight } from "./preflight.js";
import { createServer } from "./server.js";

const [command = "help"] = process.argv.slice(2);

if (command === "serve") {
  const server = createServer();
  await server.listen({ host: "127.0.0.1", port: 3998 });
} else if (command === "preflight") {
  const config = loadConfig(process.env);
  const node = new StacksNodeClient(config.nodeRpcUrl);
  const api = new StacksApiClient(config.apiUrl, config.apiKey, config.apiKeyHeader);
  const [nodeInfo, nodePoxInfo, apiNodeInfo, apiStatus] = await Promise.all([
    node.getInfo(),
    node.getPoxInfo(),
    api.getNodeInfo(),
    api.getStatus(),
  ]);
  const result = evaluatePreflight(config, { nodeInfo, nodePoxInfo, apiNodeInfo, apiStatus });
  console.log(JSON.stringify({ config: redactConfig(config), result }, null, 2));
  if (result.status === "fail") process.exitCode = 2;
} else {
  console.log(`Signer Sidekick scaffold

Usage:
  sidekick serve    Start the loopback-only local API
  sidekick preflight  Verify node, API, network, lag, and PoX-5 readiness

Environment:
  STACKS_NODE_RPC_URL  Required node RPC base URL
  SIDEKICK_NETWORK     mainnet (default), testnet, devnet, or regtest
  STACKS_API_URL       Optional for mainnet/testnet; defaults to Hiro
  STACKS_API_KEY       Optional API key; never included in output`);
}
