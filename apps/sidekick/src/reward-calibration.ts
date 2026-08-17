import { z } from "zod";

export const REWARD_FORECAST_MODEL_REVISION = 1;
export const REWARD_CALIBRATION_LEAD_BLOCKS = 144;
export const REWARD_CALIBRATION_TOLERANCE_BLOCKS = 12;
export const REWARD_CALIBRATION_REALIZATIONS = 6;
export const REWARD_CALIBRATION_MIN_CYCLES = 3;
export const REWARD_CALIBRATION_REQUIRED_RANGE_HITS = 5;
export const REWARD_CALIBRATION_MAX_MEDIAN_POINT_ERROR_BIPS = 1_500n;
export const REWARD_CALIBRATION_MAX_MEDIAN_RANGE_WIDTH_BIPS = 5_000n;
export const REWARD_CALIBRATION_MIN_NONZERO_OUTCOMES = 4;

const unsignedIntegerTextSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/);

export interface RewardForecastEvaluationInput {
  modelRevision: number;
  forecastObservedBurnHeight: number;
  calculationBurnHeight: number;
  targetRewardCycle: number;
  targetCheckpoint: "first-half" | "second-half";
  globalSats: { low: string; point: string; high: string };
  poolSats: { low: string; point: string; high: string };
  actualPoolSats: string;
}

export const rewardForecastEvaluationSchema = z
  .object({
    modelRevision: z.number().int().positive(),
    forecastObservedBurnHeight: z.number().int().nonnegative().safe(),
    calculationBurnHeight: z.number().int().nonnegative().safe(),
    targetRewardCycle: z.number().int().nonnegative().safe(),
    targetCheckpoint: z.enum(["first-half", "second-half"]),
    globalSats: z
      .object({
        low: unsignedIntegerTextSchema,
        point: unsignedIntegerTextSchema,
        high: unsignedIntegerTextSchema,
      })
      .strict(),
    poolSats: z
      .object({
        low: unsignedIntegerTextSchema,
        point: unsignedIntegerTextSchema,
        high: unsignedIntegerTextSchema,
      })
      .strict(),
    actualPoolSats: unsignedIntegerTextSchema,
    leadBlocks: z.number().int().safe(),
    pointErrorSats: unsignedIntegerTextSchema,
    pointErrorBips: unsignedIntegerTextSchema.nullable(),
    rangeContainsActual: z.boolean(),
    rangeWidthBips: unsignedIntegerTextSchema.nullable(),
  })
  .strict();

export interface RewardForecastEvaluation extends RewardForecastEvaluationInput {
  leadBlocks: number;
  pointErrorSats: string;
  pointErrorBips: string | null;
  rangeContainsActual: boolean;
  rangeWidthBips: string | null;
}

export interface RewardCalibrationSample {
  modelRevision: number;
  targetRewardCycle: number;
  calculationBurnHeight: number;
  actualPoolSats: string;
  evaluation: RewardForecastEvaluation | null;
}

export interface RewardCalibrationAssessment {
  modelRevision: number;
  status: "collecting" | "passing" | "failing";
  eligibleRealizations: number;
  rewardCycles: number;
  nonzeroOutcomes: number;
  rangeHits: number;
  medianPointErrorBips: string | null;
  medianRangeWidthBips: string | null;
  requirements: {
    realizations: number;
    rewardCycles: number;
    nonzeroOutcomes: number;
    rangeHits: number;
    maxMedianPointErrorBips: string;
    maxMedianRangeWidthBips: string;
    evaluationLeadBlocks: number;
    evaluationToleranceBlocks: number;
  };
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

function normalizedBips(numerator: bigint, denominator: bigint): string | null {
  return denominator === 0n ? null : ceilDivide(numerator * 10_000n, denominator).toString();
}

function median(values: readonly bigint[]): bigint | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle] ?? null;
  const left = ordered[middle - 1];
  const right = ordered[middle];
  return left === undefined || right === undefined ? null : ceilDivide(left + right, 2n);
}

export function evaluateRewardForecast(
  input: RewardForecastEvaluationInput,
): RewardForecastEvaluation {
  const calculationBurnHeight = z
    .number()
    .int()
    .nonnegative()
    .safe()
    .parse(input.calculationBurnHeight);
  const observedBurnHeight = z
    .number()
    .int()
    .nonnegative()
    .safe()
    .parse(input.forecastObservedBurnHeight);
  const low = BigInt(unsignedIntegerTextSchema.parse(input.poolSats.low));
  const point = BigInt(unsignedIntegerTextSchema.parse(input.poolSats.point));
  const high = BigInt(unsignedIntegerTextSchema.parse(input.poolSats.high));
  const actual = BigInt(unsignedIntegerTextSchema.parse(input.actualPoolSats));
  if (low > point || point > high) throw new Error("Forecast pool range must be ordered");
  const pointError = point >= actual ? point - actual : actual - point;
  return rewardForecastEvaluationSchema.parse({
    ...input,
    leadBlocks: calculationBurnHeight - observedBurnHeight,
    pointErrorSats: pointError.toString(),
    pointErrorBips: normalizedBips(pointError, actual),
    rangeContainsActual: low <= actual && actual <= high,
    rangeWidthBips: normalizedBips(high - low, point),
  });
}

