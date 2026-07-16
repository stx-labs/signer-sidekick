import type { ClarityValue } from "@stx-labs/signer-sidekick-protocol/clarity-codecs";
import {
  decodePox5CycleMembership,
  decodePox5StakerInfo,
  decodeUInt,
  encodePrincipalHex,
  encodeUIntHex,
} from "@stx-labs/signer-sidekick-protocol/clarity-codecs";
import type { SignerStakersPage } from "./chain-clients.js";
import type { SidekickStore, SignerStakerPageItem } from "./storage/store.js";

const maxStxFutureStackingCycles = 96n;

export interface SignerStakerApi {
  getSignerStakers(
    signerPrincipal: string,
    cursor?: string | null,
    limit?: number,
  ): Promise<SignerStakersPage>;
}

export interface SignerStakerNode {
  callReadOnly(
    principal: string,
    functionName: string,
    sender: string,
    args: readonly string[],
  ): Promise<ClarityValue>;
}

export type SignerStakerDiscrepancy =
  | {
      kind: "stx-position-missing";
      stakerPrincipal: string;
    }
  | {
      kind: "signer-mismatch";
      stakerPrincipal: string;
      expectedSignerPrincipal: string;
      actualSignerPrincipal: string;
    }
  | {
      kind: "cycle-membership-missing";
      stakerPrincipal: string;
      rewardCycle: string;
    };

export interface SyncSignerStakersOptions {
  store: SidekickStore;
  api: SignerStakerApi;
  node: SignerStakerNode;
  sourceId: string;
  nodeSourceId: string;
  managerPrincipal: string;
  pox5ContractId: string;
  observedAt: string;
  burnBlockHeight: number;
  stacksTipHeight: number;
  currentRewardCycle: number;
  pageLimit?: number;
  stakerConcurrency?: number;
}

export interface SyncSignerStakersResult {
  runId: string;
  resumed: boolean;
  status: "completed";
  pagesProcessed: number;
  itemsProcessed: number;
  activeStakers: number;
  nodeVerifiedStxPositions: number;
  unverifiedStxDiscoveries: number;
  discrepanciesObservedThisInvocation: SignerStakerDiscrepancy[];
}

async function verifyPageItem(
  item: SignerStakersPage["results"][number],
  options: Pick<
    SyncSignerStakersOptions,
    "node" | "pox5ContractId" | "managerPrincipal" | "currentRewardCycle"
  >,
): Promise<{
  item: SignerStakerPageItem;
  discrepancy: SignerStakerDiscrepancy | null;
}> {
  const hasStx = item.types.includes("stx");
  const hasBtc = item.types.includes("btc");
  if (!hasStx) {
    return {
      item: {
        stakerPrincipal: item.staker,
        hasStx,
        hasBtc,
        active: true,
        stxNodeVerified: null,
        position: null,
      },
      discrepancy: null,
    };
  }

  const response = await options.node.callReadOnly(
    options.pox5ContractId,
    "get-staker-info",
    options.managerPrincipal,
    [encodePrincipalHex(item.staker)],
  );
  const position = decodePox5StakerInfo(response);
  if (!position || position.signer !== options.managerPrincipal) {
    return {
      item: {
        stakerPrincipal: item.staker,
        hasStx,
        hasBtc,
        active: true,
        stxNodeVerified: false,
        position: null,
      },
      discrepancy: position
        ? {
            kind: "signer-mismatch",
            stakerPrincipal: item.staker,
            expectedSignerPrincipal: options.managerPrincipal,
            actualSignerPrincipal: position.signer,
          }
        : { kind: "stx-position-missing", stakerPrincipal: item.staker },
    };
  }
  if (position.numCycles < 1n) {
    // PoX-5 retains a staker-info tuple after `unstake`, but clears num-cycles
    // to zero. The signer API can continue returning that historical roster
    // entry, so treat it as a node-verified absence of an active position
    // instead of failing the entire reconciliation run.
    return {
      item: {
        stakerPrincipal: item.staker,
        hasStx,
        hasBtc,
        active: false,
        stxNodeVerified: false,
        position: null,
      },
      discrepancy: null,
    };
  }
  const unlockCycle = position.firstRewardCycle + position.numCycles;
  const unlockBurnHeight = decodeUInt(
    await options.node.callReadOnly(
      options.pox5ContractId,
      "reward-cycle-to-burn-height",
      options.managerPrincipal,
      [encodeUIntHex(unlockCycle)],
    ),
    "reward-cycle-to-burn-height",
  );
  const firstActiveCycle =
    position.firstRewardCycle > BigInt(options.currentRewardCycle)
      ? position.firstRewardCycle
      : BigInt(options.currentRewardCycle);
  const activeCycleSpan = unlockCycle - firstActiveCycle;
  // stake-update retains the original first cycle and accumulates lifetime num-cycles. The
  // contract's 96-cycle limit applies to the future period at each update, so a long-running
  // position can legitimately report a much larger lifetime value. At most the current frozen
  // cycle plus 96 future cycles should need verification.
  if (activeCycleSpan < 1n || activeCycleSpan > maxStxFutureStackingCycles + 1n) {
    throw new Error(
      `PoX-5 returned invalid active cycle span ${activeCycleSpan} ` +
        `(stored num-cycles ${position.numCycles}) for ${item.staker}`,
    );
  }
  const cycleMemberships: NonNullable<SignerStakerPageItem["position"]>["cycleMemberships"] = [];
  const cycles: bigint[] = [];
  for (let cycle = firstActiveCycle; cycle < unlockCycle; cycle += 1n) cycles.push(cycle);
  for (let index = 0; index < cycles.length; index += 8) {
    const batch = cycles.slice(index, index + 8);
    const memberships = await Promise.all(
      batch.map(async (rewardCycle) => {
        const value = await options.node.callReadOnly(
          options.pox5ContractId,
          "get-signer-cycle-membership",
          options.managerPrincipal,
          [encodePrincipalHex(item.staker), encodeUIntHex(rewardCycle)],
        );
        const membership = decodePox5CycleMembership(value);
        if (!membership) {
          return null;
        }
        return {
          rewardCycle,
          signerPrincipal: membership.signer,
          amountUstx: membership.amountUstx,
        };
      }),
    );
    const missingCycle = memberships.indexOf(null);
    if (missingCycle !== -1) {
      const rewardCycle = batch[missingCycle];
      return {
        item: {
          stakerPrincipal: item.staker,
          hasStx,
          hasBtc,
          active: true,
          stxNodeVerified: false,
          position: null,
        },
        discrepancy: {
          kind: "cycle-membership-missing",
          stakerPrincipal: item.staker,
          rewardCycle: String(rewardCycle),
        },
      };
    }
    cycleMemberships.push(
      ...memberships.filter(
        (
          membership,
        ): membership is {
          rewardCycle: bigint;
          signerPrincipal: string;
          amountUstx: bigint;
        } => membership !== null && membership.signerPrincipal === options.managerPrincipal,
      ),
    );
  }
  return {
    item: {
      stakerPrincipal: item.staker,
      hasStx,
      hasBtc,
      active: true,
      stxNodeVerified: true,
      position: {
        signerPrincipal: position.signer,
        amountUstx: position.amountUstx,
        firstRewardCycle: position.firstRewardCycle,
        numCycles: position.numCycles,
        unlockBurnHeight,
        cycleMemberships,
      },
    },
    discrepancy: null,
  };
}

