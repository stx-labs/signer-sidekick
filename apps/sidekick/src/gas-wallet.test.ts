import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boolCV,
  compressPublicKey,
  getAddressFromPublicKey,
  privateKeyToPublic,
} from "@stacks/transactions";
import { gasWalletStatusSchema } from "@stx-labs/signer-sidekick-api-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GasWalletError, GasWalletService, type GasWalletServiceOptions } from "./gas-wallet.js";
import { openSidekickStore, type SidekickStore } from "./storage/store.js";
import type { LiveTransactionReader } from "./transaction-engine/live-transaction-reader.js";
import type { TransactionEngineRuntimeContext } from "./transaction-engine/runtime.js";

const privateKey = `${"11".repeat(32)}01`;
const publicKey = compressPublicKey(privateKeyToPublic(privateKey)).toLowerCase();
const principal = getAddressFromPublicKey(publicKey, "testnet");
const managerPrincipal = "ST000000000000000000002AMW42H.signer-manager";
const now = new Date("2026-08-22T12:00:00.000Z");

function engineStub(options: { activationError?: string } = {}) {
  const state = { ready: false };
  const activateGasWallet = vi.fn(async () => {
    if (options.activationError) throw new Error(options.activationError);
    state.ready = true;
  });
  const deactivateGasWallet = vi.fn(async () => {
    state.ready = false;
  });
  return {
    state,
    activateGasWallet,
    deactivateGasWallet,
    gasWalletSignerReady: () => state.ready,
    gasPayerIdentity: () => null,
  };
}

function contextStub(options: { isAdmin?: boolean; disconnected?: boolean } = {}) {
  const callReadOnly = vi.fn(async () => boolCV(options.isAdmin ?? false));
  const runtimeContext = (): TransactionEngineRuntimeContext => {
    if (options.disconnected) throw new Error("The configured connection is not current");
    return {
      config: { network: "testnet", nodeRpcUrl: "http://127.0.0.1:20443" },
      node: { callReadOnly, getTenureInfo: async () => ({ tip_block_id: "ab".repeat(32) }) },
      api: {},
    } as unknown as TransactionEngineRuntimeContext;
  };
  return { runtimeContext, callReadOnly };
}

const reader = {
  readAnchoredAccount: async () => ({
    status: "observed",
    httpStatus: 200,
    value: { balanceUstx: 2_500_000n },
  }),
} as unknown as Pick<LiveTransactionReader, "readAnchoredAccount">;

