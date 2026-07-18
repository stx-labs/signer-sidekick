import type { ClarityValue } from "@stx-labs/signer-sidekick-protocol/clarity-codecs";
import {
  decodePox5CycleMembership,
  decodePox5StakerInfo,
  decodeUInt,
  encodePrincipalHex,
  encodeUIntHex,
} from "@stx-labs/signer-sidekick-protocol/clarity-codecs";
import type { ChainAnchor } from "./chain-anchor.js";
import type { ApiStatus, ChainReadOptions, SignerStakersPage } from "./chain-clients.js";
import type { SidekickStore, SignerStakerPageItem } from "./storage/store.js";

const maxStxFutureStackingCycles = 96n;

export interface SignerStakerApi {
  getSignerStakers(
    signerPrincipal: string,
    cursor?: string | null,
    limit?: number,
  ): Promise<SignerStakersPage>;
  getStatus?(): Promise<ApiStatus>;
}

export interface SignerStakerNode {
  callReadOnly(
    principal: string,
    functionName: string,
    sender: string,
    args: readonly string[],
    options?: ChainReadOptions,
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
  chainAnchor?: ChainAnchor;
  transitionCandidatePrincipals?: readonly string[];
  pageLimit?: number;
  stakerConcurrency?: number;
}

export interface SyncSignerStakersResult {
  runId: string;
  resumed: boolean;
  status: "completed" | "incomplete";
  authoritative: boolean;
  pagesProcessed: number;
  itemsProcessed: number;
  activeStakers: number;
  nodeVerifiedStxPositions: number;
  unverifiedStxDiscoveries: number;
  discrepanciesObservedThisInvocation: SignerStakerDiscrepancy[];
}

export class SignerStakerAnchorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignerStakerAnchorError";
  }
}

