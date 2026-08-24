import { describe, expect, it } from "vitest";
import { carryForwardRewards } from "./reward-last-good.js";
import type { StxRewardStatus } from "./reward-status.js";

function status(stakers: number, label: string): StxRewardStatus {
  return {
    label,
    stakers: Array.from({ length: stakers }, (_, index) => ({ principal: `SP${index}` })),
  } as unknown as StxRewardStatus;
}

describe("carryForwardRewards", () => {
  const lastGood = { rewards: status(3, "good"), rewardsPrevious: status(2, "good-previous") };

  it("publishes the fresh read untouched while the indexed API is available", () => {
    const fresh = { rewards: status(0, "fresh"), rewardsPrevious: null };
    expect(carryForwardRewards({ indexedApiAvailable: true, ...fresh, lastGood })).toEqual(fresh);
  });

  it("keeps the last staker-bearing status when an outage empties the fresh read", () => {
    expect(
      carryForwardRewards({
        indexedApiAvailable: false,
        rewards: status(0, "fresh"),
        rewardsPrevious: null,
        lastGood,
      }),
    ).toEqual(lastGood);
    expect(
      carryForwardRewards({
        indexedApiAvailable: false,
        rewards: null,
        rewardsPrevious: null,
        lastGood,
      }),
    ).toEqual(lastGood);
  });

  it("prefers a fresh read that still carries stakers during an outage", () => {
    const fresh = { rewards: status(4, "fresh"), rewardsPrevious: status(1, "fresh-previous") };
    expect(carryForwardRewards({ indexedApiAvailable: false, ...fresh, lastGood })).toEqual(fresh);
  });

  it("has nothing to carry before the first good read", () => {
    const fresh = { rewards: status(0, "fresh"), rewardsPrevious: null };
    expect(carryForwardRewards({ indexedApiAvailable: false, ...fresh, lastGood: null })).toEqual(
      fresh,
    );
    const emptyLastGood = { rewards: status(0, "empty"), rewardsPrevious: null };
    expect(
      carryForwardRewards({ indexedApiAvailable: false, ...fresh, lastGood: emptyLastGood }),
    ).toEqual(fresh);
  });
});
