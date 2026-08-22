import { afterEach, describe, expect, it } from "vitest";
import { planGasWalletSweep } from "../gas-wallet-sweep.js";
import { openSidekickStore, type SidekickStore } from "./store.js";

describe("gas wallet repository", () => {
  const stores: SidekickStore[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  it("records one public identity per deployment and never key material", async () => {
    const { store } = await openSidekickStore(":memory:");
    stores.push(store);
    expect(store.gasWallet.get()).toBeNull();
    expect(store.gasWallet.banners()).toEqual({
      setupDismissedAt: null,
      lowBalanceDismissedUntil: null,
    });

    const stored = store.gasWallet.put({
      principal: "ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5",
      publicKey: `02${"ab".repeat(32)}`.toUpperCase(),
      secretFilePath: "/var/lib/sidekick/gas-wallet.key",
      source: "generated",
      createdAt: "2026-08-22T12:00:00.000Z",
    });
    expect(stored).toEqual({
      schemaVersion: 1,
      principal: "ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5",
      publicKey: `02${"ab".repeat(32)}`,
      secretFilePath: "/var/lib/sidekick/gas-wallet.key",
      source: "generated",
      createdAt: "2026-08-22T12:00:00.000Z",
      enabled: false,
      enabledAt: null,
      updatedAt: "2026-08-22T12:00:00.000Z",
    });
    expect(() =>
      store.gasWallet.put({
        principal: "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG",
        publicKey: `02${"cd".repeat(32)}`,
        secretFilePath: "/var/lib/sidekick/other.key",
        source: "configured",
        createdAt: "2026-08-22T12:05:00.000Z",
      }),
    ).toThrow("different gas wallet is already recorded");

    expect(store.gasWallet.setEnabled(true, "2026-08-22T12:10:00.000Z")).toMatchObject({
      enabled: true,
      enabledAt: "2026-08-22T12:10:00.000Z",
      updatedAt: "2026-08-22T12:10:00.000Z",
    });
    expect(store.gasWallet.setEnabled(false, "2026-08-22T12:20:00.000Z")).toMatchObject({
      enabled: false,
      enabledAt: null,
    });

    expect(
      store.gasWallet.dismissSetupBanner("2026-08-22T12:30:00.000Z", "2026-08-22T12:30:00.000Z"),
    ).toEqual({ setupDismissedAt: "2026-08-22T12:30:00.000Z", lowBalanceDismissedUntil: null });
    expect(
      store.gasWallet.dismissLowBalance("2026-08-23T12:30:00.000Z", "2026-08-22T12:30:00.000Z"),
    ).toEqual({
      setupDismissedAt: "2026-08-22T12:30:00.000Z",
      lowBalanceDismissedUntil: "2026-08-23T12:30:00.000Z",
    });

    store.gasWallet.remove();
    expect(store.gasWallet.get()).toBeNull();
    expect(() => store.gasWallet.setEnabled(true, "2026-08-22T12:40:00.000Z")).toThrow(
      "No gas wallet is recorded",
    );
  });

  it("stores sealed sweeps with one active at a time", async () => {
    const { store } = await openSidekickStore(":memory:");
    stores.push(store);
    const plan = await planGasWalletSweep({
      network: "testnet",
      chainId: 0x8000_0000,
      sender: {
        principal: "ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5",
        publicKey: `02${"ab".repeat(32)}`,
      },
      recipient: "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG",
      balanceUstx: 1_000_000n,
      feeUstx: 200n,
      nonce: 3n,
      indexBlockHash: `0x${"ab".repeat(32)}`,
      createdAt: new Date("2026-08-22T12:00:00.000Z"),
      expiresAt: new Date("2026-08-22T12:30:00.000Z"),
    });
    expect(store.gasWalletSweeps.active()).toBeNull();
    const stored = store.gasWalletSweeps.insert({
      sweepId: "00000000-0000-4000-8000-000000000001",
      walletPrincipal: "ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5",
      plan,
      createdAt: "2026-08-22T12:00:00.000Z",
    });
    expect(stored).toMatchObject({
      status: "planned",
      recipient: "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG",
      amountUstx: "999800",
      feeUstx: "200",
      nonce: "3",
      planSha256: plan.planSha256,
      txid: null,
      broadcastAmbiguous: false,
      expiresAt: "2026-08-22T12:30:00.000Z",
    });
    expect(store.gasWalletSweeps.getPlan(stored.sweepId)).toEqual(plan);
    expect(store.gasWalletSweeps.active()?.sweepId).toBe(stored.sweepId);
    const updated = store.gasWalletSweeps.update(
      stored.sweepId,
      {
        status: "broadcast",
        txid: `0x${"cd".repeat(32)}`,
        broadcastAt: "2026-08-22T12:05:00.000Z",
      },
      "2026-08-22T12:05:00.000Z",
    );
    expect(updated).toMatchObject({ status: "broadcast", txid: `0x${"cd".repeat(32)}` });
    const settled = store.gasWalletSweeps.update(
      stored.sweepId,
      { status: "confirmed", resolvedAt: "2026-08-22T12:20:00.000Z", blockHeight: 10 },
      "2026-08-22T12:20:00.000Z",
    );
    expect(settled).toMatchObject({ status: "confirmed", blockHeight: 10 });
    expect(store.gasWalletSweeps.active()).toBeNull();
    expect(store.gasWalletSweeps.list()).toHaveLength(1);
    expect(store.gasWalletSweeps.get("00000000-0000-4000-8000-000000000002")).toBeNull();
  });
});
