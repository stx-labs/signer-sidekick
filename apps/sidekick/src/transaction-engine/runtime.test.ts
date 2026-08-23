import { getAddressFromPublicKey, privateKeyToPublic } from "@stacks/transactions";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChainAnchor } from "../chain-anchor.js";
import type { StacksApiClient, StacksNodeClient } from "../chain-clients.js";
import type { SidekickConfig } from "../config.js";
import type { OperatorAnchorSnapshot } from "../operator-anchor-snapshot.js";
import { createChainSourceId, openSidekickStore, type SidekickStore } from "../storage/store.js";
import { GasPayerSigner } from "./gas-payer-signer.js";
import type { ManagerClaimObservationInput } from "./manager-claim-observation-service.js";
import { managerClaimOperationScopeKey } from "./manager-claim-observer.js";
import type { ManagerClaimProposal } from "./manager-claim-proposal.js";
import { ManagerClaimWalletIntentError } from "./manager-claim-wallet-intent.js";
import type { StoredTransactionJob } from "./repository.js";
import {
  createSidekickTransactionEngineRuntime,
  SidekickTransactionEngineRuntime,
  type SidekickTransactionEngineRuntimeComposition,
  type TransactionEngineRuntimeContext,
} from "./runtime.js";

const stores: SidekickStore[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
});

function anchor(stacksBlockHeight: number): ChainAnchor {
  return {
    stacksBlockHeight,
    indexBlockHash: `0x${stacksBlockHeight.toString(16).padStart(64, "0")}`,
    burnBlockHeight: 960_000 + stacksBlockHeight,
    rewardCycle: 144,
    rewardCycleLength: 2_100,
    prepareCycleLength: 100,
    cyclePosition: 100,
    phase: "reward",
    checkpoint: "first-half",
  };
}

function config(): SidekickConfig {
  return {
    network: "mainnet",
    nodeRpcUrl: "http://127.0.0.1:20443",
    apiUrl: "http://127.0.0.1:3999",
    apiKeyHeader: "x-api-key",
    maxApiBurnBlockLag: 12,
    forecastHorizonCycles: 6,
    stakerPageLimit: 200,
    eventPageLimit: 100,
    databasePath: ":memory:",
  };
}

function context(): TransactionEngineRuntimeContext {
  return {
    config: config(),
    node: {} as StacksNodeClient,
    api: {} as StacksApiClient,
  };
}

function setup(value: ChainAnchor): OperatorAnchorSnapshot {
  return { chainAnchor: value } as OperatorAnchorSnapshot;
}

function blockedOutcome() {
  return {
    status: "blocked" as const,
    blocks: [
      {
        code: "attestation-unavailable" as const,
        message: "A current signed compatibility attestation is required",
      },
    ],
  };
}

function observeComposition(options: {
  freshAnchor: ChainAnchor;
  seen: ManagerClaimObservationInput[];
  freshReads: ReturnType<typeof vi.fn>;
}): SidekickTransactionEngineRuntimeComposition {
  const repository = {
    listLogicalJobs: vi.fn(() => ({ items: [], nextCursor: null, total: 0 })),
  };
  const store = { transactionEngine: repository } as unknown as SidekickStore;
  const runtimeContext = context();
  return {
    runtimeConfig: {
      requestedMode: "observe",
      gasPayer: null,
      finalityDepth: 6,
      maximumFeeUstx: 100_000n,
      maximumApprovalMinutes: 30,
    },
    store,
    runtimeContext: () => runtimeContext,
    signerHolder: { current: null, identity: null },
    createObservationService: () => ({
      observe: async (input) => {
        options.seen.push(input);
        return blockedOutcome();
      },
    }),
    readFreshObservation: async () => {
      options.freshReads();
      return {
        setup: setup(options.freshAnchor),
        rewards: null,
        sourceId: createChainSourceId(runtimeContext.config.network, runtimeContext.config.apiUrl),
        observedAt: "2026-07-17T12:01:00.000Z",
      };
    },
    captureAnchor: async () => options.freshAnchor,
    now: () => new Date("2026-07-17T12:01:00.000Z"),
    onError: vi.fn(),
  };
}

