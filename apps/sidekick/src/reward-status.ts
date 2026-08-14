import { cvToHex, noneCV, someCV, tupleCV, uintCV } from "@stacks/transactions";
import {
  type ClarityValue,
  decodeEarnedStakerRewards,
  decodeOptionalUInt,
  decodePoxAddressPreference,
  decodeUInt,
  encodeOptionalUIntHex,
  encodePrincipalHex,
  encodeUIntHex,
} from "@stx-labs/signer-sidekick-protocol/clarity-codecs";
import { bondPeriodsForRewardCycle } from "@stx-labs/signer-sidekick-protocol/pox5-bonds";
import {
  POX5_REWARD_PRECISION,
  type Pox5RewardSimulation,
  Pox5RewardSimulationError,
  simulatePox5CalculateRewards,
} from "@stx-labs/signer-sidekick-protocol/pox5-calculate-rewards";
import {
  type ChainAnchor,
  chainAnchorsEqual,
  deriveRewardCalculationTarget,
} from "./chain-anchor.js";
import type { ChainReadOptions } from "./chain-clients.js";
import {
  Pox5CalculateRewardsError,
  type Pox5CurrentPoolEstimate,
  type Pox5PoolSimulationSnapshot,
  readPox5PoolSimulationSnapshot,
  simulatePox5PoolEstimateAtGross,
} from "./pox5-calculate-rewards.js";
import {
  assessRewardCalibration,
  calibratedForecastConfidence,
  REWARD_FORECAST_MODEL_REVISION,
  type RewardCalibrationAssessment,
  type RewardForecastEvaluation,
} from "./reward-calibration.js";
import { projectGlobalRewardRunRate, type RewardForecastObservation } from "./reward-forecast.js";
import type {
  RewardCycleSnapshotInput,
  RewardOutlookObservationInput,
  SignerStakerRun,
  StoredCycleMembership,
  StoredSignerStaker,
} from "./storage/store.js";

export interface RewardStatusNode {
  callReadOnly(
    principal: string,
    functionName: string,
    sender: string,
    args: readonly string[],
    options?: ChainReadOptions,
  ): Promise<ClarityValue>;
  getDataVar(
    principal: string,
    variableName: string,
    options?: ChainReadOptions,
  ): Promise<ClarityValue>;
  getMapEntry(
    principal: string,
    mapName: string,
    key: string,
    options?: ChainReadOptions,
  ): Promise<ClarityValue>;
}

export interface RewardStatusStore {
  getLatestCompletedSignerStakerRun(
    sourceId: string,
    managerPrincipal: string,
  ): SignerStakerRun | null;
  listCycleMembershipsForCycle(
    managerPrincipal: string,
    rewardCycle: number,
    sourceId?: string | null,
  ): StoredCycleMembership[];
  listSignerStakers?(
    managerPrincipal: string,
    activeOnly?: boolean,
    sourceId?: string | null,
  ): StoredSignerStaker[];
  putRewardCycleSnapshot?(input: RewardCycleSnapshotInput): void;
  putRewardOutlookObservation?(input: RewardOutlookObservationInput): void;
  listRewardCalculationRealizations?(
    managerPrincipal: string,
    pox5ContractId: string,
    options?: { limit?: number; canonicalOnly?: boolean },
  ): Array<{
    modelRevision: number;
    targetRewardCycle: number;
    calculationBurnHeight: number;
    poolEstimate: { grossSats: string } | null;
    evaluation: RewardForecastEvaluation | null;
  }>;
  getRewardCalculationEligibilityObservation?(
    managerPrincipal: string,
    pox5ContractId: string,
    target: {
      rewardCycle: number;
      checkpoint: "first-half" | "second-half";
      calculationBurnHeight: number;
    },
  ): {
    observedAt: string;
    stacksBlockHeight: number;
    burnBlockHeight: number;
    indexBlockHash: string;
  } | null;
  listRewardForecastSamples?(
    managerPrincipal: string,
    pox5ContractId: string,
    query: {
      lastRewardComputeBurnHeight: string;
      targetRewardCycle: number;
      targetCheckpoint: "first-half" | "second-half";
      calculationBurnHeight: number;
      throughBurnBlockHeight: number;
      limit?: number;
    },
  ): RewardForecastObservation[];
}

export interface RewardStatusOptions {
  store: RewardStatusStore;
  node: RewardStatusNode;
  sourceId: string;
  managerPrincipal: string;
  pox5ContractId: string;
  rewardCycle: number;
  observedAt: string;
  burnBlockHeight: number;
  stacksTipHeight: number;
  chainAnchor?: ChainAnchor;
  rewardOutlook?: RewardOutlookStatus;
}

export interface RewardOutlookOptions {
  store: Pick<
    RewardStatusStore,
    | "putRewardOutlookObservation"
    | "listRewardForecastSamples"
    | "listRewardCalculationRealizations"
    | "getRewardCalculationEligibilityObservation"
    | "getLatestCompletedSignerStakerRun"
    | "listCycleMembershipsForCycle"
    | "listSignerStakers"
  >;
  node: Pick<RewardStatusNode, "callReadOnly"> &
    Partial<Pick<RewardStatusNode, "getDataVar" | "getMapEntry">>;
  managerPrincipal: string;
  pox5ContractId: string;
  observedAt: string;
  chainAnchor?: ChainAnchor;
  sourceId?: string;
  feeCapability?: {
    executionAvailable: boolean;
    adapter: { id: string; revision: number } | null;
    reason: string;
  };
}

/** One settleable `(staker, reward-cycle, bond-index)` tuple: exactly one transaction's worth. */
export interface StakerRewardClaim {
  /** `null` is the STX-only bucket. */
  bondIndex: string | null;
  rewards: {
    earnedSats: string;
    feeSats: string;
    grossSats: string;
  };
  /** False when the manager would reject the call, so Sidekick must not propose it. */
  claimable: boolean;
  /**
   * Mirrors the wallet-intent preparation guards exactly. Discovery that labelled a claim ready
   * where preparation refuses it would send the operator to a dead end.
   */
  blockedReason:
    | null
    | "nothing-settled"
    | "manager-has-not-claimed"
    | "l1-below-max-fee"
    | "l1-below-dust-limit";
}

/**
 * What settling this cycle would actually cost. `claim-staker-rewards` has no batch form, so the
 * outstanding claim count is the transaction count, and an operator deserves to see it before
 * starting rather than after signing the first one.
 */
export interface StakerSettlementSummary {
  /** Scoped to the stakers this page read, never the whole cycle. */
  scope: "page";
  stakersScanned: number;
  outstandingClaims: number;
  /** One transaction per outstanding claim; the contract offers no way to combine them. */
  transactionCount: number;
  totalNetSats: string;
  blockedClaims: number;
}

export interface StakerClaimDiscoveryOptions {
  node: RewardStatusNode;
  managerPrincipal: string;
  rewardCycle: number;
  /** The page of stakers to read. The caller decides the page; this function never enumerates. */
  stakerPrincipals: readonly string[];
  /** Bond buckets to probe, normally the participating ones from `readStxRewardStatus`. */
  bondIndices: readonly bigint[];
  chainAnchor?: ChainAnchor;
  concurrency?: number;
}