function requirements(): RewardCalibrationAssessment["requirements"] {
  return {
    realizations: REWARD_CALIBRATION_REALIZATIONS,
    rewardCycles: REWARD_CALIBRATION_MIN_CYCLES,
    nonzeroOutcomes: REWARD_CALIBRATION_MIN_NONZERO_OUTCOMES,
    rangeHits: REWARD_CALIBRATION_REQUIRED_RANGE_HITS,
    maxMedianPointErrorBips: REWARD_CALIBRATION_MAX_MEDIAN_POINT_ERROR_BIPS.toString(),
    maxMedianRangeWidthBips: REWARD_CALIBRATION_MAX_MEDIAN_RANGE_WIDTH_BIPS.toString(),
    evaluationLeadBlocks: REWARD_CALIBRATION_LEAD_BLOCKS,
    evaluationToleranceBlocks: REWARD_CALIBRATION_TOLERANCE_BLOCKS,
  };
}

export function assessRewardCalibration(
  samples: readonly RewardCalibrationSample[],
  modelRevision = REWARD_FORECAST_MODEL_REVISION,
): RewardCalibrationAssessment {
  const eligible = samples
    .filter(
      (sample) =>
        sample.modelRevision === modelRevision &&
        sample.evaluation?.modelRevision === modelRevision &&
        sample.evaluation.leadBlocks >= REWARD_CALIBRATION_LEAD_BLOCKS &&
        sample.evaluation.leadBlocks <=
          REWARD_CALIBRATION_LEAD_BLOCKS + REWARD_CALIBRATION_TOLERANCE_BLOCKS,
    )
    .sort((left, right) => right.calculationBurnHeight - left.calculationBurnHeight)
    .slice(0, REWARD_CALIBRATION_REALIZATIONS);
  const cycles = new Set(eligible.map(({ targetRewardCycle }) => targetRewardCycle)).size;
  const nonzero = eligible.filter(({ actualPoolSats }) => BigInt(actualPoolSats) > 0n);
  const rangeHits = eligible.filter(({ evaluation }) => evaluation?.rangeContainsActual).length;
  const pointErrors = nonzero
    .map(({ evaluation }) => evaluation?.pointErrorBips)
    .filter((value): value is string => value !== null && value !== undefined)
    .map(BigInt);
  const rangeWidths = nonzero
    .map(({ evaluation }) => evaluation?.rangeWidthBips)
    .filter((value): value is string => value !== null && value !== undefined)
    .map(BigInt);
  const medianPointError = median(pointErrors);
  const medianRangeWidth = median(rangeWidths);
  const enoughHistory =
    eligible.length >= REWARD_CALIBRATION_REALIZATIONS &&
    cycles >= REWARD_CALIBRATION_MIN_CYCLES &&
    nonzero.length >= REWARD_CALIBRATION_MIN_NONZERO_OUTCOMES;
  const passing =
    enoughHistory &&
    rangeHits >= REWARD_CALIBRATION_REQUIRED_RANGE_HITS &&
    medianPointError !== null &&
    medianPointError <= REWARD_CALIBRATION_MAX_MEDIAN_POINT_ERROR_BIPS &&
    medianRangeWidth !== null &&
    medianRangeWidth <= REWARD_CALIBRATION_MAX_MEDIAN_RANGE_WIDTH_BIPS;
  return {
    modelRevision,
    status: enoughHistory ? (passing ? "passing" : "failing") : "collecting",
    eligibleRealizations: eligible.length,
    rewardCycles: cycles,
    nonzeroOutcomes: nonzero.length,
    rangeHits,
    medianPointErrorBips: medianPointError?.toString() ?? null,
    medianRangeWidthBips: medianRangeWidth?.toString() ?? null,
    requirements: requirements(),
  };
}

export function calibratedForecastConfidence(input: {
  samplingConfidence: "low" | "developing";
  remainingBlocks: number;
  calibration: RewardCalibrationAssessment;
}): "low" | "developing" | "calibrated" {
  return input.samplingConfidence === "developing" &&
    input.remainingBlocks <= REWARD_CALIBRATION_LEAD_BLOCKS &&
    input.calibration.status === "passing"
    ? "calibrated"
    : input.samplingConfidence;
}
