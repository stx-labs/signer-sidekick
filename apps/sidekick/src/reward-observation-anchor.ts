import { type ChainAnchor, chainAnchorsEqual } from "./chain-anchor.js";
import type { StacksApiClient, StacksNodeClient } from "./chain-clients.js";
import { nodeProvesChainAnchorCanonical } from "./node-chain-anchor-proof.js";
import type { OperatorAnchorSnapshot } from "./operator-anchor-snapshot.js";
import {
  proveSignerStakerAnchorRemainsCanonical,
  SignerStakerAnchorError,
} from "./signer-staker-sync.js";
import type { SidekickStore } from "./storage/store.js";

type RosterProofNode = Pick<StacksNodeClient, "getNakamotoBlockById" | "getNakamotoBlockAtHeight">;

export async function resolveRosterProjectionAnchor(options: {
  store: Pick<SidekickStore, "getLatestCompletedSignerStakerRun">;
  api: Pick<StacksApiClient, "getStatus" | "getBlock">;
  /** Local node; proves the roster anchor when the indexed API cannot (node-first). */
  node?: RosterProofNode;
  sourceId: string;
  managerPrincipal: string;
  liveAnchor: ChainAnchor;
  indexedApiAvailable?: boolean;
}): Promise<ChainAnchor> {
  const run = options.store.getLatestCompletedSignerStakerRun(
    options.sourceId,
    options.managerPrincipal,
  );
  if (!run?.chainAnchor) return options.liveAnchor;
  if (options.indexedApiAvailable === false) {
    // An indexed-API outage must not drop the sealed roster: every reward read keys its staker set
    // to this anchor, so falling back to the live tip would empty the page. Let the local node
    // prove the anchor instead; only a failed proof (reorg, pruned block) falls back.
    return options.node &&
      (await nodeProvesChainAnchorCanonical(options.node, run.chainAnchor, options.liveAnchor))
      ? run.chainAnchor
      : options.liveAnchor;
  }
  try {
    await proveSignerStakerAnchorRemainsCanonical(options.api, run.chainAnchor);
    return run.chainAnchor;
  } catch (error) {
    if (!(error instanceof SignerStakerAnchorError)) throw error;
    // The indexed API could not confirm the anchor (a reorg, or an API that has fallen behind it).
    // The local node decides: a node-proved anchor stays; anything else falls back to the live tip.
    return options.node &&
      (await nodeProvesChainAnchorCanonical(options.node, run.chainAnchor, options.liveAnchor))
      ? run.chainAnchor
      : options.liveAnchor;
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
