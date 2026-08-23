import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import {
  deserializeTransaction,
  getAddressFromPublicKey,
  privateKeyToPublic,
} from "@stacks/transactions";
import {
  planRewardOperation,
  type RewardOperationPlan,
  type RewardOperationPlanInput,
} from "@stx-labs/signer-sidekick-protocol/reward-operation-plan";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GasPayerSigner, type GasPayerSignerError } from "./gas-payer-signer.js";

const secretKey = `${"11".repeat(32)}01`;
const publicKey = privateKeyToPublic(secretKey);
const principal = getAddressFromPublicKey(publicKey, "testnet");

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "sidekick-gas-payer-"));
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

async function secretFile(
  contents = `${secretKey}\n`,
  mode = 0o600,
  filename = "gas-payer.key",
): Promise<string> {
  const path = join(temporaryDirectory, filename);
  await writeFile(path, contents, { mode });
  await chmod(path, mode);
  return path;
}

async function expectSignerError(run: () => Promise<unknown>, code: GasPayerSignerError["code"]) {
  try {
    await run();
  } catch (error) {
    expect(error).toMatchObject({ name: "GasPayerSignerError", code });
    expect(String(error)).not.toContain(secretKey);
    expect(inspect(error)).not.toContain(secretKey);
    return;
  }
  throw new Error(`Expected GasPayerSignerError ${code}`);
}

function rewardOperationInputs(): RewardOperationPlanInput[] {
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
    sender: { principal, publicKey },
    managerSourceFingerprint: "34".repeat(32),
    nonce: 7n,
    feeUstx: 1_000n,
  };
  const manager = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.signer-manager";
  const pox5 = "ST000000000000000000002AMW42H.pox-5";
  const sbtc = "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token";
  const staker = "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG";
  return [
    {
      ...common,
      kind: "calculate-rewards",
      pox5Contract: pox5,
      bondPeriods: [2n],
      targetRewardCycle: 141n,
      targetCheckpoint: "first-half",
      expectedLastRewardComputeBurnHeight: 4_099,
    },
    {
      ...common,
      kind: "claim-rewards",
      managerContract: manager,
      pox5Contract: pox5,
      sbtcTokenContract: sbtc,
      rewardCycle: 141n,
      bondPeriods: [2n],
      expectedSbtcOutflow: 10_000n,
    },
    {
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
    {
      ...common,
      kind: "settle-accepted-withdrawal",
      managerContract: manager,
      requestId: 42n,
      stakerPrincipal: staker,
    },
    {
      ...common,
      kind: "reclaim-failed-withdrawal",
      managerContract: manager,
      sbtcTokenContract: sbtc,
      requestId: 43n,
      stakerPrincipal: staker,
      withdrawalAmountSats: 8_500n,
      maxFeeSats: 1_000n,
    },
  ];
}

async function paymentPlan(): Promise<RewardOperationPlan> {
  const input = rewardOperationInputs().find((value) => value.kind === "claim-staker-rewards");
  if (input === undefined) throw new Error("Expected a claim-staker-rewards input");
  return planRewardOperation(input);
}

