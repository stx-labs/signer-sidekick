import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boolCV,
  compressPublicKey,
  getAddressFromPublicKey,
  makeSTXTokenTransfer,
  privateKeyToPublic,
} from "@stacks/transactions";
import {
  type ConnectionAssessment,
  gasWalletStatusSchema,
  gasWalletSweepSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChainAnchorError,
  RateLimitedError,
  UpstreamHttpError,
  UpstreamSchemaError,
  UpstreamUnavailableError,
} from "./chain-clients.js";
import {
  requireConnectedAssessment,
  requireObservationAssessment,
} from "./connection-assessment.js";
import {
  type GasWalletEngine,
  GasWalletError,
  type GasWalletReader,
  GasWalletService,
  type GasWalletServiceOptions,
} from "./gas-wallet.js";
import type { GasWalletSweepPlan } from "./gas-wallet-sweep.js";
import { openSidekickStore, type SidekickStore } from "./storage/store.js";
import { apiTransactionReceipt } from "./test-helpers/api-transaction.js";
import { nakamotoBlockBytes } from "./test-helpers/nakamoto-block.js";
import {
  GasPayerSigner,
  type SignedGasWalletSweepTransaction,
} from "./transaction-engine/gas-payer-signer.js";
import type { TransactionEngineRuntimeContext } from "./transaction-engine/runtime.js";
import type { TransactionBroadcastResult } from "./transaction-engine/transaction-broadcaster.js";

