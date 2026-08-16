import { Cl, cvToHex } from "@stacks/transactions";
import { z } from "zod";
import { MAX_BOND_PERIODS_PER_CYCLE } from "./pox5-bonds.js";

export const POX5_CALCULATE_REWARDS_ADAPTER_ID = "pox5-calculate-rewards" as const;
export const POX5_CALCULATE_REWARDS_ADAPTER_REVISION = 1 as const;
/** `PRECISION` in the reviewed PoX-5 contract. */
export const POX5_REWARD_PRECISION = 1_000_000_000_000_000_000n;
/** `RESERVE_RATIO` in the reviewed PoX-5 contract, expressed in basis points. */
export const POX5_REWARD_RESERVE_RATIO_BIPS = 1_500n;

const UINT128_MAX = (1n << 128n) - 1n;

const uint128Schema = z.bigint().min(0n).max(UINT128_MAX);

export const pox5CalculationBondSchema = z
  .object({
    bondIndex: uint128Schema,
    targetRateBips: uint128Schema,
    stxValueRatio: uint128Schema,
    minUstxRatioBips: uint128Schema,
  })
  .strict();

export type Pox5CalculationBond = z.infer<typeof pox5CalculationBondSchema>;

const pox5RewardSimulationBondSchema = z
  .object({
    bondIndex: uint128Schema,
    targetRateBips: uint128Schema,
    stxValueRatio: uint128Schema,
    totalSharesSats: uint128Schema,
    currentRewardsPerSat: uint128Schema,
    managerSharesSats: uint128Schema.optional(),
  })
  .strict()
  .superRefine((bond, context) => {
    if (bond.managerSharesSats !== undefined && bond.managerSharesSats > bond.totalSharesSats) {
      context.addIssue({
        code: "custom",
        path: ["managerSharesSats"],
        message: "manager bond shares cannot exceed total bond shares",
      });
    }
  });

const pox5RewardSimulationInputSchema = z
  .object({
    grossAccruedRewardsSats: uint128Schema,
    currentReserveBalanceSats: uint128Schema,
    cycleStakedUstx: uint128Schema,
    currentRewardsPerUstx: uint128Schema,
    managerStxSharesUstx: uint128Schema.optional(),
    bonds: z.array(pox5RewardSimulationBondSchema).max(MAX_BOND_PERIODS_PER_CYCLE),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.managerStxSharesUstx !== undefined &&
      input.managerStxSharesUstx > input.cycleStakedUstx
    ) {
      context.addIssue({
        code: "custom",
        path: ["managerStxSharesUstx"],
        message: "manager STX shares cannot exceed total STX shares",
      });
    }
  });

export type Pox5RewardSimulationInput = z.input<typeof pox5RewardSimulationInputSchema>;

export interface Pox5RewardSimulation {
  grossAccruedRewardsSats: bigint;
  totalBondRewardsSats: bigint;
  remainingRewardsAfterBondsSats: bigint;
  reserveDepositSats: bigint;
  reserveBalanceSats: bigint;
  totalStxStakerRewardsSats: bigint;
  cycleStakedUstx: bigint;
  accruedRewardsPerUstx: bigint;
  cumulativeRewardsPerUstx: bigint;
  accountedRewardsDeltaSats: bigint;
  bonds: Array<{
    bondIndex: bigint;
    targetYieldSats: bigint;
    bondRewardSats: bigint;
    bondStakedSats: bigint;
    accruedRewardsPerSat: bigint;
    cumulativeRewardsPerSat: bigint;
    managerSharesSats: bigint | null;
    managerRewardSats: bigint | null;
  }>;
  manager: null | {
    stxRewardSats: bigint;
    bondRewardSats: bigint;
    grossRewardSats: bigint;
  };
}

export class Pox5RewardSimulationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Pox5RewardSimulationError";
  }
}

function checkedUint(value: bigint, label: string): bigint {
  if (value < 0n || value > UINT128_MAX) {
    throw new Pox5RewardSimulationError(`${label} exceeds Clarity uint bounds`);
  }
  return value;
}

function checkedAdd(left: bigint, right: bigint, label: string): bigint {
  return checkedUint(left + right, label);
}

