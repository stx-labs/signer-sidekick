import { type ChainAnchor, chainAnchorsEqual } from "./chain-anchor.js";
import type { StacksApiClient } from "./chain-clients.js";
import type { OperatorAnchorSnapshot } from "./operator-anchor-snapshot.js";
import {
  proveSignerStakerAnchorRemainsCanonical,
  SignerStakerAnchorError,
} from "./signer-staker-sync.js";
import type { SidekickStore } from "./storage/store.js";

export async function resolveRosterProjectionAnchor(options: {
  store: Pick<SidekickStore, "getLatestCompletedSignerStakerRun">;
  api: Pick<StacksApiClient, "getStatus" | "getBlock">;
  sourceId: string;
  managerPrincipal: string;
  liveAnchor: ChainAnchor;
  indexedApiAvailable?: boolean;
}): Promise<ChainAnchor> {
  const run = options.store.getLatestCompletedSignerStakerRun(
    options.sourceId,
    options.managerPrincipal,
  );
  if (!run?.chainAnchor || options.indexedApiAvailable === false) return options.liveAnchor;
  try {
    await proveSignerStakerAnchorRemainsCanonical(options.api, run.chainAnchor);
    return run.chainAnchor;
  } catch (error) {
    if (!(error instanceof SignerStakerAnchorError)) throw error;
    return options.liveAnchor;
  }
}

/**
 * Makes the transaction-engine setup anchor match its anchored reward evidence.
 *
 * The roster anchor has already been proven canonical by `resolveRosterProjectionAnchor`. Manager
 * source and contract identities are immutable, while preflight is deliberately live health data.
 * Planning can therefore use the older indexed anchor without mixing it with newer reward reads;
 * Operator runs still rebuild and revalidate a fresh snapshot before execution.
 */
export function anchorSetupToRewardEvidence(
  setup: OperatorAnchorSnapshot,
  rewardAnchor: ChainAnchor,
): OperatorAnchorSnapshot {
  return chainAnchorsEqual(setup.chainAnchor, rewardAnchor)
    ? setup
    : { ...setup, chainAnchor: rewardAnchor };
}
