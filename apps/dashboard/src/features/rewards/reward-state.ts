import type {
  DashboardSnapshot,
  GasWalletStatus,
  RewardLedger,
  RewardLedgerCycle,
  RewardLedgerDistribution,
  RewardLedgerPayment,
  RewardRun,
  RewardRunOperation,
} from "@stx-labs/signer-sidekick-api-contracts";
import {
  amount,
  amountParts,
  compactDuration,
  exactSats,
  feePercent,
  shortUtc,
  stxAmount,
} from "../../shared/format.js";
import { IN_PROGRESS_RUN_STATUSES, operationsForKind, type RewardRunKind } from "./run-api.js";

/**
 * Pure derivations for the Rewards page (plan §6, v2 layout): the Earning card (orientation for
 * the accruing cycle), one Distribute card per distribution that still needs the operator, and the
 * payment-row vocabulary shared by every table. Keeping this data-only makes every line testable
 * without rendering, and lets the Overview card reuse the same words.
 */

export type Tone = "success" | "caution" | "error" | "info" | "neutral" | "accent";

export interface RewardTile {
  label: string;
  value: string;
  unit: string | null;
  detail: string | null;
  tooltip: string | null;
}

export interface RewardPrimaryAction {
  kind: RewardRunKind;
  label: string;
  /** Recipe operations the server may include for this action (plan §8.5). */
  operations: RewardRunOperation[];
  /** Transactions this action is expected to take, for the gas check and the confirm sheet. */
  transactions: number;
  /** The distribution the action targets; every action is explicit about it. */
  cycle: number;
  distribution: 1 | 2;
}

export interface RewardExecutionAvailability {
  available: boolean;
  /** Why the primary action is disabled; null when available. */
  reason: string | null;
  /** Short chip text: "Gas wallet 12.48 STX · ≈ 1,200 tx". */
  chip: string | null;
  chipTone: "ok" | "low" | "none";
  chipTooltip: string | null;
  /** The operator signs with their own wallet (observe mode / no gas wallet). */
  walletFallback: boolean;
}

export function distributionName(distribution: 1 | 2 | null): string {
  return distribution === 1
    ? "First Distribution"
    : distribution === 2
      ? "Second Distribution"
      : "Distribution";
}

export function halfLabel(index: 1 | 2): string {
  return index === 1 ? "First half" : "Second half";
}

export function checkpointIndex(checkpoint: "first-half" | "second-half"): 1 | 2 {
  return checkpoint === "first-half" ? 1 : 2;
}

function plural(count: number, singular: string, pluralWord = `${singular}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? singular : pluralWord}`;
}

function big(value: string | null | undefined): bigint {
  return value && /^(0|[1-9]\d*)$/.test(value) ? BigInt(value) : 0n;
}

function text(value: bigint): string {
  return value.toString();
}

function blocks(value: number): string {
  return value.toLocaleString("en-US");
}

/** "Aug 19" — the date half of `shortUtc`, for surfaces where the time belongs in a tooltip. */
export function shortDate(iso: string | null | undefined): string {
  const full = shortUtc(iso);
  return full === "—" ? full : (full.split(",")[0] ?? full);
}

export function paymentTotal(distribution: RewardLedgerDistribution): number {
  const p = distribution.payments;
  return p.made + p.outstanding + p.notPayable + p.belowFee;
}

function provenance(by: "you" | "another-caller" | "unknown" | null | undefined): string {
  return by === "you"
    ? "by you"
    : by === "another-caller"
      ? "by another caller"
      : "by an unknown caller";
}

function shortTx(txId: string | null): string {
  if (!txId) return "";
  return `tx ${txId.slice(0, 6)}…${txId.slice(-4)}`;
}

