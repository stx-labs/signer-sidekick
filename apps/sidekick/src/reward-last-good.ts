import type { StxRewardStatus } from "./reward-status.js";

export interface LastGoodRewards {
  rewards: StxRewardStatus | null;
  rewardsPrevious: StxRewardStatus | null;
}

/**
 * Last known good reward status. An indexed-API outage can leave a fresh reward read without its
 * staker set (no provable roster anchor), which would otherwise publish an empty Rewards page.
 * While the indexed API is out, re-publish the last status that carried stakers; the status bar
 * already tells the operator the indexed data is delayed. With the API available, the fresh read
 * is always published as-is.
 */
export function carryForwardRewards(options: {
  indexedApiAvailable: boolean;
  rewards: StxRewardStatus | null;
  rewardsPrevious: StxRewardStatus | null;
  lastGood: LastGoodRewards | null;
}): LastGoodRewards {
  const { rewards, rewardsPrevious, lastGood } = options;
  if (options.indexedApiAvailable || !lastGood) return { rewards, rewardsPrevious };
  const carried = (rewards?.stakers.length ?? 0) === 0 ? lastGood.rewards : null;
  return {
    rewards: carried && carried.stakers.length > 0 ? carried : rewards,
    rewardsPrevious: rewardsPrevious ?? lastGood.rewardsPrevious,
  };
}
