import { type ChainAnchor, chainAnchorsEqual } from "./chain-anchor.js";
import type { StacksApiClient, StacksNodeClient } from "./chain-clients.js";
import { ChainAnchorError, captureNodeChainAnchor } from "./chain-clients.js";
import type { SidekickConfig } from "./config.js";
import {
  inspectDeployedManager,
  inspectManagerOrReportMissing,
  type ManagerVerificationContext,
  type ManagerVerificationReport,
} from "./manager-verification.js";
import { nodeProvesChainAnchorCanonical } from "./node-chain-anchor-proof.js";
import { type OperatorReadinessStatus, readOperatorReadiness } from "./operator-readiness.js";
import { type PreflightResult, runOperatorPreflight } from "./preflight.js";
import {
  type RegistrationVerification,
  verifyManagerRegistration,
} from "./registration-verification.js";

export interface OperatorAnchorSnapshot {
  chainAnchor: ChainAnchor;
  preflight: PreflightResult;
  manager: ManagerVerificationReport;
  registration: RegistrationVerification | null;
  readiness: OperatorReadinessStatus;
}

type OperatorAnchorSnapshotOptions = {
  config: SidekickConfig;
  node: StacksNodeClient;
  api: StacksApiClient;
  managerPrincipal: string;
  managerVerification: ManagerVerificationContext | undefined;
  reportMissingManager?: boolean;
  waitBeforeRetry?: (attempt: number) => Promise<void>;
};

class OperatorAnchorSnapshotCoherenceError extends ChainAnchorError {
  constructor(message: string) {
    super(message, { retryable: true });
    this.name = "OperatorAnchorSnapshotCoherenceError";
  }
}

async function waitBeforeSnapshotRetry(attempt: number): Promise<void> {
  const milliseconds = Math.min(1_000, 250 * 2 ** (attempt - 1));
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readOperatorAnchorSnapshotAttempt(
  options: OperatorAnchorSnapshotOptions,
): Promise<OperatorAnchorSnapshot> {
  const before = await captureNodeChainAnchor(options.node);
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
  const readiness = await readOperatorReadiness(
    options.node,
    preflight,
    manager,
    registration,
    readOptions,
  );
  const after = await captureNodeChainAnchor(options.node);
  const advancedWithinCycleWindow =
    after.stacksBlockHeight >= before.stacksBlockHeight &&
    after.burnBlockHeight >= before.burnBlockHeight &&
    after.cyclePosition >= before.cyclePosition &&
    before.rewardCycle === after.rewardCycle &&
    before.rewardCycleLength === after.rewardCycleLength &&
    before.prepareCycleLength === after.prepareCycleLength &&
    before.phase === after.phase &&
    before.checkpoint === after.checkpoint;
  const capturedAnchorRemainsCanonical =
    chainAnchorsEqual(before, after) ||
    (advancedWithinCycleWindow &&
      (await nodeProvesChainAnchorCanonical(options.node, before, after)));
  if (!capturedAnchorRemainsCanonical) {
    throw new OperatorAnchorSnapshotCoherenceError(
      "Chain position changed without preserving a canonical operator snapshot anchor",
    );
  }
  // Preflight is deliberately live health data. The node may process newer canonical blocks while
  // the pinned manager and eligibility reads are assembled, but it must still contain the captured
  // anchor and describe the same PoX reward cycle. Boundary changes and reorgs retry the snapshot.
  if (
    preflight.node.stacksTipHeight < before.stacksBlockHeight ||
    preflight.node.burnBlockHeight < before.burnBlockHeight ||
    preflight.cycle.currentId !== before.rewardCycle
  ) {
    throw new OperatorAnchorSnapshotCoherenceError(
      "Preflight facts do not match the operator snapshot chain anchor",
    );
  }
  return { chainAnchor: before, preflight, manager, registration, readiness };
}

export async function readOperatorAnchorSnapshot(
  options: OperatorAnchorSnapshotOptions,
): Promise<OperatorAnchorSnapshot> {
  const maxAttempts = 3;
  const waitBeforeRetry = options.waitBeforeRetry ?? waitBeforeSnapshotRetry;
  let lastError: ChainAnchorError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await readOperatorAnchorSnapshotAttempt(options);
    } catch (error) {
      const retryable = error instanceof ChainAnchorError && error.retryable;
      if (!retryable || attempt === maxAttempts) throw error;
      lastError = error;
      await waitBeforeRetry(attempt);
    }
  }
  throw (
    lastError ??
    new OperatorAnchorSnapshotCoherenceError("Unable to assemble a stable operator snapshot")
  );
}