export async function syncSignerStakers(
  options: SyncSignerStakersOptions,
): Promise<SyncSignerStakersResult> {
  if (!Number.isSafeInteger(options.currentRewardCycle) || options.currentRewardCycle < 0) {
    throw new Error("currentRewardCycle must be a non-negative safe integer");
  }
  const pageLimit = options.pageLimit ?? 200;
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 200) {
    throw new Error("pageLimit must be an integer from 1 through 200");
  }
  const stakerConcurrency = options.stakerConcurrency ?? 4;
  if (!Number.isSafeInteger(stakerConcurrency) || stakerConcurrency < 1 || stakerConcurrency > 16) {
    throw new Error("stakerConcurrency must be an integer from 1 through 16");
  }
  const initialRun = options.store.startOrResumeSignerStakerRun(
    options.sourceId,
    options.managerPrincipal,
    options.observedAt,
  );
  const resumed = initialRun.pagesProcessed > 0;
  let run = initialRun;
  const requestedCursors = new Set<string | null>();
  const discrepancies: SignerStakerDiscrepancy[] = [];

  while (run.status === "running") {
    if (requestedCursors.has(run.cursor)) {
      throw new Error(`Signer-staker API repeated cursor ${run.cursor ?? "<initial>"}`);
    }
    requestedCursors.add(run.cursor);
    const page = await options.api.getSignerStakers(
      options.managerPrincipal,
      run.cursor,
      pageLimit,
    );
    if (page.cursor.next === run.cursor && page.cursor.next !== null) {
      throw new Error(`Signer-staker API did not advance cursor ${run.cursor}`);
    }

    const verifiedItems: SignerStakerPageItem[] = [];
    for (let index = 0; index < page.results.length; index += stakerConcurrency) {
      const verifiedBatch = await Promise.all(
        page.results
          .slice(index, index + stakerConcurrency)
          .map((item) => verifyPageItem(item, options)),
      );
      for (const verified of verifiedBatch) {
        verifiedItems.push(verified.item);
        if (verified.discrepancy) discrepancies.push(verified.discrepancy);
      }
    }

    run = options.store.commitSignerStakerPage({
      runId: run.runId,
      sourceId: options.sourceId,
      nodeSourceId: options.nodeSourceId,
      managerPrincipal: options.managerPrincipal,
      nextCursor: page.cursor.next,
      items: verifiedItems,
      observedAt: options.observedAt,
      burnBlockHeight: options.burnBlockHeight,
      stacksTipHeight: options.stacksTipHeight,
    });
  }

  const activeStakers = options.store.listSignerStakers(options.managerPrincipal);
  return {
    runId: run.runId,
    resumed,
    status: "completed",
    pagesProcessed: run.pagesProcessed,
    itemsProcessed: run.itemsProcessed,
    activeStakers: activeStakers.length,
    nodeVerifiedStxPositions: activeStakers.filter(
      (staker) => staker.stxNodeVerified && staker.position?.active,
    ).length,
    unverifiedStxDiscoveries: activeStakers.filter(
      (staker) => staker.hasStx && staker.stxNodeVerified === false,
    ).length,
    discrepanciesObservedThisInvocation: discrepancies,
  };
}
