import {
  pendingRewardDistributions,
  type RewardLedger,
  rewardDistributionActions,
} from "@stx-labs/signer-sidekick-api-contracts";

/** One bounded ledger page per idle pass; the cursor eventually revisits older outstanding work. */
export function selectScheduledRewardAction(ledger: RewardLedger) {
  for (const { cycle, distribution } of pendingRewardDistributions(ledger)) {
    const actions = rewardDistributionActions(cycle.cycle, distribution);
    const action = actions.primary ?? actions.finish;
    if (action)
      return {
        request: {
          cycle: action.cycle,
          distribution: action.distribution,
          operations: action.operations,
        },
        beforeCycle: null,
      };
  }
  return { request: null, beforeCycle: ledger.pagination?.nextBeforeCycle ?? null };
}
