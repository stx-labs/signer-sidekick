import {
  type RewardLedger,
  type RewardLedgerCalculation,
  type RewardLedgerCapabilityLevel,
  type RewardLedgerCollect,
  type RewardLedgerCoverage,
  type RewardLedgerCycle,
  type RewardLedgerDistribution,
  type RewardLedgerDistributionStatus,
  type RewardLedgerL1Status,
  type RewardLedgerPayment,
  type RewardLedgerPaymentStatus,
  type RewardLedgerProvenance,
  type RewardLedgerRollForward,
  type RewardLedgerRollForwardReason,
  type RewardRun,
  rewardLedgerSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { poxAddressNetwork, poxAddressToBtcAddress } from "./pox-address.js";
import type {
  StoredCycleMembership,
  StoredManagerClaim,
  StoredManagerTopicEvent,
  StoredManagerWithdrawal,
  StoredPox5RewardPrint,
  StoredRewardCalculationRealization,
} from "./storage/store.js";

/**
 * Reward ledger — distributions inside cycles, derived at read time from chain evidence.
 *
 * Nothing here is persisted: realizations (network calculations), PoX-5 collect prints, manager
 * payment events, withdrawal state, cycle memberships, and the live reward status are combined into
 * one operator-facing projection. Provenance (you / another caller) is carried as data, never as
 * state. See docs/product/reward-operations-plan.md §5 and ADR 0010.
 */

const maximumPayments = 10_000;
const maximumExportPayments = 100_000;
const maximumCycles = 200;
/** Interactive views retain a bounded newest window; accounting exports may read a larger window. */
const maximumEvidenceRows = 10_000;
const maximumExportEvidenceRows = 100_000;
const registryLookupConcurrency = 8;

export type RewardLedgerDistributionIndex = 1 | 2;

export interface RewardLedgerStore {
  listRewardCalculationRealizations(
    managerPrincipal: string,
    pox5ContractId: string,
    options?: { limit?: number; canonicalOnly?: boolean },
  ): StoredRewardCalculationRealization[];
  listPox5RewardPrints(
    chainId: number,
    pox5ContractId: string,
    managerPrincipal: string,
    options?: { kinds?: readonly StoredPox5RewardPrint["kind"][]; limit?: number },
  ): StoredPox5RewardPrint[];
  listManagerClaimRecords(
    chainId: number,
    managerPrincipal: string,
    limit?: number,
  ): StoredManagerClaim[];
  getManagerRewardFeeTotals?(
    chainId: number,
    managerPrincipal: string,
    pox5ContractId: string,
  ): { earnedIndexedSats: string; paymentCount: number; unmatchedPaymentCount: number };
  listManagerWithdrawalRecords(
    chainId: number,
    managerPrincipal: string,
    limit?: number,
  ): StoredManagerWithdrawal[];
  listManagerTopicEvents(
    chainId: number,
    managerPrincipal: string,
    topic: string,
    limit?: number,
  ): StoredManagerTopicEvent[];
  listCycleMembershipsForCycle(
    managerPrincipal: string,
    rewardCycle: number,
    sourceId?: string | null,
  ): StoredCycleMembership[];
}

type RecoveryStatus = "not-started" | "reconstructing" | "complete";

/** Accept any producer status; only `complete` and `reconstructing` are distinguished. */
function recoveryStatus(value: string | undefined): RecoveryStatus {
  return value === "complete" || value === "reconstructing" ? value : "not-started";
}

export interface RewardLedgerSnapshotInput {
  generatedAt: string;
  network: string;
  managerPrincipal: string;
  chainAnchor?: {
    stacksBlockHeight: number;
    burnBlockHeight: number;
    indexBlockHash: string;
  } | null;
  roster?: ReadonlyArray<{ stakerPrincipal: string; active: boolean }>;
  historyRecovery?: {
    monitoringStartedAt: string | null;
    managerHistory: { status: string };
    currentMemberHistory: { status: string };
  } | null;
  manager?: {
    capabilities?: {
      eventVocabulary?: { normalizationAvailable: boolean } | null;
      actions?: ReadonlyArray<{ id: string; executionAvailable?: boolean }> | null;
    } | null;
  } | null;
  rewards?: RewardLedgerRewardStatusInput | null;
  /**
   * Live reward status for the previous calculation-target cycle while evidence shows it still has
   * open work (see `previousCycleOpen`). The second distribution of a cycle can only be collected
   * and distributed during the next cycle, so the live window must span both.
   */
  rewardsPrevious?: RewardLedgerRewardStatusInput | null;
  rewardOutlook?: { calculation?: RewardLedgerCalculationInput | null } | null;
}

export interface RewardLedgerCalculationInput {
  state?: string;
  next: null | {
    state: "due" | "scheduled";
    targetRewardCycle: number;
    targetCheckpoint: "first-half" | "second-half";
    grace?: null | { state: "scheduled" | "awaiting-calculation" | "action-required" };
  };
}

export interface RewardLedgerRewardStatusInput {
  rewardCycle: number;
  calculation?: RewardLedgerCalculationInput | null;
  buckets?: ReadonlyArray<{
    bondIndex: string | null;
    signerEarnedBeforeManagerClaimSats: string;
    feeSnapshotBips: string | null;
  }>;
  manager?: {
    configuredFeeBips: string;
    feeSnapshotBips: string | null;
    earnedFeesSats: string;
  } | null;
  stakers?: ReadonlyArray<{
    stakerPrincipal: string;
    payout: {
      kind: "direct-sbtc" | "bitcoin-l1";
      maxFeeSats: string | null;
      poxAddress?: { versionHex: string; hashbytesHex: string } | null;
    };
    rewards: { earnedSats: string; feeSats: string; grossSats: string };
    claimableByPolicy: boolean;
    claims?: ReadonlyArray<{
      bondIndex: string | null;
      rewards: { earnedSats: string; feeSats: string; grossSats: string };
      claimable: boolean;
    }>;
  }>;
}

export type WithdrawalRegistryStatus = "pending" | "accepted" | "rejected" | "unknown";

export interface RewardLedgerQuery {
  cycle?: number | null;
  distribution?: RewardLedgerDistributionIndex | null;
  staker?: string | null;
  /** `all` lists every retained payment (accounting exports); default selects one cycle. */
  scope?: "selection" | "all" | null;
}

export interface BuildRewardLedgerInput {
  store: RewardLedgerStore;
  chainId: number;
  managerPrincipal: string;
  pox5ContractId: string | null;
  sourceId: string | null;
  snapshot: RewardLedgerSnapshotInput;
  /** Transaction IDs Sidekick itself produced (wallet intents, engine attempts). */
  ownedTxids: ReadonlySet<string>;
  /** sBTC registry status for a manager-side pending request; omit when no registry is known. */
  withdrawalRequestStatus?: (requestId: string) => Promise<WithdrawalRegistryStatus>;
  /**
   * Operator runs sealed for a distribution, oldest first. Explains why a First-Distribution
   * account rolled forward: the recorded skip/halt on its payment, the run's own end, or no run.
   */
  runHistory?: (cycle: number, distribution: RewardLedgerDistributionIndex) => readonly RewardRun[];
  now: Date;
  query?: RewardLedgerQuery;
  /**
   * Newest evidence rows read per stream (PoX-5 prints, manager claims). Beyond this the ledger
   * keeps the newest rows and marks older cycles `historical-coverage-incomplete` (plan S1.1 will
   * window reads by cycle instead). Defaults to 10,000.
   */
  evidenceLimit?: number;
}

interface CalculationFact {
  distribution: RewardLedgerDistributionIndex;
  realization: StoredRewardCalculationRealization;
}

interface PaymentRow extends RewardLedgerPayment {
  sortKey: number;
}

function bucketKey(bondIndex: string | null): string {
  return bondIndex === null ? "stx" : `bond-${bondIndex}`;
}

function big(value: string | null | undefined): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  return BigInt(value);
}