function checkedMultiply(left: bigint, right: bigint, label: string): bigint {
  return checkedUint(left * right, label);
}

function integerDivide(numerator: bigint, denominator: bigint, label: string): bigint {
  if (denominator === 0n) {
    throw new Pox5RewardSimulationError(`${label} divides by zero`);
  }
  return numerator / denominator;
}

const pox5CalculationBondsSchema = z
  .array(pox5CalculationBondSchema)
  .max(MAX_BOND_PERIODS_PER_CYCLE)
  .superRefine((bonds, context) => {
    const seen = new Set<string>();
    for (const [index, bond] of bonds.entries()) {
      const key = bond.bondIndex.toString();
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          path: [index, "bondIndex"],
          message: `Duplicate bond period ${key}`,
        });
      }
      seen.add(key);
    }
  });

function comparePox5CalculationBondOrder(
  left: Pick<Pox5CalculationBond, "bondIndex" | "stxValueRatio">,
  right: Pick<Pox5CalculationBond, "bondIndex" | "stxValueRatio">,
): number {
  if (left.stxValueRatio !== right.stxValueRatio) {
    return left.stxValueRatio > right.stxValueRatio ? -1 : 1;
  }
  if (left.bondIndex === right.bondIndex) return 0;
  return left.bondIndex < right.bondIndex ? -1 : 1;
}

/**
 * Canonical PoX-5 reward-calculation order.
 *
 * `calculate-bond-rewards` requires the highest STX-value ratio first. Equal ratios are ordered by
 * ascending bond index, which is the contract's deterministic "earlier period first" tie-breaker.
 * The caller is responsible for supplying the complete active set read at one chain anchor; this
 * function validates and orders it without performing chain reads.
 */
export function orderPox5CalculationBonds(
  input: readonly Pox5CalculationBond[],
): Pox5CalculationBond[] {
  const bonds = pox5CalculationBondsSchema.parse(input);
  return [...bonds].sort(comparePox5CalculationBondOrder);
}

/**
 * Replays the successful distribution path in PoX-5 `calculate-rewards` with Clarity's exact
 * integer-operation order.
 *
 * This function deliberately models only contract facts. It does not project future accrual or
 * infer missing shares. A manager result is returned only when the manager's STX shares and every
 * active bond share are supplied; callers must omit the pool estimate otherwise.
 */