const privateKey = `${"11".repeat(32)}01`;
const publicKey = compressPublicKey(privateKeyToPublic(privateKey)).toLowerCase();
const principal = getAddressFromPublicKey(publicKey, "testnet");
const managerPrincipal = "ST000000000000000000002AMW42H.signer-manager";
const recipient = "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG";
const proofTransaction = await makeSTXTokenTransfer({
  recipient,
  amount: 1n,
  senderKey: privateKey,
  nonce: 1n,
  fee: 1_000n,
  network: "testnet",
});
const txid = `0x${proofTransaction.txid()}` as const;
const blockHash = `0x${"22".repeat(32)}` as const;
const indexBlockHash = `0x${"33".repeat(32)}` as const;
const blockHeight = 1_234;

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
  apiTransaction: "not-found" | "success";
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
    apiTransaction: "not-found",
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
  const blockBytes = nakamotoBlockBytes(proofTransaction.serializeBytes());
  const runtimeContext = (): TransactionEngineRuntimeContext => {
    if (state.disconnected) throw new Error("The configured connection is not current");
    return {
      config: { network: "testnet", nodeRpcUrl: "http://127.0.0.1:20443" },
      node: {
        callReadOnly,
        getTenureInfo: async () => ({
          tip_block_id: `0x${"ab".repeat(32)}`,
          tip_height: blockHeight + 10,
          reward_cycle: 141,
        }),
        getNakamotoBlockById: async () => blockBytes,
        getNakamotoBlockAtHeight: async () => blockBytes,
      },
      api: {
        getNodeInfo: async () => ({ network_id: 0x8000_0000 }),
        getTransactionDetails: async () => {
          if (state.apiTransaction === "not-found") {
            throw new UpstreamHttpError("not found", 404);
          }
          return apiTransactionReceipt({ txId: txid, blockHash, blockHeight });
        },
        getBlock: async () => ({
          canonical: true,
          height: blockHeight,
          hash: blockHash,
          index_block_hash: indexBlockHash,
        }),
      },
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

  it("reuses recent public status and coalesces concurrent refreshes", async () => {
    const { service, state, callReadOnly } = await fixture();
    await service.create();
    callReadOnly.mockClear();

    await service.status();
    await service.status();
    expect(callReadOnly).not.toHaveBeenCalled();

    state.now = new Date(state.now.getTime() + 31_000);
    await Promise.all([service.status(), service.status()]);
    expect(callReadOnly).toHaveBeenCalledTimes(1);
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

  it.each([
    "manager",
    "signer",
  ] as const)("preserves typed transient %s role errors only for run retries", async (source) => {
    const { options, state } = await fixture();
    for (const error of [
      new UpstreamUnavailableError("node timeout"),
      new RateLimitedError("limited", 5_000),
      new ChainAnchorError("tip moved", { retryable: true }),
    ]) {
      const service = new GasWalletService({
        ...options,
        ...(source === "manager"
          ? {
              runtimeContext: () => {
                throw error;
              },
            }
          : {
              signerKeyHex: async () => {
                throw error;
              },
            }),
      });
      await expect(service.refusalChecks(principal, state.now)).resolves.toMatchObject({
        refusalReason: "check-unavailable",
      });
      await expect(
        service.refusalChecks(principal, state.now, { retryTransient: true }),
      ).rejects.toBe(error);
    }
    const malformed = new GasWalletService({
      ...options,
      ...(source === "manager"
        ? {
            runtimeContext: () => {
              throw new UpstreamSchemaError("bad role evidence");
            },
          }
        : {
            signerKeyHex: async () => {
              throw new UpstreamSchemaError("bad signer evidence");
            },
          }),
    });
    await expect(
      malformed.refusalChecks(principal, state.now, { retryTransient: true }),
    ).resolves.toMatchObject({ refusalReason: "check-unavailable" });
  });

  it("preserves a proven forbidden wallet role even if another role read is transiently unavailable", async () => {
    const { options, state } = await fixture();
    state.isAdmin = true;
    const service = new GasWalletService({
      ...options,
      signerKeyHex: async () => {
        throw new UpstreamUnavailableError("unavailable");
      },
    });
    await expect(
      service.refusalChecks(principal, state.now, { retryTransient: true }),
    ).resolves.toMatchObject({ refusalReason: "manager-admin" });
    const disconnected = new GasWalletService({
      ...options,
      runtimeContext: () => {
        throw new UpstreamUnavailableError("unavailable");
      },
    });
    await expect(
      disconnected.refusalChecks(managerPrincipal, state.now, { retryTransient: true }),
    ).resolves.toMatchObject({ refusalReason: "contract-principal" });
  });

  it("does not hide a malformed manager role behind a later transient signer read", async () => {
    const { options, state } = await fixture();
    const service = new GasWalletService({
      ...options,
      runtimeContext: () => {
        throw new UpstreamSchemaError("invalid manager role");
      },
      signerKeyHex: async () => {
        throw new UpstreamUnavailableError("signer read timeout");
      },
    });
    await expect(
      service.refusalChecks(principal, state.now, { retryTransient: true }),
    ).resolves.toMatchObject({ refusalReason: "check-unavailable" });
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
      status: "unavailable",
      httpStatus: 501,
      reason: "transaction-index-unavailable",
    };
    state.unconfirmed = { status: "not-found", httpStatus: 404 };
    state.apiTransaction = "success";
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
      status: "broadcast",
      broadcastAmbiguous: true,
    });
    await expect(service.prepareSweep({ recipient })).rejects.toMatchObject({
      code: "gas_wallet_sweep_blocked",
    });

    await expect(
      service.refreshSweep("00000000-0000-4000-8000-000000000099"),
    ).rejects.toMatchObject({
      code: "gas_wallet_sweep_not_found",
    });
    await service.disable();
    await expect(service.approveSweep(ambiguous.sweepId)).rejects.toMatchObject({
      code: "gas_wallet_engine_unavailable",
    });
  });

  it("persists the submitted identity before broadcast, survives that crash seam, and observes with the signer disabled", async () => {
    const h = await fixture();
    const databasePath = join(h.directory, "crash.sqlite");
    const { store } = await openSidekickStore(databasePath);
    const first = new GasWalletService({ ...h.options, store });
    await first.create();
    await first.enable();
    const planned = await first.prepareSweep({ recipient });
    // Simulate process death inside broadcast: there is never a broadcaster response to save.
    h.broadcast.mockImplementation(() => new Promise(() => {}));
    void first.approveSweep(planned.sweepId);
    await vi.waitFor(() => expect(h.broadcast).toHaveBeenCalledOnce());
    expect(store.gasWalletSweeps.get(planned.sweepId)).toMatchObject({
      status: "broadcast",
      txid,
      broadcastAmbiguous: true,
      approvedAt: h.state.now.toISOString(),
    });
    store.close();
    const reopened = await openSidekickStore(databasePath);
    stores.push(reopened.store);
    const restarted = new GasWalletService({ ...h.options, store: reopened.store });
    await restarted.disable();
    h.state.now = new Date("2026-08-23T12:00:00.000Z");
    h.state.unconfirmed = { status: "not-found", httpStatus: 404 };
    await restarted.observeSubmitted();
    expect(reopened.store.gasWalletSweeps.active()).toMatchObject({ status: "broadcast", txid });
    h.state.apiTransaction = "success";
    h.state.now = new Date("2026-08-23T12:00:30.000Z");
    await restarted.observeSubmitted();
    expect(reopened.store.gasWalletSweeps.get(planned.sweepId)).toMatchObject({
      status: "confirmed",
      txid,
    });
    expect(reopened.store.gasWalletSweeps.active()).toBeNull();
    expect(h.engine.signGasWalletSweep).toHaveBeenCalledOnce();
    expect(h.broadcast).toHaveBeenCalledOnce();
  });

  it("completes a genuinely locally signed sweep via API after restart with the node unavailable and signer unloaded", async () => {
    const h = await fixture();
    const databasePath = join(h.directory, "api-completion.sqlite");
    const initial = await openSidekickStore(databasePath);
    let assessment = { status: "connected" } as ConnectionAssessment;
    let submittedTxid = txid;
    const context = h.options.runtimeContext();
    const getTransactionDetails = vi.fn(async () =>
      apiTransactionReceipt({ txId: submittedTxid, blockHash, blockHeight }),
    );
    const observationContext = {
      ...context,
      node: {
        ...context.node,
        getTenureInfo: async () => {
          throw new UpstreamUnavailableError("node offline");
        },
      },
      api: { ...context.api, getTransactionDetails },
    } as unknown as TransactionEngineRuntimeContext;
    const options = {
      ...h.options,
      store: initial.store,
      runtimeContext: () => {
        requireConnectedAssessment(assessment);
        return context;
      },
      observationRuntimeContext: () => {
        requireObservationAssessment(assessment);
        return observationContext;
      },
    };
    const first = new GasWalletService(options);
    await first.create();
    await first.enable();
    const signer = await GasPayerSigner.fromSecretFile({
      secretFilePath: h.options.secretFilePath,
      expectedPrincipal: principal,
      network: "testnet",
    });
    h.engine.signGasWalletSweep.mockImplementation((plan) => signer.signGasWalletSweepPlan(plan));
    const plan = await first.prepareSweep({ recipient });
    h.broadcast.mockRejectedValue(new Error("ambiguous transport failure"));
    const submitted = await first.approveSweep(plan.sweepId);
    if (!submitted.txid) throw new Error("Expected persisted locally signed identity");
    submittedTxid = submitted.txid;
    signer.destroy();
    initial.store.close();
    const reopened = await openSidekickStore(databasePath);
    stores.push(reopened.store);
    const restarted = new GasWalletService({ ...options, store: reopened.store, engine: null });
    assessment = { status: "blocked" } as ConnectionAssessment;
    await expect(restarted.observeSubmitted()).rejects.toThrow("identity/network");
    expect(getTransactionDetails).not.toHaveBeenCalled();
    assessment = { status: "unavailable" } as ConnectionAssessment;
    // Manual refresh bypasses the pacing of the preceding refused read.
    expect(await restarted.refreshSweep(plan.sweepId)).toMatchObject({
      status: "confirmed",
      executionSource: "api",
      txid: submittedTxid,
    });
    expect(reopened.store.gasWalletSweeps.active()).toBeNull();
    expect(reopened.store.gasWalletSweeps.get(plan.sweepId)?.executionSource).toBe("api");
    const final = await openSidekickStore(databasePath);
    stores.push(final.store);
    expect(final.store.gasWalletSweeps.get(plan.sweepId)?.executionSource).toBe("api");
    expect(h.engine.signGasWalletSweep).toHaveBeenCalledOnce();
    expect(h.broadcast).toHaveBeenCalledOnce();
  });

  it.each([
    "plan-missing",
    "plan-corrupt",
    "approval-missing",
    "broadcast-missing",
    "prior-conflict",
  ])("keeps an API-reported sweep pending when its local binding has %s", async (kind) => {
    const h = await fixture();
    await h.service.create();
    await h.service.enable();
    const planned = await h.service.prepareSweep({ recipient });
    await h.service.approveSweep(planned.sweepId);
    if (kind === "plan-missing") vi.spyOn(h.store.gasWalletSweeps, "getPlan").mockReturnValue(null);
    if (kind === "plan-corrupt") {
      const plan = h.store.gasWalletSweeps.getPlan(planned.sweepId);
      if (!plan) throw new Error("Missing plan");
      vi.spyOn(h.store.gasWalletSweeps, "getPlan").mockReturnValue({
        ...plan,
        unsignedTransactionHex: "00",
      });
    }
    if (kind === "approval-missing")
      h.store.gasWalletSweeps.update(
        planned.sweepId,
        { approvedAt: null },
        h.state.now.toISOString(),
      );
    if (kind === "broadcast-missing")
      h.store.gasWalletSweeps.update(
        planned.sweepId,
        { broadcastAt: null },
        h.state.now.toISOString(),
      );
    if (kind === "prior-conflict")
      h.store.gasWalletSweeps.update(
        planned.sweepId,
        { failureReason: "Unresolved node disagreement" },
        h.state.now.toISOString(),
      );
    h.state.apiTransaction = "success";
    const context = h.options.runtimeContext();
    const service = new GasWalletService({
      ...h.options,
      observationRuntimeContext: () => ({
        ...context,
        node: {
          ...context.node,
          getTenureInfo: async () => {
            throw new UpstreamUnavailableError("offline");
          },
        },
      }),
    });
    expect(await service.refreshSweep(planned.sweepId)).toMatchObject({
      status: "broadcast",
      executionSource: null,
    });
    expect(h.store.gasWalletSweeps.active()?.sweepId).toBe(planned.sweepId);
  });

  it("bounds never-appearing sweep observations, retains authorization, and allows immediate manual refresh", async () => {
    const h = await fixture();
    const context = h.options.runtimeContext();
    const getTransactionDetails = vi.fn(context.api.getTransactionDetails);
    const getNodeInfo = vi.fn(context.api.getNodeInfo);
    const reader = readerStub(h.state);
    const lookupIndexedTransaction = vi.fn(reader.lookupIndexedTransaction);
    const service = new GasWalletService({
      ...h.options,
      runtimeContext: () => ({
        ...context,
        api: { ...context.api, getTransactionDetails, getNodeInfo },
      }),
      createReader: () => ({ ...reader, lookupIndexedTransaction }),
    });
    await service.create();
    await service.enable();
    const planned = await service.prepareSweep({ recipient });
    h.state.broadcast = { status: "ambiguous", txid, httpStatus: null, reason: "timeout" };
    await service.approveSweep(planned.sweepId);
    h.state.unconfirmed = { status: "not-found", httpStatus: 404 };
    const loadPlan = vi.spyOn(h.store.gasWalletSweeps, "getPlan");
    const startedAt = h.state.now.getTime();
    for (let seconds = 0; seconds < 3600; seconds += 5) {
      h.state.now = new Date(startedAt + seconds * 1000);
      await service.observeSubmitted();
    }
    expect(lookupIndexedTransaction).toHaveBeenCalledTimes(15);
    expect(getNodeInfo).toHaveBeenCalledTimes(15);
    expect(getTransactionDetails).toHaveBeenCalledTimes(15);
    expect(loadPlan).not.toHaveBeenCalled();
    expect(h.store.gasWalletSweeps.active()).toMatchObject({
      status: "broadcast",
      txid,
      broadcastAmbiguous: true,
    });
    // No automatic abandonment or repeat authority, even though the approval window elapsed.
    await expect(service.prepareSweep({ recipient })).rejects.toMatchObject({
      code: "gas_wallet_sweep_blocked",
    });
    h.state.apiTransaction = "success";
    await service.observeSubmitted();
    expect(lookupIndexedTransaction).toHaveBeenCalledTimes(15);
    expect(await service.refreshSweep(planned.sweepId)).toMatchObject({ status: "confirmed" });
    expect(lookupIndexedTransaction).toHaveBeenCalledTimes(16);
    h.state.now = new Date(startedAt + 4000 * 1000);
    await service.observeSubmitted();
    expect(lookupIndexedTransaction).toHaveBeenCalledTimes(16);
    expect(h.store.gasWalletSweeps.active()).toBeNull();
    expect(h.engine.signGasWalletSweep).toHaveBeenCalledOnce();
    expect(h.broadcast).toHaveBeenCalledOnce();
  });

  it.each([
    "mempool",
    "unavailable",
  ])("paces %s sweep observations without manufacturing an outcome or releasing authorization", async (result) => {
    const h = await fixture();
    const context = h.options.runtimeContext();
    const reader = readerStub(h.state);
    const lookupIndexedTransaction = vi.fn(reader.lookupIndexedTransaction);
    const service = new GasWalletService({
      ...h.options,
      runtimeContext: () => ({
        ...context,
        api: {
          ...context.api,
          getTransactionDetails:
            result === "unavailable"
              ? async () => {
                  throw new UpstreamHttpError("unavailable", 503);
                }
              : context.api.getTransactionDetails,
        },
      }),
      createReader: () => ({ ...reader, lookupIndexedTransaction }),
    });
    await service.create();
    await service.enable();
    const planned = await service.prepareSweep({ recipient });
    await service.approveSweep(planned.sweepId);
    if (result === "unavailable") h.state.unconfirmed = { status: "not-found", httpStatus: 404 };
    const startedAt = h.state.now.getTime();
    for (let seconds = 0; seconds < 120; seconds += 5) {
      h.state.now = new Date(startedAt + seconds * 1000);
      await service.observeSubmitted();
    }
    expect(lookupIndexedTransaction).toHaveBeenCalledTimes(result === "mempool" ? 4 : 3);
    expect(h.store.gasWalletSweeps.active()?.sweepId).toBe(planned.sweepId);
  });

  it("coalesces approval and preserves confirmation observed before the broadcast response returns", async () => {
    const h = await fixture();
    await h.service.create();
    await h.service.enable();
    const planned = await h.service.prepareSweep({ recipient });
    const response = Promise.withResolvers<TransactionBroadcastResult>();
    h.broadcast.mockReturnValue(response.promise);
    const approvals = [
      h.service.approveSweep(planned.sweepId),
      h.service.approveSweep(planned.sweepId),
    ];
    await vi.waitFor(() => expect(h.broadcast).toHaveBeenCalledOnce());
    h.state.apiTransaction = "success";
    await h.service.observeSubmitted();
    response.resolve(h.state.broadcast);
    expect(await Promise.all(approvals)).toMatchObject([
      { status: "confirmed" },
      { status: "confirmed" },
    ]);
    expect(h.engine.signGasWalletSweep).toHaveBeenCalledOnce();
    expect(h.store.gasWalletSweeps.active()).toBeNull();
  });

  it("does not release a sweep authorization for an index result with no anchored height", async () => {
    const h = await fixture();
    await h.service.create();
    await h.service.enable();
    const planned = await h.service.prepareSweep({ recipient });
    await h.service.approveSweep(planned.sweepId);
    h.state.indexed = {
      status: "observed",
      value: { isCanonical: true, blockHeight: null, resultRepr: "(ok true)" },
    };
    await h.service.observeSubmitted();
    expect(h.store.gasWalletSweeps.active()?.sweepId).toBe(planned.sweepId);
  });

  it.each([
    "absent",
    "reorged",
  ] as const)("retains the wallet authorization on a positive %s conflict", async (kind) => {
    const h = await fixture();
    await h.service.create();
    await h.service.enable();
    const planned = await h.service.prepareSweep({ recipient });
    await h.service.approveSweep(planned.sweepId);
    h.state.apiTransaction = "success";
    const context = h.options.runtimeContext();
    const empty = new Uint8Array(220);
    const service = new GasWalletService({
      ...h.options,
      runtimeContext: () => ({
        ...context,
        node: {
          ...context.node,
          getNakamotoBlockAtHeight: async () => empty,
          ...(kind === "absent" ? { getNakamotoBlockById: async () => empty } : {}),
        },
      }),
    });
    await service.observeSubmitted();
    expect(h.store.gasWalletSweeps.active()).toMatchObject({
      status: "broadcast",
      failureReason: expect.stringContaining(`conflict: ${kind}`),
    });
    await expect(service.prepareSweep({ recipient })).rejects.toMatchObject({
      code: "gas_wallet_sweep_blocked",
    });
    expect(h.engine.signGasWalletSweep).toHaveBeenCalledOnce();
  });

  it("does not broadcast if the approval was cancelled during signing", async () => {
    const h = await fixture();
    await h.service.create();
    await h.service.enable();
    const planned = await h.service.prepareSweep({ recipient });
    const sign = h.engine.signGasWalletSweep.getMockImplementation();
    if (!sign) throw new Error("Missing signer fixture");
    h.engine.signGasWalletSweep.mockImplementation(async (plan) => {
      await h.service.cancelSweep(planned.sweepId);
      return sign(plan);
    });
    await expect(h.service.approveSweep(planned.sweepId)).rejects.toMatchObject({
      code: "gas_wallet_sweep_state",
    });
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.store.gasWalletSweeps.get(planned.sweepId)?.status).toBe("cancelled");
  });
});