function text(value: bigint): string {
  return value.toString();
}

function provenance(ownedTxids: ReadonlySet<string>, txId: string | null): RewardLedgerProvenance {
  if (txId === null) return "unknown";
  return ownedTxids.has(txId) ? "you" : "another-caller";
}

function checkpointIndex(checkpoint: "first-half" | "second-half"): RewardLedgerDistributionIndex {
  return checkpoint === "first-half" ? 1 : 2;
}

/**
 * Seam rule: a payment (or collect) belongs to the latest distribution of its cycle whose
 * calculation preceded it. Falls back to the first distribution when nothing preceded it.
 */
function attribute(
  calculations: readonly CalculationFact[],
  blockHeight: number,
): RewardLedgerDistributionIndex | null {
  let result: RewardLedgerDistributionIndex | null = null;
  for (const fact of calculations) {
    if (fact.realization.blockHeight <= blockHeight) result = fact.distribution;
  }
  return result ?? calculations[0]?.distribution ?? null;
}

function l1StatusFor(
  state: StoredManagerWithdrawal["state"] | null,
  registry: WithdrawalRegistryStatus | null,
): RewardLedgerL1Status | null {
  if (state === null) return null;
  if (state === "settled") return "retired";
  if (state === "reclaimed") return "returned";
  if (registry === "accepted") return "accepted-ready-to-retire";
  if (registry === "rejected") return "rejected-return-pending";
  if (registry === "pending") return "awaiting-signers";
  return "unknown";
}

function paymentStatusFor(l1: RewardLedgerL1Status | null): RewardLedgerPaymentStatus {
  switch (l1) {
    case null:
      return "paid";
    case "awaiting-signers":
    case "unknown":
      return "sent";
    case "accepted-ready-to-retire":
      return "arrived";
    case "retired":
      return "retired";
    case "rejected-return-pending":
      return "rejected";
    case "returned":
      return "returned";
  }
}

interface RollForwardExplanation {
  rollForward: RewardLedgerRollForward;
  /** Gross entitlement the sealed recipe bounded this payment to (exact at preparation). */
  grossBoundSats: string | null;
}

/**
 * Why a First-Distribution account was not paid before the Second calculation. Runs are the
 * operator's own history: the latest run that named the account explains it; otherwise either no
 * payment run existed, or the account fell outside the recipe (cap, or zero accrual when sealed).
 */
function explainRollForward(input: {
  stakerPrincipal: string;
  cycle: number;
  bucket: string;
  runs: readonly RewardRun[];
  paidWith: PaymentRow | null;
}): RollForwardExplanation {
  const bondIndex = input.bucket === "stx" ? "stx" : input.bucket.replace(/^bond-/, "");
  const key = `${input.stakerPrincipal}:${input.cycle}:${bondIndex}`;
  const paidWith =
    input.paidWith?.paymentTxId !== null && input.paidWith?.paymentTxId !== undefined
      ? { distribution: 2 as const, txId: input.paidWith.paymentTxId }
      : null;
  let match: { run: RewardRun; child: RewardRun["children"][number] } | null = null;
  for (const run of input.runs) {
    const child = run.children.find(
      (candidate) => candidate.operation === "claim-staker-rewards" && candidate.accountKey === key,
    );
    if (child) match = { run, child };
  }
  if (!match) {
    const paymentRuns = input.runs.filter((run) =>
      run.children.some((child) => child.operation === "claim-staker-rewards"),
    );
    const latest = paymentRuns.at(-1) ?? null;
    return {
      grossBoundSats: null,
      rollForward: {
        reason: latest === null ? "no-run" : "not-in-recipe",
        detail:
          latest === null
            ? "No First Distribution payment run was made before the Second calculation"
            : `${paymentRuns.length} payment ${paymentRuns.length === 1 ? "run was" : "runs were"} sealed without this account (recipe cap, or no accrual when sealed)`,
        runId: latest?.runId ?? null,
        childIndex: null,
        recordedAt: latest?.createdAt ?? null,
        paidWith,
      },
    };
  }
  const { run, child } = match;
  let reason: RewardLedgerRollForwardReason;
  let detail: string | null = child.failureReason ?? run.failureReason ?? null;
  switch (child.status) {
    case "skipped":
      reason = child.provenance === "policy-exception" ? "skipped-below-fee-budget" : "skipped";
      break;
    case "halted":
      reason = "halted-at-this-payment";
      break;
    case "broadcast":
      reason = "broadcast-unresolved";
      detail = child.txid ? `Broadcast as ${child.txid} and never confirmed` : detail;
      break;
    case "confirmed":
    case "externally-completed":
      reason = "paid-after-second-calculation";
      detail = child.txid ? `Confirmed as ${child.txid} after the Second calculation` : detail;
      break;
    default:
      reason =
        run.status === "halted"
          ? "not-attempted-run-halted"
          : run.status === "cancelled"
            ? "not-attempted-run-cancelled"
            : run.status === "expired"
              ? "not-attempted-run-expired"
              : "not-attempted-run-open";
      detail = run.failureReason ?? null;
  }
  return {
    grossBoundSats: child.maximumAmountSats,
    rollForward: {
      reason,
      detail,
      runId: run.runId,
      childIndex: child.index,
      recordedAt: child.updatedAt,
      paidWith,
    },
  };
}

function capabilityLevel(snapshot: RewardLedgerSnapshotInput): RewardLedgerCapabilityLevel {
  const capabilities = snapshot.manager?.capabilities ?? null;
  if (!capabilities) return "pox5-baseline";
  const claims = capabilities.actions?.find((action) => action.id === "reference-reward-claims");
  if (claims?.executionAvailable) return "reviewed-execution-adapter";
  if (capabilities.eventVocabulary?.normalizationAvailable) return "reviewed-event-vocabulary";
  return "manager-readable";
}

