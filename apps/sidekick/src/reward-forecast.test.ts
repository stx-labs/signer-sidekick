import { describe, expect, it } from "vitest";
import { projectGlobalRewardRunRate, type RewardForecastObservation } from "./reward-forecast.js";

const target = {
  rewardCycle: 141,
  checkpoint: "first-half" as const,
  calculationBurnHeight: 1_100,
};

function sample(
  observedBurnBlockHeight: number,
  globalAccruedRewardsSats: string,
  overrides: Partial<RewardForecastObservation> = {},
): RewardForecastObservation {
  return {
    observedBurnBlockHeight,
    observedAt: new Date(
      `2026-08-14T${String(observedBurnBlockHeight % 24).padStart(2, "0")}:00:00.000Z`,
    ).toISOString(),
    globalAccruedRewardsSats,
    lastRewardComputeBurnHeight: "1000",
    nextCalculation: {
      targetRewardCycle: target.rewardCycle,
      targetCheckpoint: target.checkpoint,
      calculationBurnHeight: target.calculationBurnHeight,
    },
    ...overrides,
  };
}

describe("reward run-rate forecast", () => {
  it("uses the cumulative rate for its point and observed interval rates for a bounded range", () => {
    const current = sample(1_030, "3000");
    const result = projectGlobalRewardRunRate({
      observations: [sample(1_010, "800"), sample(1_020, "2200")],
      current,
      target,
    });

    expect(result).toEqual({
      status: "available",
      forecast: {
        kind: "checkpoint-run-rate",
        targetRewardCycle: 141,
        targetCheckpoint: "first-half",
        calculationBurnHeight: 1_100,
        globalSats: {
          // Rates are 80, 140, and 80 sats/block; cumulative is 100 sats/block.
          low: "8600",
          point: "10000",
          high: "12800",
        },
        sample: {
          observations: 3,
          firstObservedBurnHeight: 1_010,
          lastObservedBurnHeight: 1_030,
          sampleBlocks: 20,
          elapsedBlocks: 30,
          remainingBlocks: 70,
        },
        confidence: "low",
        assumptions: ["zero-accrual-after-last-calculation", "linear-global-accrual-run-rate"],
      },
    });
  });

  it("requires three distinct samples spanning at least six burn blocks", () => {
    const current = sample(1_006, "600");
    expect(
      projectGlobalRewardRunRate({
        observations: [sample(1_001, "100")],
        current,
        target,
      }),
    ).toEqual({ status: "unavailable", reason: "insufficient-samples" });
    expect(
      projectGlobalRewardRunRate({
        observations: [sample(1_002, "200"), sample(1_004, "400")],
        current,
        target,
      }),
    ).toEqual({ status: "unavailable", reason: "insufficient-samples" });
  });

  it("uses only observed deltas and waits for 24 blocks before the first PoX-5 calculation", () => {
    const firstCalculation = (height: number, sats: string) =>
      sample(height, sats, { lastRewardComputeBurnHeight: "0" });
    expect(
      projectGlobalRewardRunRate({
        observations: [firstCalculation(1_010, "50000000"), firstCalculation(1_020, "51000000")],
        current: firstCalculation(1_030, "52000000"),
        target,
      }),
    ).toEqual({ status: "unavailable", reason: "insufficient-samples" });

    const result = projectGlobalRewardRunRate({
      observations: [firstCalculation(1_006, "50000000"), firstCalculation(1_018, "51200000")],
      current: firstCalculation(1_030, "52400000"),
      target,
    });
    expect(result).toMatchObject({
      status: "available",
      forecast: {
        globalSats: { point: "59400000" },
        sample: { sampleBlocks: 24, elapsedBlocks: 24, remainingBlocks: 70 },
        assumptions: ["observed-accrual-sample-window", "linear-global-accrual-run-rate"],
      },
    });
  });

  it("refuses to forecast a cumulative balance that decreases inside one calculation interval", () => {
    const current = sample(1_030, "2000");
    expect(
      projectGlobalRewardRunRate({
        observations: [sample(1_010, "1000"), sample(1_020, "3000")],
        current,
        target,
      }),
    ).toEqual({ status: "unavailable", reason: "non-monotonic-accrual" });
  });

  it("collapses the range to the exact current accrual at the calculation checkpoint", () => {
    const checkpointTarget = { ...target, calculationBurnHeight: 1_030 };
    const current = sample(1_030, "3000", {
      nextCalculation: {
        targetRewardCycle: 141,
        targetCheckpoint: "first-half",
        calculationBurnHeight: 1_030,
      },
    });
    const result = projectGlobalRewardRunRate({
      observations: [
        sample(1_010, "800", { nextCalculation: current.nextCalculation }),
        sample(1_020, "2200", { nextCalculation: current.nextCalculation }),
      ],
      current,
      target: checkpointTarget,
    });

    expect(result).toMatchObject({
      status: "available",
      forecast: {
        globalSats: { low: "3000", point: "3000", high: "3000" },
        sample: { remainingBlocks: 0 },
      },
    });
  });
});
