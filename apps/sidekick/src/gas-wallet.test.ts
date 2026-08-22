import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boolCV,
  compressPublicKey,
  getAddressFromPublicKey,
  privateKeyToPublic,
} from "@stacks/transactions";
import {
  gasWalletStatusSchema,
  gasWalletSweepSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type GasWalletEngine,
  GasWalletError,
  type GasWalletReader,
  GasWalletService,
  type GasWalletServiceOptions,
} from "./gas-wallet.js";
import type { GasWalletSweepPlan } from "./gas-wallet-sweep.js";
import { openSidekickStore, type SidekickStore } from "./storage/store.js";
import type { SignedGasWalletSweepTransaction } from "./transaction-engine/gas-payer-signer.js";
import type { TransactionEngineRuntimeContext } from "./transaction-engine/runtime.js";
import type { TransactionBroadcastResult } from "./transaction-engine/transaction-broadcaster.js";

const privateKey = `${"11".repeat(32)}01`;
const publicKey = compressPublicKey(privateKeyToPublic(privateKey)).toLowerCase();
const principal = getAddressFromPublicKey(publicKey, "testnet");
const managerPrincipal = "ST000000000000000000002AMW42H.signer-manager";
const recipient = "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG";
const txid = `0x${"cd".repeat(32)}` as const;

interface Harness {
  now: Date;
  balanceUstx: bigint;
  nonce: bigint;
  isAdmin: boolean;
  disconnected: boolean;
  activeJobs: number;
  activationError: string | null;
  broadcast: TransactionBroadcastResult;
  indexed: unknown;
  unconfirmed: unknown;
}

function harness(): Harness {
  return {
    now: new Date("2026-08-22T12:00:00.000Z"),
    balanceUstx: 2_500_000n,
    nonce: 0n,
    isAdmin: false,
    disconnected: false,
    activeJobs: 0,
    activationError: null,
    broadcast: { status: "accepted", txid, httpStatus: 200 },
    indexed: { status: "not-found", httpStatus: 404 },
    unconfirmed: { status: "observed", httpStatus: 200, value: { location: { kind: "mempool" } } },
  };
}

function engineStub(state: Harness) {
  const signerState = { ready: false };
  const activateGasWallet = vi.fn(async () => {
    if (state.activationError) throw new Error(state.activationError);
    signerState.ready = true;
  });
  const deactivateGasWallet = vi.fn(async () => {
    signerState.ready = false;
  });
  const signGasWalletSweep = vi.fn(
    async (plan: GasWalletSweepPlan) =>
      ({
        kind: "signed-gas-wallet-sweep",
        planSha256: plan.planSha256,
        unsignedTransactionSha256: plan.unsignedTransactionSha256,
        precomputedTxid: txid,
        nonce: plan.material.nonce,
        fee: plan.material.feeUstx,
        signedTransactionBytes: new Uint8Array([1, 2, 3]),
      }) as unknown as SignedGasWalletSweepTransaction,
  );
  const engine: GasWalletEngine & {
    activateGasWallet: typeof activateGasWallet;
    deactivateGasWallet: typeof deactivateGasWallet;
    signGasWalletSweep: typeof signGasWalletSweep;
  } = {
    activateGasWallet,
    deactivateGasWallet,
    signGasWalletSweep,
    gasWalletSignerReady: () => signerState.ready,
    gasPayerIdentity: () => null,
    activeJobCount: () => state.activeJobs,
  };
  return engine;
}

function runtimeContextStub(state: Harness) {
  const callReadOnly = vi.fn(async () => boolCV(state.isAdmin));
  const runtimeContext = (): TransactionEngineRuntimeContext => {
    if (state.disconnected) throw new Error("The configured connection is not current");
    return {
      config: { network: "testnet", nodeRpcUrl: "http://127.0.0.1:20443" },
      node: { callReadOnly, getTenureInfo: async () => ({ tip_block_id: "ab".repeat(32) }) },
      api: {},
    } as unknown as TransactionEngineRuntimeContext;
  };
  return { runtimeContext, callReadOnly };
}