describe("GasPayerSigner", () => {
  it("keeps one explicit sealed signing method per reward adapter", async () => {
    const signer = await GasPayerSigner.fromSecretFile({
      secretFilePath: await secretFile(),
      expectedPrincipal: principal,
      network: "testnet",
    });
    const plans = await Promise.all(rewardOperationInputs().map(planRewardOperation));
    const [calculate, collect, payment, settle, reclaim] = plans;
    if (!calculate || !collect || !payment || !settle || !reclaim) {
      throw new Error("Expected one plan for every reward adapter");
    }
    const signed = await Promise.all([
      signer.signPox5CalculateRewardsPlan(calculate),
      signer.signManagerClaimRewardsRunPlan(collect),
      signer.signClaimStakerRewardsPlan(payment),
      signer.signSettleAcceptedWithdrawalPlan(settle),
      signer.signReclaimFailedWithdrawalPlan(reclaim),
    ]);

    expect(signed.map(({ operationKind }) => operationKind)).toEqual([
      "calculate-rewards",
      "claim-rewards",
      "claim-staker-rewards",
      "settle-accepted-withdrawal",
      "reclaim-failed-withdrawal",
    ]);
    for (const [index, attempt] of signed.entries()) {
      const transaction = deserializeTransaction(attempt.signedTransactionBytes);
      expect(attempt).toMatchObject({
        kind: "signed-reward-operation",
        planSha256: plans[index]?.planSha256,
        precomputedTxid: `0x${transaction.txid()}`,
        nonce: "7",
        fee: "1000",
      });
      expect(() => transaction.verifyOrigin()).not.toThrow();
      expect(JSON.stringify(attempt)).not.toContain(secretKey);
    }

    const tampered = structuredClone(payment) as RewardOperationPlan;
    tampered.material.authorization.recipeSha256 = "ef".repeat(32);
    await expectSignerError(
      () => signer.signClaimStakerRewardsPlan(tampered),
      "sealed-plan-invalid",
    );
    await expectSignerError(
      () => signer.signPox5CalculateRewardsPlan(collect),
      "sealed-plan-invalid",
    );
  });

  it("rejects relative paths, symlinks, and non-regular secret paths", async () => {
    await expectSignerError(
      () =>
        GasPayerSigner.fromSecretFile({
          secretFilePath: "gas-payer.key",
          expectedPrincipal: principal,
          network: "testnet",
        }),
      "invalid-configuration",
    );

    const target = await secretFile();
    const link = join(temporaryDirectory, "gas-payer-link.key");
    await symlink(target, link);
    await expectSignerError(
      () =>
        GasPayerSigner.fromSecretFile({
          secretFilePath: link,
          expectedPrincipal: principal,
          network: "testnet",
        }),
      "secret-symlink",
    );

    const directory = join(temporaryDirectory, "secret-directory");
    await mkdir(directory);
    await expectSignerError(
      () =>
        GasPayerSigner.fromSecretFile({
          secretFilePath: directory,
          expectedPrincipal: principal,
          network: "testnet",
        }),
      "secret-not-regular-file",
    );
  });

  it.each([0o644, 0o640, 0o610, 0o700])("rejects insecure secret mode %o", async (mode) => {
    const path = await secretFile(`${secretKey}\n`, mode);
    await expectSignerError(
      () =>
        GasPayerSigner.fromSecretFile({
          secretFilePath: path,
          expectedPrincipal: principal,
          network: "testnet",
        }),
      "secret-insecure-permissions",
    );
  });

  it.each([
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about\n",
    `0x${"11".repeat(32)}\n`,
    `${JSON.stringify({ privateKey: secretKey })}\n`,
    `${"11".repeat(31)}\n`,
    `${"11".repeat(32)}02\n`,
  ])("rejects mnemonic, wrapped, truncated, and non-compressed secret formats", async (contents) => {
    const path = await secretFile(contents);
    await expectSignerError(
      () =>
        GasPayerSigner.fromSecretFile({
          secretFilePath: path,
          expectedPrincipal: principal,
          network: "testnet",
        }),
      "secret-invalid-format",
    );
  });

  it("fails closed when the secret does not match the configured public identity", async () => {
    const path = await secretFile();
    const otherPrincipal = getAddressFromPublicKey(
      privateKeyToPublic(`${"22".repeat(32)}01`),
      "testnet",
    );
    await expectSignerError(
      () =>
        GasPayerSigner.fromSecretFile({
          secretFilePath: path,
          expectedPrincipal: otherPrincipal,
          network: "testnet",
        }),
      "identity-mismatch",
    );
  });

  it.each([
    (plan: RewardOperationPlan) => {
      plan.planSha256 = "00".repeat(32);
    },
    (plan: RewardOperationPlan) => {
      plan.unsignedTransactionSha256 = "00".repeat(32);
    },
    (plan: RewardOperationPlan) => {
      plan.unsignedTransactionHex = `${plan.unsignedTransactionHex.slice(0, -2)}00`;
    },
    (plan: RewardOperationPlan) => {
      plan.material.authorization.recipeSha256 = "ef".repeat(32);
    },
    (plan: RewardOperationPlan) => {
      (plan as RewardOperationPlan & { arbitraryCall: boolean }).arbitraryCall = true;
    },
  ])("rejects a tampered or widened sealed reward operation plan", async (tamper) => {
    const signer = await GasPayerSigner.fromSecretFile({
      secretFilePath: await secretFile(),
      expectedPrincipal: principal,
      network: "testnet",
    });
    const plan = structuredClone(await paymentPlan());
    tamper(plan);

    await expectSignerError(() => signer.signClaimStakerRewardsPlan(plan), "sealed-plan-invalid");
  });

  it("zeroes and permanently disables its private signing capability", async () => {
    const signer = await GasPayerSigner.fromSecretFile({
      secretFilePath: await secretFile(),
      expectedPrincipal: principal,
      network: "testnet",
    });
    signer.destroy();
    signer.destroy();
    await expectSignerError(
      async () => signer.signClaimStakerRewardsPlan(await paymentPlan()),
      "signer-destroyed",
    );
  });
});
