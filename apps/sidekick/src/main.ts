import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createAttachActivationPlan, createFreshActivationPlan } from "./activation-plan.js";
import { StacksApiClient, StacksNodeClient } from "./chain-clients.js";
import { loadConfig, redactConfig, sidekickNetworkSchema } from "./config.js";
import { createPoolEnrollmentDocument } from "./enrollment-info.js";
import { renderManagerDeployment } from "./manager-render.js";
import { inspectDeployedManager } from "./manager-verification.js";
import { createOperatorRecord } from "./operator-record.js";
import { runOperatorPreflight } from "./preflight.js";
import { verifyManagerRegistration } from "./registration-verification.js";
import { createServer } from "./server.js";
import { readPoolSetupStatus } from "./setup-status.js";
import { prepareSignerGrant, verifySignerGrantOutput } from "./signer-grant.js";
import { openSidekickStore } from "./storage/store.js";
import { createSupportBundle } from "./support-bundle.js";

const [command = "help", ...arguments_] = process.argv.slice(2);

function clientsFromConfig(config: ReturnType<typeof loadConfig>) {
  return {
    node: new StacksNodeClient(config.nodeRpcUrl),
    api: new StacksApiClient(config.apiUrl, config.apiKey, config.apiKeyHeader),
  };
}

async function setupContext(managerPrincipal: string) {
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
  const setup = await readPoolSetupStatus(node, preflight, manager, registration);
  return { config, preflight, manager, registration, setup };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
}

