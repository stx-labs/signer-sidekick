import { z } from "zod";

const unsignedIntegerTextSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/);

export interface RewardForecastObservation {
  observedBurnBlockHeight: number;
  observedAt: string;
  globalAccruedRewardsSats: string;
  lastRewardComputeBurnHeight: string;
  nextCalculation: null | {
    targetRewardCycle: number;
    targetCheckpoint: "first-half" | "second-half";
    calculationBurnHeight: number;
  };
}

export interface GlobalRewardRunRateForecast {
  kind: "checkpoint-run-rate";
  targetRewardCycle: number;
  targetCheckpoint: "first-half" | "second-half";
  calculationBurnHeight: number;
  globalSats: {
    low: string;
    point: string;
    high: string;
  };
  sample: {
    observations: number;
    firstObservedBurnHeight: number;
    lastObservedBurnHeight: number;
    sampleBlocks: number;
    elapsedBlocks: number;
    remainingBlocks: number;
  };
  confidence: "low" | "developing";
  assumptions: [
    "zero-accrual-after-last-calculation" | "observed-accrual-sample-window",
    "linear-global-accrual-run-rate",
  ];
}

export type GlobalRewardForecastResult =
  | { status: "available"; forecast: GlobalRewardRunRateForecast }
  | { status: "unavailable"; reason: "insufficient-samples" | "non-monotonic-accrual" };

interface Rate {
  numerator: bigint;
  denominator: bigint;
}

function compareRates(left: Rate, right: Rate): number {
  const comparison = left.numerator * right.denominator - right.numerator * left.denominator;
  return comparison < 0n ? -1 : comparison > 0n ? 1 : 0;
}

