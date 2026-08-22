import { afterEach, describe, expect, it } from "vitest";
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
});
