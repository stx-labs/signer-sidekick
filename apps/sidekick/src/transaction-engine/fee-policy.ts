import type { LiveObservation, TransactionFeeObservation } from "./live-transaction-reader.js";

/**
 * Per-transaction fee policy, modelled on the Leather wallet / Hiro Explorer "standard priority"
 * method (`@leather.io/query` `parseStacksTxFeeEstimationResponse`): ask the node to estimate the
 * exact payload, clamp the middle estimate into a standard band, and pay the band floor when the
 * node has no estimate.
 *
 * The raw node estimate is a fee *rate* learned from the last few blocks multiplied by the call's
 * cost. Nakamoto blocks are small, so a handful of bot transactions paying 2–8 STX swing the rate
 * by 10–40× within a minute even while blocks still have free space; the band keeps the engine
 * paying what clears in normal conditions, the cap stays the authorization ceiling sealed into every
 * recipe, and nothing halts on an estimate.
 */
export interface TransactionFeePolicy {
  /** Band floor, and the fee paid when the node has no estimate. */
  minimumFeeUstx: bigint;
  /** Band ceiling for estimate-based fees (standard priority). */
  standardFeeUstx: bigint;
  /** Hard per-transaction cap sealed into recipes and sweeps; never exceeded. */
  maximumFeeUstx: bigint;
}

export type FeeBasis = "estimate" | "minimum" | "standard-ceiling" | "default";

export interface FeeSelection {
  feeUstx: bigint;
  basis: FeeBasis;
  /** The node's middle estimate when one was observed, for operator-facing detail. */
  estimateUstx: bigint | null;
}

function min(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

export function selectTransactionFee(
  estimate: LiveObservation<TransactionFeeObservation> | null,
  policy: TransactionFeePolicy,
): FeeSelection {
  const ceiling = min(policy.standardFeeUstx, policy.maximumFeeUstx);
  const floor = min(policy.minimumFeeUstx, ceiling);
  const middle = estimate?.status === "observed" ? estimate.value.estimates.middle.feeUstx : null;
  if (middle === null || middle <= 0n) {
    return { feeUstx: floor, basis: "default", estimateUstx: null };
  }
  if (middle > ceiling)
    return { feeUstx: ceiling, basis: "standard-ceiling", estimateUstx: middle };
  if (middle < floor) return { feeUstx: floor, basis: "minimum", estimateUstx: middle };
  return { feeUstx: middle, basis: "estimate", estimateUstx: middle };
}