export interface StakerClaimDiscovery {
  rewardCycle: number;
  stakers: StakerRewardStatus[];
  settlement: StakerSettlementSummary;
}

/** Hard ceiling on a single page, so one call cannot become the crawl this split removed. */
const maxStakerClaimPage = 100;
/** `sbtc-withdrawal` asserts `(> amount DUST_LIMIT)` on net minus the staker's fee budget. */
const sbtcWithdrawalDustLimit = 546n;

export interface StakerRewardStatus {
  stakerPrincipal: string;
  rewardCycle: number;
  payout:
    | {
        kind: "direct-sbtc";
        poxAddress: null;
        maxFeeSats: null;
      }
    | {
        kind: "bitcoin-l1";
        poxAddress: {
          versionHex: string;
          hashbytesHex: string;
        };
        maxFeeSats: string;
      };
  rewards: {
    earnedSats: string;
    feeSats: string;
    grossSats: string;
  };
  claimableByPolicy: boolean;
  /**
   * Claims for the buckets that were read. The operator snapshot reads only the STX bucket; use
   * `discoverStakerClaims` for the full per-bucket set.
   */
  claims: StakerRewardClaim[];
}

/**
 * One PoX-5 reward bucket for this manager in the observed cycle. The STX-only bucket is keyed by
 * `bond-index: none`; each participating bond period gets its own. `claim-rewards` sweeps whichever
 * buckets the call names, and the manager pins a fee snapshot for each named bucket, so the buckets
 * are what a claim is actually built from.
 */
export interface RewardBucketStatus {
  /** `null` is the STX-only bucket. */
  bondIndex: string | null;
  managerSharesSats: string;
  signerEarnedBeforeManagerClaimSats: string;
  rewardsPerToken: string;
  feeSnapshotBips: string | null;
  /**
   * True when a claim must name this bucket. Shares alone is not enough: unstaking settles rewards
   * into the unclaimed balance before zeroing shares, so a zero-share bucket can still owe sats.
   */
  participating: boolean;
}

/**
 * State of the permissionless global `calculate-rewards` call for the cycle Sidekick would claim.
 * Nothing is claimable until it runs, and Observe never calls it, so an operator seeing zero
 * rewards needs to know whether the calculation is outstanding or genuinely produced nothing.
 */
export interface RewardCalculationStatus {
  state: "pending" | "completed" | "ahead" | "unknown";
  targetRewardCycle: number | null;
  targetCheckpoint: "first-half" | "second-half" | null;
  expectedLastRewardComputeBurnHeight: number | null;
  observedLastRewardComputeBurnHeight: string;
  next: null | {
    state: "due" | "scheduled";
    targetRewardCycle: number;
    targetCheckpoint: "first-half" | "second-half";
    calculationBurnHeight: number;
    eligibleBurnHeight: number;
    blocksRemaining: number;
    grace: null | {
      state: "scheduled" | "awaiting-calculation" | "action-required";
      firstEligibleObservedAt: string | null;
      firstEligibleStacksBlockHeight: number | null;
      elapsedMinutes: number;
      canonicalStacksBlocks: number;
      requiredMinutes: 10;
      requiredCanonicalStacksBlocks: 24;
    };
  };
}

export interface RewardOutlookStatus {
  pox5ContractId: string;
  observedAt: string;
  chainAnchor: ChainAnchor | null;
  accrued: {
    globalSats: string;
    source: "pox5-get-new-rewards";
  };
  poolEstimate: Pox5CurrentPoolEstimate | null;
  poolEstimateUnavailableReason:
    | "chain-anchor-unavailable"
    | "calculation-target-unavailable"
    | "incomplete-active-bond-state"
    | "anchored-inputs-unavailable"
    | "contract-simulation-failed"
    | null;
  forecast: null | {
    kind: "checkpoint-run-rate";
    targetRewardCycle: number;
    targetCheckpoint: "first-half" | "second-half";
    calculationBurnHeight: number;
    globalSats: { low: string; point: string; high: string };
    poolSats: { low: string; point: string; high: string };
    sample: {
      observations: number;
      firstObservedBurnHeight: number;
      lastObservedBurnHeight: number;
      sampleBlocks: number;
      elapsedBlocks: number;
      remainingBlocks: number;
    };
    confidence: "low" | "developing" | "calibrated";
    assumptions: [
      "zero-accrual-after-last-calculation",
      "linear-global-accrual-run-rate",
      "current-cycle-shares",
      "current-active-bond-set",
      "unchanged-reserve-before-calculation",
      "contract-integer-rounding",
    ];
  };
  forecastUnavailableReason:
    | "chain-anchor-unavailable"
    | "calculation-target-unavailable"
    | "current-pool-estimate-unavailable"
    | "insufficient-samples"
    | "non-monotonic-accrual"
    | "forecast-inputs-unavailable"
    | "contract-simulation-failed"
    | null;
  operatorFeeForecast: null | {
    kind: "reference-manager-exact";
    sats: { low: string; point: string; high: string };
    inputs: {
      stakers: number;
      buckets: Array<{
        bondIndex: string | null;
        feeBips: string;
        source: "cycle-snapshot" | "configured-fee-assumption";
      }>;
    };
    assumptions: Array<"per-staker-per-bucket-integer-rounding" | "configured-fee-until-claim">;
  };
  operatorFeeForecastUnavailableReason:
    | "reviewed-fee-capability-unavailable"
    | "forecast-unavailable"
    | "authoritative-roster-unavailable"
    | "per-staker-shares-incomplete"
    | "anchored-fee-inputs-unavailable"
    | null;
  calibration: RewardCalibrationAssessment;
  calculation: RewardCalculationStatus;
}

export interface StxRewardStatus {
  status: "ready" | "attention";
  managerPrincipal: string;
  pox5ContractId: string;
  rewardCycle: number;
  observedAt: {
    timestamp: string;
    burnBlockHeight: number;
    stacksTipHeight: number;
  };
  ingestion: null | {
    runId: string;
    completedAt: string;
  };
  global: {
    lastRewardComputeBurnHeight: string;
    lastComputedRewardCycle: string | null;
    /** Exact PoX-5 `get-new-rewards`: global accrual since the last calculation. */
    globalAccruedRewardsSats: string;
    rewardsPerToken: string;
    /** The STX-only bucket. Kept for compatibility; `buckets` carries the full picture. */
    signerEarnedBeforeManagerClaimSats: string;
    /** Sum across the STX bucket and every participating bond bucket. */
    signerEarnedAcrossBucketsSats: string;
  };
  calculation: RewardCalculationStatus;
  /** The STX bucket first, then participating bond buckets ascending by index. */
  buckets: RewardBucketStatus[];
  manager: {
    configuredFeeBips: string;
    feeSnapshotBips: string | null;
    earnedFeesSats: string;
    withdrawalLiabilitySats: string;
    unclaimedStakerRewardsSats: string;
  };
  totals: {
    stakers: number;
    grossSats: string;
    earnedSats: string;
    feeSats: string;
    actionableClaims: number;
    l1ClaimsWaitingForFeeThreshold: number;
  };
  stakers: StakerRewardStatus[];
}

