import { Cl, cvToHex } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import {
  encodePox5CalculateRewardsArguments,
  orderPox5CalculationBonds,
  POX5_REWARD_PRECISION,
  simulatePox5CalculateRewards,
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

  it("replays the contract's STX-only integer distribution", () => {
    const simulation = simulatePox5CalculateRewards({
      grossAccruedRewardsSats: 2_000n,
      currentReserveBalanceSats: 0n,
      cycleStakedUstx: 50_000_000_000n,
      currentRewardsPerUstx: 0n,
      managerStxSharesUstx: 50_000_000_000n,
      bonds: [],
    });

    expect(simulation).toMatchObject({
      totalBondRewardsSats: 0n,
      remainingRewardsAfterBondsSats: 2_000n,
      reserveDepositSats: 300n,
      reserveBalanceSats: 300n,
      totalStxStakerRewardsSats: 1_700n,
      accruedRewardsPerUstx: 34_000_000_000n,
      cumulativeRewardsPerUstx: 34_000_000_000n,
      accountedRewardsDeltaSats: 1_700n,
      manager: {
        stxRewardSats: 1_700n,
        bondRewardSats: 0n,
        grossRewardSats: 1_700n,
      },
    });
  });

  it("orders mixed bonds and preserves contract rounding at each bucket", () => {
    const simulation = simulatePox5CalculateRewards({
      grossAccruedRewardsSats: 2_000n,
      currentReserveBalanceSats: 50n,
      cycleStakedUstx: 50_000_000_000n,
      currentRewardsPerUstx: 7n,
      managerStxSharesUstx: 25_000_000_000n,
      bonds: [
        {
          ...bond(1n, 900n, 500n),
          totalSharesSats: 100_000n,
          currentRewardsPerSat: 3n,
          managerSharesSats: 50_000n,
        },
        {
          ...bond(0n, 1_000n, 250n),
          totalSharesSats: 40_000n,
          currentRewardsPerSat: 5n,
          managerSharesSats: 10_000n,
        },
      ],
    });

    expect(simulation.bonds.map(({ bondIndex }) => bondIndex)).toEqual([0n, 1n]);
    expect(simulation.bonds).toEqual([
      {
        bondIndex: 0n,
        targetYieldSats: 20n,
        bondRewardSats: 20n,
        bondStakedSats: 40_000n,
        accruedRewardsPerSat: 500_000_000_000_000n,
        cumulativeRewardsPerSat: 500_000_000_000_005n,
        managerSharesSats: 10_000n,
        managerRewardSats: 5n,
      },
      {
        bondIndex: 1n,
        targetYieldSats: 100n,
        bondRewardSats: 100n,
        bondStakedSats: 100_000n,
        accruedRewardsPerSat: 1_000_000_000_000_000n,
        cumulativeRewardsPerSat: 1_000_000_000_000_003n,
        managerSharesSats: 50_000n,
        managerRewardSats: 50n,
      },
    ]);
    expect(simulation.reserveDepositSats).toBe(282n);
    expect(simulation.totalStxStakerRewardsSats).toBe(1_598n);
    expect(simulation.manager).toEqual({
      stxRewardSats: 799n,
      bondRewardSats: 55n,
      grossRewardSats: 854n,
    });
  });

  it("omits a manager result when any share input is missing and allocates no-STX rewards to reserve", () => {
    const simulation = simulatePox5CalculateRewards({
      grossAccruedRewardsSats: 11n,
      currentReserveBalanceSats: 5n,
      cycleStakedUstx: 0n,
      currentRewardsPerUstx: 9n,
      bonds: [
        {
          ...bond(0n, 1n, 1n),
          totalSharesSats: 0n,
          currentRewardsPerSat: 0n,
        },
      ],
    });

    expect(simulation.manager).toBeNull();
    expect(simulation.reserveDepositSats).toBe(11n);
    expect(simulation.reserveBalanceSats).toBe(16n);
    expect(simulation.accruedRewardsPerUstx).toBe(0n);
    expect(simulation.cumulativeRewardsPerUstx).toBe(9n);
  });

  it("fails closed on impossible shares and Clarity uint overflow", () => {
    expect(() =>
      simulatePox5CalculateRewards({
        grossAccruedRewardsSats: 1n,
        currentReserveBalanceSats: 0n,
        cycleStakedUstx: 1n,
        currentRewardsPerUstx: 0n,
        managerStxSharesUstx: 2n,
        bonds: [],
      }),
    ).toThrow("manager STX shares cannot exceed total STX shares");

    expect(() =>
      simulatePox5CalculateRewards({
        grossAccruedRewardsSats: 1n,
        currentReserveBalanceSats: 0n,
        cycleStakedUstx: 1n,
        currentRewardsPerUstx: 0n,
        bonds: [
          {
            ...bond(0n, 1n, (1n << 128n) - 1n),
            totalSharesSats: (1n << 128n) - 1n,
            currentRewardsPerSat: 0n,
          },
        ],
      }),
    ).toThrow("target-yield product exceeds Clarity uint bounds");
  });

  it("pins the reviewed PoX-5 precision constant", () => {
    expect(POX5_REWARD_PRECISION).toBe(1_000_000_000_000_000_000n);
  });
});
