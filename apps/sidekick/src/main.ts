import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { StacksApiClient, StacksNodeClient } from "./chain-clients.js";
import { loadConfig, redactConfig, sidekickNetworkSchema } from "./config.js";
import { renderManagerDeployment } from "./manager-render.js";
import { inspectDeployedManager } from "./manager-verification.js";
import { runOperatorPreflight } from "./preflight.js";
import { verifyManagerRegistration } from "./registration-verification.js";
import { createServer } from "./server.js";
import { prepareSignerGrant, verifySignerGrantOutput } from "./signer-grant.js";

const [command = "help", ...arguments_] = process.argv.slice(2);

function clientsFromConfig(config: ReturnType<typeof loadConfig>) {
  return {
    node: new StacksNodeClient(config.nodeRpcUrl),
    api: new StacksApiClient(config.apiUrl, config.apiKey, config.apiKeyHeader),
  };
}

if (command === "serve") {
  const server = createServer();
  await server.listen({ host: "127.0.0.1", port: 3998 });
} else if (command === "preflight") {
  const config = loadConfig(process.env);
  const { node, api } = clientsFromConfig(config);
  const result = await runOperatorPreflight(config, node, api);
  console.log(JSON.stringify({ config: redactConfig(config), result }, null, 2));
  if (result.status === "fail") process.exitCode = 2;
} else if (command === "attach") {
  const [managerPrincipal] = arguments_;
  if (!managerPrincipal) throw new Error("Usage: sidekick attach <manager-contract-principal>");
  const config = loadConfig(process.env);
  const { node, api } = clientsFromConfig(config);
  const [preflight, manager] = await Promise.all([
    runOperatorPreflight(config, node, api),
    inspectDeployedManager(node, config.network, managerPrincipal),
  ]);
  const registration =
    manager.attachAllowed && preflight.pox.pox5ContractId
      ? await verifyManagerRegistration(node, preflight.pox.pox5ContractId, managerPrincipal)
      : null;
  console.log(
    JSON.stringify({ config: redactConfig(config), preflight, manager, registration }, null, 2),
  );
  if (preflight.status === "fail" || !manager.attachAllowed) process.exitCode = 2;
} else if (command === "manager" && arguments_[0] === "render") {
  const [, adminPrincipal, contractName, outputDirectory] = arguments_;
  if (!adminPrincipal || !contractName || !outputDirectory) {
    throw new Error(
      "Usage: sidekick manager render <admin-principal> <contract-name> <output-directory>",
    );
  }
  const network = sidekickNetworkSchema.parse(process.env.SIDEKICK_NETWORK ?? "mainnet");
  const contractsDirectory =
    process.env.SIDEKICK_CONTRACTS_DIR ?? resolve(import.meta.dirname, "../../../contracts");
  const rendered = await renderManagerDeployment({
    network,
    adminPrincipal,
    contractName,
    outputDirectory,
    contractsDirectory,
  });
  console.log(JSON.stringify(rendered, null, 2));
  if (!rendered.manifest.deploymentAllowed) process.exitCode = 3;
} else if (command === "signer-grant" && arguments_[0] === "prepare") {
  const [, managerPrincipal, authId, signerConfigPath] = arguments_;
  if (!managerPrincipal || !authId) {
    throw new Error(
      "Usage: sidekick signer-grant prepare <manager-principal> <auth-id> [signer-config-path]",
    );
  }
  const config = loadConfig(process.env);
  const { node, api } = clientsFromConfig(config);
  const preflight = await runOperatorPreflight(config, node, api);
  if (preflight.status === "fail" || !preflight.pox.pox5ContractId) {
    throw new Error("Signer grant preparation requires a successful preflight with active PoX-5");
  }
  const preparation = await prepareSignerGrant(
    node,
    preflight.pox.pox5ContractId,
    managerPrincipal,
    authId,
    signerConfigPath,
  );
  console.log(
    JSON.stringify(
      {
        config: redactConfig(config),
        verifiedAt: {
          burnBlockHeight: preflight.node.burnBlockHeight,
          stacksTipHeight: preflight.node.stacksTipHeight,
        },
        preparation,
      },
      null,
      2,
    ),
  );
} else if (command === "signer-grant" && arguments_[0] === "verify") {
  const [, managerPrincipal, authId, signerOutputPath] = arguments_;
  if (!managerPrincipal || !authId || !signerOutputPath) {
    throw new Error(
      "Usage: sidekick signer-grant verify <manager-principal> <auth-id> <signer-output.json>",
    );
  }
  const config = loadConfig(process.env);
  const { node, api } = clientsFromConfig(config);
  const preflight = await runOperatorPreflight(config, node, api);
  if (preflight.status === "fail" || !preflight.pox.pox5ContractId) {
    throw new Error("Signer grant verification requires a successful preflight with active PoX-5");
  }
  const signerOutput = JSON.parse(await readFile(resolve(signerOutputPath), "utf8")) as unknown;
  const verified = await verifySignerGrantOutput(
    node,
    preflight.pox.pox5ContractId,
    managerPrincipal,
    authId,
    signerOutput,
  );
  console.log(
    JSON.stringify(
      {
        config: redactConfig(config),
        verifiedAt: {
          burnBlockHeight: preflight.node.burnBlockHeight,
          stacksTipHeight: preflight.node.stacksTipHeight,
        },
        verified,
      },
      null,
      2,
    ),
  );
} else {
  console.log(`Signer Sidekick scaffold

Usage:
  sidekick serve    Start the loopback-only local API
  sidekick preflight  Verify node, API, network, lag, and PoX-5 readiness
  sidekick attach <manager>  Verify and attach an existing manager in Observe mode
  sidekick manager render <admin> <name> <output-dir>
  sidekick signer-grant prepare <manager> <auth-id> [signer-config]
  sidekick signer-grant verify <manager> <auth-id> <signer-output.json>

Environment:
  STACKS_NODE_RPC_URL  Required node RPC base URL for connected commands
  SIDEKICK_NETWORK     mainnet (default), testnet, devnet, or regtest
  STACKS_API_URL       Optional for mainnet/testnet; defaults to Hiro
  STACKS_API_KEY       Optional API key; never included in output
  SIDEKICK_CONTRACTS_DIR  Optional path to the pinned contracts directory`);
}
