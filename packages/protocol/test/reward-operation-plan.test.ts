import {
  ClarityType,
  deserializeTransaction,
  getAddressFromPublicKey,
  PayloadType,
  PostConditionMode,
  privateKeyToPublic,
  wireToPostCondition,
} from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import {
  planRewardOperation,
  type RewardOperationPlanInput,
  revalidateRewardOperationPlan,
} from "../src/reward-operation-plan.js";

const publicKey = privateKeyToPublic(`${"11".repeat(32)}01`);
const senderPrincipal = getAddressFromPublicKey(publicKey, "testnet");
const manager = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.signer-manager";
const pox5 = "ST000000000000000000002AMW42H.pox-5";
const sbtc = "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token";
const staker = "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG";

const common = {
  authorization: {
    schemaVersion: 2 as const,
    kind: "operator-run" as const,
    runId: "00000000-0000-4000-8000-000000000001",
    recipeSha256: "12".repeat(32),
  },
  network: { kind: "testnet" as const, chainId: 0x8000_0005 },
  chainAnchor: {
    stacksBlockHeight: 9_000,
    burnBlockHeight: 4_100,
    indexBlockHash: `0x${"ab".repeat(32)}`,
  },
  sender: { principal: senderPrincipal, publicKey },
  managerSourceFingerprint: "34".repeat(32),
  nonce: 7n,
  feeUstx: 1_000n,
};

const cases: Array<{
  name: string;
  input: RewardOperationPlanInput;
  contractName: string;
  functionName: string;
  argumentTypes: ClarityType[];
  effect: unknown;
}> = [
  {
    name: "calculate",
    input: {
      ...common,
      kind: "calculate-rewards",
      pox5Contract: pox5,
      bondPeriods: [2n, 4n],
      targetRewardCycle: 141n,
      targetCheckpoint: "first-half",
      expectedLastRewardComputeBurnHeight: 4_099,
    },
    contractName: "pox-5",
    functionName: "calculate-rewards",
    argumentTypes: [ClarityType.List],
    effect: { kind: "no-asset-transfer" },
  },
  {
    name: "collect",
    input: {
      ...common,
      kind: "claim-rewards",
      managerContract: manager,
      pox5Contract: pox5,
      sbtcTokenContract: sbtc,
      rewardCycle: 141n,
      bondPeriods: [2n, 4n],
      expectedSbtcOutflow: 10_000n,
    },
    contractName: "signer-manager",
    functionName: "claim-rewards",
    argumentTypes: [ClarityType.List, ClarityType.UInt],
    effect: {
      kind: "exact-ft-transfer",
      sender: pox5,
      recipient: manager,
      amountSats: "10000",
    },
  },
  {
    name: "direct payment",
    input: {
      ...common,
      kind: "claim-staker-rewards",
      managerContract: manager,
      sbtcTokenContract: sbtc,
      stakerPrincipal: staker,
      rewardCycle: 141n,
      bondIndex: null,
      payoutRoute: "direct-sbtc",
      grossSats: 10_000n,
      feeSats: 500n,
      expectedNetSats: 9_500n,
    },
    contractName: "signer-manager",
    functionName: "claim-staker-rewards",
    argumentTypes: [ClarityType.PrincipalStandard, ClarityType.UInt, ClarityType.OptionalNone],
    effect: {
      kind: "exact-ft-transfer",
      sender: manager,
      recipient: staker,
      amountSats: "9500",
    },
  },
  {
    name: "settle accepted Bitcoin withdrawal",
    input: {
      ...common,
      kind: "settle-accepted-withdrawal",
      managerContract: manager,
      requestId: 42n,
      stakerPrincipal: staker,
    },
    contractName: "signer-manager",
    functionName: "settle-accepted-withdrawal",
    argumentTypes: [ClarityType.UInt],
    effect: { kind: "no-asset-transfer" },
  },
  {
    name: "return rejected Bitcoin withdrawal",
    input: {
      ...common,
      kind: "reclaim-failed-withdrawal",
      managerContract: manager,
      sbtcTokenContract: sbtc,
      requestId: 43n,
      stakerPrincipal: staker,
      withdrawalAmountSats: 8_500n,
      maxFeeSats: 1_000n,
    },
    contractName: "signer-manager",
    functionName: "reclaim-failed-withdrawal",
    argumentTypes: [ClarityType.UInt],
    effect: {
      kind: "exact-ft-transfer",
      sender: manager,
      recipient: staker,
      amountSats: "9500",
    },
  },
];

describe("operator-run reward operation adapters", () => {
  it.each(cases)("serializes and revalidates the $name adapter", async (testCase) => {
    const plan = await planRewardOperation(testCase.input);
    const transaction = deserializeTransaction(plan.unsignedTransactionHex);

    expect(transaction.postConditionMode).toBe(PostConditionMode.Deny);
    expect(transaction.payload.payloadType).toBe(PayloadType.ContractCall);
    if (transaction.payload.payloadType !== PayloadType.ContractCall) {
      throw new Error("Expected a contract call");
    }
    expect(transaction.payload.contractName.content).toBe(testCase.contractName);
    expect(transaction.payload.functionName.content).toBe(testCase.functionName);
    expect(transaction.payload.functionArgs.map(({ type }) => type)).toEqual(
      testCase.argumentTypes,
    );
    expect(plan.material.expectedEffect).toMatchObject(testCase.effect as Record<string, unknown>);
    await expect(revalidateRewardOperationPlan(plan)).resolves.toEqual(plan);
  });

  it("pins the direct and Bitcoin payout routes while keeping the exact manager outflow", async () => {
    const payoutInput = cases[2]?.input;
    if (payoutInput?.kind !== "claim-staker-rewards") {
      throw new Error("Expected the staker-payment fixture");
    }
    const direct = await planRewardOperation(payoutInput);
    const bitcoin = await planRewardOperation({
      ...payoutInput,
      payoutRoute: "bitcoin-l1",
    });

    expect(bitcoin.material.expectedEffect).toMatchObject({
      recipient: "sbtc-withdrawal",
      amountSats: "9500",
    });
    expect(bitcoin.planSha256).not.toBe(direct.planSha256);
    expect(
      deserializeTransaction(bitcoin.unsignedTransactionHex).postConditions.values.map(
        wireToPostCondition,
      ),
    ).toEqual(
      deserializeTransaction(direct.unsignedTransactionHex).postConditions.values.map(
        wireToPostCondition,
      ),
    );
  });

  it("rejects any persisted material or byte mutation", async () => {
    const collectInput = cases[1]?.input;
    if (!collectInput) throw new Error("Expected the collect fixture");
    const plan = await planRewardOperation(collectInput);
    await expect(
      revalidateRewardOperationPlan({
        ...plan,
        material: {
          ...plan.material,
          authorization: { ...plan.material.authorization, recipeSha256: "ef".repeat(32) },
        },
      }),
    ).rejects.toThrow("sealed plan mismatch");
    await expect(
      revalidateRewardOperationPlan({
        ...plan,
        unsignedTransactionHex: `${plan.unsignedTransactionHex}00`,
      }),
    ).rejects.toThrow();
  });
});
