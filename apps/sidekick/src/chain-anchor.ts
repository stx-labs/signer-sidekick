import { z } from "zod";

export const chainAnchorSchema = z
  .object({
    stacksBlockHeight: z.number().int().nonnegative(),
    indexBlockHash: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/i)
      .transform((value) => value.toLowerCase()),
    burnBlockHeight: z.number().int().nonnegative(),
    rewardCycle: z.number().int().nonnegative(),
    rewardCycleLength: z.number().int().positive(),
    prepareCycleLength: z.number().int().nonnegative(),
    cyclePosition: z.number().int().nonnegative(),
    phase: z.enum(["reward", "prepare"]),
    checkpoint: z.enum(["first-half", "second-half"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.prepareCycleLength > value.rewardCycleLength) {
      context.addIssue({
        code: "custom",
        message: "prepareCycleLength cannot exceed rewardCycleLength",
        path: ["prepareCycleLength"],
      });
    }
    if (value.cyclePosition >= value.rewardCycleLength) {
      context.addIssue({
        code: "custom",
        message: "cyclePosition must be within rewardCycleLength",
        path: ["cyclePosition"],
      });
    }
    const expectedPhase =
      value.cyclePosition >= value.rewardCycleLength - value.prepareCycleLength
        ? "prepare"
        : "reward";
    if (value.phase !== expectedPhase) {
      context.addIssue({
        code: "custom",
        message: `phase must be ${expectedPhase} at this cycle position`,
        path: ["phase"],
      });
    }
    const expectedCheckpoint =
      value.cyclePosition < Math.floor(value.rewardCycleLength / 2) ? "first-half" : "second-half";
    if (value.checkpoint !== expectedCheckpoint) {
      context.addIssue({
        code: "custom",
        message: `checkpoint must be ${expectedCheckpoint} at this cycle position`,
        path: ["checkpoint"],
      });
    }
  });

export type ChainAnchor = z.infer<typeof chainAnchorSchema>;

export type RewardCalculationCheckpoint = "first-half" | "second-half";

export type RewardCalculationTarget =
  | {
      status: "ready";
      rewardCycle: number;
      calculationCheckpoint: RewardCalculationCheckpoint;
      expectedLastRewardComputeBurnHeight: number;
    }
  | {
      status: "invalid";
      reason: "odd-reward-cycle-length" | "no-previous-reward-cycle" | "invalid-cycle-start";
    };

/**
 * Resolves the completed PoX-5 distribution calculation visible at an anchor.
 *
 * PoX-5 calculates rewards twice per reward cycle. During the second half of cycle C, the
 * completed first-half calculation targets C. During the first half of cycle C + 1, the completed
 * second-half calculation also targets C. The calculation checkpoint is therefore distinct from
 * the anchor's current half-cycle label.
 */
export function deriveRewardCalculationTarget(anchor: ChainAnchor): RewardCalculationTarget {
  if (anchor.rewardCycleLength % 2 !== 0) {
    return { status: "invalid", reason: "odd-reward-cycle-length" };
  }

  const cycleStart = anchor.burnBlockHeight - anchor.cyclePosition;
  if (!Number.isSafeInteger(cycleStart) || cycleStart < 0) {
    return { status: "invalid", reason: "invalid-cycle-start" };
  }

  if (anchor.checkpoint === "second-half") {
    return {
      status: "ready",
      rewardCycle: anchor.rewardCycle,
      calculationCheckpoint: "first-half",
      expectedLastRewardComputeBurnHeight: cycleStart + anchor.rewardCycleLength / 2 - 1,
    };
  }

  if (anchor.rewardCycle === 0 || cycleStart === 0) {
    return { status: "invalid", reason: "no-previous-reward-cycle" };
  }
  return {
    status: "ready",
    rewardCycle: anchor.rewardCycle - 1,
    calculationCheckpoint: "second-half",
    expectedLastRewardComputeBurnHeight: cycleStart - 1,
  };
}

export function parseChainAnchor(value: unknown): ChainAnchor {
  return chainAnchorSchema.parse(value);
}

export function chainAnchorsEqual(left: ChainAnchor, right: ChainAnchor): boolean {
  return (
    left.stacksBlockHeight === right.stacksBlockHeight &&
    left.indexBlockHash === right.indexBlockHash &&
    left.burnBlockHeight === right.burnBlockHeight &&
    left.rewardCycle === right.rewardCycle &&
    left.rewardCycleLength === right.rewardCycleLength &&
    left.prepareCycleLength === right.prepareCycleLength &&
    left.cyclePosition === right.cyclePosition &&
    left.phase === right.phase &&
    left.checkpoint === right.checkpoint
  );
}
