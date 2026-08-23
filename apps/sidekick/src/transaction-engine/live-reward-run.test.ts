import type { ManagerCapabilities } from "@stx-labs/signer-sidekick-api-contracts";
import { describe, expect, it } from "vitest";
import {
  calculationResultMatchesTarget,
  reviewedRewardManagerAvailable,
  selectRewardRunFee,
} from "./live-reward-run.js";
import type { LiveObservation, TransactionFeeObservation } from "./live-transaction-reader.js";

function observedFee(feeUstx: bigint): LiveObservation<TransactionFeeObservation> {
  return {
    status: "observed",
    httpStatus: 200,
    value: {
      transactionPayloadHex: "00",
      estimatedFinalByteLength: 1,
      estimatedCost: {
        readCount: 0n,
        readLength: 0n,
        runtime: 0n,
        writeCount: 0n,
        writeLength: 0n,
      },
      estimatedCostScalar: 0n,
      costScalarChangeByByte: 0,
      estimates: {
        low: { feeRate: 0, feeUstx },
        middle: { feeRate: 0, feeUstx },
        high: { feeRate: 0, feeUstx },
      },
    },
  };
}

describe("selectRewardRunFee", () => {
  it("uses an observed fee within the approved ceiling", () => {
    expect(selectRewardRunFee(observedFee(400n), 1_000n)).toEqual({
      status: "ready",
      feeUstx: 400n,
    });
  });

  it("uses the approved ceiling when estimation is unavailable", () => {
    expect(
      selectRewardRunFee({ status: "unavailable", httpStatus: 500, reason: "http-error" }, 1_000n),
    ).toEqual({ status: "ready", feeUstx: 1_000n });
    expect(selectRewardRunFee(observedFee(0n), 1_000n)).toEqual({
      status: "ready",
      feeUstx: 1_000n,
    });
  });

  it("refuses a positive estimate above the approved ceiling", () => {
    expect(selectRewardRunFee(observedFee(1_001n), 1_000n)).toEqual({ status: "blocked" });
  });
});

describe("calculationResultMatchesTarget", () => {
  const result = "(ok (tuple (calculation-height u209) (distribution-cycle u2) (stx-cycle u5)))";

  it("accepts the exact cycle and calculation height sealed in the recipe", () => {
    expect(calculationResultMatchesTarget(result, "5", 209)).toBe(true);
  });

  it("rejects a calculation for a different cycle or checkpoint height", () => {
    expect(calculationResultMatchesTarget(result, "4", 209)).toBe(false);
    expect(calculationResultMatchesTarget(result, "5", 208)).toBe(false);
  });

  it("rejects a successful response that omits the target evidence", () => {
    expect(calculationResultMatchesTarget("(ok true)", "5", 209)).toBe(false);
  });
});

describe("reviewedRewardManagerAvailable", () => {
  const sourceSha256 = "a".repeat(64);
  const capabilities: ManagerCapabilities = {
    signerManagerTrait: { compatible: true, reason: "test" },
    observedFunctions: { public: [], readOnly: [] },
    sourceReview: { exactReviewed: true, reason: "test" },
    eventVocabulary: {
      id: "reference-manager-v1",
      normalizationAvailable: true,
      adapter: null,
      reason: "test",
    },
    actions: [
      {
        id: "reference-reward-claims",
        interfaceAvailable: true,
        executionAvailable: true,
        missingFunctions: [],
        adapter: {
          id: "reference-manager-claim-rewards",
          revision: 1,
          reviewedSourceSha256: sourceSha256,
        },
        reason: "test",
      },
    ],
  };

  it("requires both executable capability and the exact reviewed source fingerprint", () => {
    expect(reviewedRewardManagerAvailable(capabilities, sourceSha256)).toBe(true);
    expect(reviewedRewardManagerAvailable(capabilities, "b".repeat(64))).toBe(false);
    expect(
      reviewedRewardManagerAvailable(
        {
          ...capabilities,
          actions: capabilities.actions.map((action) => ({
            ...action,
            executionAvailable: false,
          })),
        },
        sourceSha256,
      ),
    ).toBe(false);
  });
});
