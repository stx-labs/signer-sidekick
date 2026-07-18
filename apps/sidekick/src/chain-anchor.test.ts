import { describe, expect, it } from "vitest";
import {
  type ChainAnchor,
  deriveRewardCalculationTarget,
  parseChainAnchor,
} from "./chain-anchor.js";

const anchor: ChainAnchor = parseChainAnchor({
  stacksBlockHeight: 9_000,
  indexBlockHash: `0x${"ab".repeat(32)}`,
  burnBlockHeight: 4_100,
  rewardCycle: 5,
  rewardCycleLength: 100,
  prepareCycleLength: 10,
  cyclePosition: 50,
  phase: "reward",
  checkpoint: "second-half",
});

describe("PoX-5 reward calculation targets", () => {
  it("maps a second-half anchor to the first calculation for the anchor cycle", () => {
    expect(deriveRewardCalculationTarget(anchor)).toEqual({
      status: "ready",
      rewardCycle: 5,
      calculationCheckpoint: "first-half",
      expectedLastRewardComputeBurnHeight: 4_099,
    });
  });

  it("maps the following first-half anchor to the second calculation for the prior cycle", () => {
    expect(
      deriveRewardCalculationTarget({
        ...anchor,
        burnBlockHeight: 4_160,
        rewardCycle: 6,
        cyclePosition: 10,
        checkpoint: "first-half",
      }),
    ).toEqual({
      status: "ready",
      rewardCycle: 5,
      calculationCheckpoint: "second-half",
      expectedLastRewardComputeBurnHeight: 4_149,
    });
  });

  it("rejects odd cycle lengths and a first-half cycle-zero anchor", () => {
    expect(
      deriveRewardCalculationTarget({
        ...anchor,
        rewardCycleLength: 99,
        cyclePosition: 50,
      }),
    ).toEqual({ status: "invalid", reason: "odd-reward-cycle-length" });
    expect(
      deriveRewardCalculationTarget({
        ...anchor,
        burnBlockHeight: 10,
        rewardCycle: 0,
        cyclePosition: 10,
        checkpoint: "first-half",
      }),
    ).toEqual({ status: "invalid", reason: "no-previous-reward-cycle" });
  });
});