describe("gas wallet service", () => {
  const stores: SidekickStore[] = [];
  const directories: string[] = [];
  afterEach(async () => {
    for (const store of stores.splice(0)) store.close();
    for (const directory of directories.splice(0))
      await rm(directory, { recursive: true, force: true });
  });

  async function fixture(overrides: Partial<GasWalletServiceOptions> = {}) {
    const { store } = await openSidekickStore(":memory:");
    stores.push(store);
    const directory = await mkdtemp(join(tmpdir(), "sidekick-gas-wallet-"));
    directories.push(directory);
    const engine = engineStub();
    const { runtimeContext, callReadOnly } = contextStub();
    const options: GasWalletServiceOptions = {
      store,
      engineMode: "operator-run",
      engine,
      runtimeContext,
      managerPrincipal,
      network: "testnet",
      secretFilePath: join(directory, "secrets", "gas-wallet.key"),
      maximumFeeUstx: 100_000n,
      signerKeyHex: () => null,
      now: () => now,
      generatePrivateKey: () => privateKey,
      createReader: () => reader,
      ...overrides,
    };
    return {
      store,
      directory,
      engine,
      callReadOnly,
      options,
      service: new GasWalletService(options),
    };
  }

  it("generates the wallet once, writes a 0600 secret, and records only the public identity", async () => {
    const { service, store, options } = await fixture();
    const before = await service.status();
    expect(before).toMatchObject({ configured: false, enabled: false, signer: "not-loaded" });
    expect(gasWalletStatusSchema.parse(before)).toEqual(before);

    const created = await service.create();
    expect(created).toMatchObject({
      configured: true,
      enabled: false,
      source: "generated",
      principal,
      publicKey,
      secretFilePath: options.secretFilePath,
      createdAt: now.toISOString(),
      signer: "disabled",
      balanceUstx: "2500000",
      estimatedTransactions: 25,
      feeBasisUstx: "100000",
    });
    expect(gasWalletStatusSchema.parse(created)).toEqual(created);
    expect(JSON.stringify(created)).not.toContain(privateKey.slice(0, 16));
    const secretStat = await stat(options.secretFilePath);
    expect(secretStat.mode & 0o777).toBe(0o600);
    expect(await readFile(options.secretFilePath, "utf8")).toBe(`${privateKey}\n`);
    expect(store.gasWallet.get()).toMatchObject({ principal, publicKey, enabled: false });

    await expect(service.create()).rejects.toMatchObject({ code: "gas_wallet_exists" });
    store.gasWallet.remove();
    await expect(service.create()).rejects.toThrow("already exists at");
  });

  it("enables only after the refusal checks pass and activates the engine", async () => {
    const refusingAdmin = contextStub({ isAdmin: true });
    const { service, engine, store, options } = await fixture({
      runtimeContext: refusingAdmin.runtimeContext,
    });
    await service.create();
    await expect(service.enable()).rejects.toMatchObject({ code: "gas_wallet_refused" });
    expect(engine.activateGasWallet).not.toHaveBeenCalled();
    expect((await service.status()).refusal).toMatchObject({
      isManagerAdmin: true,
      isSignerKey: false,
      isContract: false,
      refusalReason: "manager-admin",
    });

    const signerKeyService = new GasWalletService({
      ...options,
      runtimeContext: contextStub().runtimeContext,
      signerKeyHex: () => publicKey,
    });
    await expect(signerKeyService.enable()).rejects.toThrow("signer key");

    const disconnected = new GasWalletService({
      ...options,
      runtimeContext: contextStub({ disconnected: true }).runtimeContext,
    });
    await expect(disconnected.enable()).rejects.toThrow("could not be read");

    const enabled = await service.status();
    expect(enabled.enabled).toBe(false);
    const allowed = new GasWalletService({
      ...options,
      runtimeContext: contextStub().runtimeContext,
    });
    const result = await allowed.enable();
    expect(engine.activateGasWallet).toHaveBeenCalledWith({
      principal,
      publicKey,
      secretFilePath: options.secretFilePath,
      network: "testnet",
    });
    expect(result).toMatchObject({
      enabled: true,
      enabledAt: now.toISOString(),
      signer: "ready",
      refusal: { refusalReason: null },
    });
    expect(store.gasWallet.get()).toMatchObject({ enabled: true });

    const disabled = await allowed.disable();
    expect(engine.deactivateGasWallet).toHaveBeenCalledTimes(1);
    expect(disabled).toMatchObject({ enabled: false, signer: "disabled" });
  });

  it("refuses to enable outside operator-run and tracks banner dismissals", async () => {
    const { service, options } = await fixture({ engineMode: "observe" });
    await service.create();
    await expect(service.enable()).rejects.toMatchObject({ code: "gas_wallet_engine_mode" });
    expect(await service.dismissBanner("setup")).toMatchObject({
      banners: { setupDismissedAt: now.toISOString(), lowBalanceDismissedUntil: null },
    });
    expect(await service.dismissBanner("low-balance")).toMatchObject({
      banners: {
        setupDismissedAt: now.toISOString(),
        lowBalanceDismissedUntil: "2026-08-23T12:00:00.000Z",
      },
    });
    const withoutEngine = new GasWalletService({
      ...options,
      engineMode: "operator-run",
      engine: null,
    });
    expect((await withoutEngine.status()).signer).toBe("engine-unavailable");
    await expect(withoutEngine.enable()).rejects.toMatchObject({
      code: "gas_wallet_engine_unavailable",
    });
    await expect(new GasWalletService(options).disable()).resolves.toMatchObject({
      enabled: false,
    });
    expect(new GasWalletError("gas_wallet_missing", "x").name).toBe("GasWalletError");
  });

  it("re-activates an enabled wallet at startup and reports activation failures", async () => {
    const { service, options, store } = await fixture();
    await service.create();
    await service.enable();
    expect(store.gasWallet.get()).toMatchObject({ enabled: true });

    const warn = vi.fn();
    const failing = engineStub({ activationError: "secret file permissions are too open" });
    const restarted = new GasWalletService({ ...options, engine: failing, logger: { warn } });
    await restarted.startup();
    expect(failing.activateGasWallet).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("permissions are too open"));
    expect(await restarted.status()).toMatchObject({
      enabled: true,
      signer: "unreadable",
      signerError: "secret file permissions are too open",
    });

    const healthy = engineStub();
    const recovered = new GasWalletService({ ...options, engine: healthy });
    await recovered.startup();
    expect(await recovered.status()).toMatchObject({ enabled: true, signer: "ready" });
  });
});
