import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  Cl,
  type ClarityValue,
  compressPublicKey,
  deserializeTransaction,
  getAddressFromPublicKey,
  PayloadType,
  privateKeyToPublic,
  serializeCV,
  signWithKey,
} from "@stacks/transactions";
import { beforeEach, describe, expect, it } from "vitest";
import { simulatePox5CalculateRewards } from "../../../packages/protocol/src/pox5-calculate-rewards.js";
import { decodePox5CalculateRewardsEvent } from "../../../packages/protocol/src/pox5-events.js";
import {
  planRewardOperation,
  type RewardOperationPlan,
} from "../../../packages/protocol/src/reward-operation-plan.js";

const root = resolve(import.meta.dirname, "../../..");
const deployer = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";
const managerId = `${deployer}.signer-manager`;
const managerTwoId = `${deployer}.signer-manager-two`;
const pox5Id = "ST000000000000000000002AMW42H.pox-5";
const deploymentPlanPox5Id = `${deployer}.pox-5`;
const sbtcDeployer = "ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT";
const sbtcTokenId = `${sbtcDeployer}.sbtc-token`;
const sbtcAssetId = `${sbtcTokenId}.sbtc-token`;
const sbtcRegistryId = `${sbtcDeployer}.sbtc-registry`;
const sbtcWithdrawalId = `${sbtcDeployer}.sbtc-withdrawal`;
const signerPrivateKey = `${"11".repeat(32)}01`;
const minimumStake = 50_000_000_000n;
const rewardCycleLength = 100n;
const halfCycleLength = rewardCycleLength / 2n;

const withdrawalSource = readFileSync(
  resolve(import.meta.dirname, "contracts/sbtc-withdrawal.clar"),
  "utf8",
);
const registrySource = readFileSync(
  resolve(import.meta.dirname, "contracts/sbtc-registry.clar"),
  "utf8",
);
const tokenSource = readFileSync(resolve(import.meta.dirname, "contracts/sbtc-token.clar"), "utf8");
const managerSource = readFileSync(
  resolve(root, "contracts/reference-manager/generated/regtest/signer-manager.clar"),
  "utf8",
);

function normalizeTrailingNewlines(source: string): string {
  return `${source.trimEnd()}\n`;
}

function expectOk(result: ClarityValue, expected?: ClarityValue): void {
  if (expected) {
    expect(result).toBeOk(expected);
  } else {
    expect(result.type).toBe("ok");
  }
}

function uintValue(result: ClarityValue): bigint {
  if (result.type !== "uint") {
    throw new Error(`Expected a uint Clarity value, received ${result.type}`);
  }
  return BigInt(result.value);
}

function expectCalculateRewardsPrint(
  events: Array<{
    event: string;
    data: { contract_identifier?: string; value?: ClarityValue };
  }>,
  expected: {
    bondPeriods: bigint[];
    calculationBurnHeight: bigint;
    grossAccruedRewardsSats: bigint;
    totalBondRewardsSats: bigint;
    reserveDepositSats: bigint;
    reserveBalanceSats: bigint;
    rewardCycle: bigint;
    totalStxStakerRewardsSats: bigint;
    cycleStakedUstx: bigint;
    accruedRewardsPerUstx: bigint;
    cumulativeRewardsPerUstx: bigint;
  },
): void {
  const realization = events
    .filter(
      ({ event, data }) =>
        event === "print_event" && data.contract_identifier === pox5Id && data.value !== undefined,
    )
    .map(({ data }) => decodePox5CalculateRewardsEvent(data.value as ClarityValue))
    .find((candidate) => candidate !== null);
  if (!realization) throw new Error("PoX-5 calculate-rewards print was not emitted");
  expect(realization).toEqual({
    kind: "calculate-rewards",
    topic: "calculate-rewards",
    bondPeriods: expected.bondPeriods.map(String),
    calculationBurnHeight: expected.calculationBurnHeight.toString(),
    grossAccruedRewardsSats: expected.grossAccruedRewardsSats.toString(),
    totalBondRewardsSats: expected.totalBondRewardsSats.toString(),
    reserveDepositSats: expected.reserveDepositSats.toString(),
    reserveBalanceSats: expected.reserveBalanceSats.toString(),
    rewardCycle: expected.rewardCycle.toString(),
    totalStxStakerRewardsSats: expected.totalStxStakerRewardsSats.toString(),
    cycleStakedUstx: expected.cycleStakedUstx.toString(),
    accruedRewardsPerUstx: expected.accruedRewardsPerUstx.toString(),
    cumulativeRewardsPerUstx: expected.cumulativeRewardsPerUstx.toString(),
  });
}

function bufferValue(result: ClarityValue): string {
  if (result.type !== "buffer") {
    throw new Error(`Expected a buffer Clarity value, received ${result.type}`);
  }
  return result.value;
}

function optionalBufferValue(result: ClarityValue): string {
  if (result.type !== "some") {
    throw new Error(`Expected an optional Clarity value, received ${result.type}`);
  }
  return bufferValue(result.value);
}

function initializePox5(): void {
  const configured = simnet.callPublicFn(
    pox5Id,
    "set-burnchain-parameters",
    [Cl.uint(0), Cl.uint(10), Cl.uint(rewardCycleLength), Cl.uint(1)],
    deployer,
  );
  expectOk(configured.result, Cl.bool(true));
}