function callReadOnly(
  node: Pick<RewardStatusNode, "callReadOnly">,
  principal: string,
  functionName: string,
  sender: string,
  args: readonly string[],
  options?: ChainReadOptions,
): Promise<ClarityValue> {
  return options
    ? node.callReadOnly(principal, functionName, sender, args, options)
    : node.callReadOnly(principal, functionName, sender, args);
}

function getDataVar(
  node: RewardStatusNode,
  principal: string,
  variableName: string,
  options?: ChainReadOptions,
): Promise<ClarityValue> {
  return options
    ? node.getDataVar(principal, variableName, options)
    : node.getDataVar(principal, variableName);
}

function getMapEntry(
  node: RewardStatusNode,
  principal: string,
  mapName: string,
  key: string,
  options?: ChainReadOptions,
): Promise<ClarityValue> {
  return options
    ? node.getMapEntry(principal, mapName, key, options)
    : node.getMapEntry(principal, mapName, key);
}

/**
 * Reads a staker's position in every bucket they could hold rewards in.
 *
 * `claim-staker-rewards` settles one `(staker, reward-cycle, bond-index)` at a time and has no
 * batch form, so each bucket that owes something is its own transaction. That makes it worth
 * knowing exactly which ones are worth sending: a bucket that pays zero, or an L1 payout that
 * cannot cover the staker's own withdrawal fee budget, is a call the manager would reject.
 */
async function readStakerReward(
  node: RewardStatusNode,
  managerPrincipal: string,
  stakerPrincipal: string,
  rewardCycle: number,
  bondIndices: readonly (bigint | null)[],
  /** Buckets whose manager fee snapshot was observed at this anchor. */
  claimedBuckets: ReadonlySet<string>,
  /** `get-unclaimed-staker-rewards`; the manager asserts this covers each gross payout. */
  managerUnclaimedSats: bigint,
  options?: ChainReadOptions,
): Promise<StakerRewardStatus> {
  const [payoutValue, ...rewardValues] = await Promise.all([
    callReadOnly(
      node,
      managerPrincipal,
      "get-pox-addr",
      managerPrincipal,
      [encodePrincipalHex(stakerPrincipal)],
      options,
    ),
    ...bondIndices.map((bondIndex) =>
      callReadOnly(
        node,
        managerPrincipal,
        "get-earned-staker-rewards",
        managerPrincipal,
        [
          encodePrincipalHex(stakerPrincipal),
          encodeUIntHex(BigInt(rewardCycle)),
          encodeOptionalUIntHex(bondIndex),
        ],
        options,
      ),
    ),
  ]);
  const payout = decodePoxAddressPreference(payoutValue);
  const claims: StakerRewardClaim[] = bondIndices.map((bondIndex, index) => {
    const value = rewardValues[index];
    if (!value) throw new Error(`Missing staker reward read for ${stakerPrincipal}`);
    const rewards = decodeEarnedStakerRewards(value);
    const gross = rewards.earned + rewards.fees;
    // Same ladder the wallet-intent preparation walks, in the same order.
    const blockedReason: StakerRewardClaim["blockedReason"] =
      rewards.earned === 0n
        ? "nothing-settled"
        : !claimedBuckets.has(bucketKey(bondIndex))
          ? "manager-has-not-claimed"
          : managerUnclaimedSats < gross
            ? "manager-has-not-claimed"
            : payout === null
              ? null
              : rewards.earned < payout.maxFee
                ? "l1-below-max-fee"
                : rewards.earned - payout.maxFee <= sbtcWithdrawalDustLimit
                  ? "l1-below-dust-limit"
                  : null;
    return {
      bondIndex: bondIndex === null ? null : bondIndex.toString(),
      rewards: {
        earnedSats: rewards.earned.toString(),
        feeSats: rewards.fees.toString(),
        grossSats: gross.toString(),
      },
      claimable: blockedReason === null,
      blockedReason,
    };
  });
  const earned = sum(claims.map(({ rewards }) => BigInt(rewards.earnedSats)));
  const fees = sum(claims.map(({ rewards }) => BigInt(rewards.feeSats)));
  return {
    stakerPrincipal,
    rewardCycle,
    payout: payout
      ? {
          kind: "bitcoin-l1",
          poxAddress: {
            versionHex: payout.versionHex,
            hashbytesHex: payout.hashbytesHex,
          },
          maxFeeSats: payout.maxFee.toString(),
        }
      : { kind: "direct-sbtc", poxAddress: null, maxFeeSats: null },
    rewards: {
      earnedSats: earned.toString(),
      feeSats: fees.toString(),
      grossSats: (earned + fees).toString(),
    },
    claims,
    claimableByPolicy: claims.some(({ claimable }) => claimable),
  };
}

/**
 * Reads every settleable tuple for a bounded page of stakers.
 *
 * Separate from `readStxRewardStatus` on purpose. That runs on the operator snapshot cadence and
 * must stay proportional to the roster; this issues one `get-pox-addr` plus one
 * `get-earned-staker-rewards` per staker per bucket, so it is only safe on demand and in pages.
 */
export async function discoverStakerClaims(
  options: StakerClaimDiscoveryOptions,
): Promise<StakerClaimDiscovery> {
  if (!Number.isSafeInteger(options.rewardCycle) || options.rewardCycle < 0) {
    throw new Error("rewardCycle must be a non-negative safe integer");
  }
  if (options.stakerPrincipals.length > maxStakerClaimPage) {
    throw new Error(
      `Staker claim discovery accepts at most ${maxStakerClaimPage} stakers per page; page the roster instead`,
    );
  }
  if (new Set(options.bondIndices.map(String)).size !== options.bondIndices.length) {
    throw new Error("Bond indices must be unique");
  }
  const readOptions = options.chainAnchor ? { tip: options.chainAnchor.indexBlockHash } : undefined;
  const concurrency = options.concurrency ?? 8;
  // A staker can only hold rewards where the manager holds a bucket, so this is the exact set of
  // tuples `claim-staker-rewards` could be called with -- and therefore the exact transaction set.
  const bondIndices: (bigint | null)[] = [null, ...options.bondIndices];
  // A fee snapshot is inserted only when the manager claims a bucket. Read each bucket once per
  // page, rather than once per staker, so discovery uses the same proof as wallet preparation
  // without turning the bounded roster scan into another per-staker crawl.
  const [unclaimedValue, feeSnapshotValues] = await Promise.all([
    callReadOnly(
      options.node,
      options.managerPrincipal,
      "get-unclaimed-staker-rewards",
      options.managerPrincipal,
      [],
      readOptions,
    ),
    Promise.all(
      bondIndices.map((bondIndex) =>
        getMapEntry(
          options.node,
          options.managerPrincipal,
          "fee-bips-for-cycle",
          cvToHex(
            tupleCV({
              "reward-cycle": uintCV(BigInt(options.rewardCycle)),
              "bond-index": bondIndex === null ? noneCV() : someCV(uintCV(bondIndex)),
            }),
          ),
          readOptions,
        ),
      ),
    ),
  ]);
  const managerUnclaimedSats = decodeUInt(unclaimedValue, "get-unclaimed-staker-rewards");
  const claimedBuckets = new Set(
    bondIndices.flatMap((bondIndex, index) =>
      decodeOptionalUInt(feeSnapshotValues[index] as ClarityValue, "fee-bips-for-cycle") !== null
        ? [bucketKey(bondIndex)]
        : [],
    ),
  );
  const stakers: StakerRewardStatus[] = [];
  for (let index = 0; index < options.stakerPrincipals.length; index += concurrency) {
    stakers.push(
      ...(await Promise.all(
        options.stakerPrincipals
          .slice(index, index + concurrency)
          .map((stakerPrincipal) =>
            readStakerReward(
              options.node,
              options.managerPrincipal,
              stakerPrincipal,
              options.rewardCycle,
              bondIndices,
              claimedBuckets,
              managerUnclaimedSats,
              readOptions,
            ),
          ),
      )),
    );
  }
  const claims = stakers.flatMap(({ claims: stakerClaims }) => stakerClaims);
  const outstanding = claims.filter(({ claimable }) => claimable);
  return {
    rewardCycle: options.rewardCycle,
    stakers,
    settlement: {
      scope: "page",
      stakersScanned: stakers.length,
      outstandingClaims: outstanding.length,
      // `claim-staker-rewards` has no batch form, so this is one transaction each.
      transactionCount: outstanding.length,
      totalNetSats: sum(outstanding.map(({ rewards }) => BigInt(rewards.earnedSats))).toString(),
      // Everything that is owed but cannot be sent yet. "nothing settled" is not owed, so it is
      // not counted here.
      blockedClaims: claims.filter(
        ({ blockedReason }) => blockedReason !== null && blockedReason !== "nothing-settled",
      ).length,
    },
  };
}

