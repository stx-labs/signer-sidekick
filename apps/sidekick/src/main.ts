import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createAttachActivationPlan, createFreshActivationPlan } from "./activation-plan.js";
import { StacksApiClient, StacksNodeClient } from "./chain-clients.js";
import { loadConfig, redactConfig } from "./config.js";
import { createPoolEnrollmentDocument } from "./enrollment-info.js";
import { syncManagerEvents } from "./manager-event-sync.js";
import { assertManagerRenderPreflight, renderManagerDeployment } from "./manager-render.js";
import {
  createInstalledManagerProfile,
  parseManagerTrustArguments,
  writeInstalledManagerProfile,
} from "./manager-trust.js";
import {
  createManagerVerificationContext,
  inspectDeployedManager,
  type ManagerVerificationContext,
} from "./manager-verification.js";
import {
  compatibilityProfileByIdentity,
  loadNetworkCompatibilityProfiles,
} from "./network-compatibility-store.js";
import { OnboardingService } from "./onboarding-service.js";
import { createOperatorRecord } from "./operator-record.js";
import { OperatorService } from "./operator-service.js";
import { readPoolForecast } from "./pool-forecast.js";
import { runOperatorPreflight } from "./preflight.js";
import { verifyManagerRegistration } from "./registration-verification.js";
import { readStxRewardStatus } from "./reward-status.js";
import { RuntimeSettingsController } from "./runtime-settings.js";
import { createServer } from "./server.js";
import { readPoolSetupStatus } from "./setup-status.js";
import { prepareSignerGrant, verifySignerGrantOutput } from "./signer-grant.js";
import { syncSignerStakers } from "./signer-staker-sync.js";
import {
  backupSidekickDatabase,
  createChainSourceId,
  createNodeSourceId,
  openSidekickStore,
} from "./storage/store.js";
import { createSupportBundle } from "./support-bundle.js";

const [command = "help", ...arguments_] = process.argv.slice(2);

function clientsFromConfig(config: ReturnType<typeof loadConfig>) {
  return {
    node: new StacksNodeClient(config.nodeRpcUrl),
    api: new StacksApiClient(config.apiUrl, config.apiKey, config.apiKeyHeader),
  };
}

function contractsDirectory(): string {
  return process.env.SIDEKICK_CONTRACTS_DIR ?? resolve(import.meta.dirname, "../../../contracts");
}

let verificationContextPromise: Promise<ManagerVerificationContext> | null = null;
function verificationContext(config: ReturnType<typeof loadConfig>) {
  verificationContextPromise ??= createManagerVerificationContext({
    contractsDirectory: contractsDirectory(),
    ...(config.trustedManagerProfilesDirectory
      ? { trustedProfilesDirectory: config.trustedManagerProfilesDirectory }
      : {}),
    ...(config.expectedNetworkId !== undefined
      ? { expectedNetworkId: config.expectedNetworkId }
      : {}),
    ...(config.compatibilityProfilesDirectory
      ? { compatibilityProfilesDirectory: config.compatibilityProfilesDirectory }
      : {}),
  });
  return verificationContextPromise;
}

