import { StacksApiClient, StacksNodeClient } from "./chain-clients.js";
import { loadConfig, redactConfig } from "./config.js";
import { inspectDeployedManager } from "./manager-verification.js";
import { runOperatorPreflight } from "./preflight.js";
import { verifyManagerRegistration } from "./registration-verification.js";
import { createServer } from "./server.js";

const [command = "help", argument] = process.argv.slice(2);

if (command === "serve") {
  const server = createServer();
  await server.listen({ host: "127.0.0.1", port: 3998 });
} else if (command === "preflight") {
  const config = loadConfig(process.env);
  const node = new StacksNodeClient(config.nodeRpcUrl);
  const api = new StacksApiClient(config.apiUrl, config.apiKey, config.apiKeyHeader);
  const result = await runOperatorPreflight(config, node, api);
  console.log(JSON.stringify({ config: redactConfig(config), result }, null, 2));
  if (result.status === "fail") process.exitCode = 2;
} else if (command === "attach") {
  if (!argument) throw new Error("Usage: sidekick attach <manager-contract-principal>");
  const config = loadConfig(process.env);
  const node = new StacksNodeClient(config.nodeRpcUrl);
  const api = new StacksApiClient(config.apiUrl, config.apiKey, config.apiKeyHeader);
  const [preflight, manager] = await Promise.all([
    runOperatorPreflight(config, node, api),
    inspectDeployedManager(node, config.network, argument),
  ]);
  const registration =
    manager.attachAllowed && preflight.pox.pox5ContractId
      ? await verifyManagerRegistration(node, preflight.pox.pox5ContractId, argument)
      : null;
  console.log(
    JSON.stringify({ config: redactConfig(config), preflight, manager, registration }, null, 2),
  );
  if (preflight.status === "fail" || !manager.attachAllowed) process.exitCode = 2;
} else {
  console.log(`Signer Sidekick scaffold

Usage:
  sidekick serve    Start the loopback-only local API
  sidekick preflight  Verify node, API, network, lag, and PoX-5 readiness
  sidekick attach <manager>  Verify and attach an existing manager in Observe mode

Environment:
  STACKS_NODE_RPC_URL  Required node RPC base URL
  SIDEKICK_NETWORK     mainnet (default), testnet, devnet, or regtest
  STACKS_API_URL       Optional for mainnet/testnet; defaults to Hiro
  STACKS_API_KEY       Optional API key; never included in output`);
}