function bucketKey(bondIndex: bigint | null): string {
  return bondIndex === null ? "stx" : bondIndex.toString();
}

function sum(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

/**
 * Reads one reward bucket for the manager: its shares, its settled-but-unclaimed earnings, the
 * cumulative rewards-per-token PoX-5 has credited, and whether the manager has already pinned a
 * fee for it.
 */
async function readRewardBucket(
  node: RewardStatusNode,
  managerPrincipal: string,
  pox5ContractId: string,
  rewardCycle: number,
  bondIndex: bigint | null,
  options?: ChainReadOptions,
): Promise<RewardBucketStatus> {
  const cycleArgs = [encodeUIntHex(BigInt(rewardCycle)), encodeOptionalUIntHex(bondIndex)];
  const [sharesValue, earnedValue, rewardsPerTokenValue, feeSnapshotValue] = await Promise.all([
    callReadOnly(
      node,
      pox5ContractId,
      "get-signer-shares-staked-for-cycle",
      managerPrincipal,
      [encodePrincipalHex(managerPrincipal), ...cycleArgs],
      options,
    ),
    callReadOnly(
      node,
      pox5ContractId,
      "get-earned",
      managerPrincipal,
      [encodePrincipalHex(managerPrincipal), ...cycleArgs],
      options,
    ),
    callReadOnly(
      node,
      pox5ContractId,
      "get-rewards-per-token-for-cycle",
      managerPrincipal,
      cycleArgs,
      options,
    ),
    getMapEntry(
      node,
      managerPrincipal,
      "fee-bips-for-cycle",
      cvToHex(
        tupleCV({
          "reward-cycle": uintCV(BigInt(rewardCycle)),
          "bond-index": bondIndex === null ? noneCV() : someCV(uintCV(bondIndex)),
        }),
      ),
      options,
    ),
  ]);
  const managerShares = decodeUInt(sharesValue, "get-signer-shares-staked-for-cycle");
  const earned = decodeUInt(earnedValue, "get-earned");
  return {
    bondIndex: bondIndex === null ? null : bondIndex.toString(),
    managerSharesSats: managerShares.toString(),
    signerEarnedBeforeManagerClaimSats: earned.toString(),
    rewardsPerToken: decodeUInt(rewardsPerTokenValue, "get-rewards-per-token-for-cycle").toString(),
    feeSnapshotBips: decodeOptionalUInt(feeSnapshotValue, "fee-bips-for-cycle")?.toString() ?? null,
    participating: managerShares > 0n || earned > 0n,
  };
}

/**
 * Every bond bucket that can hold shares for the cycle, read at the same tip as everything else.
 *
 * PoX-5 has no getter for `first-bond-period-cycle`, but `bond-period-to-reward-cycle(u0)` returns
 * it by construction. A chain with no bond schedule still answers, so this needs no special case
 * for STX-only deployments: the candidate windows simply come back holding nothing.
 */
async function readBondBuckets(
  node: RewardStatusNode,
  managerPrincipal: string,
  pox5ContractId: string,
  rewardCycle: number,
  options?: ChainReadOptions,
): Promise<RewardBucketStatus[]> {
  const firstBondPeriodCycle = decodeUInt(
    await callReadOnly(
      node,
      pox5ContractId,
      "bond-period-to-reward-cycle",
      managerPrincipal,
      [encodeUIntHex(0n)],
      options,
    ),
    "bond-period-to-reward-cycle",
  );
  const bondPeriods = bondPeriodsForRewardCycle(BigInt(rewardCycle), firstBondPeriodCycle);
  return Promise.all(
    bondPeriods.map((bondIndex) =>
      readRewardBucket(node, managerPrincipal, pox5ContractId, rewardCycle, bondIndex, options),
    ),
  );
}

function rewardCalculationStatus(
  observedLastRewardComputeBurnHeight: bigint,
  chainAnchor: ChainAnchor | undefined,
): RewardCalculationStatus {
  const base = {
    observedLastRewardComputeBurnHeight: observedLastRewardComputeBurnHeight.toString(),
  };
  if (!chainAnchor) {
    return {
      ...base,
      state: "unknown",
      targetRewardCycle: null,
      targetCheckpoint: null,
      expectedLastRewardComputeBurnHeight: null,
      next: null,
    };
  }
  const target = deriveRewardCalculationTarget(chainAnchor);
  if (target.status === "invalid") {
    return {
      ...base,
      state: "unknown",
      targetRewardCycle: null,
      targetCheckpoint: null,
      expectedLastRewardComputeBurnHeight: null,
      next: null,
    };
  }
  const expected = BigInt(target.expectedLastRewardComputeBurnHeight);
  const state =
    observedLastRewardComputeBurnHeight === expected
      ? "completed"
      : observedLastRewardComputeBurnHeight < expected
        ? "pending"
        : "ahead";
  let next: RewardCalculationStatus["next"] = null;
  if (state === "pending") {
    const eligibleBurnHeight = target.expectedLastRewardComputeBurnHeight + 1;
    const blocksRemaining = Math.max(0, eligibleBurnHeight - chainAnchor.burnBlockHeight);
    next = {
      state: blocksRemaining === 0 ? "due" : "scheduled",
      targetRewardCycle: target.rewardCycle,
      targetCheckpoint: target.calculationCheckpoint,
      calculationBurnHeight: target.expectedLastRewardComputeBurnHeight,
      eligibleBurnHeight,
      blocksRemaining,
      grace: null,
    };
  } else if (state === "completed") {
    const cycleStart = chainAnchor.burnBlockHeight - chainAnchor.cyclePosition;
    const firstHalf = chainAnchor.checkpoint === "first-half";
    const calculationBurnHeight = firstHalf
      ? cycleStart + chainAnchor.rewardCycleLength / 2 - 1
      : cycleStart + chainAnchor.rewardCycleLength - 1;
    const eligibleBurnHeight = calculationBurnHeight + 1;
    const blocksRemaining = Math.max(0, eligibleBurnHeight - chainAnchor.burnBlockHeight);
    next = {
      state: blocksRemaining === 0 ? "due" : "scheduled",
      targetRewardCycle: chainAnchor.rewardCycle,
      targetCheckpoint: firstHalf ? "first-half" : "second-half",
      calculationBurnHeight,
      eligibleBurnHeight,
      blocksRemaining,
      grace: null,
    };
  }
  return {
    ...base,
    // `pending` is the state that used to surface as stale local data: nobody has called the
    // permissionless `calculate-rewards` for this distribution yet, so there is nothing to claim
    // no matter how fresh Sidekick's reads are.
    state,
    targetRewardCycle: target.rewardCycle,
    targetCheckpoint: target.calculationCheckpoint,
    expectedLastRewardComputeBurnHeight: target.expectedLastRewardComputeBurnHeight,
    next,
  };
}

function applyRewardCalculationGrace(
  calculation: RewardCalculationStatus,
  options: RewardOutlookOptions,
): void {
  const next = calculation.next;
  if (!next || !options.chainAnchor) return;
  if (next.state === "scheduled") {
    next.grace = {
      state: "scheduled",
      firstEligibleObservedAt: null,
      firstEligibleStacksBlockHeight: null,
      elapsedMinutes: 0,
      canonicalStacksBlocks: 0,
      requiredMinutes: 10,
      requiredCanonicalStacksBlocks: 24,
    };
    return;
  }
  const first = options.store.getRewardCalculationEligibilityObservation?.(
    options.managerPrincipal,
    options.pox5ContractId,
    {
      rewardCycle: next.targetRewardCycle,
      checkpoint: next.targetCheckpoint,
      calculationBurnHeight: next.calculationBurnHeight,
    },
  ) ?? {
    observedAt: options.observedAt,
    stacksBlockHeight: options.chainAnchor.stacksBlockHeight,
  };
  const elapsedMinutes = Math.max(
    0,
    Math.floor((Date.parse(options.observedAt) - Date.parse(first.observedAt)) / 60_000),
  );
  const canonicalStacksBlocks = Math.max(
    0,
    options.chainAnchor.stacksBlockHeight - first.stacksBlockHeight,
  );
  next.grace = {
    state:
      elapsedMinutes >= 10 && canonicalStacksBlocks >= 24
        ? "action-required"
        : "awaiting-calculation",
    firstEligibleObservedAt: first.observedAt,
    firstEligibleStacksBlockHeight: first.stacksBlockHeight,
    elapsedMinutes,
    canonicalStacksBlocks,
    requiredMinutes: 10,
    requiredCanonicalStacksBlocks: 24,
  };
}

type OperatorFeeForecast = NonNullable<RewardOutlookStatus["operatorFeeForecast"]>;
type OperatorFeeUnavailable = Exclude<
  RewardOutlookStatus["operatorFeeForecastUnavailableReason"],
  null
>;

function exactBucketFees(input: {
  simulation: Pox5RewardSimulation;
  stxShares: readonly bigint[];
  bondShares: ReadonlyMap<string, readonly bigint[]>;
  feeBips: ReadonlyMap<string, bigint>;
}): bigint {
  const feeFor = (gross: bigint, feeBips: bigint) => (gross * feeBips) / 10_000n;
  let total = input.stxShares.reduce((fees, shares) => {
    const gross = (shares * input.simulation.accruedRewardsPerUstx) / POX5_REWARD_PRECISION;
    return fees + feeFor(gross, input.feeBips.get("stx") ?? 0n);
  }, 0n);
  for (const bond of input.simulation.bonds) {
    const key = bond.bondIndex.toString();
    for (const shares of input.bondShares.get(key) ?? []) {
      const gross = (shares * bond.accruedRewardsPerSat) / POX5_REWARD_PRECISION;
      total += feeFor(gross, input.feeBips.get(key) ?? 0n);
    }
  }
  return total;
}

async function projectExactOperatorFees(input: {
  options: RewardOutlookOptions;
  snapshot: Pox5PoolSimulationSnapshot;
  forecast: NonNullable<RewardOutlookStatus["forecast"]>;
}): Promise<
  | { status: "ready"; forecast: OperatorFeeForecast }
  | { status: "unavailable"; reason: OperatorFeeUnavailable }
> {
  const { options, snapshot } = input;
  const capability = options.feeCapability;
  if (
    !capability?.executionAvailable ||
    capability.adapter?.id !== "reference-manager-claim-rewards" ||
    capability.adapter.revision !== 1
  ) {
    return { status: "unavailable", reason: "reviewed-fee-capability-unavailable" };
  }
  if (!options.node.getDataVar || !options.node.getMapEntry) {
    return { status: "unavailable", reason: "anchored-fee-inputs-unavailable" };
  }
  const getDataVar = options.node.getDataVar.bind(options.node);
  const getMapEntry = options.node.getMapEntry.bind(options.node);
  if (!options.chainAnchor || !options.sourceId || !options.store.listSignerStakers) {
    return { status: "unavailable", reason: "authoritative-roster-unavailable" };
  }
  const run = options.store.getLatestCompletedSignerStakerRun(
    options.sourceId,
    options.managerPrincipal,
  );
  if (
    !run?.authoritative ||
    !run.chainAnchor ||
    !chainAnchorsEqual(run.chainAnchor, options.chainAnchor)
  ) {
    return { status: "unavailable", reason: "authoritative-roster-unavailable" };
  }
  const targetCycle = input.forecast.targetRewardCycle;
  const memberships = options.store
    .listCycleMembershipsForCycle(options.managerPrincipal, targetCycle, options.sourceId)
    .filter(
      ({ signerPrincipal, active }) => signerPrincipal === options.managerPrincipal && active,
    );
  const stxShares = memberships.map(({ amountUstx }) => amountUstx);
  const stakers = options.store.listSignerStakers(options.managerPrincipal, true, options.sourceId);
  const bondShares = new Map<string, bigint[]>();
  for (const staker of stakers) {
    if (!staker.bond) continue;
    const key = staker.bond.bondIndex.toString();
    const bucket = bondShares.get(key) ?? [];
    bucket.push(staker.bond.amountSats);
    bondShares.set(key, bucket);
  }
  const managerStxShares = snapshot.simulationInput.managerStxSharesUstx;
  if (
    managerStxShares === undefined ||
    sum(stxShares) !== managerStxShares ||
    snapshot.simulationInput.bonds.some(
      (bond) =>
        bond.managerSharesSats === undefined ||
        sum(bondShares.get(bond.bondIndex.toString()) ?? []) !== bond.managerSharesSats,
    )
  ) {
    return { status: "unavailable", reason: "per-staker-shares-incomplete" };
  }
  try {
    const readOptions = { tip: options.chainAnchor.indexBlockHash };
    const configuredFee = decodeUInt(
      await getDataVar(options.managerPrincipal, "fees-bips", readOptions),
      "fees-bips",
    );
    const bucketIndices: Array<bigint | null> = [
      null,
      ...snapshot.simulationInput.bonds.map(({ bondIndex }) => bondIndex),
    ];
    const snapshots = await Promise.all(
      bucketIndices.map((bondIndex) =>
        getMapEntry(
          options.managerPrincipal,
          "fee-bips-for-cycle",
          cvToHex(
            tupleCV({
              "reward-cycle": uintCV(BigInt(targetCycle)),
              "bond-index": bondIndex === null ? noneCV() : someCV(uintCV(bondIndex)),
            }),
          ),
          readOptions,
        ),
      ),
    );
    const feeBips = new Map<string, bigint>();
    const buckets: OperatorFeeForecast["inputs"]["buckets"] = [];
    let configuredAssumption = false;
    bucketIndices.forEach((bondIndex, index) => {
      const observed = decodeOptionalUInt(
        snapshots[index] as ClarityValue,
        `fee-bips-for-cycle(${bondIndex ?? "stx"})`,
      );
      const fee = observed ?? configuredFee;
      const key = bondIndex === null ? "stx" : bondIndex.toString();
      feeBips.set(key, fee);
      configuredAssumption ||= observed === null;
      buckets.push({
        bondIndex: bondIndex === null ? null : key,
        feeBips: fee.toString(),
        source: observed === null ? "configured-fee-assumption" : "cycle-snapshot",
      });
    });
    const simulate = (gross: string) =>
      simulatePox5CalculateRewards({
        ...snapshot.simulationInput,
        grossAccruedRewardsSats: BigInt(gross),
      });
    return {
      status: "ready",
      forecast: {
        kind: "reference-manager-exact",
        sats: {
          low: exactBucketFees({
            simulation: simulate(input.forecast.globalSats.low),
            stxShares,
            bondShares,
            feeBips,
          }).toString(),
          point: exactBucketFees({
            simulation: simulate(input.forecast.globalSats.point),
            stxShares,
            bondShares,
            feeBips,
          }).toString(),
          high: exactBucketFees({
            simulation: simulate(input.forecast.globalSats.high),
            stxShares,
            bondShares,
            feeBips,
          }).toString(),
        },
        inputs: { stakers: stakers.length, buckets },
        assumptions: [
          "per-staker-per-bucket-integer-rounding",
          ...(configuredAssumption ? (["configured-fee-until-claim"] as const) : []),
        ],
      },
    };
  } catch {
    return { status: "unavailable", reason: "anchored-fee-inputs-unavailable" };
  }
}

/**
 * Reads the PoX-5 global reward domain without depending on any signer-manager implementation.
 * This is deliberately separate from manager settlement state: custom managers still need exact
 * accrual and checkpoint visibility even when Sidekick cannot safely execute their manager calls.
 */
export async function readRewardOutlook(
  options: RewardOutlookOptions,
): Promise<RewardOutlookStatus> {
  const readOptions = options.chainAnchor ? { tip: options.chainAnchor.indexBlockHash } : undefined;
  const [lastRewardComputeHeightValue, globalAccruedRewardsValue] = await Promise.all([
    callReadOnly(
      options.node,
      options.pox5ContractId,
      "get-last-reward-compute-height",
      options.managerPrincipal,
      [],
      readOptions,
    ),
    callReadOnly(
      options.node,
      options.pox5ContractId,
      "get-new-rewards",
      options.managerPrincipal,
      [],
      readOptions,
    ),
  ]);
  const lastRewardComputeBurnHeight = decodeUInt(
    lastRewardComputeHeightValue,
    "get-last-reward-compute-height",
  );
  const globalSats = decodeUInt(globalAccruedRewardsValue, "get-new-rewards").toString();
  const calculation = rewardCalculationStatus(lastRewardComputeBurnHeight, options.chainAnchor);
  applyRewardCalculationGrace(calculation, options);
  let poolEstimate: Pox5CurrentPoolEstimate | null = null;
  let poolEstimateUnavailableReason: RewardOutlookStatus["poolEstimateUnavailableReason"] = null;
  let forecast: RewardOutlookStatus["forecast"] = null;
  let forecastUnavailableReason: RewardOutlookStatus["forecastUnavailableReason"] = null;
  let operatorFeeForecast: RewardOutlookStatus["operatorFeeForecast"] = null;
  let operatorFeeForecastUnavailableReason: RewardOutlookStatus["operatorFeeForecastUnavailableReason"] =
    options.feeCapability?.executionAvailable
      ? "forecast-unavailable"
      : "reviewed-fee-capability-unavailable";
  const calibration = assessRewardCalibration(
    (
      options.store.listRewardCalculationRealizations?.(
        options.managerPrincipal,
        options.pox5ContractId,
        { limit: 50, canonicalOnly: true },
      ) ?? []
    ).map((realization) => ({
      modelRevision: realization.modelRevision,
      targetRewardCycle: realization.targetRewardCycle,
      calculationBurnHeight: realization.calculationBurnHeight,
      actualPoolSats: realization.poolEstimate?.grossSats ?? "0",
      evaluation: realization.evaluation,
    })),
  );
  if (!options.chainAnchor) {
    poolEstimateUnavailableReason = "chain-anchor-unavailable";
    forecastUnavailableReason = "chain-anchor-unavailable";
  } else if (!calculation.next) {
    poolEstimateUnavailableReason = "calculation-target-unavailable";
    forecastUnavailableReason = "calculation-target-unavailable";
  } else {
    try {
      const simulationSnapshot = await readPox5PoolSimulationSnapshot({
        node: options.node,
        pox5ContractId: options.pox5ContractId,
        managerPrincipal: options.managerPrincipal,
        chainAnchor: options.chainAnchor,
        targetRewardCycle: calculation.next.targetRewardCycle,
        targetCheckpoint: calculation.next.targetCheckpoint,
        calculationBurnHeight: calculation.next.calculationBurnHeight,
        grossAccruedRewardsSats: BigInt(globalSats),
      });
      poolEstimate = simulationSnapshot.currentEstimate;
      const historical =
        options.store.listRewardForecastSamples?.(
          options.managerPrincipal,
          options.pox5ContractId,
          {
            lastRewardComputeBurnHeight: calculation.observedLastRewardComputeBurnHeight,
            targetRewardCycle: calculation.next.targetRewardCycle,
            targetCheckpoint: calculation.next.targetCheckpoint,
            calculationBurnHeight: calculation.next.calculationBurnHeight,
            throughBurnBlockHeight: options.chainAnchor.burnBlockHeight,
            limit: Math.min(2_500, options.chainAnchor.rewardCycleLength + 2),
          },
        ) ?? [];
      const currentForecastObservation: RewardForecastObservation = {
        observedBurnBlockHeight: options.chainAnchor.burnBlockHeight,
        observedAt: options.observedAt,
        globalAccruedRewardsSats: globalSats,
        lastRewardComputeBurnHeight: calculation.observedLastRewardComputeBurnHeight,
        nextCalculation: calculation.next,
      };
      const projected = projectGlobalRewardRunRate({
        observations: historical,
        current: currentForecastObservation,
        target: {
          rewardCycle: calculation.next.targetRewardCycle,
          checkpoint: calculation.next.targetCheckpoint,
          calculationBurnHeight: calculation.next.calculationBurnHeight,
        },
      });
      if (projected.status === "unavailable") {
        forecastUnavailableReason = projected.reason;
      } else {
        const low = simulatePox5PoolEstimateAtGross({
          snapshot: simulationSnapshot,
          grossAccruedRewardsSats: BigInt(projected.forecast.globalSats.low),
        });
        const point = simulatePox5PoolEstimateAtGross({
          snapshot: simulationSnapshot,
          grossAccruedRewardsSats: BigInt(projected.forecast.globalSats.point),
        });
        const high = simulatePox5PoolEstimateAtGross({
          snapshot: simulationSnapshot,
          grossAccruedRewardsSats: BigInt(projected.forecast.globalSats.high),
        });
        if (!(BigInt(low.grossSats) <= BigInt(point.grossSats))) {
          throw new Pox5RewardSimulationError("projected pool low exceeds point");
        }
        if (!(BigInt(point.grossSats) <= BigInt(high.grossSats))) {
          throw new Pox5RewardSimulationError("projected pool point exceeds high");
        }
        forecast = {
          ...projected.forecast,
          poolSats: { low: low.grossSats, point: point.grossSats, high: high.grossSats },
          assumptions: [
            "zero-accrual-after-last-calculation",
            "linear-global-accrual-run-rate",
            "current-cycle-shares",
            "current-active-bond-set",
            "unchanged-reserve-before-calculation",
            "contract-integer-rounding",
          ],
        };
        forecast.confidence = calibratedForecastConfidence({
          samplingConfidence: projected.forecast.confidence,
          remainingBlocks: projected.forecast.sample.remainingBlocks,
          calibration,
        });
        const feeProjection = await projectExactOperatorFees({
          options,
          snapshot: simulationSnapshot,
          forecast,
        });
        if (feeProjection.status === "ready") {
          operatorFeeForecast = feeProjection.forecast;
          operatorFeeForecastUnavailableReason = null;
        } else {
          operatorFeeForecastUnavailableReason = feeProjection.reason;
        }
      }
    } catch (error) {
      if (poolEstimate === null) {
        poolEstimateUnavailableReason =
          error instanceof Pox5CalculateRewardsError && error.code === "incomplete-bond-state"
            ? "incomplete-active-bond-state"
            : error instanceof Pox5RewardSimulationError
              ? "contract-simulation-failed"
              : "anchored-inputs-unavailable";
        forecastUnavailableReason = "current-pool-estimate-unavailable";
      } else {
        forecastUnavailableReason =
          error instanceof Pox5RewardSimulationError
            ? "contract-simulation-failed"
            : "forecast-inputs-unavailable";
      }
    }
  }
  const outlook: RewardOutlookStatus = {
    pox5ContractId: options.pox5ContractId,
    observedAt: options.observedAt,
    chainAnchor: options.chainAnchor ?? null,
    accrued: { globalSats, source: "pox5-get-new-rewards" },
    poolEstimate,
    poolEstimateUnavailableReason,
    forecast,
    forecastUnavailableReason,
    operatorFeeForecast,
    operatorFeeForecastUnavailableReason,
    calibration,
    calculation,
  };
  if (options.chainAnchor) {
    options.store.putRewardOutlookObservation?.({
      managerPrincipal: options.managerPrincipal,
      pox5ContractId: options.pox5ContractId,
      observedAt: options.observedAt,
      chainAnchor: options.chainAnchor,
      globalAccruedRewardsSats: globalSats,
      calculationState: calculation.state,
      lastRewardComputeBurnHeight: calculation.observedLastRewardComputeBurnHeight,
      nextCalculation: calculation.next
        ? {
            state: calculation.next.state,
            targetRewardCycle: calculation.next.targetRewardCycle,
            targetCheckpoint: calculation.next.targetCheckpoint,
            calculationBurnHeight: calculation.next.calculationBurnHeight,
            eligibleBurnHeight: calculation.next.eligibleBurnHeight,
            blocksRemaining: calculation.next.blocksRemaining,
          }
        : null,
      poolEstimate,
      poolEstimateUnavailableReason,
      forecast,
      forecastModelRevision: forecast ? REWARD_FORECAST_MODEL_REVISION : null,
      forecastUnavailableReason,
    });
  }
  return outlook;
}

export async function readStxRewardStatus(options: RewardStatusOptions): Promise<StxRewardStatus> {
  if (!Number.isSafeInteger(options.rewardCycle) || options.rewardCycle < 0) {
    throw new Error("rewardCycle must be a non-negative safe integer");
  }
  const candidateRun = options.store.getLatestCompletedSignerStakerRun(
    options.sourceId,
    options.managerPrincipal,
  );
  const run =
    candidateRun &&
    (!options.chainAnchor ||
      (candidateRun.authoritative &&
        candidateRun.chainAnchor !== null &&
        chainAnchorsEqual(candidateRun.chainAnchor, options.chainAnchor)))
      ? candidateRun
      : null;
  const cycleMemberships = run
    ? options.store
        .listCycleMembershipsForCycle(
          options.managerPrincipal,
          options.rewardCycle,
          options.sourceId,
        )
        .filter(({ signerPrincipal }) => signerPrincipal === options.managerPrincipal)
    : [];
  const stakerPrincipals = [
    ...new Set(cycleMemberships.map(({ stakerPrincipal }) => stakerPrincipal)),
  ];
  const cycleArgs = [encodeUIntHex(BigInt(options.rewardCycle)), encodeOptionalUIntHex(null)];
  const signerCycleArgs = [encodePrincipalHex(options.managerPrincipal), ...cycleArgs];
  const readOptions = options.chainAnchor ? { tip: options.chainAnchor.indexBlockHash } : undefined;
  const rewardOutlook =
    options.rewardOutlook ??
    (await readRewardOutlook({
      store: options.store,
      node: options.node,
      managerPrincipal: options.managerPrincipal,
      pox5ContractId: options.pox5ContractId,
      observedAt: options.observedAt,
      ...(options.chainAnchor ? { chainAnchor: options.chainAnchor } : {}),
    }));
  const [
    configuredFeeValue,
    feeSnapshotValue,
    earnedFeesValue,
    withdrawalLiabilityValue,
    unclaimedStakerRewardsValue,
    rewardsPerTokenValue,
    signerEarnedValue,
    stxSharesValue,
  ] = await Promise.all([
    getDataVar(options.node, options.managerPrincipal, "fees-bips", readOptions),
    getMapEntry(
      options.node,
      options.managerPrincipal,
      "fee-bips-for-cycle",
      cvToHex(
        tupleCV({
          "reward-cycle": uintCV(BigInt(options.rewardCycle)),
          "bond-index": noneCV(),
        }),
      ),
      readOptions,
    ),
    callReadOnly(
      options.node,
      options.managerPrincipal,
      "get-earned-fees",
      options.managerPrincipal,
      [],
      readOptions,
    ),
    callReadOnly(
      options.node,
      options.managerPrincipal,
      "get-withdrawal-liability",
      options.managerPrincipal,
      [],
      readOptions,
    ),
    callReadOnly(
      options.node,
      options.managerPrincipal,
      "get-unclaimed-staker-rewards",
      options.managerPrincipal,
      [],
      readOptions,
    ),
    callReadOnly(
      options.node,
      options.pox5ContractId,
      "get-rewards-per-token-for-cycle",
      options.managerPrincipal,
      cycleArgs,
      readOptions,
    ),
    callReadOnly(
      options.node,
      options.pox5ContractId,
      "get-earned",
      options.managerPrincipal,
      signerCycleArgs,
      readOptions,
    ),
    callReadOnly(
      options.node,
      options.pox5ContractId,
      "get-signer-shares-staked-for-cycle",
      options.managerPrincipal,
      signerCycleArgs,
      readOptions,
    ),
  ]);
  const lastRewardComputeHeight = BigInt(
    rewardOutlook.calculation.observedLastRewardComputeBurnHeight,
  );
  const lastComputedRewardCycle =
    lastRewardComputeHeight === 0n
      ? null
      : decodeUInt(
          await callReadOnly(
            options.node,
            options.pox5ContractId,
            "burn-height-to-reward-cycle",
            options.managerPrincipal,
            [encodeUIntHex(lastRewardComputeHeight)],
            readOptions,
          ),
          "burn-height-to-reward-cycle",
        );

  const bondBuckets = await readBondBuckets(
    options.node,
    options.managerPrincipal,
    options.pox5ContractId,
    options.rewardCycle,
    readOptions,
  );
  // Only the STX bucket is read per staker here. Expanding this to every participating bond bucket
  // would multiply an already O(stakers) crawl by the bucket count on every operator snapshot;
  // per-bucket claim discovery is `discoverStakerClaims`, which the caller pages.
  const claimedStxBucket = new Set<string>();
  if (decodeOptionalUInt(feeSnapshotValue, "fee-bips-for-cycle") !== null) {
    claimedStxBucket.add(bucketKey(null));
  }
  const rewardStatuses: StakerRewardStatus[] = [];
  for (let index = 0; index < stakerPrincipals.length; index += 8) {
    rewardStatuses.push(
      ...(await Promise.all(
        stakerPrincipals
          .slice(index, index + 8)
          .map((stakerPrincipal) =>
            readStakerReward(
              options.node,
              options.managerPrincipal,
              stakerPrincipal,
              options.rewardCycle,
              [null],
              claimedStxBucket,
              decodeUInt(unclaimedStakerRewardsValue, "get-unclaimed-staker-rewards"),
              readOptions,
            ),
          ),
      )),
    );
  }
  const earned = rewardStatuses.map(({ rewards }) => BigInt(rewards.earnedSats));
  const fees = rewardStatuses.map(({ rewards }) => BigInt(rewards.feeSats));
  const stxBucket: RewardBucketStatus = {
    bondIndex: null,
    managerSharesSats: decodeUInt(stxSharesValue, "get-signer-shares-staked-for-cycle").toString(),
    signerEarnedBeforeManagerClaimSats: decodeUInt(signerEarnedValue, "get-earned").toString(),
    rewardsPerToken: decodeUInt(rewardsPerTokenValue, "get-rewards-per-token-for-cycle").toString(),
    feeSnapshotBips: decodeOptionalUInt(feeSnapshotValue, "fee-bips-for-cycle")?.toString() ?? null,
    participating:
      decodeUInt(stxSharesValue, "get-signer-shares-staked-for-cycle") > 0n ||
      decodeUInt(signerEarnedValue, "get-earned") > 0n,
  };
  const buckets = [stxBucket, ...bondBuckets];
  const status: StxRewardStatus = {
    status: run ? "ready" : "attention",
    managerPrincipal: options.managerPrincipal,
    pox5ContractId: options.pox5ContractId,
    rewardCycle: options.rewardCycle,
    observedAt: {
      timestamp: options.observedAt,
      burnBlockHeight: options.burnBlockHeight,
      stacksTipHeight: options.stacksTipHeight,
    },
    ingestion: run ? { runId: run.runId, completedAt: run.completedAt ?? run.updatedAt } : null,
    global: {
      lastRewardComputeBurnHeight: lastRewardComputeHeight.toString(),
      lastComputedRewardCycle: lastComputedRewardCycle?.toString() ?? null,
      globalAccruedRewardsSats: rewardOutlook.accrued.globalSats,
      rewardsPerToken: decodeUInt(
        rewardsPerTokenValue,
        "get-rewards-per-token-for-cycle",
      ).toString(),
      signerEarnedBeforeManagerClaimSats: decodeUInt(signerEarnedValue, "get-earned").toString(),
      signerEarnedAcrossBucketsSats: sum(
        buckets.map(({ signerEarnedBeforeManagerClaimSats }) =>
          BigInt(signerEarnedBeforeManagerClaimSats),
        ),
      ).toString(),
    },
    calculation: rewardOutlook.calculation,
    buckets,
    manager: {
      configuredFeeBips: decodeUInt(configuredFeeValue, "fees-bips").toString(),
      feeSnapshotBips:
        decodeOptionalUInt(feeSnapshotValue, "fee-bips-for-cycle")?.toString() ?? null,
      earnedFeesSats: decodeUInt(earnedFeesValue, "get-earned-fees").toString(),
      withdrawalLiabilitySats: decodeUInt(
        withdrawalLiabilityValue,
        "get-withdrawal-liability",
      ).toString(),
      unclaimedStakerRewardsSats: decodeUInt(
        unclaimedStakerRewardsValue,
        "get-unclaimed-staker-rewards",
      ).toString(),
    },
    totals: {
      stakers: rewardStatuses.length,
      grossSats: (sum(earned) + sum(fees)).toString(),
      earnedSats: sum(earned).toString(),
      feeSats: sum(fees).toString(),
      actionableClaims: rewardStatuses.filter(({ claimableByPolicy }) => claimableByPolicy).length,
      l1ClaimsWaitingForFeeThreshold: rewardStatuses.filter(
        ({ payout, rewards, claimableByPolicy }) =>
          payout.kind === "bitcoin-l1" && BigInt(rewards.earnedSats) > 0n && !claimableByPolicy,
      ).length,
    },
    stakers: rewardStatuses,
  };
  options.store.putRewardCycleSnapshot?.({
    managerPrincipal: status.managerPrincipal,
    rewardCycle: status.rewardCycle,
    status: status.status,
    observedAt: status.observedAt.timestamp,
    burnBlockHeight: status.observedAt.burnBlockHeight,
    stacksTipHeight: status.observedAt.stacksTipHeight,
    ...(options.chainAnchor ? { chainAnchor: options.chainAnchor } : {}),
    global: status.global,
    manager: status.manager,
    totals: status.totals,
    stakers: status.stakers.map(({ rewardCycle: _rewardCycle, ...staker }) => staker),
  });
  return status;
}
