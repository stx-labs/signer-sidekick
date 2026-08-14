import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  Cl,
  type ClarityValue,
  getAddressFromPublicKey,
  privateKeyToPublic,
  serializeCV,
  signWithKey,
} from "@stacks/transactions";
import { beforeEach, describe, expect, it } from "vitest";

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
  expect(calculation.result).toBeOk(
    Cl.tuple({
      "bond-periods": Cl.list([]),
      "calculation-height": Cl.uint(cycleStart + halfCycleLength - 1n),
      "gross-accrued-rewards": Cl.uint(rewards),
      "total-bond-rewards": Cl.uint(0),
      "reserve-deposit": Cl.uint(300),
      "reserve-balance": Cl.uint(300),
      "stx-cycle": Cl.uint(1),
      "total-stx-staker-rewards": Cl.uint(1_700),
      "cycle-staked-ustx": Cl.uint(minimumStake),
      "accrued-rewards-per-ustx": Cl.uint(34_000_000_000),
      "cumulative-rewards-per-ustx": Cl.uint(34_000_000_000),
    }),
  );
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
    expect(calculation.result).toBeOk(
      Cl.tuple({
        "bond-periods": Cl.list([Cl.uint(0)]),
        "calculation-height": Cl.uint(cycleStart + halfCycleLength - 1n),
        "gross-accrued-rewards": Cl.uint(rewards),
        "total-bond-rewards": Cl.uint(100),
        "reserve-deposit": Cl.uint(285),
        "reserve-balance": Cl.uint(285),
        "stx-cycle": Cl.uint(1),
        "total-stx-staker-rewards": Cl.uint(1_615),
        "cycle-staked-ustx": Cl.uint(minimumStake),
        "accrued-rewards-per-ustx": Cl.uint(32_300_000_000),
        "cumulative-rewards-per-ustx": Cl.uint(32_300_000_000),
      }),
    );

    const bondEarned = uintValue(
      simnet.callReadOnlyFn(
        pox5Id,
        "get-earned",
        [Cl.principal(managerId), Cl.uint(1), Cl.some(Cl.uint(0))],
        deployer,
      ).result,
    );
    expect(bondEarned).toBeGreaterThan(0n);

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