function registerManagerContract(managerContractId: string): {
  signerKey: string;
  signerPrincipal: string;
} {
  const authId = 1n;
  const publicKey = privateKeyToPublic(signerPrivateKey);
  const signerKey =
    typeof publicKey === "string" ? publicKey : Buffer.from(publicKey).toString("hex");
  const messageHash = bufferValue(
    simnet.callReadOnlyFn(
      pox5Id,
      "get-signer-grant-message-hash",
      [Cl.principal(managerContractId), Cl.uint(authId)],
      deployer,
    ).result,
  );
  const vrsSignature = signWithKey(signerPrivateKey, messageHash);
  const rsvSignature = `${vrsSignature.slice(2)}${vrsSignature.slice(0, 2)}`;
  const registration = simnet.callPublicFn(
    managerContractId,
    "register-self",
    [
      Cl.principal(managerContractId),
      Cl.bufferFromHex(signerKey),
      Cl.uint(authId),
      Cl.bufferFromHex(rsvSignature),
    ],
    deployer,
  );
  expect(registration.result.type).toBe("ok");
  expect(
    simnet.callReadOnlyFn(pox5Id, "get-signer-info", [Cl.principal(managerContractId)], deployer)
      .result,
  ).toBeSome(Cl.bufferFromHex(signerKey));
  return {
    signerKey,
    signerPrincipal: getAddressFromPublicKey(signerKey, "testnet"),
  };
}

function registerManager(): { signerKey: string; signerPrincipal: string } {
  return registerManagerContract(managerId);
}

function stake(staker: string, signerCalldata: ClarityValue = Cl.none()) {
  const result = simnet.callPublicFn(
    pox5Id,
    "stake",
    [
      Cl.principal(managerId),
      Cl.uint(minimumStake),
      Cl.uint(2),
      Cl.uint(simnet.burnBlockHeight),
      signerCalldata,
    ],
    staker,
  );
  expect(result.result.type).toBe("ok");
  return result;
}

function distributeRewards(rewards: bigint) {
  const permissionlessCaller = simnet.getAccounts().get("wallet_2");
  if (!permissionlessCaller) throw new Error("Clarinet wallet fixture is missing");
  const cycleStart = uintValue(
    simnet.callReadOnlyFn(pox5Id, "reward-cycle-to-burn-height", [Cl.uint(1)], deployer).result,
  );
  simnet.mintFT(sbtcAssetId, deployer, rewards);
  expectOk(
    simnet.callPublicFn(
      sbtcTokenId,
      "transfer",
      [Cl.uint(rewards), Cl.principal(deployer), Cl.principal(pox5Id), Cl.none()],
      deployer,
    ).result,
    Cl.bool(true),
  );
  const targetHeight = cycleStart + halfCycleLength;
  simnet.mineEmptyBurnBlocks(Number(targetHeight - BigInt(simnet.burnBlockHeight)));
  const calculation = simnet.callPublicFn(
    pox5Id,
    "calculate-rewards",
    [Cl.list([])],
    permissionlessCaller,
  );
  const simulation = simulatePox5CalculateRewards({
    grossAccruedRewardsSats: rewards,
    currentReserveBalanceSats: 0n,
    cycleStakedUstx: minimumStake,
    currentRewardsPerUstx: 0n,
    managerStxSharesUstx: minimumStake,
    bonds: [],
  });
  expect(calculation.result).toBeOk(
    Cl.tuple({
      "bond-periods": Cl.list([]),
      "calculation-height": Cl.uint(cycleStart + halfCycleLength - 1n),
      "gross-accrued-rewards": Cl.uint(simulation.grossAccruedRewardsSats),
      "total-bond-rewards": Cl.uint(simulation.totalBondRewardsSats),
      "reserve-deposit": Cl.uint(simulation.reserveDepositSats),
      "reserve-balance": Cl.uint(simulation.reserveBalanceSats),
      "stx-cycle": Cl.uint(1),
      "total-stx-staker-rewards": Cl.uint(simulation.totalStxStakerRewardsSats),
      "cycle-staked-ustx": Cl.uint(simulation.cycleStakedUstx),
      "accrued-rewards-per-ustx": Cl.uint(simulation.accruedRewardsPerUstx),
      "cumulative-rewards-per-ustx": Cl.uint(simulation.cumulativeRewardsPerUstx),
    }),
  );
  expectCalculateRewardsPrint(calculation.events, {
    bondPeriods: [],
    calculationBurnHeight: cycleStart + halfCycleLength - 1n,
    rewardCycle: 1n,
    ...simulation,
  });
  expect(simulation).toMatchObject({
    reserveDepositSats: 300n,
    totalStxStakerRewardsSats: 1_700n,
    accruedRewardsPerUstx: 34_000_000_000n,
    manager: { grossRewardSats: 1_700n },
  });
  expect(
    uintValue(
      simnet.callReadOnlyFn(
        pox5Id,
        "get-earned",
        [Cl.principal(managerId), Cl.uint(1), Cl.none()],
        deployer,
      ).result,
    ),
  ).toBe(simulation.manager?.grossRewardSats);
  const claim = simnet.callPublicFn(
    managerId,
    "claim-rewards",
    [Cl.list([]), Cl.uint(1)],
    permissionlessCaller,
  );
  expect(claim.result.type).toBe("ok");
  return { calculation, claim };
}

function sbtcBalance(principal: string): bigint {
  const response = simnet.callReadOnlyFn(
    sbtcTokenId,
    "get-balance",
    [Cl.principal(principal)],
    deployer,
  ).result;
  if (response.type !== "ok") throw new Error("sBTC get-balance returned an error");
  return uintValue(response.value);
}

function poxAddressCalldata(maxFee: bigint): ClarityValue {
  const encoded = serializeCV(
    Cl.tuple({
      "pox-addr": Cl.tuple({
        version: Cl.buffer(new Uint8Array([0])),
        hashbytes: Cl.buffer(new Uint8Array(20).fill(7)),
      }),
      "max-fee": Cl.uint(maxFee),
    }),
  ).replace(/^0x/, "");
  return Cl.some(Cl.buffer(Uint8Array.from(Buffer.from(encoded, "hex"))));
}

function executeRewardPlan(plan: RewardOperationPlan, caller: string) {
  const transaction = deserializeTransaction(plan.unsignedTransactionHex);
  if (transaction.payload.payloadType !== PayloadType.ContractCall) {
    throw new Error("Reward adapter did not produce a contract call");
  }
  const contractId =
    plan.material.kind === "calculate-rewards"
      ? plan.material.pox5Contract
      : plan.material.managerContract;
  return simnet.callPublicFn(
    contractId,
    transaction.payload.functionName.content,
    transaction.payload.functionArgs as ClarityValue[],
    caller,
  );
}

