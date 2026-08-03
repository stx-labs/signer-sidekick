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
  type ChainAnchor,
  chainAnchorsEqual,
  deriveRewardCalculationTarget,
} from "./chain-anchor.js";
import type { ChainReadOptions } from "./chain-clients.js";
import type {
  RewardCycleSnapshotInput,
  SignerStakerRun,
  StoredCycleMembership,
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
  putRewardCycleSnapshot?(input: RewardCycleSnapshotInput): void;
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
  node: RewardStatusNode,
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
    };
  }
  const expected = BigInt(target.expectedLastRewardComputeBurnHeight);
  return {
    ...base,
    // `pending` is the state that used to surface as stale local data: nobody has called the
    // permissionless `calculate-rewards` for this distribution yet, so there is nothing to claim
    // no matter how fresh Sidekick's reads are.
    state:
      observedLastRewardComputeBurnHeight === expected
        ? "completed"
        : observedLastRewardComputeBurnHeight < expected
          ? "pending"
          : "ahead",
    targetRewardCycle: target.rewardCycle,
    targetCheckpoint: target.calculationCheckpoint,
    expectedLastRewardComputeBurnHeight: target.expectedLastRewardComputeBurnHeight,
  };
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
  const [
    lastRewardComputeHeightValue,
    configuredFeeValue,
    feeSnapshotValue,
    earnedFeesValue,
    withdrawalLiabilityValue,
    unclaimedStakerRewardsValue,
    rewardsPerTokenValue,
    signerEarnedValue,
    stxSharesValue,
  ] = await Promise.all([
    callReadOnly(
      options.node,
      options.pox5ContractId,
      "get-last-reward-compute-height",
      options.managerPrincipal,
      [],
      readOptions,
    ),
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
  const lastRewardComputeHeight = decodeUInt(
    lastRewardComputeHeightValue,
    "get-last-reward-compute-height",
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
    calculation: rewardCalculationStatus(lastRewardComputeHeight, options.chainAnchor),
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