if (command === "serve") {
  const server = createServer();
  await server.listen({ host: "127.0.0.1", port: 3998 });
} else if (command === "config" && arguments_[0] === "validate") {
  const config = loadConfig(process.env);
  console.log(JSON.stringify({ valid: true, config: redactConfig(config) }, null, 2));
} else if (command === "doctor") {
  const config = loadConfig(process.env);
  const { store, backupPath } = await openSidekickStore(config.databasePath);
  try {
    console.log(
      JSON.stringify(
        {
          status: "ok",
          config: redactConfig(config),
          database: store.databaseStatus(),
          migrationBackupCreated: backupPath,
        },
        null,
        2,
      ),
    );
  } finally {
    store.close();
  }
} else if (command === "init" && arguments_[0] === "fresh") {
  const [, adminPrincipal, contractName, outputDirectory, authId, signerConfigPath] = arguments_;
  if (!adminPrincipal || !contractName || !outputDirectory || !authId) {
    throw new Error(
      "Usage: sidekick init fresh <admin-principal> <contract-name> <output-directory> <auth-id> [signer-config-path]",
    );
  }
  const config = loadConfig(process.env);
  const { node, api } = clientsFromConfig(config);
  const preflight = await runOperatorPreflight(config, node, api);
  const activationPlan = createFreshActivationPlan({
    network: config.network,
    preflight,
    adminPrincipal,
    contractName,
    outputDirectory,
    authId,
    ...(signerConfigPath ? { signerConfigPath } : {}),
  });
  console.log(JSON.stringify({ config: redactConfig(config), preflight, activationPlan }, null, 2));
  if (activationPlan.status === "blocked") process.exitCode = 2;
} else if (command === "init" && arguments_[0] === "attach") {
  const [, managerPrincipal] = arguments_;
  if (!managerPrincipal) throw new Error("Usage: sidekick init attach <manager-principal>");
  const { config, preflight, manager, registration, setup } = await setupContext(managerPrincipal);
  const activationPlan = createAttachActivationPlan(preflight, manager, registration, setup);
  console.log(JSON.stringify({ config: redactConfig(config), activationPlan }, null, 2));
  if (activationPlan.status === "blocked") process.exitCode = 2;
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
} else if (command === "manager" && arguments_[0] === "verify") {
  const [, managerPrincipal] = arguments_;
  if (!managerPrincipal) throw new Error("Usage: sidekick manager verify <manager-principal>");
  const config = loadConfig(process.env);
  const { node } = clientsFromConfig(config);
  const manager = await inspectDeployedManager(node, config.network, managerPrincipal);
  console.log(JSON.stringify({ config: redactConfig(config), manager }, null, 2));
  if (!manager.attachAllowed) process.exitCode = 2;
} else if (command === "setup" && arguments_[0] === "status") {
  const [, managerPrincipal] = arguments_;
  if (!managerPrincipal) throw new Error("Usage: sidekick setup status <manager-principal>");
  const { config, preflight, manager, registration, setup } = await setupContext(managerPrincipal);
  console.log(
    JSON.stringify(
      { config: redactConfig(config), preflight, manager, registration, setup },
      null,
      2,
    ),
  );
  if (setup.status === "blocked") process.exitCode = 2;
} else if (command === "pool" && arguments_[0] === "enrollment-info") {
  const [, managerPrincipal, poolConfigPath] = arguments_;
  if (!managerPrincipal || !poolConfigPath) {
    throw new Error("Usage: sidekick pool enrollment-info <manager-principal> <pool-config.json>");
  }
  const poolConfig = await readJson(poolConfigPath);
  const { preflight, manager, registration, setup } = await setupContext(managerPrincipal);
  const enrollment = createPoolEnrollmentDocument(
    poolConfig,
    preflight,
    manager,
    registration,
    setup,
  );
  console.log(JSON.stringify(enrollment, null, 2));
  if (!enrollment.readiness.enrollmentReady) process.exitCode = 2;
} else if (command === "setup" && arguments_[0] === "record") {
  const [, managerPrincipal, poolConfigPath, recordMetadataPath] = arguments_;
  if (!managerPrincipal || !poolConfigPath) {
    throw new Error(
      "Usage: sidekick setup record <manager-principal> <pool-config.json> [record-metadata.json]",
    );
  }
  const [poolConfig, recordMetadata] = await Promise.all([
    readJson(poolConfigPath),
    recordMetadataPath ? readJson(recordMetadataPath) : { schemaVersion: 1 },
  ]);
  const { preflight, manager, registration, setup } = await setupContext(managerPrincipal);
  const enrollment = createPoolEnrollmentDocument(
    poolConfig,
    preflight,
    manager,
    registration,
    setup,
  );
  const record = createOperatorRecord(
    recordMetadata,
    preflight,
    manager,
    registration,
    setup,
    enrollment,
  );
  console.log(JSON.stringify(record, null, 2));
  if (setup.status === "blocked") process.exitCode = 2;
} else if (command === "export" && arguments_[0] === "support-bundle") {
  const [, managerPrincipal, poolConfigPath, recordMetadataPath] = arguments_;
  if (!managerPrincipal) {
    throw new Error(
      "Usage: sidekick export support-bundle <manager-principal> [pool-config.json] [record-metadata.json]",
    );
  }
  const [poolConfig, recordMetadata] = await Promise.all([
    poolConfigPath ? readJson(poolConfigPath) : null,
    recordMetadataPath ? readJson(recordMetadataPath) : { schemaVersion: 1 },
  ]);
  const { config, preflight, manager, registration, setup } = await setupContext(managerPrincipal);
  const enrollment = poolConfig
    ? createPoolEnrollmentDocument(poolConfig, preflight, manager, registration, setup)
    : null;
  const record = createOperatorRecord(
    recordMetadata,
    preflight,
    manager,
    registration,
    setup,
    enrollment,
  );
  const bundle = createSupportBundle(
    config,
    preflight,
    manager,
    registration,
    setup,
    record,
    enrollment,
    process.env.npm_package_version,
  );
  console.log(JSON.stringify(bundle, null, 2));
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
  sidekick config validate  Validate and print redacted endpoint configuration
  sidekick doctor  Open, migrate, and verify the local SQLite store
  sidekick init fresh <admin> <name> <output-dir> <auth-id> [signer-config]
  sidekick init attach <manager>  Build an activation plan from a running manager
  sidekick preflight  Verify node, API, network, lag, and PoX-5 readiness
  sidekick attach <manager>  Verify and attach an existing manager in Observe mode
  sidekick manager verify <manager>  Verify deployed source and interface compatibility
  sidekick setup status <manager>  Verify registration and current/next eligibility
  sidekick setup record <manager> <pool-config.json> [record-metadata.json]
  sidekick pool enrollment-info <manager> <pool-config.json>
  sidekick export support-bundle <manager> [pool-config.json] [record-metadata.json]
  sidekick manager render <admin> <name> <output-dir>
  sidekick signer-grant prepare <manager> <auth-id> [signer-config]
  sidekick signer-grant verify <manager> <auth-id> <signer-output.json>

Environment:
  STACKS_NODE_RPC_URL  Required node RPC base URL for connected commands
  SIDEKICK_NETWORK     mainnet (default), testnet, devnet, or regtest
  STACKS_API_URL       Optional for mainnet/testnet; defaults to Hiro
  STACKS_API_KEY       Optional API key; never included in output
  SIDEKICK_DATABASE_PATH  Optional SQLite path; defaults to data/sidekick.sqlite
  SIDEKICK_CONTRACTS_DIR  Optional path to the pinned contracts directory`);
}
