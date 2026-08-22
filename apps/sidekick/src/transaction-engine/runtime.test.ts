import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddressFromPublicKey, privateKeyToPublic } from "@stacks/transactions";
import {
  compatibilityAttestationSigningBytes,
  type VerifiedCompatibilityAttestation,
} from "@stx-labs/signer-sidekick-protocol/compatibility-attestation";
import { MAINNET_4_0_1_COMPATIBILITY } from "@stx-labs/signer-sidekick-protocol/known-network-compatibility";
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

/** Legacy attestation-gated path stays enabled under operator-run only while these are configured. */
const legacyAttestationFiles = {
  documentFilePath: "/etc/sidekick/compatibility.json",
  trustKeysFilePath: "/etc/sidekick/attestation-keys.json",
};

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
      attestation: null,
      finalityDepth: 6,
      maximumFeeUstx: 100_000n,
      maximumApprovalMinutes: 30,
    },
    store,
    runtimeContext: () => runtimeContext,
    signerHolder: { current: null, identity: null },
    loadAttestation: async () => null,
    createObservationService: () => ({
      observe: async (input) => {
        options.seen.push(input);
        return blockedOutcome();
      },
      revalidateApprovedJob: async () => {
        throw new Error("Observe runtime must not revalidate an approved job");
      },
    }),
    createCoordinator: () => ({
      execute: async () => {
        throw new Error("Observe runtime must not execute");
      },
      recover: async ({ jobId }) => ({ status: "job-not-found", jobId }),
    }),
    buildAdmission: vi.fn(() => ({}) as never),
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

  it("refuses attestation files under operator-run before loading any signer", async () => {
    const { store } = await openSidekickStore(":memory:");
    stores.push(store);
    const publicKey = privateKeyToPublic(`${"11".repeat(32)}01`);
    const principal = getAddressFromPublicKey(publicKey, "testnet");
    const destroy = vi.fn();
    vi.spyOn(GasPayerSigner, "fromSecretFile").mockResolvedValue({
      principal,
      publicKey,
      destroy,
    } as unknown as GasPayerSigner);
    const assistContext = context();
    assistContext.config.network = "testnet";

    await expect(
      createSidekickTransactionEngineRuntime({
        env: {
          SIDEKICK_ENGINE_MODE: "operator-run",
          SIDEKICK_GAS_PAYER_PRINCIPAL: principal,
          SIDEKICK_GAS_PAYER_PUBLIC_KEY: publicKey,
          SIDEKICK_GAS_PAYER_SECRET_FILE: "/private/tmp/missing-sidekick-gas-payer.key",
          SIDEKICK_COMPATIBILITY_ATTESTATION_FILE: "/private/tmp/missing-sidekick-attestation.json",
          SIDEKICK_COMPATIBILITY_TRUST_KEYS_FILE: "/private/tmp/missing-sidekick-trust-keys.json",
        },
        store,
        managerPrincipal: "ST000000000000000000002AMW42H.signer-manager",
        managerVerification: undefined,
        runtimeContext: () => assistContext,
      }),
    ).rejects.toThrow("Compatibility attestation files are not used in operator-run");
    expect(destroy).not.toHaveBeenCalled();
  });

  it("refuses attestation files under operator-run even when they are valid for the network", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sidekick-runtime-attestation-"));
    try {
      const { store } = await openSidekickStore(":memory:");
      stores.push(store);
      const publicKey = privateKeyToPublic(`${"11".repeat(32)}01`);
      const principal = getAddressFromPublicKey(publicKey, "testnet");
      const destroy = vi.fn();
      vi.spyOn(GasPayerSigner, "fromSecretFile").mockResolvedValue({
        principal,
        publicKey,
        destroy,
      } as unknown as GasPayerSigner);
      const issuerKeys = generateKeyPairSync("ed25519");
      const payload = {
        schemaVersion: 1 as const,
        issuer: "stacks-labs",
        revision: 2,
        issuedAt: "2026-07-18T00:00:00.000Z",
        notBefore: "2026-07-18T00:00:00.000Z",
        expiresAt: "2026-07-19T00:00:00.000Z",
        profile: MAINNET_4_0_1_COMPATIBILITY,
      };
      const attestationPath = join(directory, "attestation.json");
      const trustKeysPath = join(directory, "trust-keys.json");
      await writeFile(
        attestationPath,
        JSON.stringify({
          schemaVersion: 1,
          algorithm: "ed25519",
          keyId: "release-a",
          payload,
          signature: sign(
            null,
            compatibilityAttestationSigningBytes(payload),
            issuerKeys.privateKey,
          ).toString("base64"),
        }),
      );
      await writeFile(
        trustKeysPath,
        JSON.stringify([
          {
            keyId: "release-a",
            issuer: "stacks-labs",
            algorithm: "ed25519",
            publicKeyPem: issuerKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
          },
        ]),
      );
      const assistContext = context();
      assistContext.config.network = "testnet";
      assistContext.config.expectedNetworkId = 0x8000_0005;

      await expect(
        createSidekickTransactionEngineRuntime({
          env: {
            SIDEKICK_ENGINE_MODE: "operator-run",
            SIDEKICK_GAS_PAYER_PRINCIPAL: principal,
            SIDEKICK_GAS_PAYER_PUBLIC_KEY: publicKey,
            SIDEKICK_GAS_PAYER_SECRET_FILE: join(directory, "gas-payer.key"),
            SIDEKICK_COMPATIBILITY_ATTESTATION_FILE: attestationPath,
            SIDEKICK_COMPATIBILITY_TRUST_KEYS_FILE: trustKeysPath,
          },
          store,
          managerPrincipal: "ST000000000000000000002AMW42H.signer-manager",
          managerVerification: undefined,
          runtimeContext: () => assistContext,
          now: () => new Date("2026-07-18T12:00:00.000Z"),
        }),
      ).rejects.toThrow("Compatibility attestation files are not used in operator-run");
      await expect(store.transactionEngine.get("stacks-labs")).resolves.toBeNull();
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not read fresh authority for a missing or non-Assist approved job", async () => {
    const staleAnchor = anchor(100);
    const freshAnchor = anchor(101);
    const seen: ManagerClaimObservationInput[] = [];
    const freshReads = vi.fn();
    const runtime = new SidekickTransactionEngineRuntime(
      observeComposition({ freshAnchor, seen, freshReads }),
    );
    const sourceId = createChainSourceId(config().network, config().apiUrl);

    await runtime.observe({
      setup: setup(staleAnchor),
      rewards: null,
      sourceId,
      observedAt: "2026-07-17T12:00:00.000Z",
    });
    await runtime.refreshApprovedJob("00000000-0000-4000-8000-000000000001");

    expect(freshReads).not.toHaveBeenCalled();
    expect(seen.map(({ setup: value }) => value.chainAnchor.stacksBlockHeight)).toEqual([100]);
    await runtime.close();
  });

  it("rejects browser-wallet claims in operator-run mode as a non-retryable policy failure", async () => {
    const freshReads = vi.fn();
    const base = observeComposition({ freshAnchor: anchor(101), seen: [], freshReads });
    const runtime = new SidekickTransactionEngineRuntime({
      ...base,
      runtimeConfig: {
        ...base.runtimeConfig,
        requestedMode: "operator-run",
        attestation: legacyAttestationFiles,
      },
      legacyAssist: true,
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

  it("executes a planned approval only after the callback's fresh observation and anchor read", async () => {
    const jobId = "00000000-0000-4000-8000-000000000001";
    const freshAnchor = anchor(102);
    const order: string[] = [];
    const destroy = vi.fn();
    const signer = {
      principal: "SP000000000000000000002Q6VF78",
      publicKey: `02${"11".repeat(32)}`,
      destroy,
    } as unknown as GasPayerSigner;
    const plannedAnchor = anchor(100);
    const job = { jobId, chainAnchor: plannedAnchor } as StoredTransactionJob;
    const approval = {
      intentSha256: "11".repeat(32),
      policySha256: "22".repeat(32),
      expiresAt: "2026-07-17T12:30:00.000Z",
      invalidatedAt: null,
    };
    const repository = {
      listLogicalJobs: vi.fn(() => ({ items: [], nextCursor: null, total: 0 })),
      getLogicalJob: vi.fn(() => job),
      getActiveApproval: vi.fn(() => approval),
    };
    const execute = vi.fn(async () => {
      order.push("execute");
      return {
        status: "submitted" as const,
        jobId,
        attemptId: "00000000-0000-4000-8000-000000000002",
        txid: `0x${"33".repeat(32)}`,
      };
    });
    const admission = {} as never;
    const base = observeComposition({
      freshAnchor,
      seen: [],
      freshReads: vi.fn(),
    });
    const api = {
      getStatus: vi.fn(async () => {
        order.push("status");
        return {
          server_version: "test",
          status: "ready",
          chain_tip: {
            block_height: freshAnchor.stacksBlockHeight,
            block_hash: `0x${"aa".repeat(32)}`,
            index_block_hash: freshAnchor.indexBlockHash,
            burn_block_height: freshAnchor.burnBlockHeight,
          },
        };
      }),
      getBlock: vi.fn(async (height: number) => {
        order.push(`block:${height}`);
        const value = height === plannedAnchor.stacksBlockHeight ? plannedAnchor : freshAnchor;
        return {
          canonical: true,
          height,
          hash: `0x${"bb".repeat(32)}`,
          index_block_hash: value.indexBlockHash,
          parent_block_hash: `0x${"cc".repeat(32)}`,
          parent_index_block_hash: `0x${"dd".repeat(32)}`,
          burn_block_height: value.burnBlockHeight,
        };
      }),
    } as unknown as StacksApiClient;
    const verifiedAttestation = {
      document: { payload: { expiresAt: "2026-07-17T12:30:00.000Z" } },
    } as VerifiedCompatibilityAttestation;
    const observe = vi.fn(async () => blockedOutcome());
    const revalidateApprovedJob = vi.fn(async () => {
      order.push("revalidate");
      return {
        status: "valid" as const,
        job,
        liveAnchor: freshAnchor,
        attestation: verifiedAttestation,
        admission: {
          liveFingerprintMatches: true as const,
          anchorCanonical: true as const,
          anchorDescendant: true as const,
          prerequisitesComplete: true as const,
          feeStateMatches: true as const,
        },
      };
    });
    const runtime = new SidekickTransactionEngineRuntime({
      ...base,
      runtimeConfig: {
        ...base.runtimeConfig,
        requestedMode: "operator-run",
        attestation: legacyAttestationFiles,
      },
      legacyAssist: true,
      store: { transactionEngine: repository } as unknown as SidekickStore,
      runtimeContext: () => ({ ...context(), api }),
      signerHolder: {
        current: signer,
        identity: { principal: signer.principal, publicKey: signer.publicKey },
      },
      loadAttestation: async () => {
        order.push("attestation");
        return verifiedAttestation;
      },
      readFreshObservation: async () => {
        order.push("fresh");
        return {
          setup: setup(freshAnchor),
          rewards: null,
          sourceId: createChainSourceId(config().network, config().apiUrl),
          observedAt: "2026-07-17T12:01:00.000Z",
        };
      },
      createObservationService: () => ({
        observe,
        revalidateApprovedJob,
      }),
      captureAnchor: async () => {
        order.push("anchor");
        return freshAnchor;
      },
      buildAdmission: vi.fn(() => admission),
      createCoordinator: () => ({
        execute,
        recover: async ({ jobId: recoveryJobId }) => ({
          status: "job-not-found",
          jobId: recoveryJobId,
        }),
      }),
    });

    await runtime.refreshApprovedJob(jobId);

    expect(order).toEqual([
      "fresh",
      "attestation",
      "status",
      "block:100",
      "block:102",
      "status",
      "revalidate",
      "status",
      "block:100",
      "block:102",
      "status",
      "execute",
    ]);
    expect(observe).not.toHaveBeenCalled();
    expect(revalidateApprovedJob).toHaveBeenCalledWith(
      expect.objectContaining({
        job,
        approval,
        anchorProof: expect.objectContaining({ status: "proven" }),
      }),
    );
    expect(execute).toHaveBeenCalledWith({ jobId, admission });
    await runtime.close();
    await runtime.close();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("rechecks approval and attestation expiry after slow network revalidation", async () => {
    const jobId = "00000000-0000-4000-8000-000000000031";
    const valueAnchor = anchor(100);
    const job = {
      jobId,
      state: "awaiting_approval",
      stateVersion: 2,
      chainAnchor: valueAnchor,
    } as StoredTransactionJob;
    const approval = {
      jobId,
      intentSha256: "11".repeat(32),
      policySha256: "22".repeat(32),
      expiresAt: "2026-07-17T12:30:00.000Z",
      invalidatedAt: null,
    };
    const transitionLogicalJob = vi.fn(() => ({ ...job, state: "blocked" }));
    const repository = {
      listLogicalJobs: vi.fn(() => ({ items: [], nextCursor: null, total: 0 })),
      logicalJobStats: vi.fn(() => ({ active: 0, awaitingApproval: 0, ambiguous: 0 })),
      getLogicalJob: vi.fn(() => job),
      getActiveApproval: vi.fn(() => approval),
      getForceObserveControl: vi.fn(() => null),
      getDisabledAdapterControl: vi.fn(() => null),
      transitionLogicalJob,
    };
    const attestation = {
      document: { payload: { expiresAt: "2026-07-17T12:30:00.000Z" } },
    } as VerifiedCompatibilityAttestation;
    const api = {
      getStatus: vi.fn().mockResolvedValue({
        server_version: "test",
        status: "ready",
        chain_tip: {
          block_height: valueAnchor.stacksBlockHeight,
          block_hash: `0x${"90".repeat(32)}`,
          index_block_hash: valueAnchor.indexBlockHash,
          burn_block_height: valueAnchor.burnBlockHeight,
        },
      }),
      getBlock: vi.fn().mockResolvedValue({
        canonical: true,
        height: valueAnchor.stacksBlockHeight,
        hash: `0x${"91".repeat(32)}`,
        index_block_hash: valueAnchor.indexBlockHash,
        parent_block_hash: `0x${"92".repeat(32)}`,
        parent_index_block_hash: `0x${"93".repeat(32)}`,
        burn_block_height: valueAnchor.burnBlockHeight,
      }),
    } as unknown as StacksApiClient;
    const buildAdmission = vi.fn(() => ({}) as never);
    const execute = vi.fn();
    const clock = vi
      .fn<() => Date>()
      .mockReturnValueOnce(new Date("2026-07-17T12:01:00.000Z"))
      .mockReturnValueOnce(new Date("2026-07-17T12:31:00.000Z"))
      .mockReturnValue(new Date("2026-07-17T12:31:00.000Z"));
    const base = observeComposition({ freshAnchor: valueAnchor, seen: [], freshReads: vi.fn() });
    const runtime = new SidekickTransactionEngineRuntime({
      ...base,
      runtimeConfig: {
        ...base.runtimeConfig,
        requestedMode: "operator-run",
        attestation: legacyAttestationFiles,
      },
      legacyAssist: true,
      store: { transactionEngine: repository } as unknown as SidekickStore,
      runtimeContext: () => ({ ...context(), api }),
      signerHolder: {
        current: {
          principal: "SP000000000000000000002Q6VF78",
          destroy: vi.fn(),
        } as unknown as GasPayerSigner,
        identity: { principal: "SP000000000000000000002Q6VF78", publicKey: `02${"11".repeat(32)}` },
      },
      now: clock,
      loadAttestation: async () => attestation,
      createObservationService: () => ({
        observe: async () => blockedOutcome(),
        revalidateApprovedJob: async () => ({
          status: "valid",
          job,
          liveAnchor: valueAnchor,
          attestation,
          admission: {
            liveFingerprintMatches: true,
            anchorCanonical: true,
            anchorDescendant: true,
            prerequisitesComplete: true,
            feeStateMatches: true,
          },
        }),
      }),
      createCoordinator: () => ({
        execute,
        recover: async ({ jobId: recoveryJobId }) => ({
          status: "job-not-found",
          jobId: recoveryJobId,
        }),
      }),
      buildAdmission,
    });

    await runtime.refreshApprovedJob(jobId);

    expect(transitionLogicalJob).toHaveBeenCalledWith({
      jobId,
      expectedState: "awaiting_approval",
      expectedStateVersion: 2,
      nextState: "blocked",
      blockReason: "approval-revalidation:attestation-expired",
      changedAt: "2026-07-17T12:31:00.000Z",
    });
    expect(runtime.api.status().adapters[0]?.blockReason).toBe(
      "Assist unavailable: approval or compatibility attestation expired. Sync chain data to prepare a new current job, then review and approve it",
    );
    expect(buildAdmission).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("bounds recovery and only calls the read-before-transition recovery path", async () => {
    const jobs = Array.from(
      { length: 55 },
      (_, index) => ({ jobId: `job-${index}` }) as StoredTransactionJob,
    );
    const recover = vi.fn(async ({ jobId }: { jobId: string }) => ({
      status: "job-not-found" as const,
      jobId,
    }));
    const execute = vi.fn(async () => {
      throw new Error("Recovery must not execute or broadcast");
    });
    const repository = {
      listLogicalJobs: vi.fn(() => ({ items: jobs, nextCursor: null, total: jobs.length })),
    };
    const runtime = new SidekickTransactionEngineRuntime({
      ...observeComposition({
        freshAnchor: anchor(101),
        seen: [],
        freshReads: vi.fn(),
      }),
      store: { transactionEngine: repository } as unknown as SidekickStore,
      createCoordinator: () => ({ recover, execute }),
    });

    await expect(runtime.recoverActive()).resolves.toHaveLength(8);
    expect(recover).toHaveBeenCalledTimes(8);
    expect(execute).not.toHaveBeenCalled();
    expect(repository.listLogicalJobs).toHaveBeenCalledWith({
      limit: 8,
      states: ["nonce_reserved", "broadcast", "ambiguous", "confirmed", "noncanonical_reobserve"],
    });
    await runtime.close();
  });

  it("passes only same-pass confirmed recovery jobs into completion evaluation", async () => {
    const confirmedJobId = "00000000-0000-4000-8000-000000000021";
    const omittedJobId = "00000000-0000-4000-8000-000000000022";
    const disagreedJobId = "00000000-0000-4000-8000-000000000024";
    const seen: ManagerClaimObservationInput[] = [];
    const base = observeComposition({ freshAnchor: anchor(101), seen, freshReads: vi.fn() });
    const repository = {
      listLogicalJobs: vi.fn(() => ({
        items: [{ jobId: confirmedJobId }, { jobId: omittedJobId }, { jobId: disagreedJobId }],
        nextCursor: null,
        total: 3,
      })),
      getAttempt: vi.fn((attemptId: string) =>
        attemptId === "00000000-0000-4000-8000-000000000023"
          ? {
              inclusion: {
                schemaVersion: 1,
                txid: `0x${"77".repeat(32)}`,
                executionStatus: "success",
                stacksBlockHeight: 100,
                blockHash: `0x${"79".repeat(32)}`,
                indexBlockHash: anchor(100).indexBlockHash,
                canonical: true,
                observedAt: "2026-07-17T12:00:00.000Z",
              },
            }
          : attemptId === "00000000-0000-4000-8000-000000000025"
            ? {
                inclusion: {
                  schemaVersion: 1,
                  txid: `0x${"80".repeat(32)}`,
                  executionStatus: "success",
                  stacksBlockHeight: 99,
                  blockHash: `0x${"81".repeat(32)}`,
                  indexBlockHash: `0x${"ff".repeat(32)}`,
                  canonical: true,
                  observedAt: "2026-07-17T11:59:00.000Z",
                },
              }
            : null,
      ),
    };
    const recover = vi.fn(async ({ jobId }: { jobId: string }) =>
      jobId === confirmedJobId
        ? {
            status: "confirmed" as const,
            jobId,
            attemptId: "00000000-0000-4000-8000-000000000023",
            txid: `0x${"77".repeat(32)}`,
            indexBlockHash: anchor(100).indexBlockHash,
          }
        : jobId === disagreedJobId
          ? {
              status: "confirmed" as const,
              jobId,
              attemptId: "00000000-0000-4000-8000-000000000025",
              txid: `0x${"80".repeat(32)}`,
              indexBlockHash: `0x${"ff".repeat(32)}`,
            }
          : {
              status: "observation-unavailable" as const,
              jobId,
              attemptId: "attempt",
              txid: `0x${"78".repeat(32)}`,
              reason: "not in authoritative pass",
            },
    );
    const runtime = new SidekickTransactionEngineRuntime({
      ...base,
      store: { transactionEngine: repository } as unknown as SidekickStore,
      runtimeContext: () => ({
        ...context(),
        api: {
          getStatus: vi.fn().mockResolvedValue({
            server_version: "test",
            status: "ready",
            chain_tip: {
              block_height: 101,
              block_hash: `0x${"7a".repeat(32)}`,
              index_block_hash: anchor(101).indexBlockHash,
              burn_block_height: anchor(101).burnBlockHeight,
            },
          }),
          getBlock: vi.fn(async (height: number) => {
            const value = anchor(height);
            return {
              canonical: true,
              height,
              hash: `0x${"7b".repeat(32)}`,
              index_block_hash: value.indexBlockHash,
              parent_block_hash: `0x${"7c".repeat(32)}`,
              parent_index_block_hash: `0x${"7d".repeat(32)}`,
              burn_block_height: value.burnBlockHeight,
            };
          }),
        } as unknown as StacksApiClient,
      }),
      createCoordinator: () => ({
        recover,
        execute: async () => {
          throw new Error("Observation recovery must not execute");
        },
      }),
    });

    await runtime.observe({
      setup: setup(anchor(101)),
      rewards: null,
      sourceId: createChainSourceId(config().network, config().apiUrl),
      observedAt: "2026-07-17T12:01:00.000Z",
    });

    expect(seen[0]?.samePassConfirmedJobIds).toEqual([confirmedJobId]);
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
        revalidateApprovedJob: async () => {
          throw new Error("Unexpected approved-job revalidation");
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