/**
 * Whether a cycle's latest calculated distribution still has open work by evidence alone: the
 * calculated pool is not fully collected, or a member of that cycle has no payment after the latest
 * calculation. Used to decide when the previous calculation-target cycle needs live reward reads
 * (its second distribution is collected and distributed during the next cycle).
 */
export function previousCycleOpen(
  store: Pick<
    RewardLedgerStore,
    | "listRewardCalculationRealizations"
    | "listPox5RewardPrints"
    | "listManagerClaimRecords"
    | "listCycleMembershipsForCycle"
  >,
  input: {
    chainId: number;
    managerPrincipal: string;
    pox5ContractId: string;
    sourceId: string | null;
    cycle: number;
  },
): boolean {
  const facts = store
    .listRewardCalculationRealizations(input.managerPrincipal, input.pox5ContractId, {
      limit: 500,
      canonicalOnly: true,
    })
    .filter((realization) => realization.targetRewardCycle === input.cycle)
    .sort((left, right) => left.blockHeight - right.blockHeight);
  const latest = facts.at(-1);
  if (!latest) return false;
  const poolSats = big(latest.poolEstimate?.grossSats ?? "0");
  const collected = store
    .listPox5RewardPrints(input.chainId, input.pox5ContractId, input.managerPrincipal, {
      kinds: ["claim-rewards"],
      limit: maximumEvidenceRows,
    })
    .filter(
      (print) =>
        print.kind === "claim-rewards" &&
        Number(print.rewardCycle) === input.cycle &&
        print.blockHeight >= latest.blockHeight,
    )
    .reduce((total, print) => total + big(print.totalRewardsSats ?? "0"), 0n);
  if (poolSats > collected) return true;
  const paidAfterLatest = new Set(
    store
      .listManagerClaimRecords(input.chainId, input.managerPrincipal, maximumEvidenceRows)
      .filter(
        (claim) =>
          Number(claim.rewardCycle) === input.cycle && claim.blockHeight >= latest.blockHeight,
      )
      .map((claim) => claim.stakerPrincipal),
  );
  return store
    .listCycleMembershipsForCycle(input.managerPrincipal, input.cycle, input.sourceId)
    .some(
      ({ stakerPrincipal, amountUstx }) => amountUstx > 0n && !paidAfterLatest.has(stakerPrincipal),
    );
}