describe("Epoch 4.0 PoX-5 lifecycle harness", () => {
  beforeEach(() => {
    simnet.deployContract("sbtc-withdrawal", withdrawalSource, { clarityVersion: 3 }, sbtcDeployer);
    simnet.deployContract("signer-manager", managerSource, { clarityVersion: 6 }, deployer);
  });

  it("loads the rendered contracts and keeps every regtest principal aligned", () => {
    expect(simnet.currentEpoch).toBe("4.0");
    expect(pox5Id).not.toBe(deploymentPlanPox5Id);
    expect(simnet.getContractSource(pox5Id)).toContain(sbtcTokenId);
    expect(simnet.getContractSource(managerId)).toContain(pox5Id);
    expect(simnet.getContractSource(managerId)).toContain(sbtcWithdrawalId);
    expect(normalizeTrailingNewlines(simnet.getContractSource(sbtcRegistryId))).toBe(
      normalizeTrailingNewlines(registrySource),
    );
    expect(normalizeTrailingNewlines(simnet.getContractSource(sbtcTokenId))).toBe(
      normalizeTrailingNewlines(tokenSource),
    );
    expect(simnet.getContractSource(managerId)).not.toContain(
      "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4",
    );
  });

  it("round-trips every sealed reward adapter through the real regtest contracts", async () => {
    initializePox5();
    registerManager();
    const stakerOne = simnet.getAccounts().get("wallet_1");
    const stakerTwo = simnet.getAccounts().get("wallet_2");
    if (!stakerOne || !stakerTwo) throw new Error("Clarinet wallet fixtures are missing");
    expectOk(
      simnet.callPublicFn(managerId, "update-fees", [Cl.uint(1_000)], deployer).result,
      Cl.bool(true),
    );
    stake(stakerOne, poxAddressCalldata(100n));
    stake(stakerTwo, poxAddressCalldata(100n));

    const rewards = 4_000n;
    simnet.mintFT(sbtcAssetId, deployer, rewards);
    expectOk(
      simnet.callPublicFn(
        sbtcTokenId,
        "transfer",
        [Cl.uint(rewards), Cl.principal(deployer), Cl.principal(pox5Id), Cl.none()],
        deployer,
      ).result,
      Cl.bool(true),
    );
    const cycleStart = uintValue(
      simnet.callReadOnlyFn(pox5Id, "reward-cycle-to-burn-height", [Cl.uint(1)], deployer).result,
    );
    simnet.mineEmptyBurnBlocks(
      Number(cycleStart + halfCycleLength - BigInt(simnet.burnBlockHeight)),
    );

    const publicKey = compressPublicKey(privateKeyToPublic(signerPrivateKey));
    const caller = getAddressFromPublicKey(publicKey, "testnet");
    const common = {
      authorization: {
        schemaVersion: 2 as const,
        kind: "operator-run" as const,
        runId: "00000000-0000-4000-8000-000000000001",
        recipeSha256: "12".repeat(32),
      },
      network: { kind: "testnet" as const, chainId: 0x8000_0000 },
      chainAnchor: {
        stacksBlockHeight: simnet.blockHeight,
        burnBlockHeight: simnet.burnBlockHeight,
        indexBlockHash: `0x${"ab".repeat(32)}`,
      },
      sender: { principal: caller, publicKey },
      managerSourceFingerprint: "34".repeat(32),
      nonce: 0n,
      feeUstx: 1_000n,
    };

    const calculate = await planRewardOperation({
      ...common,
      kind: "calculate-rewards",
      pox5Contract: pox5Id,
      bondPeriods: [],
      targetRewardCycle: 1n,
      targetCheckpoint: "first-half",
      expectedLastRewardComputeBurnHeight: Number(cycleStart + halfCycleLength - 1n),
    });
    expectOk(executeRewardPlan(calculate, caller).result);

    const collectAmount = uintValue(
      simnet.callReadOnlyFn(
        pox5Id,
        "get-earned",
        [Cl.principal(managerId), Cl.uint(1), Cl.none()],
        caller,
      ).result,
    );
    const collect = await planRewardOperation({
      ...common,
      kind: "claim-rewards",
      managerContract: managerId,
      pox5Contract: pox5Id,
      sbtcTokenContract: sbtcTokenId,
      rewardCycle: 1n,
      bondPeriods: [],
      expectedSbtcOutflow: collectAmount,
    });
    expectOk(executeRewardPlan(collect, caller).result);

    for (const [index, staker] of [stakerOne, stakerTwo].entries()) {
      const earned = simnet.callReadOnlyFn(
        managerId,
        "get-earned-staker-rewards",
        [Cl.principal(staker), Cl.uint(1), Cl.none()],
        caller,
      ).result;
      if (earned.type !== "tuple") throw new Error("Expected earned reward tuple");
      const net = uintValue(earned.value.earned as ClarityValue);
      const fee = uintValue(earned.value.fees as ClarityValue);
      const payment = await planRewardOperation({
        ...common,
        nonce: BigInt(index + 1),
        kind: "claim-staker-rewards",
        managerContract: managerId,
        sbtcTokenContract: sbtcTokenId,
        stakerPrincipal: staker,
        rewardCycle: 1n,
        bondIndex: null,
        payoutRoute: "bitcoin-l1",
        grossSats: net + fee,
        feeSats: fee,
        expectedNetSats: net,
      });
      expectOk(executeRewardPlan(payment, caller).result);
    }

    expectOk(
      simnet.callPublicFn(
        sbtcWithdrawalId,
        "reject-withdrawal-request",
        [Cl.uint(1), Cl.uint(0)],
        sbtcDeployer,
      ).result,
      Cl.bool(true),
    );
    const burnHeight = BigInt(simnet.burnBlockHeight - 1);
    const burnHash = optionalBufferValue(
      simnet.callReadOnlyFn(
        sbtcWithdrawalId,
        "get-burn-header",
        [Cl.uint(burnHeight)],
        sbtcDeployer,
      ).result,
    );
    expectOk(
      simnet.callPublicFn(
        sbtcWithdrawalId,
        "accept-withdrawal-request",
        [
          Cl.uint(2),
          Cl.buffer(new Uint8Array(32).fill(1)),
          Cl.uint(0),
          Cl.uint(0),
          Cl.uint(40),
          Cl.bufferFromHex(burnHash),
          Cl.uint(burnHeight),
          Cl.buffer(new Uint8Array(32).fill(2)),
        ],
        sbtcDeployer,
      ).result,
      Cl.bool(true),
    );

    const firstEarned = collectAmount / 2n - collectAmount / 2n / 10n;
    const reclaim = await planRewardOperation({
      ...common,
      nonce: 3n,
      kind: "reclaim-failed-withdrawal",
      managerContract: managerId,
      sbtcTokenContract: sbtcTokenId,
      requestId: 1n,
      stakerPrincipal: stakerOne,
      withdrawalAmountSats: firstEarned - 100n,
      maxFeeSats: 100n,
    });
    expect(reclaim.material.expectedEffect).toMatchObject({
      sender: managerId,
      recipient: stakerOne,
      amountSats: firstEarned.toString(),
    });
    expectOk(executeRewardPlan(reclaim, caller).result, Cl.bool(true));

    const settle = await planRewardOperation({
      ...common,
      nonce: 4n,
      kind: "settle-accepted-withdrawal",
      managerContract: managerId,
      requestId: 2n,
      stakerPrincipal: stakerTwo,
    });
    expect(settle.material.expectedEffect).toEqual({ kind: "no-asset-transfer" });
    expectOk(executeRewardPlan(settle, caller).result, Cl.bool(true));
    expect(
      simnet.callReadOnlyFn(managerId, "get-withdrawal-liability", [], caller).result,
    ).toBeUint(0);
    expect(sbtcBalance(stakerOne)).toBe(firstEarned);
  });

  it("registers, stakes, calculates, claims, pays a staker, and withdraws pool fees", () => {
    initializePox5();
    registerManager();
    const staker = simnet.getAccounts().get("wallet_1");
    const permissionlessCaller = simnet.getAccounts().get("wallet_2");
    if (!staker || !permissionlessCaller) throw new Error("Clarinet wallet fixtures are missing");

    expectOk(
      simnet.callPublicFn(managerId, "update-fees", [Cl.uint(1_000)], deployer).result,
      Cl.bool(true),
    );
    const stakeResult = stake(staker);
    const distribution = distributeRewards(2_000n);
    expectOk(
      simnet.callPublicFn(managerId, "update-fees", [Cl.uint(2_000)], deployer).result,
      Cl.bool(true),
    );

    expect(JSON.stringify(stakeResult.events)).toContain("stake");
    expect(JSON.stringify(distribution.calculation.events)).toContain("calculate-rewards");
    expect(JSON.stringify(distribution.claim.events)).toContain("claim-rewards");

    expect(
      simnet.callReadOnlyFn(
        managerId,
        "get-earned-staker-rewards",
        [Cl.principal(staker), Cl.uint(1), Cl.none()],
        deployer,
      ).result,
    ).toBeTuple({ earned: Cl.uint(1_530), fees: Cl.uint(170) });
    expect(
      simnet.callPublicFn(
        managerId,
        "claim-staker-rewards",
        [Cl.principal(staker), Cl.uint(1), Cl.none()],
        permissionlessCaller,
      ).result,
    ).toBeOk(Cl.tuple({ earned: Cl.uint(1_530), "withdrawal-request": Cl.none() }));
    expect(sbtcBalance(staker)).toBe(1_530n);
    expect(simnet.callReadOnlyFn(managerId, "get-earned-fees", [], deployer).result).toBeUint(170);
    expect(
      simnet.callReadOnlyFn(managerId, "get-unclaimed-staker-rewards", [], deployer).result,
    ).toBeUint(0);

    expect(
      simnet.callPublicFn(
        managerId,
        "withdraw-fees",
        [Cl.uint(170), Cl.principal(deployer)],
        permissionlessCaller,
      ).result,
    ).toBeErr(Cl.uint(1_002));
    expect(
      simnet.callPublicFn(
        managerId,
        "update-admin",
        [Cl.principal(permissionlessCaller), Cl.bool(true)],
        deployer,
      ).result,
    ).toBeOk(Cl.principal(permissionlessCaller));
    expect(
      simnet.callPublicFn(
        managerId,
        "withdraw-fees",
        [Cl.uint(170), Cl.principal(deployer)],
        permissionlessCaller,
      ).result,
    ).toBeOk(Cl.uint(170));
    expect(sbtcBalance(deployer)).toBe(170n);
  });

  it("routes an STX staker reward to L1 and permissionlessly reclaims a rejected withdrawal", () => {
    initializePox5();
    registerManager();
    const staker = simnet.getAccounts().get("wallet_1");
    const permissionlessCaller = simnet.getAccounts().get("wallet_2");
    if (!staker || !permissionlessCaller) throw new Error("Clarinet wallet fixtures are missing");

    stake(staker, poxAddressCalldata(100n));
    distributeRewards(2_000n);
    expect(
      simnet.callPublicFn(
        managerId,
        "claim-staker-rewards",
        [Cl.principal(staker), Cl.uint(1), Cl.none()],
        permissionlessCaller,
      ).result,
    ).toBeOk(Cl.tuple({ earned: Cl.uint(1_700), "withdrawal-request": Cl.some(Cl.uint(1)) }));
    expect(sbtcBalance(staker)).toBe(0n);
    expect(
      simnet.callReadOnlyFn(managerId, "get-withdrawal-liability", [], deployer).result,
    ).toBeUint(1_700);
    expect(
      simnet.callReadOnlyFn(sbtcRegistryId, "get-withdrawal-request", [Cl.uint(1)], deployer)
        .result,
    ).toBeSome(
      Cl.tuple({
        amount: Cl.uint(1_600),
        "max-fee": Cl.uint(100),
        sender: Cl.principal(managerId),
        recipient: Cl.tuple({
          version: Cl.buffer(new Uint8Array([0])),
          hashbytes: Cl.buffer(new Uint8Array(20).fill(7)),
        }),
        "block-height": Cl.uint(simnet.burnBlockHeight),
        status: Cl.none(),
      }),
    );

    expect(
      simnet.callPublicFn(
        sbtcWithdrawalId,
        "reject-withdrawal-request",
        [Cl.uint(1), Cl.uint(0)],
        sbtcDeployer,
      ).result,
    ).toBeOk(Cl.bool(true));
    expect(
      simnet.callPublicFn(
        managerId,
        "reclaim-failed-withdrawal",
        [Cl.uint(1)],
        permissionlessCaller,
      ).result,
    ).toBeOk(Cl.bool(true));
    expect(sbtcBalance(staker)).toBe(1_700n);
    expect(
      simnet.callReadOnlyFn(managerId, "get-withdrawal-liability", [], deployer).result,
    ).toBeUint(0);
    expect(
      simnet.callReadOnlyFn(managerId, "get-withdrawal-request-staker", [Cl.uint(1)], deployer)
        .result,
    ).toBeNone();
  });

  it("rejects an L1 payout whose reward cannot cover the configured maximum fee", () => {
    initializePox5();
    registerManager();
    const staker = simnet.getAccounts().get("wallet_1");
    const permissionlessCaller = simnet.getAccounts().get("wallet_2");
    if (!staker || !permissionlessCaller) throw new Error("Clarinet wallet fixtures are missing");

    stake(staker, poxAddressCalldata(2_000n));
    distributeRewards(2_000n);
    expect(
      simnet.callPublicFn(
        managerId,
        "claim-staker-rewards",
        [Cl.principal(staker), Cl.uint(1), Cl.none()],
        permissionlessCaller,
      ).result.type,
    ).toBe("err");
    expect(sbtcBalance(staker)).toBe(0n);
    expect(
      simnet.callReadOnlyFn(managerId, "get-withdrawal-liability", [], deployer).result,
    ).toBeUint(0);
  });

  it("blocks new stake after the signer revokes the manager grant", () => {
    initializePox5();
    const { signerKey, signerPrincipal } = registerManager();
    const staker = simnet.getAccounts().get("wallet_1");
    if (!staker) throw new Error("Clarinet wallet fixture is missing");

    expect(
      simnet.callPublicFn(
        pox5Id,
        "revoke-signer-grant",
        [Cl.principal(managerId), Cl.bufferFromHex(signerKey)],
        signerPrincipal,
      ).result.type,
    ).toBe("ok");
    expect(
      simnet.callPublicFn(
        pox5Id,
        "stake",
        [
          Cl.principal(managerId),
          Cl.uint(minimumStake),
          Cl.uint(2),
          Cl.uint(simnet.burnBlockHeight),
          Cl.none(),
        ],
        staker,
      ).result,
    ).toBeErr(Cl.uint(17));
  });

  it("settles an accepted L1 withdrawal and sweeps only the returned fee dust", () => {
    initializePox5();
    registerManager();
    const staker = simnet.getAccounts().get("wallet_1");
    const permissionlessCaller = simnet.getAccounts().get("wallet_2");
    if (!staker || !permissionlessCaller) throw new Error("Clarinet wallet fixtures are missing");

    stake(staker, poxAddressCalldata(100n));
    distributeRewards(2_000n);
    expect(
      simnet.callPublicFn(
        managerId,
        "claim-staker-rewards",
        [Cl.principal(staker), Cl.uint(1), Cl.none()],
        permissionlessCaller,
      ).result,
    ).toBeOk(Cl.tuple({ earned: Cl.uint(1_700), "withdrawal-request": Cl.some(Cl.uint(1)) }));

    const burnHeight = BigInt(simnet.burnBlockHeight - 1);
    const burnHash = optionalBufferValue(
      simnet.callReadOnlyFn(
        sbtcWithdrawalId,
        "get-burn-header",
        [Cl.uint(burnHeight)],
        sbtcDeployer,
      ).result,
    );
    expect(
      simnet.callPublicFn(
        sbtcWithdrawalId,
        "accept-withdrawal-request",
        [
          Cl.uint(1),
          Cl.buffer(new Uint8Array(32).fill(1)),
          Cl.uint(0),
          Cl.uint(0),
          Cl.uint(40),
          Cl.bufferFromHex(burnHash),
          Cl.uint(burnHeight),
          Cl.buffer(new Uint8Array(32).fill(2)),
        ],
        sbtcDeployer,
      ).result,
    ).toBeOk(Cl.bool(true));
    expect(sbtcBalance(managerId)).toBe(60n);
    expect(
      simnet.callPublicFn(
        managerId,
        "settle-accepted-withdrawal",
        [Cl.uint(1)],
        permissionlessCaller,
      ).result,
    ).toBeOk(Cl.bool(true));
    expect(
      simnet.callReadOnlyFn(managerId, "get-withdrawal-liability", [], deployer).result,
    ).toBeUint(0);
    expect(
      simnet.callPublicFn(managerId, "sweep-fee-refunds", [Cl.principal(deployer)], deployer)
        .result,
    ).toBeOk(Cl.uint(60));
    expect(sbtcBalance(deployer)).toBe(60n);
    expect(sbtcBalance(managerId)).toBe(0n);
  });

  it("truncates future-cycle membership when an STX staker unstakes early", () => {
    initializePox5();
    registerManager();
    const staker = simnet.getAccounts().get("wallet_1");
    if (!staker) throw new Error("Clarinet wallet fixture is missing");

    stake(staker);
    const firstCycleHeight = uintValue(
      simnet.callReadOnlyFn(pox5Id, "reward-cycle-to-burn-height", [Cl.uint(1)], deployer).result,
    );
    simnet.mineEmptyBurnBlocks(Number(firstCycleHeight - BigInt(simnet.burnBlockHeight)));
    expect(
      simnet.callPublicFn(pox5Id, "unstake", [Cl.principal(managerId)], staker).result.type,
    ).toBe("ok");
    expect(
      simnet.callReadOnlyFn(pox5Id, "get-staker-info", [Cl.principal(staker)], deployer).result,
    ).toBeSome(
      Cl.tuple({
        "amount-ustx": Cl.uint(minimumStake),
        "first-reward-cycle": Cl.uint(1),
        "num-cycles": Cl.uint(1),
        signer: Cl.principal(managerId),
      }),
    );
    expect(
      simnet.callReadOnlyFn(
        pox5Id,
        "get-staker-shares-staked-for-cycle",
        [Cl.principal(staker), Cl.uint(1), Cl.none(), Cl.principal(managerId)],
        deployer,
      ).result,
    ).toBeUint(minimumStake);
    expect(
      simnet.callReadOnlyFn(
        pox5Id,
        "get-staker-shares-staked-for-cycle",
        [Cl.principal(staker), Cl.uint(2), Cl.none(), Cl.principal(managerId)],
        deployer,
      ).result,
    ).toBeUint(0);
  });

  it("updates stake membership and crosses the signer threshold in both directions", () => {
    initializePox5();
    registerManager();
    const staker = simnet.getAccounts().get("wallet_1");
    if (!staker) throw new Error("Clarinet wallet fixture is missing");

    stake(staker);
    expect(
      simnet.callReadOnlyFn(
        pox5Id,
        "signer-set-contains-for-cycle",
        [Cl.principal(managerId), Cl.uint(1)],
        deployer,
      ).result,
    ).toBeBool(true);
    expect(
      simnet.callPublicFn(
        pox5Id,
        "stake-update",
        [
          Cl.principal(managerId),
          Cl.principal(managerId),
          Cl.uint(1),
          Cl.uint(1_000_000),
          Cl.none(),
        ],
        staker,
      ).result.type,
    ).toBe("ok");
    expect(
      simnet.callReadOnlyFn(pox5Id, "get-staker-info", [Cl.principal(staker)], deployer).result,
    ).toBeSome(
      Cl.tuple({
        "amount-ustx": Cl.uint(minimumStake + 1_000_000n),
        "first-reward-cycle": Cl.uint(1),
        "num-cycles": Cl.uint(3),
        signer: Cl.principal(managerId),
      }),
    );
    expect(
      simnet.callPublicFn(pox5Id, "unstake", [Cl.principal(managerId)], staker).result.type,
    ).toBe("ok");
    expect(
      simnet.callReadOnlyFn(
        pox5Id,
        "signer-set-contains-for-cycle",
        [Cl.principal(managerId), Cl.uint(1)],
        deployer,
      ).result,
    ).toBeBool(false);
  });

  it("keeps the current cycle with the old signer when stake-update switches signers", () => {
    initializePox5();
    registerManager();
    simnet.deployContract("signer-manager-two", managerSource, { clarityVersion: 6 }, deployer);
    registerManagerContract(managerTwoId);
    const staker = simnet.getAccounts().get("wallet_1");
    if (!staker) throw new Error("Clarinet wallet fixture is missing");

    stake(staker);
    const firstCycleStart = uintValue(
      simnet.callReadOnlyFn(pox5Id, "reward-cycle-to-burn-height", [Cl.uint(1)], deployer).result,
    );
    simnet.mineEmptyBurnBlocks(Number(firstCycleStart - BigInt(simnet.burnBlockHeight)));

    expect(
      simnet.callPublicFn(
        pox5Id,
        "stake-update",
        [
          Cl.principal(managerTwoId),
          Cl.principal(managerId),
          Cl.uint(1),
          Cl.uint(1_000_000),
          Cl.none(),
        ],
        staker,
      ).result.type,
    ).toBe("ok");
    expect(
      simnet.callReadOnlyFn(pox5Id, "get-staker-info", [Cl.principal(staker)], deployer).result,
    ).toBeSome(
      Cl.tuple({
        "amount-ustx": Cl.uint(minimumStake + 1_000_000n),
        "first-reward-cycle": Cl.uint(1),
        "num-cycles": Cl.uint(3),
        signer: Cl.principal(managerTwoId),
      }),
    );
    expect(
      simnet.callReadOnlyFn(
        pox5Id,
        "get-signer-cycle-membership",
        [Cl.principal(staker), Cl.uint(1)],
        deployer,
      ).result,
    ).toBeSome(
      Cl.tuple({
        "amount-ustx": Cl.uint(minimumStake),
        signer: Cl.principal(managerId),
      }),
    );
    expect(
      simnet.callReadOnlyFn(
        pox5Id,
        "get-signer-cycle-membership",
        [Cl.principal(staker), Cl.uint(2)],
        deployer,
      ).result,
    ).toBeSome(
      Cl.tuple({
        "amount-ustx": Cl.uint(minimumStake + 1_000_000n),
        signer: Cl.principal(managerTwoId),
      }),
    );
  });

  it("calculates both half-cycle distributions and rejects permissionless duplicate races", () => {
    initializePox5();
    registerManager();
    const staker = simnet.getAccounts().get("wallet_1");
    const permissionlessCaller = simnet.getAccounts().get("wallet_2");
    if (!staker || !permissionlessCaller) throw new Error("Clarinet wallet fixtures are missing");
    stake(staker);
    distributeRewards(2_000n);

    const cycleStart = uintValue(
      simnet.callReadOnlyFn(pox5Id, "reward-cycle-to-burn-height", [Cl.uint(1)], deployer).result,
    );
    simnet.mintFT(sbtcAssetId, deployer, 1_000n);
    expectOk(
      simnet.callPublicFn(
        sbtcTokenId,
        "transfer",
        [Cl.uint(1_000), Cl.principal(deployer), Cl.principal(pox5Id), Cl.none()],
        deployer,
      ).result,
      Cl.bool(true),
    );
    const secondHalfHeight = cycleStart + rewardCycleLength;
    simnet.mineEmptyBurnBlocks(Number(secondHalfHeight - BigInt(simnet.burnBlockHeight)));
    expect(
      simnet.callPublicFn(pox5Id, "calculate-rewards", [Cl.list([])], permissionlessCaller).result
        .type,
    ).toBe("ok");
    expect(
      simnet.callPublicFn(
        managerId,
        "claim-rewards",
        [Cl.list([]), Cl.uint(1)],
        permissionlessCaller,
      ).result.type,
    ).toBe("ok");
    expect(
      simnet.callPublicFn(pox5Id, "calculate-rewards", [Cl.list([])], permissionlessCaller).result,
    ).toBeErr(Cl.uint(30));
    expect(
      simnet.callPublicFn(
        managerId,
        "claim-rewards",
        [Cl.list([]), Cl.uint(1)],
        permissionlessCaller,
      ).result.type,
    ).toBe("err");
  });

  it("rejects stake and unstake mutations during the prepare phase", () => {
    initializePox5();
    registerManager();
    const staker = simnet.getAccounts().get("wallet_1");
    const otherStaker = simnet.getAccounts().get("wallet_2");
    if (!staker || !otherStaker) throw new Error("Clarinet wallet fixtures are missing");
    stake(staker);
    const firstCycleHeight = uintValue(
      simnet.callReadOnlyFn(pox5Id, "reward-cycle-to-burn-height", [Cl.uint(1)], deployer).result,
    );
    const prepareStart = firstCycleHeight - 10n;
    simnet.mineEmptyBurnBlocks(Number(prepareStart - BigInt(simnet.burnBlockHeight)));

    expect(
      simnet.callPublicFn(
        pox5Id,
        "stake",
        [
          Cl.principal(managerId),
          Cl.uint(minimumStake),
          Cl.uint(2),
          Cl.uint(simnet.burnBlockHeight),
          Cl.none(),
        ],
        otherStaker,
      ).result,
    ).toBeErr(Cl.uint(47));
    expect(
      simnet.callPublicFn(pox5Id, "unstake", [Cl.principal(managerId)], staker).result,
    ).toBeErr(Cl.uint(28));
  });

  it("distributes and claims an sBTC bond bucket alongside the STX bucket", async () => {
    initializePox5();
    registerManager();
    const stxStaker = simnet.getAccounts().get("wallet_1");
    const bondStaker = simnet.getAccounts().get("wallet_2");
    if (!stxStaker || !bondStaker) throw new Error("Clarinet wallet fixtures are missing");

    // The regtest fixture ships the mainnet-boot bond admin, which simnet accepts as a sender, so
    // the role can be handed to the deployer without patching the vendored contract.
    expectOk(
      simnet.callPublicFn(
        pox5Id,
        "set-bond-admin",
        [Cl.principal(deployer)],
        "SP000000000000000000002Q6VF78",
      ).result,
    );
    expectOk(
      simnet.callPublicFn(managerId, "update-fees", [Cl.uint(1_000)], deployer).result,
      Cl.bool(true),
    );

    const bondSats = 100_000n;
    const stxValueRatio = 1_000_000n;
    const minUstxRatio = 10_000n;
    expectOk(
      simnet.callPublicFn(
        pox5Id,
        "setup-bond",
        [
          Cl.uint(0),
          Cl.uint(500),
          Cl.uint(stxValueRatio),
          Cl.uint(minUstxRatio),
          Cl.bufferFromHex("00"),
          Cl.list([
            Cl.tuple({ staker: Cl.principal(bondStaker), "max-sats": Cl.uint(bondSats * 2n) }),
          ]),
        ],
        deployer,
      ).result,
    );

    const requiredUstx = uintValue(
      simnet.callReadOnlyFn(
        pox5Id,
        "min-ustx-for-sats-amount",
        [Cl.uint(bondSats), Cl.uint(stxValueRatio), Cl.uint(minUstxRatio)],
        deployer,
      ).result,
    );
    simnet.mintFT(sbtcAssetId, bondStaker, bondSats);
    const registration = simnet.callPublicFn(
      pox5Id,
      "register-for-bond",
      [
        Cl.uint(0),
        Cl.principal(managerId),
        Cl.uint(requiredUstx),
        // `err` selects the sBTC-collateral path; `ok` would carry Bitcoin L1 lockup proofs.
        Cl.error(Cl.uint(bondSats)),
        Cl.none(),
      ],
      bondStaker,
    );
    expectOk(registration.result);
    expect(
      simnet.callReadOnlyFn(pox5Id, "get-bond-membership", [Cl.principal(bondStaker)], deployer)
        .result,
    ).toBeSome(
      Cl.tuple({
        "amount-sats": Cl.uint(bondSats),
        "amount-ustx": Cl.uint(requiredUstx),
        "bond-index": Cl.uint(0),
        "is-l1-lock": Cl.bool(false),
        signer: Cl.contractPrincipal(deployer, "signer-manager"),
      }),
    );
    // A bond participant has no STX-only record: `register-for-bond` never writes one. This is the
    // state that made the roster fail closed before bond membership was node-verified.
    expect(
      simnet.callReadOnlyFn(pox5Id, "get-staker-info", [Cl.principal(bondStaker)], deployer).result,
    ).toBeNone();

    stake(stxStaker);
    const rewards = 2_000n;
    simnet.mintFT(sbtcAssetId, deployer, rewards);
    expectOk(
      simnet.callPublicFn(
        sbtcTokenId,
        "transfer",
        [Cl.uint(rewards), Cl.principal(deployer), Cl.principal(pox5Id), Cl.none()],
        deployer,
      ).result,
      Cl.bool(true),
    );
    const cycleStart = uintValue(
      simnet.callReadOnlyFn(pox5Id, "reward-cycle-to-burn-height", [Cl.uint(1)], deployer).result,
    );
    simnet.mineEmptyBurnBlocks(
      Number(cycleStart + halfCycleLength - BigInt(simnet.burnBlockHeight)),
    );

    // The global calculator needs the complete active bond list; an empty one is rejected outright.
    expect(
      simnet.callPublicFn(pox5Id, "calculate-rewards", [Cl.list([])], deployer).result,
    ).toBeErr(Cl.uint(33));
    const calculation = simnet.callPublicFn(
      pox5Id,
      "calculate-rewards",
      [Cl.list([Cl.uint(0)])],
      deployer,
    );
    const simulation = simulatePox5CalculateRewards({
      grossAccruedRewardsSats: rewards,
      currentReserveBalanceSats: 0n,
      cycleStakedUstx: minimumStake,
      currentRewardsPerUstx: 0n,
      managerStxSharesUstx: minimumStake,
      bonds: [
        {
          bondIndex: 0n,
          targetRateBips: 500n,
          stxValueRatio,
          totalSharesSats: bondSats,
          currentRewardsPerSat: 0n,
          managerSharesSats: bondSats,
        },
      ],
    });
    expect(calculation.result).toBeOk(
      Cl.tuple({
        "bond-periods": Cl.list([Cl.uint(0)]),
        "calculation-height": Cl.uint(cycleStart + halfCycleLength - 1n),
        "gross-accrued-rewards": Cl.uint(simulation.grossAccruedRewardsSats),
        "total-bond-rewards": Cl.uint(simulation.totalBondRewardsSats),
        "reserve-deposit": Cl.uint(simulation.reserveDepositSats),
        "reserve-balance": Cl.uint(simulation.reserveBalanceSats),
        "stx-cycle": Cl.uint(1),
        "total-stx-staker-rewards": Cl.uint(simulation.totalStxStakerRewardsSats),
        "cycle-staked-ustx": Cl.uint(simulation.cycleStakedUstx),
        "accrued-rewards-per-ustx": Cl.uint(simulation.accruedRewardsPerUstx),
        "cumulative-rewards-per-ustx": Cl.uint(simulation.cumulativeRewardsPerUstx),
      }),
    );
    expectCalculateRewardsPrint(calculation.events, {
      bondPeriods: [0n],
      calculationBurnHeight: cycleStart + halfCycleLength - 1n,
      rewardCycle: 1n,
      ...simulation,
    });
    expect(simulation).toMatchObject({
      totalBondRewardsSats: 100n,
      reserveDepositSats: 285n,
      totalStxStakerRewardsSats: 1_615n,
      accruedRewardsPerUstx: 32_300_000_000n,
      manager: { stxRewardSats: 1_615n, bondRewardSats: 100n, grossRewardSats: 1_715n },
      bonds: [
        {
          bondIndex: 0n,
          targetYieldSats: 100n,
          bondRewardSats: 100n,
          accruedRewardsPerSat: 1_000_000_000_000_000n,
        },
      ],
    });

    const bondEarned = uintValue(
      simnet.callReadOnlyFn(
        pox5Id,
        "get-earned",
        [Cl.principal(managerId), Cl.uint(1), Cl.some(Cl.uint(0))],
        deployer,
      ).result,
    );
    expect(bondEarned).toBe(simulation.bonds[0]?.managerRewardSats);
    expect(
      uintValue(
        simnet.callReadOnlyFn(
          pox5Id,
          "get-earned",
          [Cl.principal(managerId), Cl.uint(1), Cl.none()],
          deployer,
        ).result,
      ),
    ).toBe(simulation.manager?.stxRewardSats);

    // One transaction sweeps both buckets, and the manager pins a fee snapshot for each. Claiming
    // with an empty list would succeed but strand the bond bucket and leave its fee unpinned.
    const claim = simnet.callPublicFn(
      managerId,
      "claim-rewards",
      [Cl.list([Cl.uint(0)]), Cl.uint(1)],
      deployer,
    );
    expectOk(claim.result);
    expect(
      simnet.callReadOnlyFn(managerId, "get-fee-bips-for-cycle", [Cl.uint(1), Cl.none()], deployer)
        .result,
    ).toBeUint(1_000);
    expect(
      simnet.callReadOnlyFn(
        managerId,
        "get-fee-bips-for-cycle",
        [Cl.uint(1), Cl.some(Cl.uint(0))],
        deployer,
      ).result,
    ).toBeUint(1_000);

    // The bond staker settles their own bucket; the STX staker settles theirs. One call each.
    const bondPayout = simnet.callPublicFn(
      managerId,
      "claim-staker-rewards",
      [Cl.principal(bondStaker), Cl.uint(1), Cl.some(Cl.uint(0))],
      deployer,
    );
    expectOk(bondPayout.result);
    expect(sbtcBalance(bondStaker)).toBeGreaterThan(0n);
    expect(
      simnet.callReadOnlyFn(
        managerId,
        "get-earned-staker-rewards",
        [Cl.principal(bondStaker), Cl.uint(1), Cl.some(Cl.uint(0))],
        deployer,
      ).result,
    ).toBeTuple({ earned: Cl.uint(0), fees: Cl.uint(0) });

    // Both buckets settle to zero for the manager, so the single claim really did sweep both.
    for (const bucket of [Cl.none(), Cl.some(Cl.uint(0))]) {
      expect(
        simnet.callReadOnlyFn(
          pox5Id,
          "get-earned",
          [Cl.principal(managerId), Cl.uint(1), bucket],
          deployer,
        ).result,
      ).toBeUint(0);
    }
  });
});