describe("transaction engine runtime composition", () => {
  it("starts Observe mode without gas-payer or attestation files", async () => {
    const { store } = await openSidekickStore(":memory:");
    stores.push(store);
    const runtime = await createSidekickTransactionEngineRuntime({
      env: {},
      store,
      managerPrincipal: "SP000000000000000000002Q6VF78.signer-manager",
      managerVerification: undefined,
      runtimeContext: context,
    });

    expect(runtime.api.status()).toMatchObject({
      mode: "observe",
      adapters: [{ mode: "observe", enabled: true }],
    });
    await runtime.close();
  });

  it("rejects the retired Assist mode before startup", async () => {
    const { store } = await openSidekickStore(":memory:");
    stores.push(store);

    await expect(
      createSidekickTransactionEngineRuntime({
        env: { SIDEKICK_ENGINE_MODE: "assist" },
        store,
        managerPrincipal: "SP000000000000000000002Q6VF78.signer-manager",
        managerVerification: undefined,
        runtimeContext: context,
      }),
    ).rejects.toThrow("SIDEKICK_ENGINE_MODE=assist is retired");
  });

  it("starts operator-run without a gas wallet and activates one later", async () => {
    const { store } = await openSidekickStore(":memory:");
    stores.push(store);
    const publicKey = privateKeyToPublic(`${"11".repeat(32)}01`);
    const principal = getAddressFromPublicKey(publicKey, "testnet");
    const destroy = vi.fn();
    const fromSecretFile = vi
      .spyOn(GasPayerSigner, "fromSecretFile")
      .mockResolvedValue({ principal, publicKey, destroy } as unknown as GasPayerSigner);
    const operatorContext = context();
    operatorContext.config.network = "testnet";

    const runtime = await createSidekickTransactionEngineRuntime({
      env: { SIDEKICK_ENGINE_MODE: "operator-run" },
      store,
      managerPrincipal: "ST000000000000000000002AMW42H.signer-manager",
      managerVerification: undefined,
      runtimeContext: () => operatorContext,
    });
    expect(runtime.requestedMode).toBe("operator-run");
    expect(runtime.api.status()).toMatchObject({ mode: "operator-run" });
    expect(runtime.gasWalletSignerReady()).toBe(false);
    expect(runtime.gasPayerIdentity()).toBeNull();
    expect(fromSecretFile).not.toHaveBeenCalled();

    await expect(
      runtime.activateGasWallet({
        principal,
        publicKey: "02ab".padEnd(66, "0"),
        secretFilePath: "/private/tmp/sidekick-gas-wallet.key",
        network: "testnet",
      }),
    ).rejects.toThrow("does not match the recorded public key");
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(runtime.gasWalletSignerReady()).toBe(false);

    await runtime.activateGasWallet({
      principal,
      publicKey,
      secretFilePath: "/private/tmp/sidekick-gas-wallet.key",
      network: "testnet",
    });
    expect(runtime.gasWalletSignerReady()).toBe(true);
    expect(runtime.gasPayerIdentity()).toEqual({ principal, publicKey });
    await runtime.deactivateGasWallet();
    expect(runtime.gasWalletSignerReady()).toBe(false);
    expect(destroy).toHaveBeenCalledTimes(2);
    await runtime.close();
  });

  it("rejects browser-wallet claims in operator-run mode as a non-retryable policy failure", async () => {
    const freshReads = vi.fn();
    const base = observeComposition({ freshAnchor: anchor(101), seen: [], freshReads });
    const runtime = new SidekickTransactionEngineRuntime({
      ...base,
      runtimeConfig: { ...base.runtimeConfig, requestedMode: "operator-run" },
    });

    const error = await runtime
      .observeManagerClaimWalletJob("00000000-0000-4000-8000-000000000001")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ManagerClaimWalletIntentError);
    expect(error).toMatchObject({
      code: "unavailable",
      message: "Browser-wallet claims require Observe mode. Use the gas wallet or switch modes",
      retryable: false,
    });
    expect(freshReads).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("finds the exact current preflighted Observe job before a direct wallet claim", async () => {
    const managerContract = "SP000000000000000000002Q6VF78.signer-manager";
    const jobId = "00000000-0000-4000-8000-000000000001";
    const job = {
      jobId,
      state: "preflighted",
      adapterId: "reference-manager-claim-rewards",
      adapterRevision: 2,
      managerPrincipal: managerContract,
    } as StoredTransactionJob;
    const getActiveLogicalJobForScope = vi.fn(() => job);
    const base = observeComposition({
      freshAnchor: anchor(101),
      seen: [],
      freshReads: vi.fn(),
    });
    const runtime = new SidekickTransactionEngineRuntime({
      ...base,
      store: {
        transactionEngine: {
          listLogicalJobs: vi.fn(() => ({ items: [], nextCursor: null, total: 0 })),
          getActiveLogicalJobForScope,
        },
      } as unknown as SidekickStore,
    });
    const proposal = {
      network: { kind: "mainnet", chainId: 1 },
      manager: { contract: managerContract },
      rewardCheckpoint: {
        rewardCycle: "144",
        calculationCheckpoint: "first-half",
        lastRewardComputeBurnHeight: 960_100,
        rewardsPerToken: "42",
      },
    } as ManagerClaimProposal;

    await expect(runtime.findEligibleManagerClaimWalletJob(proposal)).resolves.toEqual({ jobId });
    expect(getActiveLogicalJobForScope).toHaveBeenCalledWith(
      managerClaimOperationScopeKey({
        network: proposal.network,
        managerContract,
        rewardCycle: 144n,
        calculationCheckpoint: "first-half",
        lastRewardComputeBurnHeight: 960_100,
        rewardsPerToken: 42n,
      }),
    );
    await runtime.close();
  });

  it("runs maintenance recursively without overlap", async () => {
    vi.useFakeTimers();
    let releaseRead: (() => void) | undefined;
    const firstRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const freshReads = vi.fn(async () => {
      if (freshReads.mock.calls.length === 1) await firstRead;
      return {
        setup: setup(anchor(101)),
        rewards: null,
        sourceId: createChainSourceId(config().network, config().apiUrl),
        observedAt: "2026-07-17T12:01:00.000Z",
      };
    });
    const base = observeComposition({ freshAnchor: anchor(101), seen: [], freshReads: vi.fn() });
    const runtime = new SidekickTransactionEngineRuntime({
      ...base,
      readFreshObservation: freshReads,
    });

    runtime.start(10);
    await vi.advanceTimersByTimeAsync(10);
    expect(freshReads).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(freshReads).toHaveBeenCalledTimes(1);

    releaseRead?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(freshReads).toHaveBeenCalledTimes(2);
    await runtime.close();
    vi.useRealTimers();
  });

  it("drains active and queued work before destroying the signer", async () => {
    let releaseObservation: (() => void) | undefined;
    const observationGate = new Promise<void>((resolve) => {
      releaseObservation = resolve;
    });
    const destroy = vi.fn();
    const base = observeComposition({ freshAnchor: anchor(101), seen: [], freshReads: vi.fn() });
    const runtime = new SidekickTransactionEngineRuntime({
      ...base,
      signerHolder: { current: { destroy } as unknown as GasPayerSigner, identity: null },
      createObservationService: () => ({
        observe: async () => {
          await observationGate;
          return blockedOutcome();
        },
      }),
    });
    const input = {
      setup: setup(anchor(100)),
      rewards: null,
      sourceId: createChainSourceId(config().network, config().apiUrl),
      observedAt: "2026-07-17T12:00:00.000Z",
    };
    const active = runtime.observe(input);
    await Promise.resolve();
    const queued = runtime.observe(input);
    const closing = runtime.close();
    await Promise.resolve();
    expect(destroy).not.toHaveBeenCalled();

    releaseObservation?.();
    await active;
    await expect(queued).rejects.toThrow("closed");
    await closing;
    expect(destroy).toHaveBeenCalledOnce();
  });
});
