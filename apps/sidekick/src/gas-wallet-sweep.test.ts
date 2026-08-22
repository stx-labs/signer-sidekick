import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compressPublicKey,
  deserializeTransaction,
  getAddressFromPublicKey,
  PayloadType,
  privateKeyToPublic,
  type TokenTransferPayloadWire,
} from "@stacks/transactions";
import { afterEach, describe, expect, it } from "vitest";
import {
  GasWalletSweepPlanError,
  planGasWalletSweep,
  revalidateGasWalletSweepPlan,
  sweepPayloadRecipient,
  validateSweepRecipient,
} from "./gas-wallet-sweep.js";
import { GasPayerSigner } from "./transaction-engine/gas-payer-signer.js";

const privateKey = `${"11".repeat(32)}01`;
const publicKey = compressPublicKey(privateKeyToPublic(privateKey)).toLowerCase();
const principal = getAddressFromPublicKey(publicKey, "testnet");
const recipient = "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG";
const createdAt = new Date("2026-08-22T12:00:00.000Z");
const expiresAt = new Date("2026-08-22T12:30:00.000Z");

function input(overrides: Partial<Parameters<typeof planGasWalletSweep>[0]> = {}) {
  return {
    network: "testnet" as const,
    chainId: 0x8000_0000,
    sender: { principal, publicKey },
    recipient,
    balanceUstx: 2_500_000n,
    feeUstx: 180n,
    nonce: 7n,
    indexBlockHash: `0x${"ab".repeat(32)}` as `0x${string}`,
    createdAt,
    expiresAt,
    ...overrides,
  };
}

describe("gas wallet sweep plan", () => {
  it("seals balance minus fee into the token-transfer payload and is deterministic", async () => {
    const plan = await planGasWalletSweep(input());
    expect(plan.kind).toBe("gas-wallet-sweep");
    expect(plan.material).toMatchObject({
      schemaVersion: 1,
      network: { kind: "testnet", chainId: 0x8000_0000 },
      sender: { principal, publicKey },
      recipient,
      amountUstx: "2499820",
      feeUstx: "180",
      nonce: "7",
      balanceUstx: "2500000",
      anchor: { indexBlockHash: `0x${"ab".repeat(32)}` },
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    const again = await planGasWalletSweep(input());
    expect(again).toEqual(plan);

    const transaction = deserializeTransaction(plan.unsignedTransactionHex);
    expect(transaction.payload.payloadType).toBe(PayloadType.TokenTransfer);
    const payload = transaction.payload as TokenTransferPayloadWire;
    expect(payload.amount).toBe(2_499_820n);
    expect(sweepPayloadRecipient(payload)).toBe(recipient);
    expect(transaction.auth.spendingCondition.nonce).toBe(7n);
    expect(transaction.auth.spendingCondition.fee).toBe(180n);

    await expect(revalidateGasWalletSweepPlan(plan)).resolves.toEqual(plan);
    await expect(
      revalidateGasWalletSweepPlan({ ...plan, material: { ...plan.material, amountUstx: "1" } }),
    ).rejects.toMatchObject({ code: "plan-mismatch" });
    await expect(
      revalidateGasWalletSweepPlan({
        ...plan,
        unsignedTransactionHex: `${plan.unsignedTransactionHex}00`,
      }),
    ).rejects.toMatchObject({ code: "plan-mismatch" });
  });

  it("refuses bad recipients and empty balances", async () => {
    expect(() =>
      validateSweepRecipient("SP000000000000000000002Q6VF78.pox-5", "testnet", principal),
    ).toThrow(GasWalletSweepPlanError);
    expect(() =>
      validateSweepRecipient("SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7", "testnet", principal),
    ).toThrow("must be a testnet address");
    expect(() => validateSweepRecipient(principal, "testnet", principal)).toThrow(
      "different address",
    );
    expect(() => validateSweepRecipient("not-an-address", "mainnet", principal)).toThrow(
      "standard Stacks address",
    );
    await expect(planGasWalletSweep(input({ balanceUstx: 180n }))).rejects.toMatchObject({
      code: "insufficient-balance",
    });
    await expect(planGasWalletSweep(input({ feeUstx: 0n }))).rejects.toMatchObject({
      code: "invalid-material",
    });
  });
});

describe("gas payer signer sweep method", () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const directory of directories.splice(0))
      await rm(directory, { recursive: true, force: true });
  });

  it("signs only a sealed sweep that belongs to the loaded wallet", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sidekick-sweep-signer-"));
    directories.push(directory);
    const secretFilePath = join(directory, "gas-wallet.key");
    const handle = await open(secretFilePath, "wx", 0o600);
    await handle.writeFile(`${privateKey}\n`, { encoding: "utf8" });
    await handle.close();
    const signer = await GasPayerSigner.fromSecretFile({
      secretFilePath,
      expectedPrincipal: principal,
      network: "testnet",
    });
    try {
      const plan = await planGasWalletSweep(input());
      const signed = await signer.signGasWalletSweepPlan(plan);
      expect(signed.kind).toBe("signed-gas-wallet-sweep");
      expect(signed.planSha256).toBe(plan.planSha256);
      expect(signed.nonce).toBe("7");
      expect(signed.fee).toBe("180");
      const transaction = deserializeTransaction(signed.signedTransactionBytes);
      expect(`0x${transaction.txid()}`).toBe(signed.precomputedTxid);
      expect((transaction.payload as TokenTransferPayloadWire).amount).toBe(2_499_820n);
      expect(JSON.stringify(signed)).not.toContain(privateKey.slice(0, 16));

      await expect(
        signer.signGasWalletSweepPlan({
          ...plan,
          material: { ...plan.material, amountUstx: "2499821" },
        }),
      ).rejects.toMatchObject({ code: "sealed-plan-invalid" });

      const otherKey = `${"22".repeat(32)}01`;
      const otherPublicKey = compressPublicKey(privateKeyToPublic(otherKey)).toLowerCase();
      const foreign = await planGasWalletSweep(
        input({
          sender: {
            principal: getAddressFromPublicKey(otherPublicKey, "testnet"),
            publicKey: otherPublicKey,
          },
        }),
      );
      await expect(signer.signGasWalletSweepPlan(foreign)).rejects.toMatchObject({
        code: "plan-signer-mismatch",
      });
      signer.destroy();
      await expect(signer.signGasWalletSweepPlan(plan)).rejects.toMatchObject({
        code: "signer-destroyed",
      });
    } finally {
      signer.destroy();
    }
  });
});
