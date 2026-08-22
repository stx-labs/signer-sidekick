import type {
  DashboardSnapshot,
  GasWalletStatus,
  RewardLedger,
  RewardLedgerCycle,
  RewardLedgerDistribution,
  RewardLedgerPayment,
} from "@stx-labs/signer-sidekick-api-contracts";
import {
  amount,
  amountParts,
  exactSats,
  feePercent,
  shortUtc,
  stxAmount,
} from "../../shared/format.js";
import type { RewardRun, RewardRunKind } from "./run-api.js";

/**
 * Pure derivation of the Rewards "Now" card (plan §6) from the ledger, the projection outlook,
 * the gas wallet, and an active run. Keeping it data-only makes every status line testable
 * without rendering, and lets the Overview card reuse the same words.
 */

export type Tone = "success" | "caution" | "error" | "info" | "neutral" | "accent";

export interface RewardTile {
  label: string;
  value: string;
  unit: string | null;
  detail: string;
  tooltip: string | null;
  hero?: boolean;
}

export interface RewardPrimaryAction {
  kind: RewardRunKind;
  label: string;
  /** Transactions this action is expected to take, for the gas check and the confirm sheet. */
  transactions: number;
  /** Distribution the action targets when it is not the current one (e.g. the prior distribution). */
  distribution: 1 | 2 | null;
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

export interface RewardNowModel {
  cycle: number | null;
  distribution: 1 | 2 | null;
  eyebrow: string;
  badge: { tone: Tone; label: string; live?: boolean };
  headline: string;
  sub: string;
  subTooltip: string | null;
  primary: RewardPrimaryAction | null;
  secondary: { kind: RewardRunKind; label: string; tooltip: string | null } | null;
  tiles: RewardTile[];
  cycleLine: { cycle: number; amount: string; text: string } | null;
  previous:
    | { kind: "cycle-complete"; cycle: number; text: string }
    | {
        kind: "prior-outstanding";
        distribution: 1 | 2;
        count: number;
        amountSats: string;
        text: string;
      }
    | null;
  attention: { title: string; text: string } | null;
  progress: { done: number; total: number; text: string; right: string } | null;
  execution: RewardExecutionAvailability;
  coverage: RewardLedgerDistribution["coverage"] | null;
}

export function distributionName(distribution: 1 | 2 | null): string {
  return distribution === 1
    ? "First Distribution"
    : distribution === 2
      ? "Second Distribution"
      : "Distribution";
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

export interface RewardStateInput {
  ledger: RewardLedger;
  /** Payments of the selected distribution, when loaded (route counts, arrived/rejected detail). */
  payments?: readonly RewardLedgerPayment[];
  snapshot: Pick<DashboardSnapshot, "rewardOutlook" | "rewards"> | null;
  gasWallet: GasWalletStatus | null;
  engineMode: "observe" | "operator-run" | null;
  activeRun: RewardRun | null;
  /** Expected wall-clock for the next calculation ("about 2 days"), when known. */
  nextCalculationIn?: string | null;
  now?: Date;
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

function execution(
  gasWallet: GasWalletStatus | null,
  engineMode: RewardStateInput["engineMode"],
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

function feeLabel(distribution: RewardLedgerDistribution, cycle: RewardLedgerCycle | null): string {
  const bips = distribution.feeBips ?? cycle?.feeBips ?? null;
  if (bips === null) return "fee locks at the first collect";
  return distribution.feeEvidence === "locked" || cycle?.feeEvidence === "locked"
    ? `fee locked ${feePercent(bips)}`
    : `${feePercent(bips)} locks at the first collect`;
}

function routeSummary(payments: readonly RewardLedgerPayment[] | undefined): string | null {
  if (!payments || payments.length === 0) return null;
  const paid = payments.filter((p) => p.paymentTxId !== null);
  if (paid.length === 0) return null;
  const bitcoin = paid.filter((p) => p.route === "bitcoin").length;
  const sbtc = paid.length - bitcoin;
  return bitcoin === 0 ? null : `${sbtc} in sBTC, ${bitcoin} over Bitcoin`;
}

export function deriveRewardNow(input: RewardStateInput): RewardNowModel | null {
  const { ledger, snapshot, gasWallet, engineMode, activeRun } = input;
  const cycle = currentCycle(ledger);
  const distribution = currentDistribution(ledger);
  if (!cycle || !distribution) return null;
  const outlook = snapshot?.rewardOutlook ?? null;
  const forecast = outlook?.forecast ?? null;
  const poolEstimate = outlook?.poolEstimate ?? null;
  const operatorFeeForecast = outlook?.operatorFeeForecast ?? null;
  const operatorFeeEstimate = outlook?.operatorFeeEstimate ?? null;
  const p = distribution.payments;
  const total = paymentTotal(distribution);
  const calculated = distribution.calculation.state === "done";
  const poolSats = distribution.calculation.poolSats;
  const available = big(distribution.availableToCollectSats);
  const outstandingSats = big(p.outstandingSats);
  const payments = input.payments ?? [];
  const arrived = payments.filter((row) => row.status === "arrived").length;
  const rejected = p.rejected;
  const eyebrow = `Cycle ${cycle.cycle} · ${distributionName(distribution.distribution)}`;
  const sibling =
    cycle.distributions.find((d) => d.distribution !== distribution.distribution) ?? null;
  const priorOutstanding =
    distribution.distribution === 2 && sibling && sibling.payments.outstanding > 0 ? sibling : null;
  const previousCycle =
    distribution.distribution === 1
      ? (ledger.cycles.find((c) => c.cycle === cycle.cycle - 1) ?? null)
      : null;

  // ---- primary action ----
  let primary: RewardPrimaryAction | null = null;
  let secondary: RewardNowModel["secondary"] = null;
  if (distribution.status === "calculation-overdue") {
    primary = { kind: "calculate", label: "Run calculation", transactions: 1, distribution: null };
  } else if (rejected > 0 || arrived > 0) {
    const action = {
      kind: "finish-bitcoin-payouts" as const,
      label: "Finish Bitcoin payouts",
      transactions: rejected + arrived,
      distribution: null,
    };
    if (rejected > 0) primary = action;
    else
      secondary = {
        ...action,
        tooltip: `Retire ${plural(arrived, "settled payout")} — nothing moves. A rejected payout would return sBTC to the staker.`,
      };
  }
  if (primary === null && calculated) {
    if (available > 0n && p.outstanding > 0) {
      primary = {
        kind: "collect-and-distribute",
        label: "Collect & distribute",
        transactions: 1 + p.outstanding,
        distribution: null,
      };
    } else if (available > 0n) {
      primary = { kind: "collect", label: "Collect", transactions: 1, distribution: null };
    } else if (p.outstanding > 0 && !activeRun) {
      primary = {
        kind: "distribute",
        label: `Distribute ${plural(p.outstanding, "payment")}`,
        transactions: p.outstanding,
        distribution: null,
      };
    }
  }
  if (primary === null && priorOutstanding && !activeRun) {
    secondary = {
      kind: "distribute",
      label: `Distribute ${plural(priorOutstanding.payments.outstanding, "payment")}`,
      tooltip: `${distributionName(priorOutstanding.distribution)} · ${amount(priorOutstanding.payments.outstandingSats)} outstanding`,
    };
  }
  const neededTransactions = primary?.transactions ?? (secondary ? 1 : 0);
  const executionState = execution(gasWallet, engineMode, Math.max(neededTransactions, 1));

  // ---- headline / badge / sub ----
  const running =
    activeRun !== null &&
    ["running", "approved", "started", "distributing", "collecting", "calculating"].includes(
      activeRun.state,
    );
  let badge: RewardNowModel["badge"];
  let headline: string;
  let sub: string;
  let attention: RewardNowModel["attention"] = null;
  let progress: RewardNowModel["progress"] = null;
  const yourFee = calculated
    ? text(
        big(p.operatorFeeSats) +
          (poolSats
            ? big(poolSats) - big(p.distributedSats) - big(p.operatorFeeSats) - outstandingSats
            : 0n),
      )
    : null;
  if (running && activeRun) {
    const done = activeRun.transactionsDone ?? 0;
    const all = activeRun.transactions ?? total;
    badge = { tone: "accent", label: "In progress", live: true };
    headline = `Distributing… ${done} of ${all} payments`;
    sub =
      "Sidekick is submitting one transaction at a time; the manager sends each payout and the gas wallet pays the network fees. You can close this page.";
    progress = {
      done,
      total: Math.max(all, 1),
      text: `${done} of ${all} payments${activeRun.distributedSats ? ` · ${amount(activeRun.distributedSats)} sent` : ""}`,
      right: activeRun.gasUsedUstx ? `${stxAmount(activeRun.gasUsedUstx)} gas used` : "",
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
    const overdue = distribution.status === "calculation-overdue";
    badge = overdue
      ? { tone: "caution", label: "Calculation overdue" }
      : { tone: "neutral", label: "Accruing" };
    const quiet =
      previousCycle !== null &&
      previousCycle.coverage !== "historical-coverage-incomplete" &&
      previousCycle.outstandingSats === "0";
    headline = overdue
      ? "Calculation is overdue — you can run it"
      : quiet
        ? "Nothing to do — accruing for the next distribution"
        : "Accruing — waiting on the network calculation";
    const expected = input.nextCalculationIn
      ? ` Expected in about ${input.nextCalculationIn}.`
      : "";
    sub = overdue
      ? "The network calculation for this distribution has not happened yet. Anyone can run it; Sidekick can do it from here."
      : `${quiet ? `Cycle ${previousCycle?.cycle} is fully distributed. ` : "Usually automatic."}${expected} Nothing to do yet.`;
  } else if (p.outstanding === 0 && available === 0n) {
    const arriving = p.arriving;
    badge = { tone: "success", label: arriving > 0 ? "All distributed" : "Complete" };
    headline =
      arriving > 0
        ? `All distributed · ${plural(arriving, "payout")} arriving over Bitcoin`
        : arrived > 0
          ? `All distributed · ${plural(arrived, "payout")} arrived`
          : "All distributed";
    sub =
      arriving > 0
        ? "Every payment for this distribution went out. Bitcoin payouts are still on their way; Sidekick will show when they arrive."
        : "Every payment for this distribution went out.";
  } else if (p.made > 0 && p.outstanding > 0) {
    badge = { tone: "info", label: "Distributing" };
    headline = `Distributing · ${p.made} of ${total} paid`;
    sub = `${amount(p.outstandingSats)} is still waiting for ${plural(p.outstanding, "staker")}.${available > 0n ? ` ${amount(text(available))} is still waiting to be collected.` : ""}`;
  } else {
    badge = { tone: "success", label: "Ready", live: false };
    headline =
      available > 0n && p.outstanding > 0
        ? "Ready to collect & distribute"
        : available > 0n
          ? "Ready to collect"
          : "Ready to distribute";
    const fee = yourFee && big(yourFee) > 0n ? ` and ${amount(yourFee)} is yours` : "";
    sub = `The network calculated this distribution. ${amount(text(outstandingSats + available - big(yourFee ?? "0")))} is waiting for your stakers across ${plural(total, "payment")}${fee}.`;
  }

  // ---- tiles ----
  const tiles: RewardTile[] = [];
  if (calculated) {
    const parts = amountParts(poolSats);
    tiles.push({
      label: "Calculated for this pool",
      value: parts?.value ?? "—",
      unit: parts?.unit ?? null,
      detail: "exact · from the network calculation",
      tooltip: poolSats
        ? `Exact, from the network calculation · ${exactSats(poolSats)}`
        : distribution.calculation.poolSatsUnavailableReason,
    });
  } else {
    const point = forecast?.poolSats.point ?? poolEstimate?.grossSats ?? null;
    const parts = amountParts(point);
    tiles.push({
      label: "Projected for this distribution",
      value: parts?.value ?? "—",
      unit: parts?.unit ?? null,
      detail: forecast
        ? `earned so far ${amount(poolEstimate?.grossSats ?? null)} · ${forecast.confidence} confidence`
        : poolEstimate
          ? "if the network calculated now"
          : "projection unavailable",
      tooltip: forecast
        ? `${forecast.confidence} confidence · ${forecast.sample.observations} observations across ${forecast.sample.sampleBlocks} Bitcoin blocks · range ${amount(forecast.poolSats.low)} – ${amount(forecast.poolSats.high)}`
        : null,
      hero: true,
    });
  }
  const collectedParts = amountParts(distribution.collectedSats);
  tiles.push({
    label: "Collected",
    value: calculated ? (collectedParts?.value ?? "0") : "—",
    unit: calculated ? (collectedParts?.unit ?? "sBTC") : null,
    detail: calculated
      ? available > 0n
        ? `${amount(text(available))} ready to collect · ${feeLabel(distribution, cycle)}`
        : feeLabel(distribution, cycle)
      : `after the calculation · ${feeLabel(distribution, cycle)}`,
    tooltip: distribution.collects.length > 0 ? distributionTooltip(distribution) : null,
  });
  const routes = routeSummary(payments);
  tiles.push({
    label: "Distributed",
    value: calculated ? String(p.made) : "—",
    unit: calculated ? `of ${total}` : null,
    detail: calculated
      ? p.outstanding > 0
        ? `${amount(p.outstandingSats)} waiting for stakers`
        : `${amount(p.distributedSats)}${routes ? ` · ${routes}` : ""}${p.rolledForward > 0 ? ` · ${p.rolledForward} rolled forward` : ""}`
      : `${plural(total || (snapshot?.rewards?.totals.stakers ?? 0), "payment")} expected`,
    tooltip: null,
  });
  const feeSats = calculated
    ? yourFee
    : (operatorFeeForecast?.sats.point ?? operatorFeeEstimate?.sats ?? null);
  const feeParts = amountParts(feeSats);
  tiles.push({
    label: "Your fee",
    value: feeParts?.value ?? "—",
    unit: feeParts?.unit ?? null,
    detail: calculated
      ? `${feeLabel(distribution, cycle)} · ${p.made === total && total > 0 ? "paid" : "paid as you distribute"}`
      : `projected · ${feeLabel(distribution, cycle)}`,
    tooltip: feeSats ? exactSats(feeSats) : null,
  });

  // ---- cycle line ----
  const cycleCalculated = cycle.distributions.reduce(
    (sum, d) => sum + big(d.calculation.poolSats),
    0n,
  );
  const projectedMissing = cycle.distributions.some((d) => d.calculation.state !== "done")
    ? big(forecast?.poolSats.point ?? poolEstimate?.grossSats ?? null)
    : 0n;
  const cycleAmount = cycleCalculated + projectedMissing;
  // Fee across the cycle: what each calculated distribution will credit you (pool minus what goes
  // to stakers), plus the projection for a distribution that is not calculated yet.
  const cycleFee = cycle.distributions.reduce((sum, d) => {
    if (d.calculation.state === "done" && d.calculation.poolSats) {
      const expected =
        big(d.calculation.poolSats) -
        big(d.payments.distributedSats) -
        big(d.payments.outstandingSats);
      return sum + (expected > 0n ? expected : big(d.payments.operatorFeeSats));
    }
    return sum + (d.distribution === distribution.distribution ? big(feeSats) : 0n);
  }, 0n);
  const siblingState =
    sibling === null
      ? null
      : sibling.status === "complete" || sibling.status === "all-distributed"
        ? `${distributionName(sibling.distribution)} complete`
        : sibling.calculation.state !== "done"
          ? `${distributionName(sibling.distribution)} not calculated yet`
          : `${distributionName(sibling.distribution)} ${sibling.payments.outstanding > 0 ? `has ${plural(sibling.payments.outstanding, "payment")} outstanding` : "in progress"}`;
  const cycleLine =
    cycleAmount > 0n
      ? {
          cycle: cycle.cycle,
          amount: amount(text(cycleAmount)),
          text: `${projectedMissing > 0n ? "projected for this pool across both distributions" : "calculated for this pool across both distributions"} · your fee ${amount(text(cycleFee))}${siblingState ? ` · ${siblingState}` : ""}`,
        }
      : null;

  // ---- previous ----
  let previous: RewardNowModel["previous"] = null;
  if (priorOutstanding) {
    previous = {
      kind: "prior-outstanding",
      distribution: priorOutstanding.distribution,
      count: priorOutstanding.payments.outstanding,
      amountSats: priorOutstanding.payments.outstandingSats,
      text: `${distributionName(priorOutstanding.distribution)} still has ${plural(priorOutstanding.payments.outstanding, "payment")} outstanding · ${amount(priorOutstanding.payments.outstandingSats)}`,
    };
  } else if (previousCycle && !calculated) {
    const completeDistributions = previousCycle.distributions.filter(
      (d) => d.status === "complete" || d.status === "all-distributed",
    ).length;
    previous = {
      kind: "cycle-complete",
      cycle: previousCycle.cycle,
      text: `Cycle ${previousCycle.cycle} ${completeDistributions === previousCycle.distributions.length ? "complete" : "in progress"} · ${amount(previousCycle.distributedSats)} to stakers · your fee ${amount(previousCycle.operatorFeeSats)} · ${completeDistributions} of ${previousCycle.distributions.length} distributions`,
    };
  }

  return {
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
    cycleLine,
    previous,
    attention,
    progress,
    execution: executionState,
    coverage: distribution.coverage,
  };
}

/** Payment status tabs for the selected distribution, with counts that sum to the table. */
export type PaymentTab = "outstanding" | "paid" | "arriving" | "rejected" | "all";

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
    case "paid":
      return {
        tone: "success",
        label: "Paid",
        sub: row.paymentTxId ? shortTx(row.paymentTxId) : null,
      };
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
      return {
        tone: "success",
        label: "Arrived",
        sub: row.l1RequestId ? `request #${row.l1RequestId} · retired` : null,
      };
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
  let result = 0;
  switch (key) {
    case "staker":
      result = left.stakerPrincipal.localeCompare(right.stakerPrincipal);
      break;
    case "gross":
      result =
        sats(left.grossRewardSats) < sats(right.grossRewardSats)
          ? -1
          : sats(left.grossRewardSats) > sats(right.grossRewardSats)
            ? 1
            : 0;
      break;
    case "fee":
      result =
        sats(left.operatorFeeSats) < sats(right.operatorFeeSats)
          ? -1
          : sats(left.operatorFeeSats) > sats(right.operatorFeeSats)
            ? 1
            : 0;
      break;
    case "toStaker":
      result =
        sats(left.payoutSats ?? left.stakerEntitlementSats) <
        sats(right.payoutSats ?? right.stakerEntitlementSats)
          ? -1
          : sats(left.payoutSats ?? left.stakerEntitlementSats) >
              sats(right.payoutSats ?? right.stakerEntitlementSats)
            ? 1
            : 0;
      break;
    case "status":
      result = paymentTab(left).localeCompare(paymentTab(right));
      break;
  }
  return result * sign || left.stakerPrincipal.localeCompare(right.stakerPrincipal);
}