export function simulatePox5CalculateRewards(
  rawInput: Pox5RewardSimulationInput,
): Pox5RewardSimulation {
  const input = pox5RewardSimulationInputSchema.parse(rawInput);
  const orderedBonds = [...input.bonds].sort(comparePox5CalculationBondOrder);
  const bondStateByIndex = new Map(
    input.bonds.map((bond) => [bond.bondIndex.toString(), bond] as const),
  );
  let availableRewards = input.grossAccruedRewardsSats;
  const bonds: Pox5RewardSimulation["bonds"] = [];

  for (const orderedBond of orderedBonds) {
    const bond = bondStateByIndex.get(orderedBond.bondIndex.toString());
    if (!bond) {
      throw new Pox5RewardSimulationError(
        `missing simulation state for bond ${orderedBond.bondIndex}`,
      );
    }
    // PoX-5 evaluates `(/ (/ (* total-sats target-rate) u10000) u50)` in this order.
    const targetYieldSats = integerDivide(
      integerDivide(
        checkedMultiply(
          bond.totalSharesSats,
          bond.targetRateBips,
          `bond ${bond.bondIndex} target-yield product`,
        ),
        10_000n,
        `bond ${bond.bondIndex} target-yield basis-points division`,
      ),
      50n,
      `bond ${bond.bondIndex} target-yield distribution division`,
    );
    const bondRewardSats = availableRewards >= targetYieldSats ? targetYieldSats : availableRewards;
    const accruedRewardsPerSat =
      bond.totalSharesSats === 0n
        ? 0n
        : integerDivide(
            checkedMultiply(
              bondRewardSats,
              POX5_REWARD_PRECISION,
              `bond ${bond.bondIndex} rewards-per-sat product`,
            ),
            bond.totalSharesSats,
            `bond ${bond.bondIndex} rewards-per-sat division`,
          );
    const managerRewardSats =
      bond.managerSharesSats === undefined
        ? null
        : integerDivide(
            checkedMultiply(
              bond.managerSharesSats,
              accruedRewardsPerSat,
              `bond ${bond.bondIndex} manager reward product`,
            ),
            POX5_REWARD_PRECISION,
            `bond ${bond.bondIndex} manager reward division`,
          );
    bonds.push({
      bondIndex: bond.bondIndex,
      targetYieldSats,
      bondRewardSats,
      bondStakedSats: bond.totalSharesSats,
      accruedRewardsPerSat,
      cumulativeRewardsPerSat: checkedAdd(
        bond.currentRewardsPerSat,
        accruedRewardsPerSat,
        `bond ${bond.bondIndex} cumulative rewards per sat`,
      ),
      managerSharesSats: bond.managerSharesSats ?? null,
      managerRewardSats,
    });
    availableRewards -= bondRewardSats;
  }

  const reserveDepositBaseSats = integerDivide(
    checkedMultiply(availableRewards, POX5_REWARD_RESERVE_RATIO_BIPS, "reserve-cut product"),
    10_000n,
    "reserve-cut division",
  );
  const totalStxStakerRewardsSats = availableRewards - reserveDepositBaseSats;
  const noStxStakers = input.cycleStakedUstx === 0n;
  const accruedRewardsPerUstx = noStxStakers
    ? 0n
    : integerDivide(
        checkedMultiply(
          totalStxStakerRewardsSats,
          POX5_REWARD_PRECISION,
          "STX rewards-per-ustx product",
        ),
        input.cycleStakedUstx,
        "STX rewards-per-ustx division",
      );
  const reserveDepositSats = noStxStakers
    ? checkedAdd(
        reserveDepositBaseSats,
        totalStxStakerRewardsSats,
        "unallocated STX reserve deposit",
      )
    : reserveDepositBaseSats;
  const managerStxRewardSats =
    input.managerStxSharesUstx === undefined
      ? null
      : integerDivide(
          checkedMultiply(
            input.managerStxSharesUstx,
            accruedRewardsPerUstx,
            "manager STX reward product",
          ),
          POX5_REWARD_PRECISION,
          "manager STX reward division",
        );
  const managerBondRewards = bonds.map(({ managerRewardSats }) => managerRewardSats);
  const hasCompleteManagerShares =
    managerStxRewardSats !== null && managerBondRewards.every((reward) => reward !== null);
  const managerBondRewardSats = hasCompleteManagerShares
    ? managerBondRewards.reduce((total, reward) => total + (reward ?? 0n), 0n)
    : null;
  const manager =
    managerStxRewardSats === null || managerBondRewardSats === null
      ? null
      : {
          stxRewardSats: managerStxRewardSats,
          bondRewardSats: managerBondRewardSats,
          grossRewardSats: checkedAdd(
            managerStxRewardSats,
            managerBondRewardSats,
            "manager gross reward",
          ),
        };

  return {
    grossAccruedRewardsSats: input.grossAccruedRewardsSats,
    totalBondRewardsSats: input.grossAccruedRewardsSats - availableRewards,
    remainingRewardsAfterBondsSats: availableRewards,
    reserveDepositSats,
    reserveBalanceSats: checkedAdd(
      input.currentReserveBalanceSats,
      reserveDepositSats,
      "reserve balance",
    ),
    totalStxStakerRewardsSats,
    cycleStakedUstx: input.cycleStakedUstx,
    accruedRewardsPerUstx,
    cumulativeRewardsPerUstx: checkedAdd(
      input.currentRewardsPerUstx,
      accruedRewardsPerUstx,
      "cumulative rewards per ustx",
    ),
    accountedRewardsDeltaSats: input.grossAccruedRewardsSats - reserveDepositSats,
    bonds,
    manager,
  };
}

/** The one Clarity argument accepted by `pox-5::calculate-rewards`. */
export function encodePox5CalculateRewardsArguments(
  input: readonly Pox5CalculationBond[],
): [string] {
  const ordered = orderPox5CalculationBonds(input);
  return [cvToHex(Cl.list(ordered.map(({ bondIndex }) => Cl.uint(bondIndex))))];
}
