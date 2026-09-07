import type { GasWalletStatus } from "@stx-labs/signer-sidekick-api-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiJson, apiJsonOrUnavailable } from "../../api-client.js";

vi.mock("../../api-client.js", () => ({ apiJson: vi.fn(), apiJsonOrUnavailable: vi.fn() }));
const status: GasWalletStatus = {
  schemaVersion: 1,
  generatedAt: "2026-09-07T12:00:00Z",
  network: "mainnet",
  engineMode: "observe",
  configured: false,
  enabled: false,
  source: null,
  principal: null,
  publicKey: null,
  secretFilePath: null,
  createdAt: null,
  enabledAt: null,
  signer: "not-loaded",
  signerError: null,
  balanceUstx: null,
  balanceObservedAt: null,
  balanceError: null,
  feeBasisUstx: "100000",
  feeBasis: "fee-cap",
  estimatedTransactions: null,
  refusal: {
    checkedAt: null,
    isManagerAdmin: null,
    isSignerKey: null,
    isContract: false,
    refusalReason: null,
  },
  banners: { setupDismissedAt: null, lowBalanceDismissedUntil: null },
  activeSweepId: null,
  sweeps: [],
};

describe("scoped gas-wallet public status cache", () => {
  let stored: Map<string, string>;
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    stored = new Map();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shares a bounded GET without letting one consumer abort another", async () => {
    const api = await import("./gas-wallet-api.js");
    let resolve!: (value: GasWalletStatus) => void;
    vi.mocked(apiJsonOrUnavailable).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const controller = new AbortController();
    const first = api.loadGasWalletStatus("credential", controller.signal, "mainnet:manager-a");
    const firstResult = expect(first).rejects.toThrow();
    const second = api.loadGasWalletStatus("credential", undefined, "mainnet:manager-a");
    controller.abort();
    resolve(status);
    await firstResult;
    expect(await second).toEqual(status);
    expect(apiJsonOrUnavailable).toHaveBeenCalledTimes(1);
    expect(api.cachedGasWalletStatus("credential", "mainnet:manager-a")).toEqual(status);
    expect([...stored.values()].join()).not.toContain("credential");
  });

  it("does not leak old-manager or old-network status or late responses", async () => {
    const api = await import("./gas-wallet-api.js");
    let resolve!: (value: GasWalletStatus) => void;
    vi.mocked(apiJsonOrUnavailable).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const old = api.loadGasWalletStatus("credential", undefined, "mainnet:manager-a");
    expect(api.cachedGasWalletStatus("credential", "mainnet:manager-b")).toBeUndefined();
    resolve(status);
    await old;
    expect(api.cachedGasWalletStatus("credential", "mainnet:manager-b")).toBeUndefined();
    vi.mocked(apiJsonOrUnavailable).mockResolvedValueOnce(status);
    await api.loadGasWalletStatus("credential", undefined, "mainnet:manager-a");
    expect(api.cachedGasWalletStatus("credential", "testnet:manager-a")).toBeUndefined();
    expect(api.cachedGasWalletStatus("credential", "mainnet:manager-a")).toEqual(status);
  });

  it("does not coalesce reads across credentials", async () => {
    const api = await import("./gas-wallet-api.js");
    vi.mocked(apiJsonOrUnavailable).mockResolvedValue(status);
    await Promise.all([
      api.loadGasWalletStatus("first", undefined, "mainnet:manager-a"),
      api.loadGasWalletStatus("second", undefined, "mainnet:manager-a"),
    ]);
    expect(apiJsonOrUnavailable).toHaveBeenCalledTimes(2);
  });

  it("prevents a pre-mutation GET from overwriting an acknowledged mutation in cache", async () => {
    const api = await import("./gas-wallet-api.js");
    let resolve!: (value: GasWalletStatus) => void;
    vi.mocked(apiJsonOrUnavailable).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const old = api.loadGasWalletStatus("credential", undefined, "mainnet:manager-a");
    const enabled = { ...status, enabled: true };
    vi.mocked(apiJson).mockResolvedValueOnce(enabled);
    await api.enableGasWallet("credential");
    resolve(status);
    expect(await old).toEqual(enabled);
    expect(api.cachedGasWalletStatus("credential", "mainnet:manager-a")).toEqual(enabled);
  });

  it("works with denied session storage and never caches before identity is known", async () => {
    const api = await import("./gas-wallet-api.js");
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(api.cachedGasWalletStatus("credential", "mainnet:manager-a")).toBeUndefined();
    vi.mocked(apiJsonOrUnavailable).mockResolvedValue(status);
    expect(await api.loadGasWalletStatus("credential", undefined, "mainnet:manager-a")).toEqual(
      status,
    );
    expect(api.cachedGasWalletStatus("credential", null)).toBeUndefined();
    await api.loadGasWalletStatus("credential");
    expect(api.cachedGasWalletStatus("credential", null)).toBeUndefined();
  });
});
