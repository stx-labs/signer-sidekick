import { type ChainAnchor, chainAnchorsEqual } from "./chain-anchor.js";
import type { StacksApiClient, StacksNodeClient } from "./chain-clients.js";
import { ChainAnchorError, captureChainAnchor } from "./chain-clients.js";
import type { SidekickConfig } from "./config.js";
import {
  inspectDeployedManager,
  inspectManagerOrReportMissing,
  type ManagerVerificationContext,
  type ManagerVerificationReport,
} from "./manager-verification.js";
import { type PreflightResult, runOperatorPreflight } from "./preflight.js";
import {
  type RegistrationVerification,
  verifyManagerRegistration,
} from "./registration-verification.js";
import { type PoolSetupStatus, readPoolSetupStatus } from "./setup-status.js";

export interface SetupSnapshot {
  chainAnchor: ChainAnchor;
  preflight: PreflightResult;
  manager: ManagerVerificationReport;
  registration: RegistrationVerification | null;
  setup: PoolSetupStatus;
}

type SetupSnapshotOptions = {
  config: SidekickConfig;
  node: StacksNodeClient;
  api: StacksApiClient;
  managerPrincipal: string;
  managerVerification: ManagerVerificationContext | undefined;
  reportMissingManager?: boolean;
};

class SetupSnapshotCoherenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupSnapshotCoherenceError";
  }
}

async function readSetupSnapshotAttempt(options: SetupSnapshotOptions): Promise<SetupSnapshot> {
  const before = await captureChainAnchor(options.node, options.api);
  const managerReader = options.reportMissingManager
    ? inspectManagerOrReportMissing
    : inspectDeployedManager;
  const [preflight, manager] = await Promise.all([
    runOperatorPreflight(options.config, options.node, options.api),
    managerReader(
      options.node,
      options.config.network,
      options.managerPrincipal,
      options.managerVerification,
    ),
  ]);
  const registration =
    manager.attachAllowed && preflight.pox.pox5ContractId
      ? await verifyManagerRegistration(
          options.node,
          preflight.pox.pox5ContractId,
          options.managerPrincipal,
        )
      : null;
  const setup = await readPoolSetupStatus(options.node, preflight, manager, registration);
  const after = await captureChainAnchor(options.node, options.api);
  if (!chainAnchorsEqual(before, after)) {
    throw new SetupSnapshotCoherenceError(
      "Chain position moved while the setup snapshot was being assembled",
    );
  }
  if (
    preflight.node.stacksTipHeight !== before.stacksBlockHeight ||
    preflight.node.burnBlockHeight !== before.burnBlockHeight ||
    preflight.cycle.currentId !== before.rewardCycle
  ) {
    throw new SetupSnapshotCoherenceError(
      "Preflight facts do not match the setup snapshot chain anchor",
    );
  }
  return { chainAnchor: before, preflight, manager, registration, setup };
}

export async function readSetupSnapshot(options: SetupSnapshotOptions): Promise<SetupSnapshot> {
  const maxAttempts = 3;
  let lastError: ChainAnchorError | SetupSnapshotCoherenceError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await readSetupSnapshotAttempt(options);
    } catch (error) {
      const retryable =
        (error instanceof ChainAnchorError && error.retryable) ||
        error instanceof SetupSnapshotCoherenceError;
      if (!retryable || attempt === maxAttempts) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new SetupSnapshotCoherenceError("Unable to assemble a stable setup snapshot");
}
