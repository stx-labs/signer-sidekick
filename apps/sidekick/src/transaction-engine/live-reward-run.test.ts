import type { ManagerCapabilities } from "@stx-labs/signer-sidekick-api-contracts";
import { describe, expect, it } from "vitest";
import {
  calculationResultMatchesTarget,
  factReadsForOperations,
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
  const policy = { minimumFeeUstx: 3_000n, standardFeeUstx: 10_000n, maximumFeeUstx: 100_000n };

  it("pays the node's middle estimate inside the standard band", () => {
    expect(selectRewardRunFee(observedFee(7_014n), policy)).toEqual({
      feeUstx: 7_014n,
      basis: "estimate",
      estimateUstx: 7_014n,
    });
  });

  it("clamps a spiking estimate to the standard ceiling instead of halting the run", () => {
    expect(selectRewardRunFee(observedFee(83_000n), policy)).toEqual({
      feeUstx: 10_000n,
      basis: "standard-ceiling",
      estimateUstx: 83_000n,
    });
  });

  it("pays the band floor when estimation is unavailable", () => {
    const expected = { feeUstx: 3_000n, basis: "default", estimateUstx: null };
    expect(
      selectRewardRunFee({ status: "unavailable", httpStatus: 500, reason: "http-error" }, policy),
    ).toEqual(expected);
    expect(selectRewardRunFee(observedFee(0n), policy)).toEqual(expected);
    expect(selectRewardRunFee(null, policy)).toEqual(expected);
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

describe("factReadsForOperations", () => {
  it("scopes preparation reads to the requested operations", () => {
    expect(factReadsForOperations(["claim-rewards"])).toEqual({
      calculate: false,
      collect: true,
      accounts: false,
      withdrawals: false,
    });
    expect(factReadsForOperations(["calculate-rewards"])).toEqual({
      calculate: true,
      collect: false,
      accounts: false,
      withdrawals: false,
    });
    // Payouts need the bond periods the collect read provides, never the calculation target.
    expect(factReadsForOperations(["claim-staker-rewards"])).toEqual({
      calculate: false,
      collect: true,
      accounts: true,
      withdrawals: false,
    });
    expect(
      factReadsForOperations(["settle-accepted-withdrawal", "reclaim-failed-withdrawal"]),
    ).toEqual({ calculate: false, collect: false, accounts: false, withdrawals: true });
    // No explicit operations keeps the full discovery the default recipe needs.
    expect(factReadsForOperations(undefined)).toEqual({
      calculate: true,
      collect: true,
      accounts: true,
      withdrawals: true,
    });
  });
});
