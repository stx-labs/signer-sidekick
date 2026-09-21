import type {
  RewardLedger,
  RewardLedgerDistribution,
} from "@stx-labs/signer-sidekick-api-contracts";
import { describe, expect, it } from "vitest";
import { selectScheduledRewardAction } from "./reward-schedule-selection.js";

function ledger(overrides: Partial<RewardLedgerDistribution> = {}): RewardLedger {
  return {
    cycles: [
      {
        cycle: 143,
        distributions: [
          {
            distribution: 1,
            status: "ready",
            calculation: { state: "done" },
            availableToCollectSats: "10000",
            payments: { outstanding: 0, arrived: 0, rejected: 0, arriving: 0 },
            ...overrides,
          },
        ],
      },
    ],
    pagination: { nextBeforeCycle: 120 },
  } as unknown as RewardLedger;
}

describe("schedule shares the Rewards button selection", () => {
  it("collects before accounts are available, then chooses payouts with normal chunking", () => {
    expect(selectScheduledRewardAction(ledger()).request?.operations).toEqual(["claim-rewards"]);
    const current = ledger({ availableToCollectSats: "0" });
    firstDistribution(current).payments.outstanding = 201;
    expect(selectScheduledRewardAction(current).request).toEqual({
      cycle: 143,
      distribution: 1,
      operations: ["claim-staker-rewards"],
    });
  });
  it("only selects a calculation after existing readiness declares it overdue", () => {
    expect(selectScheduledRewardAction(ledger({ status: "accruing" })).request).toBeNull();
    expect(
      selectScheduledRewardAction(ledger({ status: "calculation-overdue" })).request?.operations,
    ).toEqual(["calculate-rewards"]);
  });
  it("checks later Bitcoin acceptance/rejection and never treats completed history as new work", () => {
    const current = ledger({ status: "all-distributed", availableToCollectSats: "0" });
    const distribution = firstDistribution(current);
    distribution.payments.arriving = 1;
    expect(selectScheduledRewardAction(current).request).toBeNull();
    distribution.payments.arrived = 1;
    expect(selectScheduledRewardAction(current).request?.operations).toEqual([
      "settle-accepted-withdrawal",
      "reclaim-failed-withdrawal",
    ]);
    distribution.status = "complete";
    expect(selectScheduledRewardAction(current).request).toBeNull();
  });
  it("keeps missing interpretation out of the queue and advances a bounded historical cursor", () => {
    expect(selectScheduledRewardAction(ledger({ status: "interpretation-unavailable" }))).toEqual({
      request: null,
      beforeCycle: 120,
    });
  });
  it("prefers older actionable distributions across a cycle rollover", () => {
    const current = ledger();
    const cycle = current.cycles[0];
    if (!cycle) throw new Error("Missing fixture cycle");
    current.cycles.unshift({ ...cycle, cycle: 144 });
    expect(selectScheduledRewardAction(current).request?.cycle).toBe(143);
  });
});

function firstDistribution(current: RewardLedger): RewardLedgerDistribution {
  const distribution = current.cycles[0]?.distributions[0];
  if (!distribution) throw new Error("Missing fixture distribution");
  return distribution;
}