export async function buildRewardLedger(input: BuildRewardLedgerInput): Promise<RewardLedger> {
  const { store, chainId, managerPrincipal, pox5ContractId, snapshot, ownedTxids } = input;
  const query = input.query ?? {};
  const scope: "selection" | "all" = query.scope === "all" ? "all" : "selection";
  const rewards = snapshot.rewards ?? null;
  const currentCycle = rewards?.rewardCycle ?? null;
  // Live window: the calculation-target cycle plus the previous cycle while it still has open work.
  const liveStatuses = new Map<number, RewardLedgerRewardStatusInput>();
  if (rewards) liveStatuses.set(rewards.rewardCycle, rewards);
  const rewardsPrevious = snapshot.rewardsPrevious ?? null;
  if (rewardsPrevious && !liveStatuses.has(rewardsPrevious.rewardCycle)) {
    liveStatuses.set(rewardsPrevious.rewardCycle, rewardsPrevious);
  }
  const roster = new Set((snapshot.roster ?? []).map(({ stakerPrincipal }) => stakerPrincipal));
  // Current Bitcoin payout registrations from live reward status. Historical claim events do not
  // carry their original destination, so the API and UI must not present this as historical proof.
  const l1Network = poxAddressNetwork(snapshot.network);
  const l1AddressByStaker = new Map<string, string>();
  for (const status of liveStatuses.values()) {
    for (const staker of status.stakers ?? []) {
      const pox = staker.payout.poxAddress ?? null;
      if (staker.payout.kind !== "bitcoin-l1" || !pox) continue;
      if (l1AddressByStaker.has(staker.stakerPrincipal)) continue;
      const address = poxAddressToBtcAddress(pox.versionHex, pox.hashbytesHex, l1Network);
      if (address) l1AddressByStaker.set(staker.stakerPrincipal, address);
    }
  }
  const recovery = snapshot.historyRecovery ?? null;
  const recoveryIncomplete =
    recovery !== null &&
    (recoveryStatus(recovery.managerHistory.status) !== "complete" ||
      recoveryStatus(recovery.currentMemberHistory.status) !== "complete");

  // --- evidence reads (all bounded) ---
  const realizations = pox5ContractId
    ? store.listRewardCalculationRealizations(managerPrincipal, pox5ContractId, {
        limit: 500,
        canonicalOnly: true,
      })
    : [];
  const maximumRequestedEvidence =
    scope === "all" ? maximumExportEvidenceRows : maximumEvidenceRows;
  const evidenceLimit = Math.max(
    1,
    Math.min(maximumRequestedEvidence, input.evidenceLimit ?? maximumRequestedEvidence),
  );
  const printsRead = pox5ContractId
    ? store.listPox5RewardPrints(chainId, pox5ContractId, managerPrincipal, {
        limit: evidenceLimit + 1,
      })
    : [];
  const claimsRead = store.listManagerClaimRecords(chainId, managerPrincipal, evidenceLimit + 1);
  // Stores return the newest rows oldest-first; one extra row proves truncation. Drop the oldest so
  // the retained window is exactly `evidenceLimit` rows, and remember where it starts.
  const printsTruncated = printsRead.length > evidenceLimit;
  const claimsTruncated = claimsRead.length > evidenceLimit;
  const prints = printsTruncated ? printsRead.slice(printsRead.length - evidenceLimit) : printsRead;
  const claims = claimsTruncated ? claimsRead.slice(claimsRead.length - evidenceLimit) : claimsRead;
  const oldestRetainedBlockHeight = Math.max(
    printsTruncated ? (prints[0]?.blockHeight ?? 0) : -1,
    claimsTruncated ? (claims[0]?.blockHeight ?? 0) : -1,
  );
  const evidenceWindow: RewardLedger["evidenceWindow"] = {
    truncated: printsTruncated || claimsTruncated,
    oldestRetainedBlockHeight:
      printsTruncated || claimsTruncated ? Math.max(0, oldestRetainedBlockHeight) : null,
    limit: evidenceLimit,
  };
  const withdrawals = new Map(
    store
      .listManagerWithdrawalRecords(chainId, managerPrincipal, evidenceLimit + 1)
      .map((withdrawal) => [withdrawal.requestId, withdrawal] as const),
  );
  const registryStatus = new Map<string, WithdrawalRegistryStatus>();
  if (input.withdrawalRequestStatus) {
    const lookup = input.withdrawalRequestStatus;
    const pending = [...withdrawals.values()].filter(({ state }) => state === "pending");
    // Bounded concurrency: a mature pool can hold many in-flight Bitcoin payouts.
    for (let index = 0; index < pending.length; index += registryLookupConcurrency) {
      const batch = pending.slice(index, index + registryLookupConcurrency);
      const statuses = await Promise.all(
        batch.map(({ requestId }) => lookup(requestId).catch(() => "unknown" as const)),
      );
      batch.forEach(({ requestId }, offset) => {
        registryStatus.set(requestId, statuses[offset] ?? "unknown");
      });
    }
  }

  // --- index evidence by cycle ---
  const calculationsByCycle = new Map<number, CalculationFact[]>();
  for (const realization of realizations) {
    const list = calculationsByCycle.get(realization.targetRewardCycle) ?? [];
    list.push({ distribution: checkpointIndex(realization.targetCheckpoint), realization });
    calculationsByCycle.set(realization.targetRewardCycle, list);
  }
  for (const list of calculationsByCycle.values()) {
    list.sort((left, right) => left.realization.blockHeight - right.realization.blockHeight);
  }
  const collectsByCycle = new Map<number, StoredPox5RewardPrint[]>();
  const grossByPayment = new Map<string, string>();
  for (const print of prints) {
    if (print.kind === "claim-rewards") {
      const cycle = Number(print.rewardCycle ?? Number.NaN);
      if (!Number.isSafeInteger(cycle)) continue;
      const list = collectsByCycle.get(cycle) ?? [];
      list.push(print);
      collectsByCycle.set(cycle, list);
    } else if (print.stakerPrincipal && print.rewardsClaimedSats !== null) {
      grossByPayment.set(
        `${print.txId}|${print.stakerPrincipal}|${bucketKey(print.bondIndex)}`,
        print.rewardsClaimedSats,
      );
    }
  }
  const claimsByCycle = new Map<number, StoredManagerClaim[]>();
  for (const claim of claims) {
    const cycle = Number(claim.rewardCycle);
    if (!Number.isSafeInteger(cycle)) continue;
    const list = claimsByCycle.get(cycle) ?? [];
    list.push(claim);
    claimsByCycle.set(cycle, list);
  }

  const oldestRetainedCycle = evidenceWindow.truncated
    ? Math.min(...[...collectsByCycle.keys(), ...claimsByCycle.keys()], Number.POSITIVE_INFINITY)
    : Number.NEGATIVE_INFINITY;

  // --- cycle universe: everything with evidence plus the live cycle, newest first ---
  const cycleIds = [
    ...new Set<number>([
      ...calculationsByCycle.keys(),
      ...collectsByCycle.keys(),
      ...claimsByCycle.keys(),
      ...liveStatuses.keys(),
      ...(query.cycle === null || query.cycle === undefined ? [] : [query.cycle]),
    ]),
  ]
    .sort((left, right) => right - left)
    .slice(0, maximumCycles);

  const next = rewards?.calculation?.next ?? snapshot.rewardOutlook?.calculation?.next ?? null;

  const allPayments: PaymentRow[] = [];
  const cycles: RewardLedgerCycle[] = [];
  // Current-distribution candidate per live cycle; chosen after every cycle is known.
  const currentCandidates = new Map<number, RewardLedgerDistributionIndex | null>();

  for (const cycle of cycleIds) {
    const calculations = calculationsByCycle.get(cycle) ?? [];
    const collects = collectsByCycle.get(cycle) ?? [];
    const cycleClaims = claimsByCycle.get(cycle) ?? [];
    const live = liveStatuses.get(cycle) ?? null;
    const isLive = live !== null;
    const availableToCollect = live?.buckets
      ? text(
          live.buckets.reduce(
            (total, bucket) => total + big(bucket.signerEarnedBeforeManagerClaimSats),
            0n,
          ),
        )
      : null;
    const memberships = store.listCycleMembershipsForCycle(managerPrincipal, cycle, input.sourceId);
    const departedMembers = memberships.some(
      ({ stakerPrincipal, amountUstx }) => amountUstx > 0n && !roster.has(stakerPrincipal),
    );
    // Evidence below the retained window may be missing for this cycle: anything at or before the
    // oldest retained row, or any non-current cycle older than the oldest cycle still in the window.
    const cycleEvidenceHeights = [
      ...calculations.map(({ realization }) => realization.blockHeight),
      ...collects.map(({ blockHeight }) => blockHeight),
      ...cycleClaims.map(({ blockHeight }) => blockHeight),
    ];
    const evidenceIncomplete =
      evidenceWindow.truncated &&
      !isLive &&
      (cycleEvidenceHeights.some(
        (height) => height <= (evidenceWindow.oldestRetainedBlockHeight ?? 0),
      ) ||
        cycle < oldestRetainedCycle);
    // Recovery gaps apply to the current cycle too: a fresh install may not yet have seen payments
    // made earlier in this cycle. Departed members and the evidence window only concern history.
    const historicallyIncomplete =
      recoveryIncomplete || (!isLive && (departedMembers || evidenceIncomplete));

    // fee evidence for the cycle
    const feeBips = isLive
      ? (live?.manager?.feeSnapshotBips ?? live?.manager?.configuredFeeBips ?? null)
      : null;
    const feeEvidence: RewardLedgerDistribution["feeEvidence"] = isLive
      ? live?.manager?.feeSnapshotBips
        ? "locked"
        : live?.manager?.configuredFeeBips
          ? "provisional"
          : "unknown"
      : collects.length > 0
        ? "locked"
        : "unknown";

    // paid payments (historical + this cycle's already-paid)
    const paidRows: PaymentRow[] = [];
    const paidAccountsByDistribution = new Map<RewardLedgerDistributionIndex, Set<string>>();
    for (const claim of cycleClaims) {
      const distribution = attribute(calculations, claim.blockHeight);
      const bucket = bucketKey(claim.bondIndex);
      const account = `${claim.stakerPrincipal}|${bucket}`;
      if (distribution !== null) {
        const set = paidAccountsByDistribution.get(distribution) ?? new Set<string>();
        set.add(account);
        paidAccountsByDistribution.set(distribution, set);
      }
      const gross = grossByPayment.get(`${claim.txId}|${claim.stakerPrincipal}|${bucket}`) ?? null;
      const entitlement = big(claim.amountSats);
      const operatorFee = gross === null ? null : big(gross) - entitlement;
      const withdrawal =
        claim.withdrawalRequestId === null
          ? null
          : (withdrawals.get(claim.withdrawalRequestId) ?? null);
      const l1 = l1StatusFor(
        withdrawal?.state ?? (claim.withdrawalRequestId === null ? null : "pending"),
        claim.withdrawalRequestId === null
          ? null
          : (registryStatus.get(claim.withdrawalRequestId) ?? null),
      );
      const route = claim.destination === "bitcoin-l1" ? "bitcoin" : "sbtc";
      const status = paymentStatusFor(l1);
      const payoutSats =
        route === "sbtc"
          ? text(entitlement)
          : status === "returned"
            ? null
            : (withdrawal?.amountSats ?? null);
      paidRows.push({
        schemaVersion: 1,
        cycle,
        distribution,
        bucket,
        stakerPrincipal: claim.stakerPrincipal,
        route,
        grossRewardSats: gross,
        operatorFeeSats: operatorFee === null || operatorFee < 0n ? null : text(operatorFee),
        stakerEntitlementSats: text(entitlement),
        payoutSats,
        payoutAsset: payoutSats === null ? null : route === "sbtc" ? "sBTC" : "BTC",
        l1MaxFeeSats: withdrawal?.maxFeeSats ?? null,
        l1ActualFeeSats: null,
        feeRefundSats: null,
        returnedSats: status === "returned" ? text(entitlement) : null,
        status,
        coverage: "exact",
        includesPriorDistribution: false,
        paymentTxId: claim.txId,
        paymentBlockHeight: claim.blockHeight,
        paidAt: claim.occurredAt,
        by: provenance(ownedTxids, claim.txId),
        l1RequestId: claim.withdrawalRequestId,
        l1Status: l1,
        settleOrReclaimTxId: withdrawal?.resolvedTxId ?? null,
        btcSweepTxId: null,
        unavailableReason: gross === null ? "gross-unavailable-without-pox5-print" : null,
        l1Address:
          route === "bitcoin" ? (l1AddressByStaker.get(claim.stakerPrincipal) ?? null) : null,
        rollForward: null,
        sortKey: claim.blockHeight,
      });
    }

    // rolled forward: accounts with first-distribution accrual that were not paid before the
    // second calculation; their later payment carries both distributions.
    let rolledForward = 0;
    const rolledRows: PaymentRow[] = [];
    const first = calculations.find(({ distribution }) => distribution === 1);
    const second = calculations.find(({ distribution }) => distribution === 2);
    if (first && second && big(first.realization.poolEstimate?.grossSats ?? "0") > 0n) {
      const paidBeforeSecond = new Set(
        paidRows
          .filter(
            (row) =>
              row.paymentBlockHeight !== null &&
              row.paymentBlockHeight >= first.realization.blockHeight &&
              row.paymentBlockHeight < second.realization.blockHeight,
          )
          .map((row) => `${row.stakerPrincipal}|${row.bucket}`),
      );
      // Account universe: STX-only buckets from memberships plus every (staker, bond bucket) that
      // paid in this cycle, so Bitcoin-bond buckets keep their identity across the seam.
      const accounts = new Set<string>([
        ...memberships
          .filter(({ amountUstx }) => amountUstx > 0n)
          .map(({ stakerPrincipal }) => `${stakerPrincipal}|stx`),
        ...paidRows.map((row) => `${row.stakerPrincipal}|${row.bucket}`),
      ]);
      const rolled = new Set([...accounts].filter((account) => !paidBeforeSecond.has(account)));
      rolledForward = rolled.size;
      for (const row of paidRows) {
        if (
          row.distribution === 2 &&
          rolled.has(`${row.stakerPrincipal}|${row.bucket}`) &&
          row.paymentBlockHeight !== null &&
          row.paymentBlockHeight >= second.realization.blockHeight
        ) {
          row.includesPriorDistribution = true;
          row.coverage = "combined";
        }
      }
      // One First-Distribution row per rolled account: what happened to its payment, and the
      // Second-Distribution payment that carried the amount once that was made. The first-half
      // amount itself is not separable from chain evidence; the recipe's gross bound is kept.
      // With incomplete history a missing first-half payment proves nothing, so no row is emitted.
      const runs = historicallyIncomplete ? [] : (input.runHistory?.(cycle, 1) ?? []);
      for (const account of historicallyIncomplete ? [] : [...rolled].sort()) {
        const separator = account.lastIndexOf("|");
        const stakerPrincipal = account.slice(0, separator);
        const bucket = account.slice(separator + 1);
        const paidWith =
          paidRows.find(
            (row) =>
              row.distribution === 2 &&
              row.stakerPrincipal === stakerPrincipal &&
              row.bucket === bucket &&
              row.paymentBlockHeight !== null &&
              row.paymentBlockHeight >= second.realization.blockHeight,
          ) ?? null;
        const explanation = explainRollForward({ stakerPrincipal, cycle, bucket, runs, paidWith });
        const route: RewardLedgerPayment["route"] =
          paidWith?.route ?? (l1AddressByStaker.has(stakerPrincipal) ? "bitcoin" : "sbtc");
        rolledRows.push({
          schemaVersion: 1,
          cycle,
          distribution: 1,
          bucket,
          stakerPrincipal,
          route,
          grossRewardSats: explanation.grossBoundSats,
          operatorFeeSats: null,
          stakerEntitlementSats: "0",
          payoutSats: null,
          payoutAsset: null,
          l1MaxFeeSats: null,
          l1ActualFeeSats: null,
          feeRefundSats: null,
          returnedSats: null,
          status: "rolled-forward",
          coverage: "exact",
          includesPriorDistribution: false,
          paymentTxId: paidWith?.paymentTxId ?? null,
          paymentBlockHeight: paidWith?.paymentBlockHeight ?? null,
          paidAt: paidWith?.paidAt ?? null,
          by: paidWith?.by ?? null,
          l1RequestId: null,
          l1Status: null,
          settleOrReclaimTxId: null,
          btcSweepTxId: null,
          unavailableReason: "first-half-amount-carried-by-the-second-distribution-payment",
          l1Address: route === "bitcoin" ? (l1AddressByStaker.get(stakerPrincipal) ?? null) : null,
          rollForward: explanation.rollForward,
          sortKey: second.realization.blockHeight,
        });
      }
    }

    // outstanding payments: live entitlements for the live cycles only
    const outstandingRows: PaymentRow[] = [];
    const latestCalculated = calculations.at(-1)?.distribution ?? null;
    if (isLive && live?.stakers) {
      // Live reads already reflect earlier payments (a paid account reads back zero), so a
      // nonzero entitlement here is genuinely outstanding.
      for (const staker of live.stakers) {
        const entries = staker.claims?.length
          ? staker.claims
          : [{ bondIndex: null, rewards: staker.rewards, claimable: staker.claimableByPolicy }];
        for (const entry of entries) {
          const entitlement = big(entry.rewards.earnedSats);
          if (entitlement <= 0n) continue;
          const bucket = bucketKey(entry.bondIndex);
          const route = staker.payout.kind === "bitcoin-l1" ? "bitcoin" : "sbtc";
          const status: RewardLedgerPaymentStatus = entry.claimable
            ? "outstanding"
            : route === "bitcoin"
              ? "below-fee"
              : "not-payable";
          outstandingRows.push({
            schemaVersion: 1,
            cycle,
            distribution: latestCalculated,
            bucket,
            stakerPrincipal: staker.stakerPrincipal,
            route,
            grossRewardSats: entry.rewards.grossSats,
            operatorFeeSats: entry.rewards.feeSats,
            stakerEntitlementSats: entry.rewards.earnedSats,
            payoutSats:
              route === "sbtc"
                ? entry.rewards.earnedSats
                : staker.payout.maxFeeSats !== null && entitlement > big(staker.payout.maxFeeSats)
                  ? text(entitlement - big(staker.payout.maxFeeSats))
                  : null,
            payoutAsset: route === "sbtc" ? "sBTC" : "BTC",
            l1MaxFeeSats: staker.payout.maxFeeSats,
            l1ActualFeeSats: null,
            feeRefundSats: null,
            returnedSats: null,
            status,
            coverage: "exact",
            includesPriorDistribution:
              latestCalculated === 2 &&
              first !== undefined &&
              !paidRows.some(
                (row) =>
                  row.stakerPrincipal === staker.stakerPrincipal &&
                  row.bucket === bucket &&
                  row.distribution === 1,
              ),
            paymentTxId: null,
            paymentBlockHeight: null,
            paidAt: null,
            by: null,
            l1RequestId: null,
            l1Status: null,
            settleOrReclaimTxId: null,
            btcSweepTxId: null,
            l1Address:
              route === "bitcoin" ? (l1AddressByStaker.get(staker.stakerPrincipal) ?? null) : null,
            rollForward: null,
            unavailableReason:
              status === "below-fee"
                ? "entitlement-below-bitcoin-fee-budget"
                : status === "not-payable"
                  ? "fee-not-locked-or-manager-unfunded"
                  : null,
            sortKey: Number.MAX_SAFE_INTEGER,
          });
        }
      }
      for (const row of outstandingRows)
        if (row.includesPriorDistribution) row.coverage = "combined";
    }

    const cycleRows = [...paidRows, ...rolledRows, ...outstandingRows];
    if (historicallyIncomplete) {
      for (const row of cycleRows) row.coverage = "historical-coverage-incomplete";
    }
    allPayments.push(...cycleRows);

    // distributions present for this cycle
    const indices: RewardLedgerDistributionIndex[] = [];
    if (calculations.length > 0 || cycleRows.length > 0 || collects.length > 0) indices.push(1);
    if (
      second ||
      (isLive && next?.targetRewardCycle === cycle && next.targetCheckpoint === "second-half") ||
      (first && (isLive || collects.some((c) => attribute(calculations, c.blockHeight) === 2)))
    ) {
      if (!indices.includes(2)) indices.push(2);
    }
    if (isLive && indices.length === 0) indices.push(1);
    indices.sort();

    let fallbackCurrent: RewardLedgerDistributionIndex | null = null;

    const distributions: RewardLedgerDistribution[] = indices.map((index) => {
      const fact = calculations.find(({ distribution }) => distribution === index);
      const rows = cycleRows.filter((row) => row.distribution === index);
      const distributionCollects = collects.filter(
        (collect) => attribute(calculations, collect.blockHeight) === index,
      );
      const collectedSats = distributionCollects.reduce(
        (total, collect) => total + big(collect.totalRewardsSats),
        0n,
      );
      const settled = rows.filter((row) => row.status !== "rolled-forward");
      const counts = {
        made: rows.filter((row) =>
          ["paid", "sent", "arrived", "retired", "rejected", "returned"].includes(row.status),
        ).length,
        outstanding: rows.filter((row) => row.status === "outstanding").length,
        notPayable: rows.filter((row) => row.status === "not-payable").length,
        belowFee: rows.filter((row) => row.status === "below-fee").length,
        rolledForward: index === 1 ? rolledForward : 0,
        sent: rows.filter((row) => row.status === "sent").length,
        arrived: rows.filter((row) => row.status === "arrived").length,
        arriving: rows.filter((row) => row.status === "sent" || row.status === "arrived").length,
        rejected: rows.filter((row) => row.status === "rejected").length,
        returned: rows.filter((row) => row.status === "returned").length,
        distributedSats: text(
          settled
            .filter((row) => row.paymentTxId !== null)
            .reduce((total, row) => total + big(row.stakerEntitlementSats), 0n),
        ),
        outstandingSats: text(
          settled
            .filter((row) => row.paymentTxId === null)
            .reduce((total, row) => total + big(row.stakerEntitlementSats), 0n),
        ),
        operatorFeeSats: text(
          settled
            .filter((row) => row.paymentTxId !== null)
            .reduce((total, row) => total + big(row.operatorFeeSats ?? "0"), 0n),
        ),
      };
      const expectedNext =
        next !== null &&
        next.targetRewardCycle === cycle &&
        checkpointIndex(next.targetCheckpoint) === index
          ? next
          : null;
      const calculation: RewardLedgerCalculation = fact
        ? {
            state: "done",
            txId: fact.realization.txId,
            blockHeight: fact.realization.blockHeight,
            calculationBurnHeight: fact.realization.calculationBurnHeight,
            observedAt: fact.realization.observedAt,
            poolSats: fact.realization.poolEstimate?.grossSats ?? null,
            poolSatsUnavailableReason: fact.realization.poolEstimate
              ? null
              : (fact.realization.poolEstimateUnavailableReason ?? "pool-estimate-unavailable"),
            by: provenance(ownedTxids, fact.realization.txId),
          }
        : {
            state: expectedNext?.grace?.state === "action-required" ? "overdue" : "waiting",
            txId: null,
            blockHeight: null,
            calculationBurnHeight: null,
            observedAt: null,
            poolSats: null,
            poolSatsUnavailableReason: null,
            by: null,
          };
      const coverage: RewardLedgerCoverage = historicallyIncomplete
        ? "historical-coverage-incomplete"
        : rows.some((row) => row.coverage === "combined")
          ? "combined"
          : "exact";
      const isLatestCalculated = fact !== undefined && latestCalculated === index;
      let status: RewardLedgerDistributionStatus;
      let statusDetail: string;
      if (counts.rejected > 0) {
        status = "needs-attention";
        statusDetail = `${counts.rejected} Bitcoin payout${counts.rejected === 1 ? "" : "s"} rejected · return pending`;
      } else if (!fact) {
        if (calculation.state === "overdue") {
          status = "calculation-overdue";
          statusDetail = "The network calculation is overdue";
        } else if (expectedNext?.state === "due") {
          status = "waiting-calculation";
          statusDetail = "Waiting on the network calculation";
        } else {
          status = "accruing";
          statusDetail = "Accruing before the network calculation";
        }
      } else if (
        isLatestCalculated &&
        ((availableToCollect !== null && big(availableToCollect) > 0n) || counts.outstanding > 0)
      ) {
        status = "ready";
        statusDetail =
          big(availableToCollect ?? "0") > 0n && counts.outstanding > 0
            ? `Ready to collect ${availableToCollect} sats and distribute ${counts.outstanding} payments`
            : big(availableToCollect ?? "0") > 0n
              ? `Ready to collect ${availableToCollect} sats`
              : `Ready to distribute ${counts.outstanding} payments`;
      } else if (counts.arriving > 0) {
        status = "all-distributed";
        statusDetail = `All distributed · ${counts.arriving} arriving over Bitcoin`;
      } else {
        status = "complete";
        statusDetail = "Complete";
      }
      // Current-distribution candidate for this live cycle: the latest calculated distribution, or
      // the one whose calculation is expected next. Earlier distributions that still need the
      // operator stay visible through their own status; the Rewards page lists them under the
      // current one with their own action (plan §6, "Accruing" state).
      if (isLive && (isLatestCalculated || (!fact && expectedNext !== null))) {
        fallbackCurrent = index;
      }
      const collectRows: RewardLedgerCollect[] = distributionCollects.map((collect) => ({
        sats: collect.totalRewardsSats ?? "0",
        stxSats: collect.stxRewardsSats,
        txId: collect.txId,
        blockHeight: collect.blockHeight,
        by: provenance(ownedTxids, collect.txId),
      }));
      return {
        schemaVersion: 1,
        cycle,
        distribution: index,
        current: false,
        calculation,
        collects: collectRows.slice(0, 50),
        collectedSats: text(collectedSats),
        availableToCollectSats: isLive && isLatestCalculated ? availableToCollect : null,
        feeBips,
        feeEvidence,
        payments: counts,
        status,
        statusDetail,
        coverage,
      };
    });

    if (isLive) currentCandidates.set(cycle, fallbackCurrent);
    const cycleCoverage: RewardLedgerCoverage = distributions.some(
      ({ coverage }) => coverage === "historical-coverage-incomplete",
    )
      ? "historical-coverage-incomplete"
      : distributions.some(({ coverage }) => coverage === "combined")
        ? "combined"
        : "exact";
    cycles.push({
      cycle,
      feeBips,
      feeEvidence,
      collectedSats: text(distributions.reduce((total, d) => total + big(d.collectedSats), 0n)),
      distributedSats: text(
        distributions.reduce((total, d) => total + big(d.payments.distributedSats), 0n),
      ),
      operatorFeeSats: text(
        distributions.reduce((total, d) => total + big(d.payments.operatorFeeSats), 0n),
      ),
      outstandingSats: text(
        distributions.reduce((total, d) => total + big(d.payments.outstandingSats), 0n),
      ),
      coverage: cycleCoverage,
      distributions,
    });
  }

  // --- current distribution across the live window ---
  // The Now card follows the calculation-target cycle (its latest calculated or expected-next
  // distribution). An earlier live cycle only becomes current when the target cycle has no
  // distribution yet; its open work otherwise surfaces through per-distribution status.
  let current: { cycle: number; distribution: RewardLedgerDistributionIndex } | null = null;
  const liveCyclesDescending = [...currentCandidates.keys()].sort((left, right) => right - left);
  for (const liveCycle of liveCyclesDescending) {
    const candidate = currentCandidates.get(liveCycle) ?? null;
    if (candidate !== null) {
      current = { cycle: liveCycle, distribution: candidate };
      break;
    }
  }
  for (const cycle of cycles) {
    for (const distribution of cycle.distributions) {
      distribution.current =
        current !== null &&
        cycle.cycle === current.cycle &&
        distribution.distribution === current.distribution;
    }
  }

  // --- payment selection: outstanding first, then newest paid ---
  const selectedCycle =
    scope === "all"
      ? null
      : query.cycle !== null && query.cycle !== undefined
        ? query.cycle
        : (current?.cycle ?? currentCycle ?? cycleIds[0] ?? null);
  const filtered = allPayments
    .filter((row) => selectedCycle === null || row.cycle === selectedCycle)
    .filter(
      (row) =>
        query.distribution === null ||
        query.distribution === undefined ||
        row.distribution === query.distribution,
    )
    .filter(
      (row) =>
        query.staker === null ||
        query.staker === undefined ||
        row.stakerPrincipal.toLowerCase().startsWith(query.staker.toLowerCase()),
    )
    .sort(
      (left, right) =>
        right.sortKey - left.sortKey || left.stakerPrincipal.localeCompare(right.stakerPrincipal),
    );
  const paymentLimit = scope === "all" ? maximumExportPayments : maximumPayments;
  const payments = filtered.slice(0, paymentLimit).map(({ sortKey: _sortKey, ...row }) => row);

  // --- fees ---
  const boundedFeeRows = allPayments.filter((row) => row.paymentTxId !== null);
  const aggregate =
    pox5ContractId && store.getManagerRewardFeeTotals
      ? store.getManagerRewardFeeTotals(chainId, managerPrincipal, pox5ContractId)
      : null;
  const earnedIndexed = aggregate
    ? big(aggregate.earnedIndexedSats)
    : boundedFeeRows.reduce((total, row) => total + big(row.operatorFeeSats ?? "0"), 0n);
  const indexedPaymentCount = aggregate?.paymentCount ?? boundedFeeRows.length;
  const unmatchedPaymentCount =
    aggregate?.unmatchedPaymentCount ??
    boundedFeeRows.filter((row) => row.operatorFeeSats === null).length;
  const historyComplete =
    !recoveryIncomplete &&
    unmatchedPaymentCount === 0 &&
    (aggregate !== null || !evidenceWindow.truncated);
  const balance = rewards?.manager?.earnedFeesSats ?? null;
  const withdrawnDerived =
    historyComplete && balance !== null && earnedIndexed >= big(balance)
      ? text(earnedIndexed - big(balance))
      : null;
  const refunds = store
    .listManagerTopicEvents(chainId, managerPrincipal, "sweep-fee-refunds", 1_000)
    .map((event) => ({ txId: event.txId, blockHeight: event.blockHeight, amountSats: null }));

  const anchor = snapshot.chainAnchor ?? null;
  return rewardLedgerSchema.parse({
    schemaVersion: 1,
    generatedAt: input.now.toISOString(),
    managerPrincipal,
    network: snapshot.network,
    pox5ContractId,
    anchor: anchor
      ? {
          stacksTipHeight: anchor.stacksBlockHeight,
          burnBlockHeight: anchor.burnBlockHeight,
          indexBlockHash: anchor.indexBlockHash,
        }
      : null,
    capabilityLevel: capabilityLevel(snapshot),
    monitoringStartedAt: recovery?.monitoringStartedAt ?? null,
    recovery: {
      managerHistory: recoveryStatus(recovery?.managerHistory.status),
      currentMemberHistory: recoveryStatus(recovery?.currentMemberHistory.status),
    },
    evidenceWindow,
    current: {
      cycle: current?.cycle ?? currentCycle,
      distribution: current?.distribution ?? null,
    },
    cycles,
    payments,
    paymentsTruncated:
      filtered.length > paymentLimit || (scope === "all" && evidenceWindow.truncated),
    fees: {
      feeBips: rewards?.manager?.feeSnapshotBips ?? rewards?.manager?.configuredFeeBips ?? null,
      earnedIndexedSats: text(earnedIndexed),
      indexedPaymentCount,
      unmatchedPaymentCount,
      historyComplete,
      balanceInManagerSats: balance,
      withdrawnDerivedSats: withdrawnDerived,
      refunds,
    },
    query: {
      cycle: selectedCycle,
      distribution: query.distribution ?? null,
      staker: query.staker ?? null,
      scope,
    },
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/** CSV cell that is safe against formula injection in spreadsheet tools. */
export function csvSafeCell(value: unknown): string {
  let cell = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`;
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

function csv(rows: readonly (readonly unknown[])[]): string {
  return rows.map((row) => row.map(csvSafeCell).join(",")).join("\n");
}

export function rewardLedgerDistributionsCsv(ledger: RewardLedger): string {
  const header = [
    "cycle",
    "distribution",
    "status",
    "calculation_state",
    "calculation_txid",
    "calculation_block_height",
    "calculation_burn_height",
    "calculated_pool_sats",
    "collected_sats",
    "collect_txids",
    "fee_bips",
    "fee_evidence",
    "payments_made",
    "payments_outstanding",
    "payments_rolled_forward",
    "payments_arriving",
    "payments_rejected",
    "payments_returned",
    "distributed_sats",
    "outstanding_sats",
    "operator_fee_sats",
    "coverage",
  ];
  const rows = ledger.cycles.flatMap((cycle) =>
    cycle.distributions.map((d) => [
      d.cycle,
      d.distribution,
      d.status,
      d.calculation.state,
      d.calculation.txId,
      d.calculation.blockHeight,
      d.calculation.calculationBurnHeight,
      d.calculation.poolSats,
      d.collectedSats,
      d.collects.map((c) => c.txId).join(" "),
      d.feeBips,
      d.feeEvidence,
      d.payments.made,
      d.payments.outstanding,
      d.payments.rolledForward,
      d.payments.arriving,
      d.payments.rejected,
      d.payments.returned,
      d.payments.distributedSats,
      d.payments.outstandingSats,
      d.payments.operatorFeeSats,
      d.coverage,
    ]),
  );
  return csv([header, ...rows]);
}

export function rewardLedgerPaymentsCsv(ledger: RewardLedger): string {
  const header = [
    "cycle",
    "distribution",
    "bucket",
    "staker_principal",
    "route",
    "gross_reward_sats",
    "operator_fee_sats",
    "staker_entitlement_sats",
    "payout_sats",
    "payout_asset",
    "l1_max_fee_sats",
    "l1_actual_fee_sats",
    "fee_refund_sats",
    "returned_sats",
    "status",
    "coverage",
    "includes_prior_distribution",
    "payment_txid",
    "payment_block_height",
    "paid_at",
    "by",
    "l1_request_id",
    "l1_status",
    "settle_or_reclaim_txid",
    "btc_sweep_txid",
    "unavailable_reason",
    "l1_address",
    "roll_forward_reason",
    "roll_forward_detail",
    "roll_forward_run_id",
    "roll_forward_paid_with_txid",
  ];
  const rows = ledger.payments.map((p) => [
    p.cycle,
    p.distribution,
    p.bucket,
    p.stakerPrincipal,
    p.route,
    p.grossRewardSats,
    p.operatorFeeSats,
    p.stakerEntitlementSats,
    p.payoutSats,
    p.payoutAsset,
    p.l1MaxFeeSats,
    p.l1ActualFeeSats,
    p.feeRefundSats,
    p.returnedSats,
    p.status,
    p.coverage,
    p.includesPriorDistribution,
    p.paymentTxId,
    p.paymentBlockHeight,
    p.paidAt,
    p.by,
    p.l1RequestId,
    p.l1Status,
    p.settleOrReclaimTxId,
    p.btcSweepTxId,
    p.unavailableReason,
    p.l1Address,
    p.rollForward?.reason ?? null,
    p.rollForward?.detail ?? null,
    p.rollForward?.runId ?? null,
    p.rollForward?.paidWith?.txId ?? null,
  ]);
  return csv([header, ...rows]);
}

export interface RewardLedgerFeeRow {
  kind:
    | "operator-fee"
    | "fee-refund-sweep"
    | "earned-indexed-total"
    | "balance-in-manager"
    | "withdrawn-derived";
  cycle: number | null;
  distribution: number | null;
  stakerPrincipal: string | null;
  bucket: string | null;
  amountSats: string | null;
  txId: string | null;
  blockHeight: number | null;
  note: string;
}

/** Fee accounting rows shared by the CSV and JSON fee exports (plan §9). */
export function rewardLedgerFeeRows(ledger: RewardLedger): RewardLedgerFeeRow[] {
  const feeRows: RewardLedgerFeeRow[] = ledger.payments
    .filter((p) => p.paymentTxId !== null && p.operatorFeeSats !== null)
    .map((p) => ({
      kind: "operator-fee",
      cycle: p.cycle,
      distribution: p.distribution,
      stakerPrincipal: p.stakerPrincipal,
      bucket: p.bucket,
      amountSats: p.operatorFeeSats,
      txId: p.paymentTxId,
      blockHeight: p.paymentBlockHeight,
      note: "credited in the manager as the payment was distributed",
    }));
  const refundRows: RewardLedgerFeeRow[] = ledger.fees.refunds.map((r) => ({
    kind: "fee-refund-sweep",
    cycle: null,
    distribution: null,
    stakerPrincipal: null,
    bucket: null,
    amountSats: r.amountSats,
    txId: r.txId,
    blockHeight: r.blockHeight,
    note: "sweep-fee-refunds event",
  }));
  const summary = (
    kind: RewardLedgerFeeRow["kind"],
    amountSats: string | null,
    note: string,
  ): RewardLedgerFeeRow => ({
    kind,
    cycle: null,
    distribution: null,
    stakerPrincipal: null,
    bucket: null,
    amountSats,
    txId: null,
    blockHeight: null,
    note,
  });
  return [
    ...feeRows,
    ...refundRows,
    summary(
      "earned-indexed-total",
      ledger.fees.earnedIndexedSats,
      "sum of operator fees on indexed payments",
    ),
    summary(
      "balance-in-manager",
      ledger.fees.balanceInManagerSats,
      "manager earned-fees balance at the anchor",
    ),
    summary(
      "withdrawn-derived",
      ledger.fees.withdrawnDerivedSats,
      "earned-indexed-total minus balance; withdraw-fees emits no event",
    ),
  ];
}

export function rewardLedgerFeesCsv(ledger: RewardLedger): string {
  const header = [
    "kind",
    "cycle",
    "distribution",
    "staker_principal",
    "bucket",
    "amount_sats",
    "txid",
    "block_height",
    "note",
  ];
  const rows = rewardLedgerFeeRows(ledger).map((row) => [
    row.kind,
    row.cycle,
    row.distribution,
    row.stakerPrincipal,
    row.bucket,
    row.amountSats,
    row.txId,
    row.blockHeight,
    row.note,
  ]);
  return csv([header, ...rows]);
}
