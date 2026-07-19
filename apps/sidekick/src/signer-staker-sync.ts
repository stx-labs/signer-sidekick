import type { ClarityValue } from "@stx-labs/signer-sidekick-protocol/clarity-codecs";
import {
  decodePox5CycleMembership,
  decodePox5StakerInfo,
  decodeUInt,
  encodePrincipalHex,
  encodeUIntHex,
} from "@stx-labs/signer-sidekick-protocol/clarity-codecs";
import type { ChainAnchor } from "./chain-anchor.js";
import type {
  ApiStatus,
  ChainReadOptions,
  SignerStakersPage,
  StacksBlockSummary,
} from "./chain-clients.js";
import type { SidekickStore, SignerStakerPageItem } from "./storage/store.js";

const maxStxFutureStackingCycles = 96n;

export interface SignerStakerApi {
  getSignerStakers(
    signerPrincipal: string,
    cursor?: string | null,
    limit?: number,
  ): Promise<SignerStakersPage>;
  getStatus?(): Promise<ApiStatus>;
  getBlock?(heightOrHash: number | string): Promise<StacksBlockSummary>;
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
  onProgress?: (progress: SyncSignerStakersProgress) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface SyncSignerStakersProgress {
  phase: "discovering" | "verifying";
  completed: number;
  total: number | null;
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
  readonly invalidatesSealedRun: boolean;

  constructor(message: string, options: ErrorOptions & { invalidatesSealedRun?: boolean } = {}) {
    super(message, options);
    this.name = "SignerStakerAnchorError";
    this.invalidatesSealedRun = options.invalidatesSealedRun ?? false;
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
    status.chain_tip.index_block_hash.toLowerCase() === anchor.indexBlockHash.toLowerCase() &&
    status.chain_tip.burn_block_height === anchor.burnBlockHeight
  );
}

function apiStatusesHaveSameTip(left: ApiStatus, right: ApiStatus): boolean {
  return (
    left.chain_tip.block_height === right.chain_tip.block_height &&
    left.chain_tip.block_hash.toLowerCase() === right.chain_tip.block_hash.toLowerCase() &&
    left.chain_tip.index_block_hash.toLowerCase() ===
      right.chain_tip.index_block_hash.toLowerCase() &&
    left.chain_tip.burn_block_height === right.chain_tip.burn_block_height
  );
}

function blockMatchesAnchor(block: StacksBlockSummary, anchor: ChainAnchor): boolean {
  return (
    block.canonical &&
    block.height === anchor.stacksBlockHeight &&
    block.index_block_hash.toLowerCase() === anchor.indexBlockHash.toLowerCase() &&
    block.burn_block_height === anchor.burnBlockHeight
  );
}

async function proveSealedAnchorRemainsCanonical(
  api: Required<Pick<SignerStakerApi, "getStatus" | "getBlock">>,
  anchor: ChainAnchor,
  signal?: AbortSignal,
): Promise<void> {
  try {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      signal?.throwIfAborted();
      const before = await api.getStatus();
      signal?.throwIfAborted();
      if (before.chain_tip.block_height < anchor.stacksBlockHeight) {
        throw new SignerStakerAnchorError("Signer-staker API is behind the sealed chain anchor");
      }
      const block = await api.getBlock(anchor.stacksBlockHeight);
      signal?.throwIfAborted();
      const after = await api.getStatus();
      signal?.throwIfAborted();
      if (!apiStatusesHaveSameTip(before, after)) {
        if (attempt < 3) continue;
        throw new SignerStakerAnchorError(
          "Chain tip moved while revalidating the sealed signer-staker anchor",
        );
      }
      if (!blockMatchesAnchor(block, anchor)) {
        throw new SignerStakerAnchorError("Sealed signer-staker anchor is no longer canonical", {
          invalidatesSealedRun: true,
        });
      }
      return;
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof SignerStakerAnchorError) throw error;
    throw new SignerStakerAnchorError("Unable to revalidate the sealed signer-staker anchor", {
      cause: error,
    });
  }
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
  options.signal?.throwIfAborted();
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