function readerStub(state: Harness): GasWalletReader {
  return {
    readAnchoredAccount: async () => ({
      status: "observed",
      httpStatus: 200,
      value: { balanceUstx: state.balanceUstx, nonce: state.nonce },
    }),
    lookupIndexedTransaction: async () => state.indexed,
    lookupUnconfirmedTransaction: async () => state.unconfirmed,
    estimateUnsignedTransactionFee: async () => ({
      status: "observed",
      httpStatus: 200,
      value: { estimates: { middle: { feeUstx: 250n } } },
    }),
  } as unknown as GasWalletReader;
}

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
    const state = harness();
    const engine = engineStub(state);
    const { runtimeContext, callReadOnly } = runtimeContextStub(state);
    const broadcast = vi.fn(async () => state.broadcast);
    const options: GasWalletServiceOptions = {
      store,
      engineMode: "operator-run",
      engine,
      runtimeContext,
      managerPrincipal,
      network: "testnet",
      chainId: 0x8000_0000,
      secretFilePath: join(directory, "secrets", "gas-wallet.key"),
      maximumFeeUstx: 100_000n,
      signerKeyHex: () => null,
      now: () => state.now,
      generatePrivateKey: () => privateKey,
      createReader: () => readerStub(state),
      createBroadcaster: () => ({ broadcast }),
      ...overrides,
    };
    return {
      store,
      directory,
      state,
      engine,
      callReadOnly,
      broadcast,
      options,
      service: new GasWalletService(options),
    };
  }

  it("generates the wallet once, writes a 0600 secret, and records only the public identity", async () => {
    const { service, store, options, state } = await fixture();
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
      createdAt: state.now.toISOString(),
      signer: "disabled",
      balanceUstx: "2500000",
      estimatedTransactions: 25,
      feeBasisUstx: "100000",
      activeSweepId: null,
      sweeps: [],
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
    const { service, engine, store, options, state } = await fixture();
    await service.create();
    state.isAdmin = true;
    await expect(service.enable()).rejects.toMatchObject({ code: "gas_wallet_refused" });
    expect(engine.activateGasWallet).not.toHaveBeenCalled();
    expect((await service.status()).refusal).toMatchObject({
      isManagerAdmin: true,
      isSignerKey: false,
      isContract: false,
      refusalReason: "manager-admin",
    });
    state.isAdmin = false;

    const signerKeyService = new GasWalletService({ ...options, signerKeyHex: () => publicKey });
    await expect(signerKeyService.enable()).rejects.toThrow("signer key");

    state.disconnected = true;
    await expect(service.enable()).rejects.toThrow("could not be read");
    state.disconnected = false;

    const result = await service.enable();
    expect(engine.activateGasWallet).toHaveBeenCalledWith({
      principal,
      publicKey,
      secretFilePath: options.secretFilePath,
      network: "testnet",
    });
    expect(result).toMatchObject({
      enabled: true,
      enabledAt: state.now.toISOString(),
      signer: "ready",
      refusal: { refusalReason: null },
    });
    expect(store.gasWallet.get()).toMatchObject({ enabled: true });

    const disabled = await service.disable();
    expect(engine.deactivateGasWallet).toHaveBeenCalledTimes(1);
    expect(disabled).toMatchObject({ enabled: false, signer: "disabled" });
  });

  it("refuses to enable outside operator-run and tracks banner dismissals", async () => {
    const { service, options, state } = await fixture({ engineMode: "observe" });
    await service.create();
    await expect(service.enable()).rejects.toMatchObject({ code: "gas_wallet_engine_mode" });
    expect(await service.dismissBanner("setup")).toMatchObject({
      banners: { setupDismissedAt: state.now.toISOString(), lowBalanceDismissedUntil: null },
    });
    expect(await service.dismissBanner("low-balance")).toMatchObject({
      banners: {
        setupDismissedAt: state.now.toISOString(),
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
    const { service, options, store, state } = await fixture();
    await service.create();
    await service.enable();
    expect(store.gasWallet.get()).toMatchObject({ enabled: true });

    const warn = vi.fn();
    const failingState = { ...state, activationError: "secret file permissions are too open" };
    const failing = engineStub(failingState);
    const restarted = new GasWalletService({ ...options, engine: failing, logger: { warn } });
    await restarted.startup();
    expect(failing.activateGasWallet).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("permissions are too open"));
    expect(await restarted.status()).toMatchObject({
      enabled: true,
      signer: "unreadable",
      signerError: "secret file permissions are too open",
    });

    const healthy = engineStub(state);
    const recovered = new GasWalletService({ ...options, engine: healthy });
    await recovered.startup();
    expect(await recovered.status()).toMatchObject({ enabled: true, signer: "ready" });
  });

  it("seals, approves, broadcasts, and settles a sweep of balance minus fee", async () => {
    const { service, engine, broadcast, state } = await fixture();
    await service.create();
    await service.enable();

    const planned = await service.prepareSweep({ recipient });
    expect(gasWalletSweepSchema.parse(planned)).toEqual(planned);
    expect(planned).toMatchObject({
      status: "planned",
      walletPrincipal: principal,
      recipient,
      amountUstx: "2499750",
      feeUstx: "250",
      nonce: "0",
      balanceUstx: "2500000",
      txid: null,
      expiresAt: "2026-08-22T12:30:00.000Z",
    });
    expect((await service.status()).activeSweepId).toBe(planned.sweepId);
    await expect(service.prepareSweep({ recipient })).rejects.toMatchObject({
      code: "gas_wallet_sweep_blocked",
    });

    const broadcasted = await service.approveSweep(planned.sweepId);
    expect(engine.signGasWalletSweep).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcasted).toMatchObject({
      status: "broadcast",
      txid,
      broadcastAmbiguous: false,
      approvedAt: state.now.toISOString(),
      broadcastAt: state.now.toISOString(),
    });
    await expect(service.approveSweep(planned.sweepId)).rejects.toMatchObject({
      code: "gas_wallet_sweep_state",
    });

    // Still in the mempool: nothing settles yet.
    expect((await service.refreshSweep(planned.sweepId)).status).toBe("broadcast");
    state.indexed = {
      status: "observed",
      httpStatus: 200,
      value: { isCanonical: true, resultRepr: "(ok true)", blockHeight: 1234n },
    };
    const confirmed = await service.refreshSweep(planned.sweepId);
    expect(confirmed).toMatchObject({
      status: "confirmed",
      blockHeight: 1234,
      failureReason: null,
    });
    expect((await service.status()).activeSweepId).toBeNull();

    // A second sweep can be prepared once the first has settled; cancelling keeps the wallet free.
    state.now = new Date("2026-08-22T12:10:00.000Z");
    const second = await service.prepareSweep({ recipient });
    expect((await service.cancelSweep(second.sweepId)).status).toBe("cancelled");
    expect((await service.listSweeps()).map((sweep) => sweep.status)).toEqual([
      "cancelled",
      "confirmed",
    ]);
  });

  it("fails closed on stale nonces, expiry, busy engines, rejections, and bad recipients", async () => {
    const { service, state, engine } = await fixture();
    await service.create();
    await service.enable();

    await expect(service.prepareSweep({ recipient: principal })).rejects.toMatchObject({
      code: "invalid_gas_wallet_sweep_recipient",
    });
    await expect(
      service.prepareSweep({ recipient: "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7" }),
    ).rejects.toMatchObject({ code: "invalid_gas_wallet_sweep_recipient" });
    state.balanceUstx = 100n;
    await expect(service.prepareSweep({ recipient })).rejects.toMatchObject({
      code: "gas_wallet_sweep_empty",
    });
    state.balanceUstx = 2_500_000n;

    state.activeJobs = 1;
    await expect(service.prepareSweep({ recipient })).rejects.toMatchObject({
      code: "gas_wallet_sweep_blocked",
    });
    state.activeJobs = 0;

    const refusedAtSignature = await service.prepareSweep({ recipient });
    state.isAdmin = true;
    await expect(service.approveSweep(refusedAtSignature.sweepId)).rejects.toMatchObject({
      code: "gas_wallet_refused",
    });
    state.isAdmin = false;
    expect(engine.signGasWalletSweep).not.toHaveBeenCalled();
    expect((await service.cancelSweep(refusedAtSignature.sweepId)).status).toBe("cancelled");

    const stale = await service.prepareSweep({ recipient });
    state.nonce = 1n;
    await expect(service.approveSweep(stale.sweepId)).rejects.toMatchObject({
      code: "gas_wallet_sweep_stale",
    });
    expect(await service.refreshSweep(stale.sweepId)).toMatchObject({
      status: "expired",
      failureReason: "Wallet nonce changed after the sweep was planned",
    });
    expect(engine.signGasWalletSweep).not.toHaveBeenCalled();
    state.nonce = 0n;

    state.now = new Date("2026-08-22T12:01:00.000Z");
    const expiring = await service.prepareSweep({ recipient });
    state.now = new Date("2026-08-22T12:32:00.000Z");
    await expect(service.approveSweep(expiring.sweepId)).rejects.toMatchObject({
      code: "gas_wallet_sweep_expired",
    });
    expect((await service.status()).sweeps[0]).toMatchObject({
      sweepId: expiring.sweepId,
      status: "expired",
    });

    const rejected = await service.prepareSweep({ recipient });
    state.broadcast = {
      status: "deterministic-rejection",
      txid,
      httpStatus: 400,
      reason: "node-rejection",
      nodeMessage: "FeeTooLow",
    };
    expect(await service.approveSweep(rejected.sweepId)).toMatchObject({
      status: "failed",
      txid,
      failureReason: "Node rejected the sweep: FeeTooLow",
    });

    const ambiguous = await service.prepareSweep({ recipient });
    state.broadcast = { status: "ambiguous", txid, httpStatus: null, reason: "timeout" };
    expect(await service.approveSweep(ambiguous.sweepId)).toMatchObject({
      status: "broadcast",
      broadcastAmbiguous: true,
    });
    state.unconfirmed = { status: "not-found", httpStatus: 404 };
    expect((await service.refreshSweep(ambiguous.sweepId)).status).toBe("broadcast");
    state.now = new Date("2026-08-22T13:05:00.000Z");
    expect(await service.refreshSweep(ambiguous.sweepId)).toMatchObject({
      status: "failed",
      failureReason: expect.stringContaining("never saw the sweep"),
    });

    await expect(
      service.refreshSweep("00000000-0000-4000-8000-000000000099"),
    ).rejects.toMatchObject({
      code: "gas_wallet_sweep_not_found",
    });
    await service.disable();
    const notReady = await service.prepareSweep({ recipient });
    await expect(service.approveSweep(notReady.sweepId)).rejects.toMatchObject({
      code: "gas_wallet_engine_unavailable",
    });
  });
});
