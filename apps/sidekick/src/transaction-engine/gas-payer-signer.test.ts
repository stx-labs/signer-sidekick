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
  MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
  type ManagerClaimRewardsPlan,
  planManagerClaimRewards,
} from "@stx-labs/signer-sidekick-protocol/manager-claim-rewards";
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

async function fixturePlan(
  signerPublicKey = publicKey,
  signerPrincipal = principal,
): Promise<ManagerClaimRewardsPlan> {
  return planManagerClaimRewards({
    schemaVersion: 1,
    adapterRevision: MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
    network: { kind: "testnet", chainId: 0x8000_0005 },
    managerContract: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.signer-manager",
    pox5Contract: "ST000000000000000000002AMW42H.pox-5",
    sbtcTokenContract: "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token",
    rewardCycle: 5n,
    expectedSbtcOutflow: 1_234n,
    chainAnchor: {
      stacksBlockHeight: 9_000,
      indexBlockHash: `0x${"ab".repeat(32)}`,
      burnBlockHeight: 4_100,
      rewardCycle: 5n,
      rewardCycleLength: 100,
      prepareCycleLength: 10,
      cyclePosition: 50,
      phase: "reward",
      checkpoint: "second-half",
    },
    attestationDigest: "cd".repeat(32),
    managerSourceFingerprint: "12".repeat(32),
    rewardObservation: {
      calculationCheckpoint: "first-half",
      lastRewardComputeBurnHeight: 4_099,
      rewardsPerToken: 123_456_789n,
    },
    stxEarnedSats: 1_234n,
    bondBuckets: [],
    feeSnapshot: { state: "absent", effectiveFeeBips: 500n },
    sender: { principal: signerPrincipal, publicKey: signerPublicKey },
    nonce: 7n,
    fee: 1_000n,
  });
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

describe("GasPayerSigner", () => {
  it("signs only the revalidated manager claim and returns defensive bytes plus its txid", async () => {
    const path = await secretFile(`${"11".repeat(32)}\n`, 0o400);
    const signer = await GasPayerSigner.fromSecretFile({
      secretFilePath: path,
      expectedPrincipal: principal,
      network: "testnet",
    });
    const plan = await fixturePlan();

    const signed = await signer.signManagerClaimRewardsPlan(plan);
    const bytes = signed.signedTransactionBytes;
    const transaction = deserializeTransaction(bytes);

    expect(signer).toMatchObject({ principal, publicKey, network: "testnet" });
    expect(signed).toMatchObject({
      kind: "signed-manager-claim-rewards",
      intentHash: plan.intentHash,
      unsignedTransactionSha256: plan.unsignedTransactionSha256,
      precomputedTxid: `0x${transaction.txid()}`,
      nonce: "7",
      fee: "1000",
    });
    expect(() => transaction.verifyOrigin()).not.toThrow();
    expect(Buffer.from(bytes).toString("hex")).not.toBe(plan.unsignedTransactionHex);

    bytes.fill(0);
    expect(signed.signedTransactionBytes.some((value) => value !== 0)).toBe(true);
    expect(JSON.stringify(signer)).not.toContain(secretKey);
    expect(JSON.stringify(signed)).not.toContain(secretKey);
    expect(inspect(signer)).not.toContain(secretKey);
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
    (plan: ManagerClaimRewardsPlan) => {
      (plan as { intentHash: string }).intentHash = "00".repeat(32);
    },
    (plan: ManagerClaimRewardsPlan) => {
      (plan as { unsignedTransactionSha256: string }).unsignedTransactionSha256 = "00".repeat(32);
    },
    (plan: ManagerClaimRewardsPlan) => {
      (plan as { unsignedTransactionHex: string }).unsignedTransactionHex =
        `${plan.unsignedTransactionHex.slice(0, -2)}00`;
    },
    (plan: ManagerClaimRewardsPlan) => {
      (plan.material.adapter as { id: string }).id = "arbitrary-call";
    },
    (plan: ManagerClaimRewardsPlan) => {
      (plan as ManagerClaimRewardsPlan & { arbitraryCall: boolean }).arbitraryCall = true;
    },
  ])("rejects a tampered or widened sealed transaction vector", async (tamper) => {
    const signer = await GasPayerSigner.fromSecretFile({
      secretFilePath: await secretFile(),
      expectedPrincipal: principal,
      network: "testnet",
    });
    const plan = structuredClone(await fixturePlan());
    tamper(plan);

    await expectSignerError(() => signer.signManagerClaimRewardsPlan(plan), "sealed-plan-invalid");
  });

  it("refuses a valid sealed plan belonging to another gas payer", async () => {
    const signer = await GasPayerSigner.fromSecretFile({
      secretFilePath: await secretFile(),
      expectedPrincipal: principal,
      network: "testnet",
    });
    const otherSecret = `${"22".repeat(32)}01`;
    const otherPublicKey = privateKeyToPublic(otherSecret);
    const otherPrincipal = getAddressFromPublicKey(otherPublicKey, "testnet");

    await expectSignerError(
      async () =>
        signer.signManagerClaimRewardsPlan(await fixturePlan(otherPublicKey, otherPrincipal)),
      "plan-signer-mismatch",
    );
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
      async () => signer.signManagerClaimRewardsPlan(await fixturePlan()),
      "signer-destroyed",
    );
  });
});
