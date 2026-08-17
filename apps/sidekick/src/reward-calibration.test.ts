import { describe, expect, it } from "vitest";
import {
  assessRewardCalibration,
  calibratedForecastConfidence,
  evaluateRewardForecast,
  REWARD_FORECAST_MODEL_REVISION,
  type RewardCalibrationSample,
} from "./reward-calibration.js";

function sample(
  index: number,
  options: { hit?: boolean; pointErrorBips?: number; rangeWidthBips?: number } = {},
): RewardCalibrationSample {
  const actual = 100_000n;
  const pointError = (BigInt(options.pointErrorBips ?? 1_000) * actual) / 10_000n;
  const point = actual + pointError;
  const width = (BigInt(options.rangeWidthBips ?? 4_000) * point) / 10_000n;
  const hit = options.hit ?? true;
  const low = hit ? actual - width / 2n : actual + 1n;
  const high = hit ? actual + width / 2n : actual + width;
  const calculationBurnHeight = 1_000_000 + index * 1_050;
  return {
    modelRevision: REWARD_FORECAST_MODEL_REVISION,
    targetRewardCycle: 140 + Math.floor(index / 2),
    calculationBurnHeight,
    actualPoolSats: actual.toString(),
    evaluation: evaluateRewardForecast({
      modelRevision: REWARD_FORECAST_MODEL_REVISION,
      forecastObservedBurnHeight: calculationBurnHeight - 144,
      calculationBurnHeight,
      targetRewardCycle: 140 + Math.floor(index / 2),
      targetCheckpoint: index % 2 === 0 ? "first-half" : "second-half",
      globalSats: { low: "1", point: "2", high: "3" },
      poolSats: { low: low.toString(), point: point.toString(), high: high.toString() },
      actualPoolSats: actual.toString(),
    }),
  };
}

describe("reward forecast calibration", () => {
  it("computes fixed-horizon error and range evidence without floating point", () => {
    expect(
      evaluateRewardForecast({
        modelRevision: 1,
        forecastObservedBurnHeight: 856,
        calculationBurnHeight: 1_000,
        targetRewardCycle: 141,
        targetCheckpoint: "first-half",
        globalSats: { low: "100", point: "120", high: "140" },
        poolSats: { low: "80", point: "110", high: "130" },
        actualPoolSats: "100",
      }),
    ).toMatchObject({
      leadBlocks: 144,
      pointErrorSats: "10",
      pointErrorBips: "1000",
      rangeContainsActual: true,
      rangeWidthBips: "4546",
    });
  });

  it("requires six fixed-horizon outcomes across three cycles and useful accuracy", () => {
    const passing = assessRewardCalibration(Array.from({ length: 6 }, (_, index) => sample(index)));
    expect(passing).toMatchObject({
      status: "passing",
      eligibleRealizations: 6,
      rewardCycles: 3,
      nonzeroOutcomes: 6,
      rangeHits: 6,
      medianPointErrorBips: "1000",
    });
    expect(
      calibratedForecastConfidence({
        samplingConfidence: "developing",
        remainingBlocks: 100,
        calibration: passing,
      }),
    ).toBe("calibrated");
    expect(
      calibratedForecastConfidence({
        samplingConfidence: "developing",
        remainingBlocks: 145,
        calibration: passing,
      }),
    ).toBe("developing");
  });

  it("stays collecting without history and fails broad or inaccurate histories", () => {
    expect(assessRewardCalibration([sample(0), sample(1)])).toMatchObject({
      status: "collecting",
      eligibleRealizations: 2,
    });
    expect(
      assessRewardCalibration(
        Array.from({ length: 6 }, (_, index) =>
          sample(index, { hit: index !== 0 && index !== 1, pointErrorBips: 2_000 }),
        ),
      ),
    ).toMatchObject({ status: "failing", rangeHits: 4 });
  });
});