  const sealedRun = options.store.getResumableSignerStakerRun(
    options.sourceId,
    options.managerPrincipal,
  );
  if (sealedRun && !sealedRun.chainAnchor) {
    throw new Error(`Sealed signer-staker API roster ${sealedRun.runId} has no chain anchor`);
  }
  const initialRun = options.store.startOrResumeSignerStakerRun(
    options.sourceId,
    options.managerPrincipal,
    options.observedAt,
    sealedRun?.chainAnchor ?? options.chainAnchor,
  );
  const resumed = initialRun.pagesProcessed > 0;
  let run = initialRun;
  const reconciliationAnchor = run.chainAnchor ?? options.chainAnchor;
  const reconciliationBurnBlockHeight =
    reconciliationAnchor?.burnBlockHeight ?? options.burnBlockHeight;
  const reconciliationStacksTipHeight =
    reconciliationAnchor?.stacksBlockHeight ?? options.stacksTipHeight;
  const reconciliationRewardCycle = reconciliationAnchor?.rewardCycle ?? options.currentRewardCycle;
  const verificationOptions = {
    node: options.node,
    pox5ContractId: options.pox5ContractId,
    managerPrincipal: options.managerPrincipal,
    currentRewardCycle: reconciliationRewardCycle,
    ...(reconciliationAnchor ? { chainAnchor: reconciliationAnchor } : {}),
  };
  const discrepancies: SignerStakerDiscrepancy[] = [];
  let apiScan = options.store.getSignerStakerApiScan(run.runId);