/** "Calculated Aug 22, 03:14 UTC · by another caller · tx 0x7c1e…a9f4" lines for ⓘ tooltips. */
export function distributionTooltip(distribution: RewardLedgerDistribution): string | null {
  const lines: string[] = [];
  if (distribution.calculation.state === "done") {
    lines.push(
      [
        `Calculated ${shortUtc(distribution.calculation.observedAt)}`,
        provenance(distribution.calculation.by),
        shortTx(distribution.calculation.txId),
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }
  for (const collect of distribution.collects) {
    lines.push(
      [
        `Collected block ${collect.blockHeight.toLocaleString("en-US")}`,
        provenance(collect.by),
        shortTx(collect.txId),
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }
  if (distribution.payments.rolledForward > 0) {
    lines.push(
      `${plural(distribution.payments.rolledForward, "payment")} rolled forward to the Second Distribution`,
    );
  }
  return lines.length === 0 ? null : lines.join("\n");
}

function currentCycle(ledger: RewardLedger): RewardLedgerCycle | null {
  return ledger.cycles.find((cycle) => cycle.cycle === ledger.current.cycle) ?? null;
}

export function currentDistribution(ledger: RewardLedger): RewardLedgerDistribution | null {
  const cycle = currentCycle(ledger);
  if (!cycle) return null;
  return (
    cycle.distributions.find((d) => d.distribution === ledger.current.distribution) ??
    cycle.distributions.at(-1) ??
    null
  );
}

export function execution(
  gasWallet: GasWalletStatus | null,
  engineMode: "observe" | "operator-run" | null,
  neededTransactions: number,
): RewardExecutionAvailability {
  if (engineMode !== "operator-run") {
    return {
      available: false,
      reason:
        engineMode === null
          ? "Sidekick could not read the engine status"
          : "This Sidekick runs in Observe mode: sign calls with your own wallet, or switch to operator-run and create a gas wallet",
      chip: null,
      chipTone: "none",
      chipTooltip: null,
      walletFallback: true,
    };
  }
  if (!gasWallet?.configured) {
    return {
      available: false,
      reason: "Create a gas wallet in Settings to run calls from here",
      chip: "No gas wallet",
      chipTone: "none",
      chipTooltip: "Create a gas wallet in Settings › Gas wallet",
      walletFallback: true,
    };
  }
  const balance = gasWallet.balanceUstx === null ? null : stxAmount(gasWallet.balanceUstx);
  const estimate =
    gasWallet.estimatedTransactions === null
      ? null
      : `≈ ${gasWallet.estimatedTransactions.toLocaleString("en-US")} tx`;
  const chip = ["Gas wallet", balance ?? "balance unknown", estimate ? `· ${estimate}` : null]
    .filter(Boolean)
    .join(" ");
  const chipTooltip = `Gas wallet ${gasWallet.principal ?? ""}${
    balance ? ` · ${balance}` : ""
  }${estimate ? ` · about ${gasWallet.estimatedTransactions?.toLocaleString("en-US")} transactions at the fee cap` : ""}`;
  if (!gasWallet.enabled || gasWallet.signer !== "ready") {
    return {
      available: false,
      reason:
        gasWallet.signer === "unreadable"
          ? `The gas wallet key could not be loaded${gasWallet.signerError ? `: ${gasWallet.signerError}` : ""}`
          : "Enable the gas wallet in Settings to run calls from here",
      chip,
      chipTone: "low",
      chipTooltip,
      walletFallback: true,
    };
  }
  if (gasWallet.refusal.refusalReason !== null) {
    return {
      available: false,
      reason:
        gasWallet.refusal.refusalReason === "check-unavailable"
          ? "Sidekick could not verify that the gas wallet is a dedicated key; reconnect and retry"
          : "The gas wallet must be a dedicated key that is neither a manager admin nor the signer",
      chip,
      chipTone: "low",
      chipTooltip,
      walletFallback: true,
    };
  }
  const low =
    gasWallet.estimatedTransactions !== null &&
    gasWallet.estimatedTransactions < neededTransactions;
  if (low) {
    const needed = Math.max(0, neededTransactions - (gasWallet.estimatedTransactions ?? 0));
    const feeBasis = big(gasWallet.feeBasisUstx);
    const fund = stxAmount(text(feeBasis * BigInt(needed)));
    return {
      available: false,
      reason: `Gas wallet needs about ${fund} more to cover ${plural(neededTransactions, "transaction")}`,
      chip,
      chipTone: "low",
      chipTooltip,
      walletFallback: false,
    };
  }
  return {
    available: true,
    reason: null,
    chip,
    chipTone: "ok",
    chipTooltip,
    walletFallback: false,
  };
}

function routeSummary(payments: readonly RewardLedgerPayment[] | undefined): string | null {
  if (!payments || payments.length === 0) return null;
  const paid = payments.filter((p) => p.paymentTxId !== null && p.status !== "rolled-forward");
  if (paid.length === 0) return null;
  const bitcoin = paid.filter((p) => p.route === "bitcoin").length;
  const sbtc = paid.length - bitcoin;
  return bitcoin === 0 ? null : `${sbtc} in sBTC, ${bitcoin} over Bitcoin`;
}

// ---------------------------------------------------------------------------------------------
// Cycle geometry — where the burn tip sits inside the accruing cycle
// ---------------------------------------------------------------------------------------------

export interface CycleGeometry {
  cycle: number;
  burnHeight: number;
  /** First burn block of the cycle. */
  cycleStart: number;
  /** First burn block of the second half. */
  halfBoundary: number;
  /** First burn block of the next cycle (exclusive end). */
  cycleEnd: number;
  length: number;
  prepareStart: number | null;
  blocksUntilPrepare: number | null;
  inPreparePhase: boolean;
  liveHalf: 1 | 2;
}

type GeometrySnapshot = Pick<DashboardSnapshot, "preflight"> | null | undefined;

export function deriveCycleGeometry(snapshot: GeometrySnapshot): CycleGeometry | null {
  const cycle = snapshot?.preflight?.cycle ?? null;
  const burnHeight = snapshot?.preflight?.node?.burnBlockHeight ?? null;
  if (!cycle || typeof burnHeight !== "number" || typeof cycle.currentId !== "number") return null;
  const length = cycle.rewardCycleLength ?? null;
  const start =
    cycle.currentCycleStartBurnHeight ??
    (length !== null && cycle.rewardPhaseStartBurnHeight !== null
      ? cycle.rewardPhaseStartBurnHeight - length
      : null);
  if (length === null || start === null || length <= 0) return null;
  const halfBoundary = start + Math.floor(length / 2);
  return {
    cycle: cycle.currentId,
    burnHeight,
    cycleStart: start,
    halfBoundary,
    cycleEnd: start + length,
    length,
    prepareStart: cycle.preparePhaseStartBurnHeight,
    blocksUntilPrepare: cycle.blocksUntilPreparePhase,
    inPreparePhase: cycle.isPreparePhase === true || cycle.blocksUntilPreparePhase === 0,
    liveHalf: burnHeight < halfBoundary ? 1 : 2,
  };
}

// ---------------------------------------------------------------------------------------------
// Earning card — the accruing cycle: identity, three facts, two halves
// ---------------------------------------------------------------------------------------------

export interface EarningHalf {
  index: 1 | 2;
  label: string;
  /** 0–100; the live half's progress, 100 once finished, 0 before it starts. */
  percent: number;
  status: { text: string; tone: "done" | "live" | "ready" | "idle" | "attention" };
  note: string;
}

export interface EarningFact {
  label: string;
  value: string;
  unit: string | null;
  sub: string | null;
  tooltip: string | null;
}

export interface EarningModel {
  cycle: number;
  badge: { tone: Tone; label: string; live?: boolean };
  /** "Second half · 3d 23h left · ends at block 964,249" */
  when: string;
  /** "Prepare phase in 3d 6h · block 964,150" */
  prepare: string | null;
  facts: EarningFact[];
  halves: EarningHalf[];
  coverage: RewardLedgerDistribution["coverage"] | null;
}

type NextCalculation = NonNullable<
  NonNullable<DashboardSnapshot["rewards"]>["calculation"]["next"]
>;

export interface EarningInput {
  ledger: RewardLedger;
  snapshot: Pick<DashboardSnapshot, "rewardOutlook" | "rewards" | "preflight"> | null;
  /** Average seconds per Bitcoin block, for "left" and "in" durations (defaults to 10 minutes). */
  burnBlockSeconds?: number | null;
  now?: Date;
}

function nextCalculation(snapshot: EarningInput["snapshot"]): NextCalculation | null {
  return snapshot?.rewardOutlook?.calculation?.next ?? snapshot?.rewards?.calculation?.next ?? null;
}

function halfStatus(distribution: RewardLedgerDistribution | null): EarningHalf["status"] {
  if (distribution?.calculation.state !== "done") {
    return distribution?.status === "calculation-overdue"
      ? { text: "Ready to calculate", tone: "ready" }
      : { text: "Waiting on calculation", tone: "idle" };
  }
  const p = distribution.payments;
  switch (distribution.status) {
    case "needs-attention":
      return { text: "Needs attention", tone: "attention" };
    case "ready":
      return {
        text:
          big(distribution.availableToCollectSats) > 0n
            ? "Ready to collect"
            : "Ready to distribute",
        tone: "ready",
      };
    case "distributing":
      return { text: `Distributing · ${p.made} of ${paymentTotal(distribution)}`, tone: "ready" };
    case "all-distributed":
      return { text: "Distributed · payouts arriving", tone: "done" };
    case "complete":
      return { text: "Distributed", tone: "done" };
    default:
      return { text: distribution.statusDetail, tone: "idle" };
  }
}

export function deriveEarning(input: EarningInput): EarningModel | null {
  const { ledger, snapshot } = input;
  const geometry = deriveCycleGeometry(snapshot);
  const cycleNumber = geometry?.cycle ?? ledger.current.cycle;
  if (cycleNumber === null) return null;
  const ledgerCycle = ledger.cycles.find((entry) => entry.cycle === cycleNumber) ?? null;
  const distributionFor = (index: 1 | 2) =>
    ledgerCycle?.distributions.find((d) => d.distribution === index) ?? null;
  const seconds = input.burnBlockSeconds ?? 600;
  const duration = (count: number) => compactDuration(Math.max(0, count) * seconds);
  const now = input.now ?? new Date();
  const next = nextCalculation(snapshot);
  const outlook = snapshot?.rewardOutlook ?? null;
  const liveHalf: 1 | 2 =
    geometry?.liveHalf ??
    (next && next.targetRewardCycle === cycleNumber ? checkpointIndex(next.targetCheckpoint) : 2);
  const targetMatchesLive =
    next !== null &&
    next.targetRewardCycle === cycleNumber &&
    checkpointIndex(next.targetCheckpoint) === liveHalf;
  const forecast = targetMatchesLive ? (outlook?.forecast ?? null) : null;
  const poolEstimate = targetMatchesLive ? (outlook?.poolEstimate ?? null) : null;
  const feeForecast = targetMatchesLive
    ? (outlook?.operatorFeeForecast?.sats.point ?? outlook?.operatorFeeEstimate?.sats ?? null)
    : null;

  // ---- identity lines ----
  let when: string;
  let prepare: string | null = null;
  if (geometry) {
    const halfEnd = liveHalf === 1 ? geometry.halfBoundary : geometry.cycleEnd;
    when = `${halfLabel(liveHalf)} · ${duration(halfEnd - geometry.burnHeight)} left · ends at block ${blocks(halfEnd - 1)}`;
    if (geometry.inPreparePhase) {
      prepare = `Prepare phase · Cycle ${cycleNumber + 1} starts in ${duration(geometry.cycleEnd - geometry.burnHeight)} · block ${blocks(geometry.cycleEnd)}`;
    } else if (geometry.blocksUntilPrepare !== null && geometry.prepareStart !== null) {
      prepare = `Prepare phase in ${duration(geometry.blocksUntilPrepare)} · block ${blocks(geometry.prepareStart)}`;
    }
  } else {
    when = `${halfLabel(liveHalf)}${next && targetMatchesLive ? ` · calculation ${next.state === "due" ? "due now" : `in ${duration(next.blocksRemaining)}`}` : ""}`;
  }

  // ---- facts ----
  const facts: EarningFact[] = [];
  const networkAccrued =
    outlook?.accrued.globalSats ?? snapshot?.rewards?.global.globalAccruedRewardsSats ?? null;
  const networkParts = amountParts(networkAccrued);
  facts.push({
    label: "Network earned this half",
    value: networkParts?.value ?? "—",
    unit: networkParts?.unit ?? null,
    sub: forecast
      ? `${amount(forecast.globalSats.point)} projected at calculation`
      : targetMatchesLive
        ? "since the last network calculation"
        : next
          ? `includes Cycle ${next.targetRewardCycle} ${next.targetCheckpoint === "first-half" ? "first" : "second"} half until it is calculated`
          : null,
    tooltip: networkAccrued ? exactSats(networkAccrued) : null,
  });
  const poolPoint = forecast?.poolSats.point ?? poolEstimate?.grossSats ?? null;
  const poolParts = amountParts(poolPoint);
  facts.push({
    label: "Pool projected this half",
    value: poolParts?.value ?? "—",
    unit: poolParts?.unit ?? null,
    sub: forecast
      ? `${amount(poolEstimate?.grossSats ?? null)} accrued · ${amount(forecast.poolSats.low)} – ${amount(forecast.poolSats.high)} · ${forecast.confidence} confidence`
      : poolEstimate
        ? "if the network calculated now"
        : targetMatchesLive || next === null
          ? "projection unavailable"
          : `after the Cycle ${next.targetRewardCycle} calculation`,
    tooltip: forecast
      ? `${forecast.sample.observations} observations across ${forecast.sample.sampleBlocks} Bitcoin blocks`
      : null,
  });
  const done = (index: 1 | 2) => distributionFor(index)?.calculation.state === "done";
  const calculatedSum = ([1, 2] as const).reduce(
    (sum, index) => sum + big(distributionFor(index)?.calculation.poolSats ?? null),
    0n,
  );
  const uncalculated = ([1, 2] as const).filter((index) => !done(index));
  const projectedSum = poolPoint === null ? null : big(poolPoint) * BigInt(uncalculated.length);
  const cycleTotal =
    projectedSum === null
      ? uncalculated.length === 0
        ? calculatedSum
        : calculatedSum > 0n
          ? calculatedSum
          : null
      : calculatedSum + projectedSum;
  const calculatedFee = ([1, 2] as const).reduce((sum, index) => {
    const d = distributionFor(index);
    if (d?.calculation.state !== "done" || !d.calculation.poolSats) return sum;
    const expected =
      big(d.calculation.poolSats) -
      big(d.payments.distributedSats) -
      big(d.payments.outstandingSats);
    return sum + (expected > 0n ? expected : big(d.payments.operatorFeeSats));
  }, 0n);
  const cycleFee =
    calculatedFee + (feeForecast === null ? 0n : big(feeForecast) * BigInt(uncalculated.length));
  const cycleParts = amountParts(cycleTotal === null ? null : text(cycleTotal));
  const cycleSub: string[] = [];
  if (calculatedSum > 0n && projectedSum !== null && uncalculated.length > 0) {
    cycleSub.push(
      `${amount(text(calculatedSum))} calculated + ${amount(text(projectedSum))} projected`,
    );
  } else if (projectedSum !== null && uncalculated.length === 2) {
    cycleSub.push("both halves projected");
  } else if (calculatedSum > 0n && uncalculated.length > 0 && projectedSum === null) {
    cycleSub.push(`${halfLabel(uncalculated[0] ?? 2).toLowerCase()} projection unavailable`);
  } else if (uncalculated.length === 0) {
    cycleSub.push("both halves calculated");
  }
  if (cycleTotal !== null && cycleTotal > 0n) cycleSub.push(`your fee ${amount(text(cycleFee))}`);
  facts.push({
    label: "Pool projected this cycle",
    value: cycleParts?.value ?? "—",
    unit: cycleParts?.unit ?? null,
    sub: cycleSub.length > 0 ? cycleSub.join(" · ") : null,
    tooltip: cycleTotal === null ? null : exactSats(text(cycleTotal)),
  });

  // ---- halves ----
  const halves: EarningHalf[] = ([1, 2] as const).map((index) => {
    const d = distributionFor(index);
    const label = halfLabel(index);
    if (!geometry) {
      const live = index === liveHalf;
      const finished = index < liveHalf || (d !== null && d.calculation.state === "done");
      return {
        index,
        label,
        percent: finished ? 100 : live ? 50 : 0,
        status: finished
          ? halfStatus(d)
          : live
            ? { text: "Accruing", tone: "live" }
            : { text: "Not started", tone: "idle" },
        note:
          d?.calculation.state === "done"
            ? `calculated ${shortDate(d.calculation.observedAt)} · ${amount(d.calculation.poolSats)}`
            : "",
      };
    }
    const start = index === 1 ? geometry.cycleStart : geometry.halfBoundary;
    const end = index === 1 ? geometry.halfBoundary : geometry.cycleEnd;
    if (geometry.burnHeight >= end) {
      const note = [
        `ended at block ${blocks(end - 1)}`,
        d?.calculation.state === "done"
          ? `calculated ${shortDate(d.calculation.observedAt)} · ${amount(d.calculation.poolSats)}`
          : null,
        d && d.payments.made > 0 ? `${plural(d.payments.made, "payment")}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      return { index, label, percent: 100, status: halfStatus(d), note };
    }
    if (geometry.burnHeight < start) {
      return {
        index,
        label,
        percent: 0,
        status: { text: "Not started", tone: "idle" },
        note: `starts at block ${blocks(start)}`,
      };
    }
    const percent = Math.min(
      99,
      Math.max(0, Math.round(((geometry.burnHeight - start) / (end - start)) * 100)),
    );
    const expected =
      next &&
      next.targetRewardCycle === cycleNumber &&
      checkpointIndex(next.targetCheckpoint) === index
        ? next.state === "due"
          ? "calculation due now"
          : `calculation expected ${shortUtc(new Date(now.getTime() + next.blocksRemaining * seconds * 1000).toISOString()).replace(",", " ~")}`
        : null;
    return {
      index,
      label,
      percent,
      status: {
        text: `Accruing · ${percent}% · ${duration(end - geometry.burnHeight)} left`,
        tone: "live",
      },
      note: [`ends at block ${blocks(end - 1)}`, expected].filter(Boolean).join(" · "),
    };
  });

  return {
    cycle: cycleNumber,
    badge: { tone: "neutral", label: "Accruing", live: true },
    when,
    prepare,
    facts,
    halves,
    coverage: ledgerCycle?.coverage ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// Distribute — one card per distribution that still needs the operator
// ---------------------------------------------------------------------------------------------

export interface DistributionCardModel {
  key: string;
  cycle: number;
  distribution: 1 | 2;
  eyebrow: string;
  badge: { tone: Tone; label: string; live?: boolean };
  headline: string;
  sub: string;
  subTooltip: string | null;
  primary: RewardPrimaryAction | null;
  secondary: { action: RewardPrimaryAction; tooltip: string | null } | null;
  tiles: RewardTile[];
  attention: { title: string; text: string } | null;
  progress: {
    done: number;
    total: number;
    text: string;
    right: string;
    runId: string;
    status: RewardRun["status"];
    canPause: boolean;
    canResume: boolean;
    canCancel: boolean;
  } | null;
  /** Another run owns the gas wallet; this card waits ("Queued behind Cycle 141 · First Distribution"). */
  queued: string | null;
  execution: RewardExecutionAvailability;
  coverage: RewardLedgerDistribution["coverage"];
  calculated: boolean;
}

export function distributionKey(cycle: number, distribution: 1 | 2): string {
  return `${cycle}:${distribution}`;
}

const pendingStatuses: ReadonlySet<RewardLedgerDistribution["status"]> = new Set([
  "needs-attention",
  "calculation-overdue",
  "ready",
  "distributing",
]);

/** Distributions that still need the operator, oldest first. */
export function pendingDistributions(
  ledger: RewardLedger,
): Array<{ cycle: RewardLedgerCycle; distribution: RewardLedgerDistribution }> {
  return ledger.cycles
    .flatMap((cycle) => cycle.distributions.map((distribution) => ({ cycle, distribution })))
    .filter(
      ({ distribution }) =>
        pendingStatuses.has(distribution.status) ||
        (distribution.status === "all-distributed" && distribution.payments.arriving > 0),
    )
    .sort(
      (left, right) =>
        left.cycle.cycle - right.cycle.cycle ||
        left.distribution.distribution - right.distribution.distribution,
    );
}

export interface DistributeInput {
  ledger: RewardLedger;
  /** Payments per `distributionKey`, when loaded (route counts, arrived/rejected detail). */
  paymentsByKey?: ReadonlyMap<string, readonly RewardLedgerPayment[]>;
  gasWallet: GasWalletStatus | null;
  engineMode: "observe" | "operator-run" | null;
  activeRun: RewardRun | null;
}

export function deriveDistributionCards(input: DistributeInput): DistributionCardModel[] {
  const { ledger, gasWallet, engineMode } = input;
  const activeRun =
    input.activeRun && IN_PROGRESS_RUN_STATUSES.has(input.activeRun.status)
      ? input.activeRun
      : null;
  return pendingDistributions(ledger).map(({ cycle, distribution }) => {
    const key = distributionKey(cycle.cycle, distribution.distribution);
    const target = { cycle: cycle.cycle, distribution: distribution.distribution };
    const p = distribution.payments;
    const total = paymentTotal(distribution);
    const calculated = distribution.calculation.state === "done";
    const poolSats = distribution.calculation.poolSats;
    const available = big(distribution.availableToCollectSats);
    const outstandingSats = big(p.outstandingSats);
    const payments = input.paymentsByKey?.get(key) ?? [];
    const arrived = payments.filter((row) => row.status === "arrived").length;
    const rejected = p.rejected;
    const eyebrow = `Cycle ${cycle.cycle} · ${distributionName(distribution.distribution)}`;
    const runForThis =
      activeRun !== null &&
      activeRun.recipe.cycle === cycle.cycle &&
      activeRun.recipe.distribution === distribution.distribution
        ? activeRun
        : null;
    const queued =
      activeRun !== null && runForThis === null
        ? `Queued behind Cycle ${activeRun.recipe.cycle} · ${distributionName(activeRun.recipe.distribution)} — one run at a time`
        : null;

    // ---- actions ----
    let primary: RewardPrimaryAction | null = null;
    let secondary: DistributionCardModel["secondary"] = null;
    if (distribution.status === "calculation-overdue") {
      primary = {
        kind: "calculate",
        label: "Run calculation",
        operations: operationsForKind("calculate"),
        transactions: 1,
        ...target,
      };
    } else if (rejected > 0 || arrived > 0) {
      const action: RewardPrimaryAction = {
        kind: "finish-bitcoin-payouts",
        label: "Finish Bitcoin payouts",
        operations: operationsForKind("finish-bitcoin-payouts"),
        transactions: rejected + arrived,
        ...target,
      };
      if (rejected > 0) primary = action;
      else
        secondary = {
          action,
          tooltip: `Retire ${plural(arrived, "settled payout")} — nothing moves. A rejected payout would return sBTC to the staker.`,
        };
    }
    if (primary === null && calculated) {
      if (available > 0n && p.outstanding > 0) {
        primary = {
          kind: "collect-and-distribute",
          label: "Collect & distribute",
          operations: operationsForKind("collect-and-distribute"),
          transactions: 1 + p.outstanding,
          ...target,
        };
      } else if (available > 0n) {
        primary = {
          kind: "collect",
          label: "Collect",
          operations: operationsForKind("collect"),
          transactions: 1,
          ...target,
        };
      } else if (p.outstanding > 0 && runForThis === null) {
        primary = {
          kind: "distribute",
          label: `Distribute ${plural(p.outstanding, "payment")}`,
          operations: operationsForKind("distribute"),
          transactions: p.outstanding,
          ...target,
        };
      }
    }
    const neededTransactions = primary?.transactions ?? secondary?.action.transactions ?? 1;
    const executionState = execution(gasWallet, engineMode, Math.max(neededTransactions, 1));

    // ---- headline / badge / sub ----
    let badge: DistributionCardModel["badge"];
    let headline: string;
    let sub: string;
    let attention: DistributionCardModel["attention"] = null;
    let progress: DistributionCardModel["progress"] = null;
    const yourFee = calculated
      ? text(
          big(p.operatorFeeSats) +
            (poolSats
              ? big(poolSats) - big(p.distributedSats) - big(p.operatorFeeSats) - outstandingSats
              : 0n),
        )
      : null;
    const calculatedLine = calculated
      ? `Calculated ${shortDate(distribution.calculation.observedAt)} ${provenance(distribution.calculation.by)}`
      : null;
    const lastCollect = distribution.collects.at(-1) ?? null;
    if (runForThis) {
      const done = runForThis.progress.completed;
      const all = Math.max(runForThis.progress.total, 1);
      const current = runForThis.children[runForThis.cursor] ?? null;
      const sent = runForThis.children
        .filter(
          (child) => child.operation === "claim-staker-rewards" && child.status === "confirmed",
        )
        .reduce((sum, child) => sum + big(child.materializedAmountSats), 0n);
      const halted = runForThis.status === "halted";
      const paused = runForThis.status === "paused";
      badge = halted
        ? { tone: "error", label: "Run halted" }
        : paused
          ? { tone: "neutral", label: "Paused" }
          : { tone: "accent", label: "In progress", live: true };
      headline = halted
        ? "Run halted"
        : paused
          ? `Paused · ${done} of ${all} done`
          : `Distributing… ${done} of ${all} payments`;
      sub = halted
        ? `${runForThis.failureReason ?? "Sidekick stopped the run"}. Nothing was signed after the halt; resume to rebuild the next step from current chain facts, or cancel.`
        : paused
          ? "The run is paused between transactions. Resume to continue, or cancel to release the gas wallet."
          : `One transaction at a time; the manager sends each payout and the gas wallet pays the network fees.${current?.status === "broadcast" ? " Waiting for the current transaction to confirm." : ""} You can close this page.`;
      attention = halted
        ? { title: "Run halted", text: runForThis.failureReason ?? "Sidekick stopped the run" }
        : null;
      progress = {
        done,
        total: all,
        text: `${done} of ${all} transactions${sent > 0n ? ` · ${amount(text(sent))} sent` : ""}`,
        right: `${stxAmount(runForThis.gasSpentUstx)} gas used`,
        runId: runForThis.runId,
        status: runForThis.status,
        canPause: runForThis.status === "running" && runForThis.progress.inFlight === 0,
        canResume: halted || paused,
        canCancel:
          (halted || paused || runForThis.status === "approved") &&
          runForThis.progress.inFlight === 0,
      };
    } else if (distribution.status === "needs-attention" || rejected > 0) {
      badge = { tone: "error", label: "Needs attention" };
      headline =
        rejected > 0
          ? `${plural(rejected, "Bitcoin payout was", "Bitcoin payouts were")} rejected`
          : "Needs attention";
      sub =
        rejected > 0
          ? `The sBTC protocol rejected ${plural(rejected, "withdrawal")}. The amount is back in the manager and owed to the staker; return it as sBTC with Finish Bitcoin payouts.`
          : distribution.statusDetail;
      attention =
        rejected > 0
          ? {
              title: `${plural(rejected, "rejected withdrawal")}`,
              text: "Finishing returns the full entitlement directly to the staker as sBTC. Their future payouts keep the configured Bitcoin route unless they change it — Sidekick does not change a staker's route.",
            }
          : null;
    } else if (!calculated) {
      badge = { tone: "caution", label: "Calculation overdue" };
      headline = "Calculation is overdue — you can run it";
      sub =
        "The network calculation for this distribution has not happened yet. Anyone can run it; Sidekick can do it from here.";
    } else if (p.outstanding === 0 && available === 0n) {
      badge = { tone: "success", label: "All distributed" };
      headline =
        arrived > 0
          ? `All distributed · ${plural(arrived, "payout")} arrived`
          : `All distributed · ${plural(p.arriving, "payout")} arriving over Bitcoin`;
      sub = `${calculatedLine ?? ""}${lastCollect ? ` · collected ${provenance(lastCollect.by)}` : ""}`;
    } else if (p.made > 0 && p.outstanding > 0) {
      badge = { tone: "info", label: "In progress" };
      headline = `${plural(p.outstanding, "payment")} still outstanding`;
      sub = `${lastCollect ? `Collected ${provenance(lastCollect.by)} · ` : ""}${p.made} of ${total} paid${available > 0n ? ` · ${amount(text(available))} still to collect` : ""}`;
    } else {
      badge = { tone: "success", label: "Ready" };
      headline =
        available > 0n && p.outstanding > 0
          ? "Ready to collect & distribute"
          : available > 0n
            ? "Ready to collect"
            : "Ready to distribute";
      sub = calculatedLine ?? distribution.statusDetail;
    }

    // ---- tiles ----
    const tiles: RewardTile[] = [];
    if (calculated) {
      const parts = amountParts(poolSats);
      tiles.push({
        label: "Calculated for this pool",
        value: parts?.value ?? "—",
        unit: parts?.unit ?? null,
        detail: null,
        tooltip: poolSats
          ? `Exact, from the network calculation · ${exactSats(poolSats)}`
          : distribution.calculation.poolSatsUnavailableReason,
      });
      const collectedParts = amountParts(distribution.collectedSats);
      const collected = big(distribution.collectedSats);
      tiles.push({
        label: "Collected",
        value: collectedParts?.value ?? "0",
        unit: collectedParts?.unit ?? "sBTC",
        detail:
          collected > 0n
            ? lastCollect
              ? provenance(lastCollect.by)
              : null
            : available > 0n
              ? `${amount(text(available))} ready to collect`
              : "not yet collected",
        tooltip: distribution.collects.length > 0 ? distributionTooltip(distribution) : null,
      });
      const routes = routeSummary(payments);
      tiles.push({
        label: "Distributed",
        value: String(p.made),
        unit: `of ${total}`,
        detail:
          p.outstanding > 0
            ? `${amount(p.outstandingSats)} ${p.made > 0 ? "waiting" : "to stakers"}`
            : `${amount(p.distributedSats)}${routes ? ` · ${routes}` : ""}${p.rolledForward > 0 ? ` · ${p.rolledForward} rolled forward` : ""}`,
        tooltip: null,
      });
      const feeParts = amountParts(yourFee);
      const bips = distribution.feeBips ?? cycle.feeBips ?? null;
      const locked = distribution.feeEvidence === "locked" || cycle.feeEvidence === "locked";
      tiles.push({
        label: "Your fee",
        value: feeParts?.value ?? "—",
        unit: feeParts?.unit ?? null,
        detail: bips ? `${feePercent(bips)}${locked ? " locked" : ""}` : null,
        tooltip: yourFee ? exactSats(yourFee) : null,
      });
    }

    return {
      key,
      cycle: cycle.cycle,
      distribution: distribution.distribution,
      eyebrow,
      badge,
      headline,
      sub,
      subTooltip: distributionTooltip(distribution),
      primary,
      secondary,
      tiles,
      attention,
      progress,
      queued,
      execution: executionState,
      coverage: distribution.coverage,
      calculated,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Payment rows — tabs, status words, sorting
// ---------------------------------------------------------------------------------------------

/** Payment status tabs, with counts that sum to the table. */
export type PaymentTab = "outstanding" | "paid" | "arriving" | "rejected" | "rolled" | "all";

export function paymentTab(row: RewardLedgerPayment): Exclude<PaymentTab, "all"> {
  switch (row.status) {
    case "outstanding":
    case "not-payable":
    case "below-fee":
      return "outstanding";
    case "sent":
    case "arrived":
      return "arriving";
    case "rejected":
      return "rejected";
    case "rolled-forward":
      return "rolled";
    default:
      return "paid";
  }
}

export function paymentStatusLabel(row: RewardLedgerPayment): {
  tone: Tone;
  label: string;
  sub: string | null;
} {
  switch (row.status) {
    case "outstanding":
      return { tone: "info", label: "Outstanding", sub: null };
    case "not-payable":
      return {
        tone: "neutral",
        label: "Not payable yet",
        sub:
          row.unavailableReason === "fee-not-locked-or-manager-unfunded"
            ? "fee not locked or manager unfunded"
            : null,
      };
    case "below-fee":
      return {
        tone: "neutral",
        label: "Below Bitcoin fee",
        sub: "entitlement is below the Bitcoin fee budget",
      };
    case "rolled-forward":
      return { tone: "caution", label: "Rolled forward → Second", sub: null };
    case "paid":
      return { tone: "success", label: "Paid", sub: null };
    case "sent":
      return {
        tone: "info",
        label: "Sent over Bitcoin",
        sub: row.l1RequestId ? `request #${row.l1RequestId} · awaiting signers` : null,
      };
    case "arrived":
      return {
        tone: "success",
        label: "Arrived · ready to retire",
        sub: row.l1RequestId ? `request #${row.l1RequestId}` : null,
      };
    case "retired":
      return { tone: "success", label: "Arrived", sub: null };
    case "rejected":
      return {
        tone: "error",
        label: "Rejected · return pending",
        sub: row.l1RequestId ? `request #${row.l1RequestId} · rejected by the sBTC signers` : null,
      };
    case "returned":
      return {
        tone: "caution",
        label: "Returned as sBTC",
        sub: row.settleOrReclaimTxId
          ? `withdrawal rejected · returned ${shortTx(row.settleOrReclaimTxId)}`
          : "withdrawal rejected",
      };
  }
}

/** The hover detail behind a "Rolled forward" chip: what happened, and where the amount went. */
export function rollForwardExplanation(
  row: RewardLedgerPayment,
): { title: string; detail: string | null; footer: string | null } | null {
  const info = row.rollForward;
  if (!info) return null;
  const runRef = info.runId ? `run ${info.runId.slice(0, 8)}` : null;
  const when = info.recordedAt ? shortDate(info.recordedAt) : null;
  const title = (() => {
    switch (info.reason) {
      case "no-run":
        return "No First Distribution payment run before the Second calculation";
      case "not-in-recipe":
        return when ? `Outside the ${when} run's recipe` : "Outside the run's recipe";
      case "skipped-below-fee-budget":
        return `Skipped${when ? ` in the ${when} run` : ""} · L1 payout below its fee budget`;
      case "skipped":
        return `Skipped${when ? ` in the ${when} run` : ""}`;
      case "halted-at-this-payment":
        return `The${when ? ` ${when}` : ""} run halted at this payment`;
      case "not-attempted-run-halted":
        return `Not attempted — the${when ? ` ${when}` : ""} run halted earlier`;
      case "not-attempted-run-cancelled":
        return `Not attempted — the${when ? ` ${when}` : ""} run was cancelled`;
      case "not-attempted-run-expired":
        return `Not attempted — the${when ? ` ${when}` : ""} run expired`;
      case "not-attempted-run-open":
        return "Not attempted — the run is still open";
      case "broadcast-unresolved":
        return "Broadcast but never confirmed";
      case "paid-after-second-calculation":
        return "Paid after the Second calculation";
    }
  })();
  const footer = [
    info.paidWith
      ? `Paid with the Second Distribution${row.paidAt ? ` · ${shortDate(row.paidAt)}` : ""} · ${shortTx(info.paidWith.txId)}`
      : "Still waiting on the Second Distribution payment",
    runRef,
  ]
    .filter(Boolean)
    .join(" · ");
  return { title, detail: info.detail, footer };
}

/** Sort keys compare integer sats, never rendered strings (plan acceptance #5). */
export type PaymentSortKey = "staker" | "gross" | "fee" | "toStaker" | "status";

export function comparePayments(
  left: RewardLedgerPayment,
  right: RewardLedgerPayment,
  key: PaymentSortKey,
  direction: "asc" | "desc",
): number {
  const sign = direction === "asc" ? 1 : -1;
  const sats = (value: string | null) => (value === null ? -1n : big(value));
  const compare = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
  let result = 0;
  switch (key) {
    case "staker":
      result = left.stakerPrincipal.localeCompare(right.stakerPrincipal);
      break;
    case "gross":
      result = compare(sats(left.grossRewardSats), sats(right.grossRewardSats));
      break;
    case "fee":
      result = compare(sats(left.operatorFeeSats), sats(right.operatorFeeSats));
      break;
    case "toStaker":
      result = compare(
        sats(left.payoutSats ?? left.stakerEntitlementSats),
        sats(right.payoutSats ?? right.stakerEntitlementSats),
      );
      break;
    case "status":
      result = paymentTab(left).localeCompare(paymentTab(right));
      break;
  }
  return result * sign || left.stakerPrincipal.localeCompare(right.stakerPrincipal);
}