async function setupContext(managerPrincipal: string) {
  const config = loadConfig(process.env);
  const { node, api } = clientsFromConfig(config);
  const managerVerification = await verificationContext(config);
  const [preflight, manager] = await Promise.all([
    runOperatorPreflight(config, node, api),
    inspectDeployedManager(node, config.network, managerPrincipal, managerVerification),
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
  const config = loadConfig(process.env);
  const managerPrincipal = process.env.SIDEKICK_MANAGER_PRINCIPAL;
  if (!managerPrincipal) throw new Error("SIDEKICK_MANAGER_PRINCIPAL is required for serve");
  const authToken = process.env.SIDEKICK_AUTH_TOKEN;
  if (!authToken) throw new Error("SIDEKICK_AUTH_TOKEN is required for serve");
  const portValue = process.env.SIDEKICK_HTTP_PORT ?? "3998";
  if (!/^[0-9]+$/.test(portValue)) {
    throw new Error("SIDEKICK_HTTP_PORT must be an integer from 1 through 65535");
  }
  const port = Number(portValue);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SIDEKICK_HTTP_PORT must be an integer from 1 through 65535");
  }
  const host = process.env.SIDEKICK_HTTP_HOST ?? "127.0.0.1";
  const { store } = await openSidekickStore(config.databasePath);
  const runtimeSettings = new RuntimeSettingsController(config, store, managerPrincipal);
  const { config: effectiveConfig, node, api } = runtimeSettings.clients();
  const managerVerification = await verificationContext(config);
  const networkCompatibility = await loadNetworkCompatibilityProfiles({
    ...(config.compatibilityProfilesDirectory
      ? { directory: config.compatibilityProfilesDirectory }
      : {}),
  });
  const service = new OperatorService({
    config: effectiveConfig,
    managerPrincipal,
    store,
    node,
    api,
    runtimeSettings,
    managerVerification,
  });
  const onboarding = new OnboardingService({
    store,
    runtimeSettings,
    managerPrincipal,
    contractsDirectory: contractsDirectory(),
    managerVerification,
  });
  const staticDirectory = process.env.SIDEKICK_STATIC_DIRECTORY;
  const server = createServer({
    service,
    onboarding,
    authToken,
    ...(staticDirectory ? { staticDirectory: resolve(staticDirectory) } : {}),
  });
  for (const issue of managerVerification.installedProfiles.issues) {
    server.log.warn(
      { code: issue.code, fileName: issue.fileName },
      `Installed trusted-manager profile ignored: ${issue.message}`,
    );
  }
  for (const issue of networkCompatibility.issues) {
    server.log.warn(
      { code: issue.code, fileName: issue.fileName },
      `Network compatibility profile ignored: ${issue.message}`,
    );
  }
  server.addHook("onClose", async () => store.close());
  await server.listen({ host, port });
  server.log.info("HTTP control plane is listening; initial manager observation is running");
  void service
    .observeManagerTrustState()
    .then(() => server.log.info("Initial manager observation completed"))
    .catch((error: unknown) =>
      server.log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "Initial manager observation failed; the next synchronization or snapshot will retry",
      ),
    );
} else if (command === "config" && arguments_[0] === "validate") {
  const config = loadConfig(process.env);
  console.log(JSON.stringify({ valid: true, config: redactConfig(config) }, null, 2));
} else if (command === "doctor") {
  const config = loadConfig(process.env);
  const [managerVerification, networkCompatibility] = await Promise.all([
    verificationContext(config),
    loadNetworkCompatibilityProfiles({
      ...(config.compatibilityProfilesDirectory
        ? { directory: config.compatibilityProfilesDirectory }
        : {}),
    }),
  ]);
  const { store, backupPath } = await openSidekickStore(config.databasePath);
  try {
    console.log(
      JSON.stringify(
        {
          status: "ok",
          config: redactConfig(config),
          database: store.databaseStatus(),
          managerProfiles: {
            directory: managerVerification.installedProfiles.directory,
            loaded: managerVerification.installedProfiles.profiles.length,
            issues: managerVerification.installedProfiles.issues,
          },
          networkCompatibility: {
            directory: networkCompatibility.directory,
            loaded: networkCompatibility.profiles.map(({ profile, origin }) => ({
              id: profile.id,
              revision: profile.revision,
              origin,
            })),
            issues: networkCompatibility.issues,
          },
          migrationBackupCreated: backupPath,
        },
        null,
        2,
      ),
    );
  } finally {
    store.close();
  }
} else if (command === "database" && arguments_[0] === "backup") {
  const [, destination] = arguments_;
  if (!destination) throw new Error("Usage: sidekick database backup <output.sqlite>");
  const databasePath =
    process.env.SIDEKICK_DATABASE_PATH === ":memory:"
      ? ":memory:"
      : resolve(process.env.SIDEKICK_DATABASE_PATH ?? "data/sidekick.sqlite");
  const result = await backupSidekickDatabase(databasePath, destination);
  console.log(JSON.stringify(result, null, 2));
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
  const managerVerification = await verificationContext(config);
  const [preflight, manager] = await Promise.all([
    runOperatorPreflight(config, node, api),
    inspectDeployedManager(node, config.network, managerPrincipal, managerVerification),
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
  const manager = await inspectDeployedManager(
    node,
    config.network,
    managerPrincipal,
    await verificationContext(config),
  );
  console.log(JSON.stringify({ config: redactConfig(config), manager }, null, 2));
  if (!manager.attachAllowed) process.exitCode = 2;
} else if (command === "manager" && arguments_[0] === "trust") {
  const { managerPrincipal, outputPath, observeOnly } = parseManagerTrustArguments(
    arguments_.slice(1),
  );
  const config = loadConfig(process.env);
  const { node } = clientsFromConfig(config);
  const managerVerification = await verificationContext(config);
  if (!managerVerification.upstreamSource && !observeOnly) {
    throw new Error(
      managerVerification.upstreamSourceError ?? "Pinned reference-manager source is unavailable",
    );
  }
  const [contractSource, contractInterface] = await Promise.all([
    node.getContractSource(managerPrincipal),
    node.getContractInterface(managerPrincipal),
  ]);
  const result = createInstalledManagerProfile({
    config,
    managerPrincipal,
    contractSource,
    contractInterface,
    upstreamSource: managerVerification.upstreamSource,
    observeOnly,
  });
  const writtenPath = result.profile
    ? await writeInstalledManagerProfile(outputPath, result.profile)
    : null;
  console.log(
    JSON.stringify(
      {
        status: result.status,
        summary: result.summary,
        outputPath: writtenPath,
        profile: result.profile,
        nextStep: result.profile
          ? "Mount the containing directory read-only at SIDEKICK_TRUSTED_MANAGER_PROFILES_DIR and restart Sidekick"
          : "No installed profile is required",
      },
      null,
      2,
    ),
  );
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
} else if (command === "pool" && arguments_[0] === "sync-stakers") {
  const [, managerPrincipal] = arguments_;
  if (!managerPrincipal) throw new Error("Usage: sidekick pool sync-stakers <manager-principal>");
  const config = loadConfig(process.env);
  const { node, api } = clientsFromConfig(config);
  const managerVerification = await verificationContext(config);
  const [preflight, manager] = await Promise.all([
    runOperatorPreflight(config, node, api),
    inspectDeployedManager(node, config.network, managerPrincipal, managerVerification),
  ]);
  if (preflight.status === "fail" || !preflight.pox.pox5ContractId) {
    throw new Error("Signer-staker sync requires a successful preflight with active PoX-5");
  }
  if (!manager.attachAllowed) {
    throw new Error("Signer-staker sync requires a recognized or compatible manager contract");
  }

  const observedAt = new Date().toISOString();
  const sourceId = createChainSourceId(config.network, config.apiUrl);
  const nodeSourceId = createNodeSourceId(config.network, config.nodeRpcUrl);
  const { store, backupPath } = await openSidekickStore(config.databasePath, observedAt);
  try {
    store.upsertChainSource({
      sourceId,
      kind: "api",
      network: config.network,
      baseUrl: config.apiUrl,
      observedAt,
    });
    store.upsertChainSource({
      sourceId: nodeSourceId,
      kind: "node",
      network: config.network,
      baseUrl: config.nodeRpcUrl,
      observedAt,
    });
    const result = await syncSignerStakers({
      store,
      api,
      node,
      sourceId,
      nodeSourceId,
      managerPrincipal,
      pox5ContractId: preflight.pox.pox5ContractId,
      observedAt,
      burnBlockHeight: preflight.node.burnBlockHeight,
      stacksTipHeight: preflight.node.stacksTipHeight,
      currentRewardCycle: preflight.cycle.currentId,
      pageLimit: config.stakerPageLimit,
    });
    const events = await syncManagerEvents({
      store,
      api,
      sourceId,
      chainId: preflight.node.networkId,
      managerPrincipal,
      observedAt,
      pageLimit: config.eventPageLimit,
    });
    const forecast = await readPoolForecast({
      store,
      node,
      sourceId,
      managerPrincipal,
      pox5ContractId: preflight.pox.pox5ContractId,
      currentRewardCycle: preflight.cycle.currentId,
      horizonCycles: config.forecastHorizonCycles,
      observedAt,
      burnBlockHeight: preflight.node.burnBlockHeight,
      stacksTipHeight: preflight.node.stacksTipHeight,
    });
    console.log(
      JSON.stringify(
        {
          config: redactConfig(config),
          migrationBackupCreated: backupPath,
          observedAt: {
            burnBlockHeight: preflight.node.burnBlockHeight,
            stacksTipHeight: preflight.node.stacksTipHeight,
          },
          result,
          events,
          forecast,
        },
        null,
        2,
      ),
    );
  } finally {
    store.close();
  }
} else if (command === "events" && arguments_[0] === "sync") {
  const [, managerPrincipal] = arguments_;
  if (!managerPrincipal) throw new Error("Usage: sidekick events sync <manager-principal>");
  const config = loadConfig(process.env);
  const { node, api } = clientsFromConfig(config);
  const managerVerification = await verificationContext(config);
  const [preflight, manager] = await Promise.all([
    runOperatorPreflight(config, node, api),
    inspectDeployedManager(node, config.network, managerPrincipal, managerVerification),
  ]);
  if (preflight.status === "fail" || !manager.attachAllowed) {
    throw new Error("Event sync requires a healthy network and recognized manager contract");
  }
  const observedAt = new Date().toISOString();
  const sourceId = createChainSourceId(config.network, config.apiUrl);
  const { store, backupPath } = await openSidekickStore(config.databasePath, observedAt);
  try {
    store.upsertChainSource({
      sourceId,
      kind: "api",
      network: config.network,
      baseUrl: config.apiUrl,
      observedAt,
    });
    const result = await syncManagerEvents({
      store,
      api,
      sourceId,
      chainId: preflight.node.networkId,
      managerPrincipal,
      observedAt,
      pageLimit: config.eventPageLimit,
    });
    console.log(JSON.stringify({ migrationBackupCreated: backupPath, result }, null, 2));
  } finally {
    store.close();
  }
} else if (command === "pool" && arguments_[0] === "status") {
  const [, managerPrincipal] = arguments_;
  if (!managerPrincipal) throw new Error("Usage: sidekick pool status <manager-principal>");
  const config = loadConfig(process.env);
  const { node, api } = clientsFromConfig(config);
  const managerVerification = await verificationContext(config);
  const [preflight, manager] = await Promise.all([
    runOperatorPreflight(config, node, api),
    inspectDeployedManager(node, config.network, managerPrincipal, managerVerification),
  ]);
  if (preflight.status === "fail" || !preflight.pox.pox5ContractId) {
    throw new Error("Pool status requires a successful preflight with active PoX-5");
  }
  if (!manager.attachAllowed) {
    throw new Error("Pool status requires a recognized or compatible manager contract");
  }
  const observedAt = new Date().toISOString();
  const sourceId = createChainSourceId(config.network, config.apiUrl);
  const { store, backupPath } = await openSidekickStore(config.databasePath, observedAt);
  try {
    const forecast = await readPoolForecast({
      store,
      node,
      sourceId,
      managerPrincipal,
      pox5ContractId: preflight.pox.pox5ContractId,
      currentRewardCycle: preflight.cycle.currentId,
      horizonCycles: config.forecastHorizonCycles,
      observedAt,
      burnBlockHeight: preflight.node.burnBlockHeight,
      stacksTipHeight: preflight.node.stacksTipHeight,
    });
    console.log(
      JSON.stringify(
        {
          config: redactConfig(config),
          migrationBackupCreated: backupPath,
          forecast,
        },
        null,
        2,
      ),
    );
    if (forecast.status === "attention") process.exitCode = 2;
  } finally {
    store.close();
  }
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
} else if (command === "rewards" && arguments_[0] === "status") {
  const [, managerPrincipal, rewardCycleArgument] = arguments_;
  if (!managerPrincipal) {
    throw new Error("Usage: sidekick rewards status <manager-principal> [reward-cycle]");
  }
  const config = loadConfig(process.env);
  const { node, api } = clientsFromConfig(config);
  const managerVerification = await verificationContext(config);
  const [preflight, manager] = await Promise.all([
    runOperatorPreflight(config, node, api),
    inspectDeployedManager(node, config.network, managerPrincipal, managerVerification),
  ]);
  if (preflight.status === "fail" || !preflight.pox.pox5ContractId) {
    throw new Error("Reward status requires a successful preflight with active PoX-5");
  }
  if (!manager.attachAllowed) {
    throw new Error("Reward status requires a recognized or compatible manager contract");
  }
  const rewardCycle = rewardCycleArgument
    ? Number.parseInt(rewardCycleArgument, 10)
    : preflight.cycle.currentId;
  if (
    !Number.isSafeInteger(rewardCycle) ||
    rewardCycle < 0 ||
    String(rewardCycle) !== String(rewardCycleArgument ?? rewardCycle)
  ) {
    throw new Error("reward-cycle must be a non-negative integer");
  }
  const observedAt = new Date().toISOString();
  const sourceId = createChainSourceId(config.network, config.apiUrl);
  const { store, backupPath } = await openSidekickStore(config.databasePath, observedAt);
  try {
    const rewards = await readStxRewardStatus({
      store,
      node,
      sourceId,
      managerPrincipal,
      pox5ContractId: preflight.pox.pox5ContractId,
      rewardCycle,
      observedAt,
      burnBlockHeight: preflight.node.burnBlockHeight,
      stacksTipHeight: preflight.node.stacksTipHeight,
    });
    console.log(
      JSON.stringify(
        {
          config: redactConfig(config),
          migrationBackupCreated: backupPath,
          rewards,
        },
        null,
        2,
      ),
    );
    if (rewards.status === "attention") process.exitCode = 2;
  } finally {
    store.close();
  }
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
  const config = loadConfig(process.env);
  const { node, api } = clientsFromConfig(config);
  const preflight = await runOperatorPreflight(config, node, api);
  assertManagerRenderPreflight(config.network, preflight);
  const compatibilityStore = await loadNetworkCompatibilityProfiles({
    ...(config.compatibilityProfilesDirectory
      ? { directory: config.compatibilityProfilesDirectory }
      : {}),
  });
  const compatibilityProfile = compatibilityProfileByIdentity(
    compatibilityStore,
    preflight.compatibility.profileId,
    preflight.compatibility.profileRevision,
  )?.profile;
  const contractsDirectory =
    process.env.SIDEKICK_CONTRACTS_DIR ?? resolve(import.meta.dirname, "../../../contracts");
  const rendered = await renderManagerDeployment({
    network: config.network,
    adminPrincipal,
    contractName,
    outputDirectory,
    contractsDirectory,
    ...(compatibilityProfile ? { compatibilityProfile } : {}),
  });
  console.log(JSON.stringify({ preflight, ...rendered }, null, 2));
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
  sidekick database backup <output.sqlite>  Create and integrity-check an online backup
  sidekick init fresh <admin> <name> <output-dir> <auth-id> [signer-config]
  sidekick init attach <manager>  Build an activation plan from a running manager
  sidekick preflight  Verify node, API, network, lag, and PoX-5 readiness
  sidekick attach <manager>  Verify and attach an existing manager in Observe mode
  sidekick manager verify <manager>  Verify deployed source and interface compatibility
  sidekick setup status <manager>  Verify registration and current/next eligibility
  sidekick setup record <manager> <pool-config.json> [record-metadata.json]
  sidekick pool enrollment-info <manager> <pool-config.json>
  sidekick pool sync-stakers <manager>  Reconcile API discoveries with PoX-5 node state
  sidekick events sync <manager>  Backfill and update canonical manager events
  sidekick pool status <manager>  Reconcile current and future pool totals
  sidekick rewards status <manager> [cycle]  Read STX reward and payout state
  sidekick export support-bundle <manager> [pool-config.json] [record-metadata.json]
  sidekick manager render <admin> <name> <output-dir>
  sidekick manager trust <manager> --output <profile.json> [--observe-only]
  sidekick signer-grant prepare <manager> <auth-id> [signer-config]
  sidekick signer-grant verify <manager> <auth-id> <signer-output.json>

Environment:
  STACKS_NODE_RPC_URL  Required node RPC base URL for connected commands
  SIDEKICK_NETWORK     mainnet (default), testnet, devnet, or regtest
  STACKS_API_URL       Optional for mainnet/testnet; defaults to Hiro
  STACKS_API_KEY       Optional API key; never included in output
  SIDEKICK_DATABASE_PATH  Optional SQLite path; defaults to data/sidekick.sqlite
  SIDEKICK_FORECAST_HORIZON_CYCLES  Optional forecast horizon; defaults to 6
  SIDEKICK_STATIC_DIRECTORY  Optional compiled dashboard directory override
  SIDEKICK_CONTRACTS_DIR  Optional path to the pinned contracts directory
  SIDEKICK_TRUSTED_MANAGER_PROFILES_DIR  Optional read-only installed profile directory`);
}
