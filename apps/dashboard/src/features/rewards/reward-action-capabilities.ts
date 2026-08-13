import type { ManagerActionCapabilityId } from "@stx-labs/signer-sidekick-api-contracts";

export type RewardManagerAction =
  | "claim-rewards"
  | "update-fees"
  | "withdraw-fees"
  | "sweep-fee-refunds";

const capabilityByAction = {
  "claim-rewards": "reference-reward-claims",
  "update-fees": "update-fees",
  "withdraw-fees": "withdraw-fees",
  "sweep-fee-refunds": "sweep-fee-refunds",
} as const satisfies Record<RewardManagerAction, ManagerActionCapabilityId>;

export function rewardManagerCapabilityId(action: RewardManagerAction): ManagerActionCapabilityId {
  return capabilityByAction[action];
}