function floorRate(rate: Rate, blocks: number): bigint {
  return (rate.numerator * BigInt(blocks)) / rate.denominator;
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

function ceilRate(rate: Rate, blocks: number): bigint {
  return ceilDivide(rate.numerator * BigInt(blocks), rate.denominator);
}

function validTarget(
  observation: RewardForecastObservation,
  target: {
    rewardCycle: number;
    checkpoint: "first-half" | "second-half";
    calculationBurnHeight: number;
  },
): boolean {
  const next = observation.nextCalculation;
  return (
    next?.targetRewardCycle === target.rewardCycle &&
    next.targetCheckpoint === target.checkpoint &&
    next.calculationBurnHeight === target.calculationBurnHeight
  );
}

/**
 * Projects only the protocol-global cumulative reward balance. Pool allocation remains a separate
 * contract simulation so no ratio shortcut can bypass PoX-5's bond ordering and integer rounding.
 *
 * The range is deliberately empirical and conservative: the point uses the cumulative rate since
 * the last completed calculation, while low/high use the slowest and fastest observed interval
 * rates. After a completed calculation, three samples spanning six Bitcoin blocks are required.
 * Before PoX-5's first calculation, the u0 sentinel has no real zero-accrual anchor, so Sidekick
 * learns only from observed deltas and waits for at least 24 Bitcoin blocks.
 */
export function projectGlobalRewardRunRate(input: {
  observations: readonly RewardForecastObservation[];
  current: RewardForecastObservation;
  target: {
    rewardCycle: number;
    checkpoint: "first-half" | "second-half";
    calculationBurnHeight: number;
  };
  minimumObservations?: number;
  minimumSampleBlocks?: number;
}): GlobalRewardForecastResult {
  const minimumObservations = z
    .number()
    .int()
    .min(3)
    .parse(input.minimumObservations ?? 3);
  const configuredMinimumSampleBlocks = z
    .number()
    .int()
    .min(1)
    .parse(input.minimumSampleBlocks ?? 6);
  const currentHeight = z
    .number()
    .int()
    .nonnegative()
    .safe()
    .parse(input.current.observedBurnBlockHeight);
  const lastComputeHeight = Number(
    unsignedIntegerTextSchema.parse(input.current.lastRewardComputeBurnHeight),
  );
  if (!Number.isSafeInteger(lastComputeHeight) || lastComputeHeight < 0) {
    return { status: "unavailable", reason: "insufficient-samples" };
  }
  const currentAccrued = BigInt(
    unsignedIntegerTextSchema.parse(input.current.globalAccruedRewardsSats),
  );
  const firstCalculation = lastComputeHeight === 0;
  const minimumSampleBlocks = firstCalculation
    ? Math.max(24, configuredMinimumSampleBlocks)
    : configuredMinimumSampleBlocks;
  if (
    currentHeight <= lastComputeHeight ||
    !validTarget(input.current, input.target) ||
    input.target.calculationBurnHeight < lastComputeHeight
  ) {
    return { status: "unavailable", reason: "insufficient-samples" };
  }

  const byBurnHeight = new Map<number, RewardForecastObservation>();
  for (const candidate of [...input.observations, input.current]) {
    if (
      candidate.lastRewardComputeBurnHeight !== input.current.lastRewardComputeBurnHeight ||
      !validTarget(candidate, input.target) ||
      candidate.observedBurnBlockHeight < lastComputeHeight ||
      candidate.observedBurnBlockHeight > currentHeight
    ) {
      continue;
    }
    unsignedIntegerTextSchema.parse(candidate.globalAccruedRewardsSats);
    const existing = byBurnHeight.get(candidate.observedBurnBlockHeight);
    if (!existing || Date.parse(candidate.observedAt) >= Date.parse(existing.observedAt)) {
      byBurnHeight.set(candidate.observedBurnBlockHeight, candidate);
    }
  }
  // The live read is authoritative for its own anchor even if an older persisted row shares it.
  byBurnHeight.set(currentHeight, input.current);
  const samples = [...byBurnHeight.values()].sort(
    (left, right) => left.observedBurnBlockHeight - right.observedBurnBlockHeight,
  );
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last) return { status: "unavailable", reason: "insufficient-samples" };
  const sampleBlocks = last.observedBurnBlockHeight - first.observedBurnBlockHeight;
  if (samples.length < minimumObservations || sampleBlocks < minimumSampleBlocks) {
    return { status: "unavailable", reason: "insufficient-samples" };
  }

  const rates: Rate[] = [];
  let previousHeight = firstCalculation ? first.observedBurnBlockHeight : lastComputeHeight;
  let previousAccrued = firstCalculation ? BigInt(first.globalAccruedRewardsSats) : 0n;
  for (const sample of firstCalculation ? samples.slice(1) : samples) {
    const accrued = BigInt(sample.globalAccruedRewardsSats);
    if (accrued < previousAccrued) {
      return { status: "unavailable", reason: "non-monotonic-accrual" };
    }
    const blocks = sample.observedBurnBlockHeight - previousHeight;
    if (blocks > 0) {
      rates.push({ numerator: accrued - previousAccrued, denominator: BigInt(blocks) });
    }
    previousHeight = sample.observedBurnBlockHeight;
    previousAccrued = accrued;
  }
  if (rates.length === 0) return { status: "unavailable", reason: "insufficient-samples" };

  const elapsedBlocks = firstCalculation ? sampleBlocks : currentHeight - lastComputeHeight;
  const remainingBlocks = Math.max(0, input.target.calculationBurnHeight - currentHeight);
  const pointRate: Rate = {
    numerator: firstCalculation
      ? currentAccrued - BigInt(first.globalAccruedRewardsSats)
      : currentAccrued,
    denominator: BigInt(elapsedBlocks),
  };
  const orderedRates = [...rates, pointRate].sort(compareRates);
  const lowRate = orderedRates[0];
  const highRate = orderedRates.at(-1);
  if (!lowRate || !highRate) {
    return { status: "unavailable", reason: "insufficient-samples" };
  }
  const projectedPoint = currentAccrued + ceilRate(pointRate, remainingBlocks);
  const projectedLow = currentAccrued + floorRate(lowRate, remainingBlocks);
  const projectedHigh = currentAccrued + ceilRate(highRate, remainingBlocks);

  return {
    status: "available",
    forecast: {
      kind: "checkpoint-run-rate",
      targetRewardCycle: input.target.rewardCycle,
      targetCheckpoint: input.target.checkpoint,
      calculationBurnHeight: input.target.calculationBurnHeight,
      globalSats: {
        low: projectedLow.toString(),
        point: projectedPoint.toString(),
        high: projectedHigh.toString(),
      },
      sample: {
        observations: samples.length,
        firstObservedBurnHeight: first.observedBurnBlockHeight,
        lastObservedBurnHeight: last.observedBurnBlockHeight,
        sampleBlocks,
        elapsedBlocks,
        remainingBlocks,
      },
      confidence: samples.length >= 6 && sampleBlocks >= 24 ? "developing" : "low",
      assumptions: [
        firstCalculation ? "observed-accrual-sample-window" : "zero-accrual-after-last-calculation",
        "linear-global-accrual-run-rate",
      ],
    },
  };
}
