import { afterEach, describe, expect, it } from "vitest";
import { openSidekickStore, type SidekickStore } from "./store.js";

const observedAt = "2026-08-23T12:00:00.000Z";
const later = "2026-08-23T12:01:00.000Z";
const registry = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-registry";
const sweepTxId = `0x${"11".repeat(32)}`;
const bitcoinBlockHash = `0x${"22".repeat(32)}`;

describe("sBTC withdrawal completion repository", () => {
  const stores: SidekickStore[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  it("persists immutable node-readable Bitcoin sweep evidence", async () => {
    const { store } = await openSidekickStore(":memory:", observedAt);
    stores.push(store);
    const saved = store.sbtcWithdrawalCompletions.upsert({
      chainId: 1,
      registryContract: registry,
      requestId: "2684",
      sweepTxId,
      bitcoinBlockHeight: 963_758,
      bitcoinBlockHash,
      observedAt,
    });
    expect(saved).toMatchObject({ sweepTxId, bitcoinBlockHeight: 963_758, observedAt });
    expect(
      store.sbtcWithdrawalCompletions.upsert({
        chainId: 1,
        registryContract: registry,
        requestId: "2684",
        sweepTxId,
        bitcoinBlockHeight: 963_758,
        bitcoinBlockHash,
        observedAt: later,
      }),
    ).toMatchObject({ observedAt: later, updatedAt: later });
    expect(() =>
      store.sbtcWithdrawalCompletions.upsert({
        chainId: 1,
        registryContract: registry,
        requestId: "2684",
        sweepTxId: `0x${"33".repeat(32)}`,
        bitcoinBlockHeight: 963_758,
        bitcoinBlockHash,
        observedAt: later,
      }),
    ).toThrow("completion evidence changed");
  });
});
