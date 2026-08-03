import { describe, expect, it } from "vitest";
import {
  BOND_GAP_CYCLES,
  BOND_LENGTH_CYCLES,
  bondPeriodFirstRewardCycle,
  bondPeriodsForRewardCycle,
  MAX_BOND_PERIODS_PER_CYCLE,
  Pox5BondError,
} from "../src/pox5-bonds.js";

describe("bondPeriodsForRewardCycle", () => {
  it("returns nothing before the first bond period cycle", () => {
    expect(bondPeriodsForRewardCycle(0n, 1n)).toEqual([]);
    expect(bondPeriodsForRewardCycle(1n, 5n)).toEqual([]);
  });

  it("matches the regtest harness anchor where cycle 1 is the first bond cycle", () => {
    // `set-burnchain-parameters(0, 10, 100, 1)` sets first-bond-period-cycle to 1, and the simnet
    // probe confirmed bond period 0 held shares for reward cycle 1.
    expect(bondPeriodsForRewardCycle(1n, 1n)).toEqual([0n]);
    expect(bondPeriodsForRewardCycle(2n, 1n)).toEqual([0n]);
    expect(bondPeriodsForRewardCycle(3n, 1n)).toEqual([0n, 1n]);
  });

  it("saturates at six periods once the schedule is fully overlapped", () => {
    const periods = bondPeriodsForRewardCycle(21n, 1n);
    expect(periods).toEqual([5n, 6n, 7n, 8n, 9n, 10n]);
    expect(periods).toHaveLength(MAX_BOND_PERIODS_PER_CYCLE);
  });

  it("never returns a period whose twelve-cycle term has ended", () => {
    const firstBondCycle = 1n;
    for (let cycle = firstBondCycle; cycle < 60n; cycle += 1n) {
      for (const index of bondPeriodsForRewardCycle(cycle, firstBondCycle)) {
        const first = bondPeriodFirstRewardCycle(index, firstBondCycle);
        expect(first).toBeLessThanOrEqual(cycle);
        expect(cycle).toBeLessThan(first + BOND_LENGTH_CYCLES);
      }
    }
  });

  it("returns every period that holds shares for the cycle", () => {
    const firstBondCycle = 4n;
    for (let cycle = 0n; cycle < 80n; cycle += 1n) {
      const derived = new Set(
        bondPeriodsForRewardCycle(cycle, firstBondCycle).map((index) => index.toString()),
      );
      // Brute-force the same predicate the contract's per-cycle share writes imply.
      const expected = new Set<string>();
      for (let index = 0n; index < 64n; index += 1n) {
        const first = firstBondCycle + index * BOND_GAP_CYCLES;
        if (first <= cycle && cycle < first + BOND_LENGTH_CYCLES) expected.add(index.toString());
      }
      expect(derived).toEqual(expected);
    }
  });

  it("returns ascending, unique indices", () => {
    const periods = bondPeriodsForRewardCycle(37n, 2n);
    expect([...periods].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))).toEqual(
      periods,
    );
    expect(new Set(periods).size).toBe(periods.length);
  });

  it("rejects negative inputs", () => {
    expect(() => bondPeriodsForRewardCycle(-1n, 0n)).toThrow(Pox5BondError);
    expect(() => bondPeriodsForRewardCycle(1n, -1n)).toThrow(Pox5BondError);
    expect(() => bondPeriodFirstRewardCycle(-1n, 0n)).toThrow(Pox5BondError);
  });
});