  if (!apiScan?.sealed) {
    await options.onProgress?.({
      phase: "discovering",
      completed: run.itemsProcessed,
      total: apiScan?.expectedTotal ?? null,
    });
    const getStatus =
      options.api.getStatus === undefined ? undefined : () => options.api.getStatus?.();
    const canFenceAnchor =
      reconciliationAnchor !== undefined &&
      getStatus !== undefined &&
      options.api.getBlock !== undefined;
    if (canFenceAnchor) {
      options.signal?.throwIfAborted();
      const before = await getStatus();
      options.signal?.throwIfAborted();
      if (!before || !apiStatusMatchesAnchor(before, reconciliationAnchor)) {
        throw new SignerStakerAnchorError("Signer-staker API is not at the requested chain anchor");
      }
    }

    const requestedCursors = new Set<string | null>();
    const seenApiStakers = new Set(apiScan?.items.map((item) => item.stakerPrincipal) ?? []);
    let expectedTotal = apiScan?.expectedTotal ?? null;
    while (!apiScan?.sealed) {
      options.signal?.throwIfAborted();
      if (requestedCursors.has(run.cursor)) {
        throw new Error(`Signer-staker API repeated cursor ${run.cursor ?? "<initial>"}`);
      }
      requestedCursors.add(run.cursor);
      const page = await options.api.getSignerStakers(
        options.managerPrincipal,
        run.cursor,
        pageLimit,
      );
      options.signal?.throwIfAborted();
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
        throw new Error(
          `Signer-staker API ended after ${apiItemsAfterPage} of ${page.total} items`,
        );
      }
      if (apiEnumerationComplete && canFenceAnchor) {
        const after = await getStatus();
        options.signal?.throwIfAborted();
        if (!after || !apiStatusMatchesAnchor(after, reconciliationAnchor)) {
          throw new SignerStakerAnchorError("Chain tip moved during signer-staker enumeration");
        }
      }

      options.signal?.throwIfAborted();
      run = options.store.commitSignerStakerApiPage({
        runId: run.runId,
        sourceId: options.sourceId,
        managerPrincipal: options.managerPrincipal,
        requestedCursor: run.cursor,
        nextCursor: page.cursor.next,
        items: page.results.map((item) => ({
          stakerPrincipal: item.staker,
          hasStx: item.types.includes("stx"),
          hasBtc: item.types.includes("btc"),
        })),
        expectedTotal: page.total,
        sealed: apiEnumerationComplete,
        anchorFenced: apiEnumerationComplete && canFenceAnchor,
        ...(reconciliationAnchor ? { chainAnchor: reconciliationAnchor } : {}),
        observedAt: options.observedAt,
      });
      for (const principal of pagePrincipals) seenApiStakers.add(principal);
      apiScan = options.store.getSignerStakerApiScan(run.runId);
      if (!apiScan) throw new Error(`Signer-staker API roster ${run.runId} was not persisted`);
    }
    await options.onProgress?.({
      phase: "discovering",
      completed: apiScan.items.length,
      total: apiScan.expectedTotal,
    });
  }

  if (!apiScan?.sealed) throw new Error(`Signer-staker API roster ${run.runId} is not sealed`);
  const apiPrincipals = new Set(apiScan.items.map((item) => item.stakerPrincipal));
  const candidates: Array<{
    item: SignerStakersPage["results"][number];
    allowRetainedStxAbsence?: boolean;
  }> = apiScan.items.map((item) => {
    const types: ("stx" | "btc")[] = [];
    if (item.hasStx) types.push("stx");
    if (item.hasBtc) types.push("btc");
    return { item: { staker: item.stakerPrincipal, types } };
  });
  for (const principal of retainedCandidates) {
    if (apiPrincipals.has(principal)) continue;
    const retained = retainedByPrincipal.get(principal);
    const types: ("stx" | "btc")[] = [];
    if (retained?.hasStx ?? true) types.push("stx");
    if (retained?.hasBtc) types.push("btc");
    candidates.push({
      item: { staker: principal, types },
      allowRetainedStxAbsence:
        apiScan.anchorFenced &&
        verifiedStoredStxPrincipals.has(principal) &&
        types.length === 1 &&
        types[0] === "stx",
    });
  }

  const verifiedItems: SignerStakerPageItem[] = [];
  await options.onProgress?.({ phase: "verifying", completed: 0, total: candidates.length });
  for (let index = 0; index < candidates.length; index += stakerConcurrency) {
    options.signal?.throwIfAborted();
    const verifiedBatch = await Promise.all(
      candidates
        .slice(index, index + stakerConcurrency)
        .map(({ item, allowRetainedStxAbsence }) =>
          verifyPageItem(
            item,
            verificationOptions,
            allowRetainedStxAbsence === undefined ? {} : { allowRetainedStxAbsence },
          ),
        ),
    );
    options.signal?.throwIfAborted();
    for (const verified of verifiedBatch) {
      verifiedItems.push(verified.item);
      if (verified.discrepancy) discrepancies.push(verified.discrepancy);
    }
    await options.onProgress?.({
      phase: "verifying",
      completed: verifiedItems.length,
      total: candidates.length,
    });
  }

  let canonicalAnchorVerified = false;
  if (apiScan.anchorFenced) {
    options.signal?.throwIfAborted();
    if (!reconciliationAnchor || !options.api.getStatus || !options.api.getBlock) {
      throw new SignerStakerAnchorError(
        "Sealed signer-staker anchor cannot be revalidated by the configured API",
      );
    }
    try {
      await proveSealedAnchorRemainsCanonical(
        {
          getStatus: () => options.api.getStatus?.() as Promise<ApiStatus>,
          getBlock: (height) => options.api.getBlock?.(height) as Promise<StacksBlockSummary>,
        },
        reconciliationAnchor,
        options.signal,
      );
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof SignerStakerAnchorError && error.invalidatesSealedRun) {
        options.store.abandonSealedSignerStakerRun(run.runId, options.observedAt);
      }
      throw error;
    }
    canonicalAnchorVerified = true;
  }

  options.signal?.throwIfAborted();
  run = options.store.commitSignerStakerPage({
    runId: run.runId,
    sourceId: options.sourceId,
    nodeSourceId: options.nodeSourceId,
    managerPrincipal: options.managerPrincipal,
    nextCursor: null,
    items: verifiedItems,
    apiItemsProcessed: 0,
    recordApiPage: false,
    authoritativeCompletion:
      apiScan.anchorFenced &&
      canonicalAnchorVerified &&
      (apiScan.expectedTotal > 0 || retainedCandidates.size > 0 || hasPriorAuthoritativeRun) &&
      verifiedItems.every((item) => item.reconciliationComplete),
    ...(reconciliationAnchor ? { chainAnchor: reconciliationAnchor } : {}),
    observedAt: options.observedAt,
    burnBlockHeight: reconciliationBurnBlockHeight,
    stacksTipHeight: reconciliationStacksTipHeight,
  });

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