async function verifyPageItem(
  item: SignerStakersPage["results"][number],
  options: Pick<
    SyncSignerStakersOptions,
    "node" | "pox5ContractId" | "managerPrincipal" | "currentRewardCycle"
  > & { chainAnchor?: ChainAnchor },
  context: { allowRetainedStxAbsence?: boolean } = {},
): Promise<{
  item: SignerStakerPageItem;
  discrepancy: SignerStakerDiscrepancy | null;
}> {
  const hasStx = item.types.includes("stx");
  const hasBtc = item.types.includes("btc");
  const readOptions = options.chainAnchor ? { tip: options.chainAnchor.indexBlockHash } : undefined;
  if (!hasStx) {
    return {
      item: {
        stakerPrincipal: item.staker,
        hasStx,
        hasBtc,
        active: true,
        stxNodeVerified: null,
        reconciliationComplete: true,
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
    readOptions,
  );
  const position = decodePox5StakerInfo(response);
  if (!position) {
    // A complete, anchor-fenced API scan that omits a previously stored STX-only
    // candidate agrees with the canonical node that no active STX position remains.
    // Keep API-listed items, bond candidates, and transition-only candidates fail-closed.
    if (context.allowRetainedStxAbsence && hasStx && !hasBtc) {
      return {
        item: {
          stakerPrincipal: item.staker,
          hasStx,
          hasBtc,
          active: false,
          stxNodeVerified: false,
          reconciliationComplete: true,
          position: null,
        },
        discrepancy: null,
      };
    }
    return {
      item: {
        stakerPrincipal: item.staker,
        hasStx,
        hasBtc,
        active: true,
        stxNodeVerified: false,
        reconciliationComplete: false,
        position: null,
      },
      discrepancy: { kind: "stx-position-missing", stakerPrincipal: item.staker },
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
        reconciliationComplete: true,
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
      readOptions,
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
          readOptions,
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
          reconciliationComplete: false,
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
      active: cycleMemberships.length > 0 || hasBtc,
      stxNodeVerified: true,
      reconciliationComplete: true,
      position: {
        signerPrincipal: position.signer,
        amountUstx: position.amountUstx,
        firstRewardCycle: position.firstRewardCycle,
        numCycles: position.numCycles,
        unlockBurnHeight,
        cycleMemberships,
      },
    },
    discrepancy:
      position.signer === options.managerPrincipal
        ? null
        : {
            kind: "signer-mismatch",
            stakerPrincipal: item.staker,
            expectedSignerPrincipal: options.managerPrincipal,
            actualSignerPrincipal: position.signer,
          },
  };
}

function apiStatusMatchesAnchor(status: ApiStatus, anchor: ChainAnchor): boolean {
  return (
    status.chain_tip.block_height === anchor.stacksBlockHeight &&
    status.chain_tip.index_block_hash.toLowerCase() === anchor.indexBlockHash &&
    status.chain_tip.burn_block_height === anchor.burnBlockHeight
  );
}

export async function syncSignerStakers(
  options: SyncSignerStakersOptions,
): Promise<SyncSignerStakersResult> {
  if (!Number.isSafeInteger(options.currentRewardCycle) || options.currentRewardCycle < 0) {
    throw new Error("currentRewardCycle must be a non-negative safe integer");
  }
  if (
    options.chainAnchor &&
    (options.chainAnchor.rewardCycle !== options.currentRewardCycle ||
      options.chainAnchor.burnBlockHeight !== options.burnBlockHeight ||
      options.chainAnchor.stacksBlockHeight !== options.stacksTipHeight)
  ) {
    throw new Error("Signer-staker inputs do not match the supplied chain anchor");
  }
  const pageLimit = options.pageLimit ?? 200;
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 200) {
    throw new Error("pageLimit must be an integer from 1 through 200");
  }
  const stakerConcurrency = options.stakerConcurrency ?? 4;
  if (!Number.isSafeInteger(stakerConcurrency) || stakerConcurrency < 1 || stakerConcurrency > 16) {
    throw new Error("stakerConcurrency must be an integer from 1 through 16");
  }
  let anchorFenced = false;
  if (options.chainAnchor && options.api.getStatus) {
    const before = await options.api.getStatus();
    if (!apiStatusMatchesAnchor(before, options.chainAnchor)) {
      throw new SignerStakerAnchorError("Signer-staker API is not at the requested chain anchor");
    }
    anchorFenced = true;
  }

  const hasPriorAuthoritativeRun =
    options.store.getLatestCompletedSignerStakerRun(options.sourceId, options.managerPrincipal) !==
    null;
  const retainedStakers = options.store.listSignerStakers(options.managerPrincipal);
  const retainedByPrincipal = new Map(
    retainedStakers.map((staker) => [staker.stakerPrincipal, staker] as const),
  );
  const storedCandidatePrincipals = new Set(retainedByPrincipal.keys());
  const verifiedStoredStxPrincipals = new Set(
    retainedStakers
      .filter((staker) => staker.hasStx && staker.stxNodeVerified && staker.position?.active)
      .map((staker) => staker.stakerPrincipal),
  );
  for (const membership of options.store.listCycleMemberships(options.managerPrincipal)) {
    storedCandidatePrincipals.add(membership.stakerPrincipal);
    verifiedStoredStxPrincipals.add(membership.stakerPrincipal);
  }
  const retainedCandidates = new Set(storedCandidatePrincipals);
  for (const stakerPrincipal of options.transitionCandidatePrincipals ?? []) {
    retainedCandidates.add(stakerPrincipal);
  }

  const initialRun = options.store.startOrResumeSignerStakerRun(
    options.sourceId,
    options.managerPrincipal,
    options.observedAt,
    options.chainAnchor,
  );
  const resumed = initialRun.pagesProcessed > 0;
  let run = initialRun;
  const requestedCursors = new Set<string | null>();
  const seenApiStakers = new Set(
    options.store.listSignerStakerPrincipalsSeenInRun(initialRun.runId),
  );
  const discrepancies: SignerStakerDiscrepancy[] = [];
  let expectedTotal: number | null = null;

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
    // API v9 defines `current` as the first row in the returned page, including on the initial
    // request. Subsequent requests use the prior page's look-ahead `next` row as an inclusive
    // cursor, so that first row must also equal the requested cursor when resuming.
    const responseCurrent = page.results[0]?.staker ?? null;
    if (page.cursor.current !== responseCurrent) {
      throw new Error(
        `Signer-staker API current cursor ${page.cursor.current ?? "<empty>"} ` +
          `does not match first result ${responseCurrent ?? "<empty>"}`,
      );
    }
    if (run.cursor !== null && responseCurrent !== run.cursor) {
      throw new Error(
        `Signer-staker API did not resume at requested cursor ${run.cursor}; ` +
          `received ${responseCurrent ?? "<empty>"}`,
      );
    }
    if (expectedTotal !== null && expectedTotal !== page.total) {
      throw new Error(`Signer-staker API total changed from ${expectedTotal} to ${page.total}`);
    }
    expectedTotal = page.total;
    const pagePrincipals = new Set<string>();
    for (const item of page.results) {
      if (pagePrincipals.has(item.staker) || seenApiStakers.has(item.staker)) {
        throw new Error(`Signer-staker API repeated staker ${item.staker}`);
      }
      pagePrincipals.add(item.staker);
    }
    const apiItemsAfterPage = run.itemsProcessed + page.results.length;
    if (apiItemsAfterPage > page.total) {
      throw new Error(
        `Signer-staker API returned ${apiItemsAfterPage} items for total ${page.total}`,
      );
    }
    const apiEnumerationComplete = page.cursor.next === null;
    if (apiEnumerationComplete && apiItemsAfterPage !== page.total) {
      throw new Error(`Signer-staker API ended after ${apiItemsAfterPage} of ${page.total} items`);
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

    if (apiEnumerationComplete) {
      const candidates = [...retainedCandidates]
        .filter((principal) => !seenApiStakers.has(principal) && !pagePrincipals.has(principal))
        .map((principal) => {
          const retained = retainedByPrincipal.get(principal);
          const types: ("stx" | "btc")[] = [];
          if (retained?.hasStx ?? true) types.push("stx");
          if (retained?.hasBtc) types.push("btc");
          return {
            item: { staker: principal, types },
            allowRetainedStxAbsence:
              anchorFenced &&
              verifiedStoredStxPrincipals.has(principal) &&
              types.length === 1 &&
              types[0] === "stx",
          };
        });
      for (let index = 0; index < candidates.length; index += stakerConcurrency) {
        const verifiedBatch = await Promise.all(
          candidates
            .slice(index, index + stakerConcurrency)
            .map(({ item, allowRetainedStxAbsence }) =>
              verifyPageItem(item, options, { allowRetainedStxAbsence }),
            ),
        );
        for (const verified of verifiedBatch) {
          verifiedItems.push(verified.item);
          if (verified.discrepancy) discrepancies.push(verified.discrepancy);
        }
      }

      if (options.chainAnchor && options.api.getStatus) {
        const after = await options.api.getStatus();
        if (!apiStatusMatchesAnchor(after, options.chainAnchor)) {
          throw new SignerStakerAnchorError("Chain tip moved during signer-staker enumeration");
        }
      }
    }

    run = options.store.commitSignerStakerPage({
      runId: run.runId,
      sourceId: options.sourceId,
      nodeSourceId: options.nodeSourceId,
      managerPrincipal: options.managerPrincipal,
      nextCursor: page.cursor.next,
      items: verifiedItems,
      apiItemsProcessed: page.results.length,
      authoritativeCompletion:
        apiEnumerationComplete &&
        anchorFenced &&
        (apiItemsAfterPage > 0 || retainedCandidates.size > 0 || hasPriorAuthoritativeRun) &&
        verifiedItems.every((item) => item.reconciliationComplete),
      ...(options.chainAnchor ? { chainAnchor: options.chainAnchor } : {}),
      observedAt: options.observedAt,
      burnBlockHeight: options.burnBlockHeight,
      stacksTipHeight: options.stacksTipHeight,
    });
    for (const principal of pagePrincipals) seenApiStakers.add(principal);
  }

  const activeStakers = options.store.listSignerStakers(options.managerPrincipal);
  return {
    runId: run.runId,
    resumed,
    status: run.authoritative ? "completed" : "incomplete",
    authoritative: run.authoritative,
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
