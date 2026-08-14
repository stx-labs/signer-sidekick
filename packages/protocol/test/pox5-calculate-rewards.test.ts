import { Cl, cvToHex } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import {
  encodePox5CalculateRewardsArguments,
  orderPox5CalculationBonds,
} from "../src/pox5-calculate-rewards.js";

const bond = (
  bondIndex: bigint,
  stxValueRatio: bigint,
  targetRateBips = 500n,
  minUstxRatioBips = 10_000n,
) => ({ bondIndex, targetRateBips, stxValueRatio, minUstxRatioBips });

describe("PoX-5 calculate-rewards adapter", () => {
  it("pins the STX-only empty-list wire argument", () => {
    expect(encodePox5CalculateRewardsArguments([])).toEqual([cvToHex(Cl.list([]))]);
    expect(encodePox5CalculateRewardsArguments([])).toEqual(["0x0b00000000"]);
  });

  it("orders active bonds by ratio descending and earlier index first on ties", () => {
    const ordered = orderPox5CalculationBonds([
      bond(3n, 9_000n),
      bond(1n, 12_000n),
      bond(2n, 12_000n),
      bond(0n, 7_000n),
    ]);
    expect(ordered.map(({ bondIndex }) => bondIndex)).toEqual([1n, 2n, 3n, 0n]);
    expect(encodePox5CalculateRewardsArguments(ordered)).toEqual([
      cvToHex(Cl.list([Cl.uint(1), Cl.uint(2), Cl.uint(3), Cl.uint(0)])),
    ]);
  });

  it("rejects duplicate periods and lists beyond PoX-5's six-item bound", () => {
    expect(() => orderPox5CalculationBonds([bond(0n, 1n), bond(0n, 2n)])).toThrow(
      "Duplicate bond period 0",
    );
    expect(() =>
      orderPox5CalculationBonds(Array.from({ length: 7 }, (_, index) => bond(BigInt(index), 1n))),
    ).toThrow();
  });
});
