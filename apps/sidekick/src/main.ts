import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deriveRewardCalculationTarget } from "./chain-anchor.js";
import { captureChainAnchor, StacksApiClient, StacksNodeClient } from "./chain-clients.js";
import {
  type CliInvocation,
  dispatchCli,
  withConnectedContext,
  withStore,
  writeCliJson,
  writeCliText,
} from "./cli-runtime.js";
import { loadConfig, redactConfig } from "./config.js";
import { HealthMonitoringService } from "./health-monitoring.js";
import { managerActionCapability } from "./manager-capabilities.js";
import { syncManagerEvents } from "./manager-event-sync.js";
import { managerEventVocabularyFor } from "./manager-event-vocabulary.js";
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
import { loadNetworkCompatibilityProfiles } from "./network-compatibility-store.js";
import { readOperatorAnchorSnapshot } from "./operator-anchor-snapshot.js";
import { OperatorService } from "./operator-service.js";
import {
  SnapshotRefreshMetricsTracker,
  startSnapshotRefreshLoop,
} from "./operator-snapshot-refresh.js";
import { readPoolForecast } from "./pool-forecast.js";
import { indexedApiCompatible, runOperatorPreflight } from "./preflight.js";
import { readStxRewardStatus } from "./reward-status.js";
import { RuntimeSettingsController } from "./runtime-settings.js";
import { createServer } from "./server.js";
import { prepareSignerGrant, verifySignerGrantOutput } from "./signer-grant.js";
import { SignerGrantService } from "./signer-grant-service.js";
import { syncSignerStakers } from "./signer-staker-sync.js";
import {
  backupSidekickDatabase,
  createChainSourceId,
  createNodeSourceId,
  openSidekickStore,
} from "./storage/store.js";
import { createOperatorSupportBundle, operatorSupportApplication } from "./support-bundle.js";
import { createSidekickTransactionEngineRuntime } from "./transaction-engine/runtime.js";
import { WalletIntentService } from "./wallet-intent-service.js";

function clientsFromConfig(config: ReturnType<typeof loadConfig>) {
  return {
    node: new StacksNodeClient(config.nodeRpcUrl),
    api: new StacksApiClient(config.apiUrl, config.apiKey, config.apiKeyHeader),
  };
}

function contractsDirectory(env: NodeJS.ProcessEnv): string {
  return env.SIDEKICK_CONTRACTS_DIR ?? resolve(import.meta.dirname, "../../../contracts");
}

