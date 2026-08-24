import { describe, expect, it } from "vitest";
import { selectTransactionFee, type TransactionFeePolicy } from "./fee-policy.js";
import type { LiveObservation, TransactionFeeObservation } from "./live-transaction-reader.js";

function observedFee(middleUstx: bigint): LiveObservation<TransactionFeeObservation> {
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
        low: { feeRate: 0, feeUstx: 307n },
        middle: { feeRate: 0, feeUstx: middleUstx },
        high: { feeRate: 0, feeUstx: middleUstx * 20n },
      },
    },
  };
}

describe("selectTransactionFee", () => {
  const policy: TransactionFeePolicy = {
    minimumFeeUstx: 3_000n,
    standardFeeUstx: 10_000n,
    maximumFeeUstx: 100_000n,
  };

  it("pays the node's middle estimate inside the standard band", () => {
    expect(selectTransactionFee(observedFee(7_014n), policy)).toEqual({
      feeUstx: 7_014n,
      basis: "estimate",
      estimateUstx: 7_014n,
    });
  });

  it("clamps a bot-driven spike to the standard ceiling instead of halting", () => {
    expect(selectTransactionFee(observedFee(83_000n), policy)).toEqual({
      feeUstx: 10_000n,
      basis: "standard-ceiling",
      estimateUstx: 83_000n,
    });
  });

  it("lifts a sub-floor estimate to the band floor", () => {
    expect(selectTransactionFee(observedFee(400n), policy)).toEqual({
      feeUstx: 3_000n,
      basis: "minimum",
      estimateUstx: 400n,
    });
  });

  it("pays the floor when the node has no estimate", () => {
    const expected = { feeUstx: 3_000n, basis: "default", estimateUstx: null };
    expect(
      selectTransactionFee(
        { status: "unavailable", httpStatus: 500, reason: "http-error" },
        policy,
      ),
    ).toEqual(expected);
    expect(selectTransactionFee(observedFee(0n), policy)).toEqual(expected);
    expect(selectTransactionFee(null, policy)).toEqual(expected);
  });

  it("never exceeds the authorization cap, even below the standard ceiling", () => {
    const tight = { ...policy, maximumFeeUstx: 5_000n };
    expect(selectTransactionFee(observedFee(8_000n), tight)).toEqual({
      feeUstx: 5_000n,
      basis: "standard-ceiling",
      estimateUstx: 8_000n,
    });
    expect(selectTransactionFee(null, { ...policy, maximumFeeUstx: 2_000n })).toEqual({
      feeUstx: 2_000n,
      basis: "default",
      estimateUstx: null,
    });
  });
});
