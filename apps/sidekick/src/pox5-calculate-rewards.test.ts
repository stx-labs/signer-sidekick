import {
  bufferCV,
  cvToHex,
  falseCV,
  listCV,
  noneCV,
  someCV,
  trueCV,
  tupleCV,
  uintCV,
} from "@stacks/transactions";
import { describe, expect, it, vi } from "vitest";
import type { ChainAnchor } from "./chain-anchor.js";
import {
  type Pox5CalculateRewardsError,
  readPox5CalculateRewardsObservation,
  readPox5CurrentPoolEstimate,
  readPox5PoolSimulationSnapshot,
  simulatePox5PoolEstimateAtGross,
} from "./pox5-calculate-rewards.js";

const pox5ContractId = "SP000000000000000000002Q6VF78.pox-5";
const sender = "SP000000000000000000002Q6VF78";
const indexBlockHash = `0x${"ab".repeat(32)}`;
const chainAnchor: ChainAnchor = {
  stacksBlockHeight: 9_000,
  indexBlockHash,
  burnBlockHeight: 8_000,
  rewardCycle: 5,
  rewardCycleLength: 100,
  prepareCycleLength: 10,
  cyclePosition: 50,
  phase: "reward",
  checkpoint: "second-half",
};

function protocolBond(stxValueRatio: bigint) {
  return someCV(
    tupleCV({
      "target-rate": uintCV(500),
      "stx-value-ratio": uintCV(stxValueRatio),
      "min-ustx-ratio": uintCV(10_000),
      "early-unlock-bytes": bufferCV(Buffer.from("00", "hex")),
    }),
  );
}

function node(options: { lastCompute?: bigint; activeWithoutBond?: boolean } = {}) {
  return {
    callReadOnly: vi.fn(
      async (
        _principal: string,
        functionName: string,
        _sender: string,
        args: readonly string[],
        readOptions?: { tip?: string },
      ) => {
        expect(readOptions).toEqual({ tip: indexBlockHash });
        if (functionName === "get-last-reward-compute-height") {
          return uintCV(options.lastCompute ?? 7_949n);
        }
        if (functionName === "get-new-rewards") return uintCV(2_000);
        if (functionName === "bond-period-to-reward-cycle") return uintCV(1);
        if (functionName === "get-reserve-balance") return uintCV(50);
        const bucketArg = args.at(-1);
        const stxBucket = bucketArg === cvToHex(noneCV());
        const bondZero = bucketArg === cvToHex(someCV(uintCV(0)));
        if (functionName === "get-total-shares-staked-for-cycle") {
          return uintCV(stxBucket ? 50_000_000_000n : bondZero ? 40_000n : 100_000n);
        }
        if (functionName === "get-rewards-per-token-for-cycle") return uintCV(0);
        if (functionName === "get-signer-shares-staked-for-cycle") {
          return uintCV(stxBucket ? 25_000_000_000n : bondZero ? 10_000n : 50_000n);
        }
        const decodedIndex =
          args[0] === cvToHex(uintCV(0)) ? 0n : args[0] === cvToHex(uintCV(1)) ? 1n : 2n;
        if (functionName === "get-protocol-bond") {
          if (decodedIndex === 0n) return protocolBond(100);
          if (decodedIndex === 2n && !options.activeWithoutBond) return protocolBond(200);
          return noneCV();
        }
        if (functionName === "is-bond-active-at-height") {
          return decodedIndex === 1n ? falseCV() : trueCV();
        }
        throw new Error(`Unexpected read ${functionName}`);
      },
    ),
    getDataVar: vi.fn(),
    getMapEntry: vi.fn(),
  };
}

describe("PoX-5 calculate-rewards observation", () => {
  it("seals the complete active set in the contract's required order", async () => {
    const reader = node();
    await expect(
      readPox5CalculateRewardsObservation({
        node: reader,
        pox5ContractId,
        sender,
        chainAnchor,
      }),
    ).resolves.toMatchObject({
      adapter: { id: "pox5-calculate-rewards", revision: 1 },
      targetRewardCycle: 5,
      targetCheckpoint: "first-half",
      expectedLastRewardComputeBurnHeight: 7_999,
      observedLastRewardComputeBurnHeight: "7949",
      grossAccruedRewardsSats: "2000",
      activeBonds: [{ bondIndex: "2" }, { bondIndex: "0" }],
      functionArgs: [cvToHex(listCV([uintCV(2), uintCV(0)]))],
    });
    expect(reader.callReadOnly).toHaveBeenCalledWith(
      pox5ContractId,
      "is-bond-active-at-height",
      sender,
      [cvToHex(uintCV(2)), cvToHex(uintCV(7_999))],
      { tip: indexBlockHash },
    );
  });

  it("rejects completed checkpoints and an active period without its definition", async () => {
    await expect(
      readPox5CalculateRewardsObservation({
        node: node({ lastCompute: 7_999n }),
        pox5ContractId,
        sender,
        chainAnchor,
      }),
    ).rejects.toMatchObject<Pox5CalculateRewardsError>({ code: "already-computed" });
    await expect(
      readPox5CalculateRewardsObservation({
        node: node({ activeWithoutBond: true }),
        pox5ContractId,
        sender,
        chainAnchor,
      }),
    ).rejects.toMatchObject<Pox5CalculateRewardsError>({ code: "incomplete-bond-state" });
  });

  it("reads every pool simulation input from one anchor and returns the contract-rounded current estimate", async () => {
    const estimate = await readPox5CurrentPoolEstimate({
      node: node(),
      pox5ContractId,
      managerPrincipal: sender,
      chainAnchor,
      targetRewardCycle: 5,
      targetCheckpoint: "first-half",
      calculationBurnHeight: 7_999,
      grossAccruedRewardsSats: 2_000n,
    });

    expect(estimate).toMatchObject({
      kind: "if-calculated-now",
      targetRewardCycle: 5,
      calculationBurnHeight: 7_999,
      grossSats: "850",
      stxSats: "790",
      bondSats: "60",
      inputs: {
        globalStxSharesUstx: "50000000000",
        managerStxSharesUstx: "25000000000",
        activeBonds: [
          {
            bondIndex: "2",
            targetRateBips: "500",
            globalSharesSats: "100000",
            managerSharesSats: "50000",
          },
          {
            bondIndex: "0",
            targetRateBips: "500",
            globalSharesSats: "40000",
            managerSharesSats: "10000",
          },
        ],
      },
    });
  });

  it("reuses the anchored share snapshot for a projected gross reward without ratio shortcuts", async () => {
    const snapshot = await readPox5PoolSimulationSnapshot({
      node: node(),
      pox5ContractId,
      managerPrincipal: sender,
      chainAnchor,
      targetRewardCycle: 5,
      targetCheckpoint: "first-half",
      calculationBurnHeight: 7_999,
      grossAccruedRewardsSats: 2_000n,
    });

    expect(
      simulatePox5PoolEstimateAtGross({ snapshot, grossAccruedRewardsSats: 4_000n }),
    ).toMatchObject({
      grossSats: "1700",
      stxSats: "1640",
      bondSats: "60",
      inputs: snapshot.currentEstimate.inputs,
    });
  });
});
