import { listCV, stringAsciiCV, tupleCV, uintCV } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import { decodePox5CalculateRewardsEvent } from "../src/pox5-events.js";

function calculationEvent(topic = "calculate-rewards") {
  return tupleCV({
    topic: stringAsciiCV(topic),
    "bond-periods": listCV([uintCV(2), uintCV(9)]),
    "calculation-height": uintCV(960_240),
    "gross-accrued-rewards": uintCV(10_000),
    "total-bond-rewards": uintCV(2_000),
    "reserve-deposit": uintCV(800),
    "reserve-balance": uintCV(900),
    "stx-cycle": uintCV(141),
    "total-stx-staker-rewards": uintCV(7_200),
    "cycle-staked-ustx": uintCV(50_000_000_000),
    "accrued-rewards-per-ustx": uintCV(144),
    "cumulative-rewards-per-ustx": uintCV(200),
  });
}

describe("PoX-5 events", () => {
  it("decodes the complete calculate-rewards realization", () => {
    expect(decodePox5CalculateRewardsEvent(calculationEvent())).toEqual({
      kind: "calculate-rewards",
      topic: "calculate-rewards",
      bondPeriods: ["2", "9"],
      calculationBurnHeight: "960240",
      grossAccruedRewardsSats: "10000",
      totalBondRewardsSats: "2000",
      reserveDepositSats: "800",
      reserveBalanceSats: "900",
      rewardCycle: "141",
      totalStxStakerRewardsSats: "7200",
      cycleStakedUstx: "50000000000",
      accruedRewardsPerUstx: "144",
      cumulativeRewardsPerUstx: "200",
    });
  });

  it("ignores other PoX-5 print topics and rejects incomplete calculation events", () => {
    expect(decodePox5CalculateRewardsEvent(calculationEvent("delegate-stx"))).toBeNull();
    expect(() =>
      decodePox5CalculateRewardsEvent(
        tupleCV({ topic: stringAsciiCV("calculate-rewards"), "bond-periods": listCV([]) }),
      ),
    ).toThrow(/missing tuple field calculation-height/);
  });
});
