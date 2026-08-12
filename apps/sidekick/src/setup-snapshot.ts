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
  waitBeforeRetry?: (attempt: number) => Promise<void>;
};

class SetupSnapshotCoherenceError extends ChainAnchorError {
  constructor(message: string) {
    super(message, { retryable: true });
    this.name = "SetupSnapshotCoherenceError";
  }
}

async function waitBeforeSnapshotRetry(attempt: number): Promise<void> {
  const milliseconds = Math.min(1_000, 250 * 2 ** (attempt - 1));
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readSetupSnapshotAttempt(options: SetupSnapshotOptions): Promise<SetupSnapshot> {
  const before = await captureChainAnchor(options.node, options.api);
  const readOptions = { tip: before.indexBlockHash };
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
      readOptions,
    ),
  ]);
  const registration =
    manager.attachAllowed && preflight.pox.pox5ContractId
      ? await verifyManagerRegistration(
          options.node,
          preflight.pox.pox5ContractId,
          options.managerPrincipal,
          readOptions,
        )
      : null;
  const setup = await readPoolSetupStatus(
    options.node,
    preflight,
    manager,
    registration,
    readOptions,
  );
  const after = await captureChainAnchor(options.node, options.api);
  if (!chainAnchorsEqual(before, after)) {
    throw new SetupSnapshotCoherenceError(
      "Chain position moved while the setup snapshot was being assembled",
    );
  }
  // Preflight is deliberately live health data. The node may have processed newer Nakamoto
  // blocks (and one newer Bitcoin block) than the stable API anchor, but it must still contain
  // that anchor and describe the same PoX reward cycle as the pinned manager and eligibility
  // reads. The second captured anchor below fences any API movement during the snapshot.
  if (
    preflight.node.stacksTipHeight < before.stacksBlockHeight ||
    preflight.node.burnBlockHeight < before.burnBlockHeight ||
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
  const waitBeforeRetry = options.waitBeforeRetry ?? waitBeforeSnapshotRetry;
  let lastError: ChainAnchorError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await readSetupSnapshotAttempt(options);
    } catch (error) {
      const retryable = error instanceof ChainAnchorError && error.retryable;
      if (!retryable || attempt === maxAttempts) throw error;
      lastError = error;
      await waitBeforeRetry(attempt);
    }
  }
  throw lastError ?? new SetupSnapshotCoherenceError("Unable to assemble a stable setup snapshot");
}