let verificationContextPromise: Promise<ManagerVerificationContext> | null = null;
function verificationContext(config: ReturnType<typeof loadConfig>, env: NodeJS.ProcessEnv) {
  verificationContextPromise ??= createManagerVerificationContext({
    contractsDirectory: contractsDirectory(env),
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

async function operatorContext(managerPrincipal: string, env: NodeJS.ProcessEnv) {
  return withConnectedContext(
    managerPrincipal,
    {
      loadConfig: () => loadConfig(env),
      clientsFromConfig,
      verificationContext: (config) => verificationContext(config, env),
      readOperatorAnchorSnapshot,
    },
    (context) => context,
  );
}

function preflightBlocked(action: string): Error {
  return new Error(
    `${action} is blocked by failed node, API, or PoX-5 checks. Run sidekick preflight, resolve failures, then retry.`,
  );
}

function managerCompatibilityBlocked(action: string): Error {
  return new Error(
    `${action} is blocked because the manager principal does not match the configured network or its interface is missing required functions. Run sidekick manager verify <manager-principal>, correct the network or manager deployment, then retry.`,
  );
}

export async function executeCliCommand({
  command,
  arguments: arguments_,
  env,
  output,
}: CliInvocation): Promise<void> {
  if (command === "serve") {
    const config = loadConfig(env);
    const managerPrincipal = env.SIDEKICK_MANAGER_PRINCIPAL;
    if (!managerPrincipal) throw new Error("SIDEKICK_MANAGER_PRINCIPAL is required for serve");
    const authToken = env.SIDEKICK_AUTH_TOKEN;
    if (!authToken) throw new Error("SIDEKICK_AUTH_TOKEN is required for serve");
    const authTrustedHeader = env.SIDEKICK_AUTH_TRUSTED_HEADER;
    const authBasicUsername = env.SIDEKICK_AUTH_BASIC_USERNAME;
    const portValue = env.SIDEKICK_HTTP_PORT ?? "3998";
    if (!/^[0-9]+$/.test(portValue)) {
      throw new Error("SIDEKICK_HTTP_PORT must be an integer from 1 through 65535");
    }
    const port = Number(portValue);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error("SIDEKICK_HTTP_PORT must be an integer from 1 through 65535");
    }
    const host = env.SIDEKICK_HTTP_HOST ?? "127.0.0.1";
    const { store } = await openSidekickStore(config.databasePath);
    let serverOwnsStore = false;
    let storeClosed = false;
    let transactionEngine: Awaited<
      ReturnType<typeof createSidekickTransactionEngineRuntime>
    > | null = null;
    const closeStore = () => {
      if (storeClosed) return;
      storeClosed = true;
      store.close();
    };
    try {
      const runtimeSettings = new RuntimeSettingsController(config, store, managerPrincipal);
      const { config: effectiveConfig, node, api } = runtimeSettings.clients();
      const managerVerification = await verificationContext(config, env);
      const networkCompatibility = await loadNetworkCompatibilityProfiles({
        ...(config.compatibilityProfilesDirectory
          ? { directory: config.compatibilityProfilesDirectory }
          : {}),
      });
      let reportTransactionEngineError: (error: unknown) => void = () => undefined;
      const engine = await createSidekickTransactionEngineRuntime({
        env,
        store,
        managerPrincipal,
        managerVerification,
        runtimeContext: () => runtimeSettings.clients(),
        onError: (error) => reportTransactionEngineError(error),
      });
      transactionEngine = engine;
      const service = new OperatorService({
        config: effectiveConfig,
        managerPrincipal,
        store,
        node,
        api,
        runtimeSettings,
        managerVerification,
        transactionEngineObservation: {
          observe: async (input) => await engine.observe(input),
          onError: (error) => reportTransactionEngineError(error),
        },
      });
      const signerGrant = new SignerGrantService({
        runtimeSettings,
        managerPrincipal,
      });
      const wallet = new WalletIntentService({
        store,
        runtimeSettings,
        managerVerification,
        transactionEngineRequestedMode: engine.requestedMode,
        observeManagerClaimWalletJob: async (jobId) =>
          await engine.observeManagerClaimWalletJob(jobId),
        readState: () => signerGrant.walletState(),
      });
      const health = new HealthMonitoringService({
        getConfig: () => runtimeSettings.effectiveConfig(),
        getBurnBlocks: () => runtimeSettings.clients().api.getBurnBlocks(),
      });
      const staticDirectory = env.SIDEKICK_STATIC_DIRECTORY;
      let snapshotRefresh: { stop(): void } | null = null;
      const snapshotRefreshMetrics = new SnapshotRefreshMetricsTracker();
      const server = createServer({
        service,
        getRateLimitSettings: () => {
          const current = runtimeSettings.effectiveConfig();
          return {
            apiUrl: current.apiUrl,
            apiKeyConfigured: Boolean(current.apiKey),
          };
        },
        wallet,
        signerGrant,
        health,
        engine: engine.api,
        supportApplication: () => operatorSupportApplication(env),
        databaseStatus: () => store.databaseStatus(),
        snapshotRefreshMetrics,
        authToken,
        ...(authTrustedHeader ? { authTrustedHeader } : {}),
        ...(authBasicUsername ? { authBasicUsername } : {}),
        ...(staticDirectory ? { staticDirectory: resolve(staticDirectory) } : {}),
      });
      reportTransactionEngineError = (error) =>
        server.log.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "Transaction engine failed closed; operator reads remain available",
        );
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
      server.addHook("onClose", async () => {
        snapshotRefresh?.stop();
        health.stop();
        try {
          await engine.close();
        } finally {
          closeStore();
        }
      });
      await server.listen({ host, port });
      serverOwnsStore = true;
      health.start();
      engine.start();
      snapshotRefresh = startSnapshotRefreshLoop(service, server.log, {
        metrics: snapshotRefreshMetrics,
      });
      server.log.info("HTTP control plane is listening; initial manager observation is running");
      void engine
        .recoverActive()
        .then((results) =>
          server.log.info(
            { recoveredJobs: results.length },
            "Transaction engine startup recovery completed",
          ),
        )
        .catch((error: unknown) => reportTransactionEngineError(error));
      void service
        .observeManagerTrustState()
        .then(() => server.log.info("Initial manager observation completed"))
        .catch((error: unknown) =>
          server.log.warn(
            { error: error instanceof Error ? error.message : String(error) },
            "Initial manager observation failed; the next synchronization or snapshot will retry",
          ),
        );
    } finally {
      if (!serverOwnsStore) {
        try {
          await transactionEngine?.close();
        } finally {
          closeStore();
        }
      }
    }
  } else if (command === "config" && arguments_[0] === "validate") {
    const config = loadConfig(env);
    writeCliJson(output, { valid: true, config: redactConfig(config) });
  } else if (command === "doctor" && arguments_[0] === "connectivity") {
    const config = loadConfig(env);
    const { node, api } = clientsFromConfig(config);
    const result = await runOperatorPreflight(config, node, api);
    writeCliJson(output, { config: redactConfig(config), result });
    if (result.status === "fail") output.setExitCode(2);
  } else if (command === "doctor") {
    const config = loadConfig(env);
    const [managerVerification, networkCompatibility] = await Promise.all([
      verificationContext(config, env),
      loadNetworkCompatibilityProfiles({
        ...(config.compatibilityProfilesDirectory
          ? { directory: config.compatibilityProfilesDirectory }
          : {}),
      }),
    ]);
    await withStore(
      () => openSidekickStore(config.databasePath),
      ({ store, backupPath }) => {
        writeCliJson(output, {
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
        });
      },
    );
  } else if (command === "database" && arguments_[0] === "backup") {
    const [, destination] = arguments_;
    if (!destination) throw new Error("Usage: sidekick database backup <output.sqlite>");
    const databasePath =
      env.SIDEKICK_DATABASE_PATH === ":memory:"
        ? ":memory:"
        : resolve(env.SIDEKICK_DATABASE_PATH ?? "data/sidekick.sqlite");
    const result = await backupSidekickDatabase(databasePath, destination);
    writeCliJson(output, result);
  } else if (command === "preflight") {
    const config = loadConfig(env);
    const { node, api } = clientsFromConfig(config);
    const result = await runOperatorPreflight(config, node, api);
    writeCliJson(output, { config: redactConfig(config), result });
    if (result.status === "fail") output.setExitCode(2);
  } else if (command === "attach") {
    const [managerPrincipal] = arguments_;
    if (!managerPrincipal) throw new Error("Usage: sidekick attach <manager-contract-principal>");
    const { config, preflight, manager, registration, readiness } = await operatorContext(
      managerPrincipal,
      env,
    );
    writeCliJson(output, {
      config: redactConfig(config),
      preflight,
      manager,
      registration,
      readiness,
    });
    if (preflight.status === "fail" || !manager.attachAllowed || readiness.status === "blocked") {
      output.setExitCode(2);
    }
  } else if (command === "manager" && arguments_[0] === "verify") {
    const [, managerPrincipal] = arguments_;
    if (!managerPrincipal) throw new Error("Usage: sidekick manager verify <manager-principal>");
    const config = loadConfig(env);
    const { node } = clientsFromConfig(config);
    const manager = await inspectDeployedManager(
      node,
      config.network,
      managerPrincipal,
      await verificationContext(config, env),
    );
    writeCliJson(output, { config: redactConfig(config), manager });
    if (!manager.attachAllowed) output.setExitCode(2);
  } else if (command === "manager" && arguments_[0] === "trust") {
    const { managerPrincipal, outputPath, observeOnly } = parseManagerTrustArguments(
      arguments_.slice(1),
    );
    const config = loadConfig(env);
    const { node } = clientsFromConfig(config);
    const managerVerification = await verificationContext(config, env);
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
    writeCliJson(output, {
      status: result.status,
      summary: result.summary,
      outputPath: writtenPath,
      profile: result.profile,
      nextStep: result.profile
        ? "Mount the containing directory read-only at SIDEKICK_TRUSTED_MANAGER_PROFILES_DIR and restart Sidekick"
        : "No installed profile is required",
    });
  } else if (command === "pool" && arguments_[0] === "sync-stakers") {
    const [, managerPrincipal] = arguments_;
    if (!managerPrincipal) throw new Error("Usage: sidekick pool sync-stakers <manager-principal>");
    const { config, node, api, preflight, manager } = await operatorContext(managerPrincipal, env);
    if (
      preflight.status === "fail" ||
      !indexedApiCompatible(preflight) ||
      !preflight.pox.pox5ContractId
    ) {
      throw preflightBlocked("Signer-staker sync");
    }
    const pox5ContractId = preflight.pox.pox5ContractId;
    if (!manager.attachAllowed) {
      throw managerCompatibilityBlocked("Signer-staker sync");
    }
    const indexedAnchor = await captureChainAnchor(node, api);

    const observedAt = new Date().toISOString();
    const sourceId = createChainSourceId(config.network, config.apiUrl);
    const nodeSourceId = createNodeSourceId(config.network, config.nodeRpcUrl);
    await withStore(
      () => openSidekickStore(config.databasePath, observedAt),
      async ({ store, backupPath }) => {
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
          pox5ContractId,
          observedAt,
          burnBlockHeight: indexedAnchor.burnBlockHeight,
          stacksTipHeight: indexedAnchor.stacksBlockHeight,
          currentRewardCycle: indexedAnchor.rewardCycle,
          chainAnchor: indexedAnchor,
          pageLimit: config.stakerPageLimit,
        });
        const events = await syncManagerEvents({
          store,
          api,
          sourceId,
          chainId: preflight.node.networkId,
          managerPrincipal,
          eventVocabulary: managerEventVocabularyFor(manager.capabilities),
          observedAt,
          pageLimit: config.eventPageLimit,
        });
        const forecast = await readPoolForecast({
          store,
          node,
          sourceId,
          managerPrincipal,
          pox5ContractId,
          currentRewardCycle: indexedAnchor.rewardCycle,
          horizonCycles: config.forecastHorizonCycles,
          observedAt,
          burnBlockHeight: indexedAnchor.burnBlockHeight,
          stacksTipHeight: indexedAnchor.stacksBlockHeight,
          chainAnchor: indexedAnchor,
        });
        writeCliJson(output, {
          config: redactConfig(config),
          migrationBackupCreated: backupPath,
          observedAt: {
            burnBlockHeight: indexedAnchor.burnBlockHeight,
            stacksTipHeight: indexedAnchor.stacksBlockHeight,
            indexBlockHash: indexedAnchor.indexBlockHash,
          },
          result,
          events,
          forecast,
        });
      },
    );
  } else if (command === "events" && arguments_[0] === "sync") {
    const [, managerPrincipal] = arguments_;
    if (!managerPrincipal) throw new Error("Usage: sidekick events sync <manager-principal>");
    const { config, api, preflight, manager } = await operatorContext(managerPrincipal, env);
    if (preflight.status === "fail" || !indexedApiCompatible(preflight)) {
      throw preflightBlocked("Event sync");
    }
    if (!manager.attachAllowed) throw managerCompatibilityBlocked("Event sync");
    const observedAt = new Date().toISOString();
    const sourceId = createChainSourceId(config.network, config.apiUrl);
    await withStore(
      () => openSidekickStore(config.databasePath, observedAt),
      async ({ store, backupPath }) => {
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
          eventVocabulary: managerEventVocabularyFor(manager.capabilities),
          observedAt,
          pageLimit: config.eventPageLimit,
        });
        writeCliJson(output, { migrationBackupCreated: backupPath, result });
      },
    );
  } else if (command === "pool" && arguments_[0] === "status") {
    const [, managerPrincipal] = arguments_;
    if (!managerPrincipal) throw new Error("Usage: sidekick pool status <manager-principal>");
    const { config, node, preflight, manager, chainAnchor } = await operatorContext(
      managerPrincipal,
      env,
    );
    if (preflight.status === "fail" || !preflight.pox.pox5ContractId) {
      throw preflightBlocked("Pool status");
    }
    const pox5ContractId = preflight.pox.pox5ContractId;
    if (!manager.attachAllowed) {
      throw managerCompatibilityBlocked("Pool status");
    }
    const observedAt = new Date().toISOString();
    const sourceId = createChainSourceId(config.network, config.apiUrl);
    await withStore(
      () => openSidekickStore(config.databasePath, observedAt),
      async ({ store, backupPath }) => {
        const forecast = await readPoolForecast({
          store,
          node,
          sourceId,
          managerPrincipal,
          pox5ContractId,
          currentRewardCycle: chainAnchor.rewardCycle,
          horizonCycles: config.forecastHorizonCycles,
          observedAt,
          burnBlockHeight: chainAnchor.burnBlockHeight,
          stacksTipHeight: chainAnchor.stacksBlockHeight,
          chainAnchor,
        });
        writeCliJson(output, {
          config: redactConfig(config),
          migrationBackupCreated: backupPath,
          forecast,
        });
        if (forecast.status === "attention") output.setExitCode(2);
      },
    );
  } else if (command === "setup" && arguments_[0] === "record") {
    throw new Error(
      "The setup record was a public-enrollment artifact and is no longer generated by Sidekick. Use the operator support bundle for support handoff",
    );
  } else if (command === "rewards" && arguments_[0] === "status") {
    const [, managerPrincipal, rewardCycleArgument] = arguments_;
    if (!managerPrincipal) {
      throw new Error("Usage: sidekick rewards status <manager-principal> [reward-cycle]");
    }
    const { config, node, preflight, manager, chainAnchor } = await operatorContext(
      managerPrincipal,
      env,
    );
    if (preflight.status === "fail" || !preflight.pox.pox5ContractId) {
      throw preflightBlocked("Reward status");
    }
    const pox5ContractId = preflight.pox.pox5ContractId;
    if (!manager.attachAllowed) {
      throw managerCompatibilityBlocked("Reward status");
    }
    const rewardCapability = managerActionCapability(
      manager.capabilities,
      "reference-reward-claims",
    );
    if (!rewardCapability.executionAvailable) {
      throw new Error(`Reward status is unavailable: ${rewardCapability.reason}`);
    }
    const defaultRewardCalculation = deriveRewardCalculationTarget(chainAnchor);
    if (!rewardCycleArgument && defaultRewardCalculation.status === "invalid") {
      throw new Error(
        `The current chain anchor has no completed PoX-5 reward calculation: ${defaultRewardCalculation.reason}`,
      );
    }
    const rewardCycle = rewardCycleArgument
      ? Number.parseInt(rewardCycleArgument, 10)
      : defaultRewardCalculation.status === "ready"
        ? defaultRewardCalculation.rewardCycle
        : -1;
    if (
      !Number.isSafeInteger(rewardCycle) ||
      rewardCycle < 0 ||
      String(rewardCycle) !== String(rewardCycleArgument ?? rewardCycle)
    ) {
      throw new Error("reward-cycle must be a non-negative integer");
    }
    const observedAt = new Date().toISOString();
    const sourceId = createChainSourceId(config.network, config.apiUrl);
    await withStore(
      () => openSidekickStore(config.databasePath, observedAt),
      async ({ store, backupPath }) => {
        const rewards = await readStxRewardStatus({
          store,
          node,
          sourceId,
          managerPrincipal,
          pox5ContractId,
          rewardCycle,
          observedAt,
          burnBlockHeight: chainAnchor.burnBlockHeight,
          stacksTipHeight: chainAnchor.stacksBlockHeight,
          chainAnchor,
        });
        writeCliJson(output, {
          config: redactConfig(config),
          migrationBackupCreated: backupPath,
          rewards,
        });
        if (rewards.status === "attention") output.setExitCode(2);
      },
    );
  } else if (command === "export" && arguments_[0] === "support-bundle") {
    const [, managerPrincipal] = arguments_;
    if (!managerPrincipal) {
      throw new Error("Usage: sidekick export support-bundle <manager-principal>");
    }
    const config = loadConfig(env);
    await withStore(
      () => openSidekickStore(config.databasePath),
      async ({ store }) => {
        const runtimeSettings = new RuntimeSettingsController(config, store, managerPrincipal);
        const { config: effectiveConfig, node, api } = runtimeSettings.clients();
        const managerVerification = await verificationContext(config, env);
        const engine = await createSidekickTransactionEngineRuntime({
          env,
          store,
          managerPrincipal,
          managerVerification,
          runtimeContext: () => runtimeSettings.clients(),
        });
        try {
          const service = new OperatorService({
            config: effectiveConfig,
            managerPrincipal,
            store,
            node,
            api,
            runtimeSettings,
            managerVerification,
          });
          const health = new HealthMonitoringService({
            getConfig: () => runtimeSettings.effectiveConfig(),
            getBurnBlocks: () => runtimeSettings.clients().api.getBurnBlocks(),
          });
          const bundle = await createOperatorSupportBundle({
            application: operatorSupportApplication(env),
            operator: async () => service.supportSnapshot(true),
            health: async () => health.refresh(),
            engine: async () => engine.api.status(),
            recentOperations: async () => engine.api.listJobs({ cursor: null, limit: 50 }),
            database: () => store.databaseStatus(),
          });
          writeCliJson(output, bundle);
        } finally {
          await engine.close();
        }
      },
    );
  } else if (command === "manager" && arguments_[0] === "render") {
    throw new Error(
      "Signer-manager deployment moved to https://stx.fan/zero_to/signing/. Configure SIDEKICK_MANAGER_PRINCIPAL after setup, then run sidekick attach",
    );
  } else if (command === "signer-grant" && arguments_[0] === "prepare") {
    const [, managerPrincipal, authId, signerConfigPath] = arguments_;
    if (!managerPrincipal || !authId) {
      throw new Error(
        "Usage: sidekick signer-grant prepare <manager-principal> <auth-id> [signer-config-path]",
      );
    }
    const config = loadConfig(env);
    const { node, api } = clientsFromConfig(config);
    const preflight = await runOperatorPreflight(config, node, api);
    if (preflight.status === "fail" || !preflight.pox.pox5ContractId) {
      throw preflightBlocked("Signer grant preparation");
    }
    const preparation = await prepareSignerGrant(
      node,
      preflight.pox.pox5ContractId,
      managerPrincipal,
      authId,
      signerConfigPath,
    );
    writeCliJson(output, {
      config: redactConfig(config),
      verifiedAt: {
        burnBlockHeight: preflight.node.burnBlockHeight,
        stacksTipHeight: preflight.node.stacksTipHeight,
      },
      preparation,
    });
  } else if (command === "signer-grant" && arguments_[0] === "verify") {
    const [, managerPrincipal, authId, signerOutputPath] = arguments_;
    if (!managerPrincipal || !authId || !signerOutputPath) {
      throw new Error(
        "Usage: sidekick signer-grant verify <manager-principal> <auth-id> <signer-output.json>",
      );
    }
    const config = loadConfig(env);
    const { node, api } = clientsFromConfig(config);
    const preflight = await runOperatorPreflight(config, node, api);
    if (preflight.status === "fail" || !preflight.pox.pox5ContractId) {
      throw preflightBlocked("Signer grant verification");
    }
    const signerOutput = JSON.parse(await readFile(resolve(signerOutputPath), "utf8")) as unknown;
    const verified = await verifySignerGrantOutput(
      node,
      preflight.pox.pox5ContractId,
      managerPrincipal,
      authId,
      signerOutput,
    );
    writeCliJson(output, {
      config: redactConfig(config),
      verifiedAt: {
        burnBlockHeight: preflight.node.burnBlockHeight,
        stacksTipHeight: preflight.node.stacksTipHeight,
      },
      verified,
    });
  } else {
    writeCliText(
      output,
      `Signer Sidekick

Usage:
  sidekick serve    Start the loopback-only local API
  sidekick config validate  Validate and print redacted endpoint configuration
  sidekick doctor  Open, migrate, and verify the local SQLite store
  sidekick doctor connectivity  Verify node, API, network, lag, and PoX-5 connectivity
  sidekick database backup <output.sqlite>  Create and integrity-check an online backup
  sidekick preflight  Verify node, API, network, lag, and PoX-5 readiness
  sidekick attach <manager>  Verify a configured manager and operator readiness
  sidekick manager verify <manager>  Verify deployed source and interface compatibility
  sidekick pool sync-stakers <manager>  Reconcile API discoveries with PoX-5 node state
  sidekick events sync <manager>  Backfill and update canonical manager events
  sidekick pool status <manager>  Reconcile current and future pool totals
  sidekick rewards status <manager> [cycle]  Read STX reward and payout state
  sidekick export support-bundle <manager>  Collect the comprehensive support artifact
  sidekick manager trust <manager> --output <profile.json> [--observe-only]
  sidekick signer-grant prepare <manager> <auth-id> [signer-config]
  sidekick signer-grant verify <manager> <auth-id> <signer-output.json>

Environment:
  STACKS_NODE_RPC_URL  Required node RPC base URL for connected commands
  SIDEKICK_NETWORK     mainnet (default), pox5-testnet, devnet, or regtest
  STACKS_API_URL       Optional for mainnet/PoX-5 Testnet; defaults to Hiro
  STACKS_API_KEY       Optional API key; never included in output
  SIDEKICK_DATABASE_PATH  Optional SQLite path; defaults to data/sidekick.sqlite
  SIDEKICK_FORECAST_HORIZON_CYCLES  Optional forecast horizon; defaults to 6
  SIDEKICK_STATIC_DIRECTORY  Optional compiled dashboard directory override
  SIDEKICK_AUTH_TRUSTED_HEADER  Optional proxy-injected API-key header
  SIDEKICK_AUTH_BASIC_USERNAME  Optional HTTP Basic username; API key is the password
  SIDEKICK_CONTRACTS_DIR  Optional path to the pinned contracts directory
  SIDEKICK_TRUSTED_MANAGER_PROFILES_DIR  Optional read-only installed profile directory`,
    );
  }
}

const entryPath = process.argv[1];
if (entryPath && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  await dispatchCli(process.argv.slice(2), executeCliCommand);
}
