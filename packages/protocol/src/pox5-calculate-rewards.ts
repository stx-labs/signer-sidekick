import { Cl, cvToHex } from "@stacks/transactions";
import { z } from "zod";
import { MAX_BOND_PERIODS_PER_CYCLE } from "./pox5-bonds.js";

export const POX5_CALCULATE_REWARDS_ADAPTER_ID = "pox5-calculate-rewards" as const;
export const POX5_CALCULATE_REWARDS_ADAPTER_REVISION = 1 as const;
export const POX5_CALCULATE_REWARDS_FUNCTION_NAME = "calculate-rewards" as const;

const uint128Schema = z
  .bigint()
  .min(0n)
  .max((1n << 128n) - 1n);

export const pox5CalculationBondSchema = z
  .object({
    bondIndex: uint128Schema,
    targetRateBips: uint128Schema,
    stxValueRatio: uint128Schema,
    minUstxRatioBips: uint128Schema,
  })
  .strict();

export type Pox5CalculationBond = z.infer<typeof pox5CalculationBondSchema>;

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
  return [...bonds].sort((left, right) => {
    if (left.stxValueRatio !== right.stxValueRatio) {
      return left.stxValueRatio > right.stxValueRatio ? -1 : 1;
    }
    if (left.bondIndex === right.bondIndex) return 0;
    return left.bondIndex < right.bondIndex ? -1 : 1;
  });
}

/** The one Clarity argument accepted by `pox-5::calculate-rewards`. */
export function encodePox5CalculateRewardsArguments(
  input: readonly Pox5CalculationBond[],
): [string] {
  const ordered = orderPox5CalculationBonds(input);
  return [cvToHex(Cl.list(ordered.map(({ bondIndex }) => Cl.uint(bondIndex))))];
}
