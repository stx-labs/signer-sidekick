import type { RewardRunOperation } from "./reward-runs.js";
import type { RewardLedger, RewardLedgerDistribution } from "./v1.js";

export function pendingRewardDistributions(ledger: RewardLedger) {
  return ledger.cycles
    .flatMap((cycle) => cycle.distributions.map((distribution) => ({ cycle, distribution })))
    .filter(
      ({ distribution: d }) =>
        [
          "interpretation-unavailable",
          "needs-attention",
          "calculation-overdue",
          "ready",
          "distributing",
        ].includes(d.status) ||
        (d.status === "all-distributed" && d.payments.arriving > 0),
    )
    .sort(
      (a, b) =>
        a.cycle.cycle - b.cycle.cycle || a.distribution.distribution - b.distribution.distribution,
    );
}

export const rewardRunKinds = [
  "collect-and-distribute",
  "distribute",
  "collect",
  "calculate",
  "finish-bitcoin-payouts",
] as const;
export type RewardRunKind = (typeof rewardRunKinds)[number];

export function operationsForKind(kind: RewardRunKind): RewardRunOperation[] {
  switch (kind) {
    case "collect-and-distribute":
      return ["claim-rewards", "claim-staker-rewards"];
    case "distribute":
      return ["claim-staker-rewards"];
    case "collect":
      return ["claim-rewards"];
    case "calculate":
      return ["calculate-rewards"];
    case "finish-bitcoin-payouts":
      return ["settle-accepted-withdrawal", "reclaim-failed-withdrawal"];
  }
}

export interface RewardAction {
  kind: RewardRunKind;
  label: string;
  operations: RewardRunOperation[];
  transactions: number;
  cycle: number;
  distribution: 1 | 2;
}

/** The button and the schedule choose the same actions. The engine still proves eligibility. */
export function rewardDistributionActions(
  cycle: number,
  distribution: RewardLedgerDistribution,
  running = false,
): { primary: RewardAction | null; finish: RewardAction | null } {
  const p = distribution.payments;
  const action = (kind: RewardRunKind, label: string, transactions: number): RewardAction => ({
    kind,
    label,
    transactions,
    operations: operationsForKind(kind),
    cycle,
    distribution: distribution.distribution,
  });
  if (distribution.status === "interpretation-unavailable") return { primary: null, finish: null };
  if (distribution.status === "calculation-overdue") {
    return { primary: action("calculate", "Run calculation", 1), finish: null };
  }
  const finish =
    p.rejected > 0 || p.arrived > 0
      ? action("finish-bitcoin-payouts", "Finish Bitcoin payouts", p.rejected + p.arrived)
      : null;
  if (p.rejected > 0) return { primary: finish, finish: null };
  let primary: RewardAction | null = null;
  if (distribution.calculation.state === "done") {
    const available = BigInt(distribution.availableToCollectSats ?? "0");
    if (available > 0n && p.outstanding > 0) {
      primary = action("collect-and-distribute", "Collect & distribute", 1 + p.outstanding);
    } else if (available > 0n) {
      primary = action("collect", "Collect", 1);
    } else if (p.outstanding > 0 && !running) {
      primary = action(
        "distribute",
        `Distribute ${p.outstanding.toLocaleString("en-US")} ${p.outstanding === 1 ? "payment" : "payments"}`,
        p.outstanding,
      );
    }
  }
  return { primary, finish };
}
