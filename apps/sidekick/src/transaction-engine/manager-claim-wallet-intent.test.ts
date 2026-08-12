import { generateKeyPairSync, sign } from "node:crypto";
import {
  getAddressFromPublicKey,
  listCV,
  makeContractCall,
  PostConditionMode,
  privateKeyToPublic,
  uintCV,
} from "@stacks/transactions";
import {
  type CompatibilityAttestationPayload,
  compatibilityAttestationPayloadSha256,
  compatibilityAttestationSigningBytes,
  type SignedCompatibilityAttestation,
} from "@stx-labs/signer-sidekick-protocol/compatibility-attestation";
import { POX5_TESTNET_COMPATIBILITY } from "@stx-labs/signer-sidekick-protocol/known-network-compatibility";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnboardingWalletIntentService } from "../onboarding-wallet-intent.js";
import type { RuntimeSettingsController } from "../runtime-settings.js";
import { openSidekickStore, type SidekickStore } from "../storage/store.js";
import {
  type ManagerClaimObserveFacts,
  ObserveManagerClaimPlanner,
} from "./manager-claim-observer.js";
import {
  ManagerClaimWalletIntentError,
  managerClaimWalletJobStatus,
  prepareManagerClaimWalletIntent,
  readManagerClaimWalletIntent,
} from "./manager-claim-wallet-intent.js";

const observedAt = "2026-07-19T12:00:00.000Z";
const manager = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.signer-manager";
const mainnetManager = "SP000000000000000000002Q6VF78.signer-manager";
const sourceSha256 = "12".repeat(32);
const gasPayerPublicKey = privateKeyToPublic(`${"11".repeat(32)}01`);
const gasPayer = getAddressFromPublicKey(gasPayerPublicKey, "testnet");
const walletActor = getAddressFromPublicKey(privateKeyToPublic(`${"22".repeat(32)}01`), "testnet");
const mainnetGasPayer = getAddressFromPublicKey(gasPayerPublicKey, "mainnet");
const mainnetWalletActor = getAddressFromPublicKey(
  privateKeyToPublic(`${"22".repeat(32)}01`),
  "mainnet",
);
const attestationKeys = generateKeyPairSync("ed25519");
const stores: SidekickStore[] = [];

const { readSetupSnapshotMock } = vi.hoisted(() => ({ readSetupSnapshotMock: vi.fn() }));
vi.mock("../setup-snapshot.js", () => ({ readSetupSnapshot: readSetupSnapshotMock }));

afterEach(() => {
  readSetupSnapshotMock.mockReset();
  for (const store of stores.splice(0)) store.close();
});

function signedAttestation(
  revision = 1,
  expiresAt = "2026-07-20T00:00:00.000Z",
): SignedCompatibilityAttestation {
  const payload: CompatibilityAttestationPayload = {
    schemaVersion: 1,
    issuer: "stacks-labs",
    revision,
    issuedAt: "2026-07-19T00:00:00.000Z",
    notBefore: "2026-07-19T00:00:00.000Z",
    expiresAt,
    profile: POX5_TESTNET_COMPATIBILITY,
  };
  return {
    schemaVersion: 1,
    algorithm: "ed25519",
    keyId: "release-a",
    payload,
    signature: sign(
      null,
      compatibilityAttestationSigningBytes(payload),
      attestationKeys.privateKey,
    ).toString("base64"),
  };
}

function facts(digest: string, mode: "observe" | "assist" = "observe"): ManagerClaimObserveFacts {
  return {
    schemaVersion: 1,
    observedAt,
    network: { kind: "testnet", chainId: 0x8000_0005 },
    manager: {
      contract: manager,
      profile: {
        id: "reference-testnet",
        recognitionTier: "reference-render",
        sourceSha256,
      },
      observedSourceSha256: sourceSha256,
    },
    chainAnchor: {
      stacksBlockHeight: 9_000,
      indexBlockHash: `0x${"ab".repeat(32)}`,
      burnBlockHeight: 4_100,
      rewardCycle: 5,
      rewardCycleLength: 100,
      prepareCycleLength: 10,
      cyclePosition: 50,
      phase: "reward",
      checkpoint: "second-half",
    },
    acceptedAttestation: {
      issuer: "stacks-labs",
      revision: 1,
      payloadSha256: digest,
      current: true,
    },
    contracts: {
      pox5: "ST000000000000000000002AMW42H.pox-5",
      sbtcToken: "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token",
    },
    rewardCheckpoint: {
      rewardCycle: 5n,
      calculationCheckpoint: "first-half",
      lastRewardComputeBurnHeight: 4_099,
      rewardsPerToken: 123_456_789n,
    },
    stxEarnedSats: 1_234n,
    bondBuckets: [],
    observedSignerEarnedSats: 1_234n,
    feeSnapshot: { state: "absent", effectiveFeeBips: 500n },
    expectedSignerOutflowSats: 1_234n,
    gasPayer: {
      principal: gasPayer,
      publicKey: gasPayerPublicKey,
      observedNonce: 7n,
      estimatedFeeUstx: 1_000n,
      maximumFeeUstx: 2_000n,
    },
    controls: { mode, adapterEnabled: true, rewardsPaused: false },
    effect: { remaining: true, completionEvidenceSha256: null },
    authoritative: { complete: true, canonical: true, finalityDepth: 1 },
  };
}

async function planned(mode: "observe" | "assist" = "observe") {
  const opened = await openSidekickStore(":memory:", observedAt);
  stores.push(opened.store);
  const document = signedAttestation();
  const digest = compatibilityAttestationPayloadSha256(document.payload);
  await opened.store.transactionEngine.accept(
    {
      acceptedState: {
        issuer: document.payload.issuer,
        revision: document.payload.revision,
        payloadSha256: digest,
        verifiedAt: observedAt,
      },
      document,
      acceptedAt: observedAt,
    },
    null,
  );
  const input = facts(digest, mode);
  const result = await new ObserveManagerClaimPlanner(opened.store.transactionEngine).observe(
    input,
  );
  return { store: opened.store, input, result };
}

function live(requestedMode: "observe" | "assist" = "observe") {
  return {
    requestedMode,
    network: {
      name: "pox5-testnet" as const,
      kind: "testnet" as const,
      chainId: 0x8000_0005,
    },
    manager: {
      principal: manager,
      profileId: "reference-testnet",
      sourceSha256,
    },
  };
}

function liveMainnet() {
  return {
    requestedMode: "observe" as const,
    network: { name: "mainnet" as const, kind: "mainnet" as const, chainId: 1 },
    manager: {
      principal: mainnetManager,
      profileId: "reference-mainnet",
      sourceSha256,
    },
  };
}

function livePrivate(name: "devnet" | "regtest", chainId: number) {
  return {
    requestedMode: "observe" as const,
    network: { name, kind: "testnet" as const, chainId },
    manager: {
      principal: manager,
      profileId: "reference-testnet",
      sourceSha256,
    },
  };
}

function observation(result: Awaited<ReturnType<typeof planned>>["result"]) {
  return {
    observedAt,
    job: {
      jobId: result.job.jobId,
      operationScopeKey: result.job.operationScopeKey,
      intentSha256: result.job.intentSha256,
      policySha256: result.job.policySha256,
      stateVersion: result.job.stateVersion,
      attestation: { ...result.job.attestation },
    },
  };
}

async function plannedMainnet() {
  const opened = await planned();
  const input: ManagerClaimObserveFacts = {
    ...opened.input,
    network: { kind: "mainnet", chainId: 1 },
    manager: {
      contract: mainnetManager,
      profile: {
        id: "reference-mainnet",
        recognitionTier: "reference-render",
        sourceSha256,
      },
      observedSourceSha256: sourceSha256,
    },
    contracts: {
      pox5: "SP000000000000000000002Q6VF78.pox-5",
      sbtcToken: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
    },
    gasPayer: {
      ...opened.input.gasPayer,
      principal: mainnetGasPayer,
    },
  };
  const result = await new ObserveManagerClaimPlanner(opened.store.transactionEngine).observe(
    input,
  );
  return { ...opened, input, result };
}

async function plannedPrivate(chainId: number) {
  const opened = await planned();
  const input: ManagerClaimObserveFacts = {
    ...opened.input,
    network: { kind: "testnet", chainId },
  };
  const result = await new ObserveManagerClaimPlanner(opened.store.transactionEngine).observe(
    input,
  );
  return { ...opened, input, result };
}

function mainnetSetupSnapshot(input: ManagerClaimObserveFacts) {
  return {
    chainAnchor: input.chainAnchor,
    preflight: {
      node: { networkId: 1 },
      checks: [
        { id: "node-network", status: "pass", message: "Node network matches" },
        { id: "api-network", status: "pass", message: "API and node networks agree" },
      ],
      compatibility: {
        status: "matched",
        managerProfileId: "reference-mainnet",
        managerSourceSha256: sourceSha256,
      },
      pox: {
        pox5ContractId: input.contracts.pox5,
        sbtcTokenContract: input.contracts.sbtcToken,
      },
    },
    manager: {
      managerPrincipal: mainnetManager,
      attachAllowed: true,
      source: {
        recognized: true,
        tier: "reference-render",
        profileId: "reference-mainnet",
        sha256: sourceSha256,
        canonicalSha256: sourceSha256,
      },
    },
    registration: null,
  };
}

function mainnetWalletState() {
  return {
    managerPrincipal: mainnetManager,
    freshInput: null,
    managerArtifact: null,
    signerGrant: { verified: null },
  };
}

function privateSetupSnapshot(
  input: ManagerClaimObserveFacts,
  network: "devnet" | "regtest",
  chainId: number,
) {
  return {
    chainAnchor: input.chainAnchor,
    preflight: {
      network,
      node: { networkId: chainId },
      checks: [
        { id: "node-network", status: "pass", message: "Node network matches" },
        { id: "api-network", status: "pass", message: "API and node networks agree" },
      ],
      compatibility: {
        status: "matched",
        managerProfileId: "reference-testnet",
        managerSourceSha256: sourceSha256,
      },
      pox: {
        pox5ContractId: input.contracts.pox5,
        sbtcTokenContract: input.contracts.sbtcToken,
      },
    },
    manager: {
      managerPrincipal: manager,
      attachAllowed: true,
      source: {
        recognized: true,
        tier: "reference-render",
        profileId: "reference-testnet",
        sha256: sourceSha256,
        canonicalSha256: sourceSha256,
      },
    },
    registration: null,
  };
}

function privateWalletState() {
  return {
    managerPrincipal: manager,
    freshInput: null,
    managerArtifact: null,
    signerGrant: { verified: null },
  };
}

describe("manager-claim browser-wallet binding", () => {
  it("extracts the exact call and FT postcondition from one immutable Observe job", async () => {
    const { store, result } = await planned();
    const prepared = await prepareManagerClaimWalletIntent({
      repository: store.transactionEngine,
      jobId: result.job.jobId,
      actorPrincipal: walletActor,
      observation: observation(result),
      live: live(),
    });

    expect(prepared).toMatchObject({
      scope: `manager-claim-wallet:${result.job.jobId}`,
      requiredSender: walletActor,
      network: "pox5-testnet",
      chainId: 0x8000_0005,
      transaction: {
        method: "stx_callContract",
        params: {
          contract: manager,
          functionName: "claim-rewards",
          address: walletActor,
          sponsored: false,
          postConditionMode: "deny",
        },
      },
      facts: {
        job: {
          jobId: result.job.jobId,
          intentSha256: result.job.intentSha256,
          policySha256: result.job.policySha256,
        },
        expectedEffect: {
          amountSats: "1234",
          sender: "ST000000000000000000002AMW42H.pox-5",
        },
      },
    });
    expect(prepared.transaction.params.functionArgs).toEqual([
      "0x0b00000000",
      "0x0100000000000000000000000000000005",
    ]);
    expect(prepared.transaction.params.postConditions).toHaveLength(1);
    expect(
      managerClaimWalletJobStatus({
        repository: store.transactionEngine,
        binding: prepared.facts.job,
      }),
    ).toBe("prepared");
  });

  it("binds the same exact claim vector to a mainnet wallet payer", async () => {
    const { store, result } = await plannedMainnet();
    const prepared = await prepareManagerClaimWalletIntent({
      repository: store.transactionEngine,
      jobId: result.job.jobId,
      actorPrincipal: mainnetWalletActor,
      observation: observation(result),
      live: liveMainnet(),
    });

    expect(prepared).toMatchObject({
      requiredSender: mainnetWalletActor,
      network: "mainnet",
      chainId: 1,
      transaction: {
        params: {
          contract: mainnetManager,
          network: "mainnet",
          address: mainnetWalletActor,
          postConditions: [expect.any(String)],
        },
      },
      facts: {
        expectedEffect: {
          sender: "SP000000000000000000002Q6VF78.pox-5",
          asset: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token::sbtc-token",
        },
      },
    });
  });

  it.each([
    { network: "devnet" as const, chainId: 0x8000_0000 },
    { network: "regtest" as const, chainId: 0x8000_0000 },
  ])("binds the exact testnet-class claim vector to $network", async ({ network, chainId }) => {
    const { store, result } = await plannedPrivate(chainId);
    const prepared = await prepareManagerClaimWalletIntent({
      repository: store.transactionEngine,
      jobId: result.job.jobId,
      actorPrincipal: walletActor,
      observation: observation(result),
      live: livePrivate(network, chainId),
    });

    expect(prepared).toMatchObject({
      requiredSender: walletActor,
      network,
      chainId,
      transaction: {
        params: {
          network,
          address: walletActor,
        },
      },
      facts: { network, chainId },
    });
  });

  it.each([
    { network: "devnet" as const, chainId: 0x8000_0000 },
    { network: "regtest" as const, chainId: 0x8000_0000 },
  ])("propagates $network through the onboarding wallet manifest", async ({ network, chainId }) => {
    const { store, input, result } = await plannedPrivate(chainId);
    readSetupSnapshotMock.mockResolvedValue(privateSetupSnapshot(input, network, chainId));
    const wallet = new OnboardingWalletIntentService({
      store,
      runtimeSettings: {
        clients: () => ({
          config: {
            network,
            expectedNetworkId: chainId,
            nodeRpcUrl: "http://node:20443",
          },
          node: {},
          api: {},
        }),
      } as unknown as RuntimeSettingsController,
      readFreshState: privateWalletState,
      readWalletState: privateWalletState,
      transactionEngineRequestedMode: "observe",
      observeManagerClaimWalletJob: vi.fn(async () => observation(result)),
    });

    await expect(
      wallet.prepare({
        action: "claim-rewards",
        actorPrincipal: walletActor,
        jobId: result.job.jobId,
      }),
    ).resolves.toMatchObject({
      network,
      chainId,
      transaction: { params: { network } },
    });
  });

  it("keeps private-network claims bound to the exact reference-manager profile and source", async () => {
    const chainId = 0x8000_0000;
    const { store, result } = await plannedPrivate(chainId);

    await expect(
      prepareManagerClaimWalletIntent({
        repository: store.transactionEngine,
        jobId: result.job.jobId,
        actorPrincipal: walletActor,
        observation: observation(result),
        live: {
          ...livePrivate("devnet", chainId),
          manager: {
            principal: manager,
            profileId: "reference-testnet",
            sourceSha256: "34".repeat(32),
          },
        },
      }),
    ).rejects.toThrow("no longer matches the verified manager");
  });

  it("allows local claim preparation when only the API network routing check fails", async () => {
    const { store, input, result } = await plannedMainnet();
    const snapshot = mainnetSetupSnapshot(input);
    snapshot.preflight.checks[1] = {
      id: "api-network",
      status: "fail",
      message: "API network mismatch",
    };
    readSetupSnapshotMock.mockResolvedValue(snapshot);
    const observeManagerClaimWalletJob = vi.fn(async () => observation(result));
    const wallet = new OnboardingWalletIntentService({
      store,
      runtimeSettings: {
        clients: () => ({
          config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
          node: {},
          api: {},
        }),
      } as unknown as RuntimeSettingsController,
      readFreshState: mainnetWalletState,
      readWalletState: mainnetWalletState,
      transactionEngineRequestedMode: "observe",
      observeManagerClaimWalletJob,
    });

    await expect(
      wallet.prepare({
        action: "claim-rewards",
        actorPrincipal: mainnetWalletActor,
        jobId: result.job.jobId,
      }),
    ).resolves.toMatchObject({ status: "prepared", action: "claim-rewards" });
    expect(observeManagerClaimWalletJob).toHaveBeenCalled();
  });

  it("rejects configured Assist, Assist-sealed jobs, and mismatched network bindings", async () => {
    const observe = await planned();
    await expect(
      prepareManagerClaimWalletIntent({
        repository: observe.store.transactionEngine,
        jobId: observe.result.job.jobId,
        actorPrincipal: walletActor,
        observation: observation(observe.result),
        live: live("assist"),
      }),
    ).rejects.toBeInstanceOf(ManagerClaimWalletIntentError);

    const assist = await planned("assist");
    await expect(
      prepareManagerClaimWalletIntent({
        repository: assist.store.transactionEngine,
        jobId: assist.result.job.jobId,
        actorPrincipal: walletActor,
        observation: observation(assist.result),
        live: live(),
      }),
    ).rejects.toThrow("not ready for browser-wallet execution");

    await expect(
      prepareManagerClaimWalletIntent({
        repository: observe.store.transactionEngine,
        jobId: observe.result.job.jobId,
        actorPrincipal: walletActor,
        observation: observation(observe.result),
        live: {
          ...live(),
          network: { name: "pox5-testnet", kind: "testnet", chainId: 0x8000_0000 },
        },
      }),
    ).rejects.toThrow("does not match");

    await expect(
      prepareManagerClaimWalletIntent({
        repository: observe.store.transactionEngine,
        jobId: observe.result.job.jobId,
        actorPrincipal: walletActor,
        observation: observation(observe.result),
        live: {
          ...live(),
          network: { name: "devnet", kind: "mainnet", chainId: 0x8000_0005 },
        },
      }),
    ).rejects.toThrow("does not match");

    const mainnet = await plannedMainnet();
    await expect(
      prepareManagerClaimWalletIntent({
        repository: mainnet.store.transactionEngine,
        jobId: mainnet.result.job.jobId,
        actorPrincipal: mainnetWalletActor,
        observation: observation(mainnet.result),
        live: {
          ...liveMainnet(),
          network: { name: "mainnet", kind: "mainnet", chainId: 2 },
        },
      }),
    ).rejects.toThrow("does not match");

    await expect(
      prepareManagerClaimWalletIntent({
        repository: observe.store.transactionEngine,
        jobId: observe.result.job.jobId,
        actorPrincipal: walletActor,
        observation: observation(observe.result),
        live: {
          ...live(),
          network: { name: "devnet", kind: "testnet", chainId: 0x1_0000_0000 },
        },
      }),
    ).rejects.toThrow("invalid chain ID");
  });

  it.each([
    {
      name: "stale selection",
      runtimeError: new ManagerClaimWalletIntentError(
        "superseded",
        "This claim job changed. Refresh Operations and select the current job",
      ),
      code: "wallet_intent_conflict",
      message: "This claim job changed. Refresh Operations and select the current job",
      retryable: false,
    },
    {
      name: "permanent claim policy failure",
      runtimeError: new ManagerClaimWalletIntentError(
        "unavailable",
        "Browser-wallet claims require Observe mode",
      ),
      code: "wallet_execution_unavailable",
      message: "Browser-wallet claims require Observe mode",
      retryable: false,
    },
    {
      name: "temporary claim observation failure",
      runtimeError: new ManagerClaimWalletIntentError(
        "unavailable",
        "Claim chain data is temporarily unavailable",
        true,
      ),
      code: "wallet_execution_unavailable",
      message: "Claim chain data is temporarily unavailable",
      retryable: true,
    },
    {
      name: "unknown claim observation failure",
      runtimeError: new Error("RPC failed with secret upstream details"),
      code: null,
      message: null,
      retryable: null,
    },
  ])("classifies a $name without widening retryability", async ({
    runtimeError,
    code,
    message,
    retryable,
  }) => {
    const { store } = await openSidekickStore(":memory:", observedAt);
    stores.push(store);
    readSetupSnapshotMock.mockResolvedValue({
      chainAnchor: {
        stacksBlockHeight: 9_000,
        indexBlockHash: `0x${"ab".repeat(32)}`,
        burnBlockHeight: 4_100,
        rewardCycle: 5,
      },
      preflight: {
        node: { networkId: 1 },
        checks: [
          { id: "node-network", status: "pass", message: "Node network matches" },
          { id: "api-network", status: "pass", message: "API and node networks agree" },
        ],
        compatibility: {
          status: "matched",
          managerProfileId: "reference-mainnet",
          managerSourceSha256: sourceSha256,
        },
        pox: {
          pox5ContractId: "SP000000000000000000002Q6VF78.pox-5",
          sbtcTokenContract: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
        },
      },
      manager: {
        managerPrincipal: mainnetManager,
        attachAllowed: true,
        source: {
          recognized: true,
          tier: "reference-render",
          profileId: "reference-mainnet",
          sha256: sourceSha256,
          canonicalSha256: sourceSha256,
        },
      },
      registration: null,
    });
    const state = {
      managerPrincipal: mainnetManager,
      freshInput: null,
      managerArtifact: null,
      signerGrant: { verified: null },
    };
    const wallet = new OnboardingWalletIntentService({
      store,
      runtimeSettings: {
        clients: () => ({
          config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
          node: {},
          api: {},
        }),
      } as unknown as RuntimeSettingsController,
      readFreshState: () => state,
      readWalletState: () => state,
      transactionEngineRequestedMode: "observe",
      observeManagerClaimWalletJob: vi.fn(async () => {
        throw runtimeError;
      }),
    });

    const error = await wallet
      .prepare({
        action: "claim-rewards",
        actorPrincipal: mainnetWalletActor,
        jobId: "10000000-0000-4000-8000-000000000007",
      })
      .catch((caught: unknown) => caught);
    if (code === null) {
      expect(error).toBe(runtimeError);
      return;
    }
    expect(error).toMatchObject({ code, message, retryable });
  });

  it("waits for and then trusts only the existing job's authoritative reconciliation", async () => {
    const { store, input, result } = await planned();
    const prepared = await prepareManagerClaimWalletIntent({
      repository: store.transactionEngine,
      jobId: result.job.jobId,
      actorPrincipal: walletActor,
      observation: observation(result),
      live: live(),
    });
    const confirmed = store.transactionEngine.transitionLogicalJob({
      jobId: result.job.jobId,
      expectedState: "preflighted",
      expectedStateVersion: result.job.stateVersion,
      nextState: "confirmed",
      changedAt: "2026-07-19T12:01:00.000Z",
    });
    expect(
      managerClaimWalletJobStatus({
        repository: store.transactionEngine,
        binding: prepared.facts.job,
      }),
    ).toBe("awaiting-reconciliation");

    store.transactionEngine.appendReconciliationObservation({
      jobId: result.job.jobId,
      predicate: result.records.reconciliation,
      predicateSha256: result.records.reconciliationSha256,
      chainAnchor: input.chainAnchor,
      authoritative: true,
      canonical: true,
      finalityDepth: 1,
      outcome: "external_success",
      effectRemaining: false,
      observedAt: "2026-07-19T12:02:00.000Z",
    });
    store.transactionEngine.transitionLogicalJob({
      jobId: confirmed.jobId,
      expectedState: "confirmed",
      expectedStateVersion: confirmed.stateVersion,
      nextState: "reconciled",
      changedAt: "2026-07-19T12:02:00.000Z",
    });
    expect(
      readManagerClaimWalletIntent({
        repository: store.transactionEngine,
        jobId: result.job.jobId,
        actorPrincipal: walletActor,
        live: live(),
      }).facts,
    ).toEqual(prepared.facts);
    expect(
      managerClaimWalletJobStatus({
        repository: store.transactionEngine,
        binding: prepared.facts.job,
      }),
    ).toBe("complete");
  });

  it("keeps a canonical browser claim confirmed until the exact engine job reconciles", async () => {
    const { store, input, result } = await plannedMainnet();
    const actorPrivateKey = `${"22".repeat(32)}01`;
    const engineObservation = observation(result);
    readSetupSnapshotMock.mockResolvedValue(mainnetSetupSnapshot(input));
    const api = {
      getNodeInfo: vi.fn(async () => ({ network_id: 1 })),
      getTransaction: vi.fn(),
      getBlock: vi.fn(),
    };
    let transactionHex = "";
    let txid = "";
    const wallet = new OnboardingWalletIntentService({
      store,
      runtimeSettings: {
        clients: () => ({
          config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
          node: { getInfo: async () => ({ network_id: 1 }) },
          api,
        }),
      } as unknown as RuntimeSettingsController,
      readFreshState: mainnetWalletState,
      readWalletState: mainnetWalletState,
      transactionEngineRequestedMode: "observe",
      observeManagerClaimWalletJob: vi.fn(async () => engineObservation),
      readerFactory: () => ({
        lookupIndexedTransaction: async () => ({
          status: "observed" as const,
          httpStatus: 200,
          value: {
            txid,
            transactionHex,
            nonce: 9n,
            feeUstx: 1_000n,
            indexBlockHash: `0x${"cd".repeat(32)}` as `0x${string}`,
            blockHeight: 9_100n,
            isCanonical: true,
            resultRepr: "(ok true)",
          },
        }),
        lookupUnconfirmedTransaction: async () => ({
          status: "not-found" as const,
          httpStatus: 404,
        }),
      }),
    });

    const prepared = await wallet.prepare({
      action: "claim-rewards",
      actorPrincipal: mainnetWalletActor,
      jobId: result.job.jobId,
    });
    if (prepared.transaction.method !== "stx_callContract") {
      throw new Error("Expected a contract call");
    }
    const transaction = await makeContractCall({
      contractAddress: mainnetManager.split(".", 1)[0] ?? "",
      contractName: "signer-manager",
      functionName: "claim-rewards",
      functionArgs: [listCV([]), uintCV(5)],
      senderKey: actorPrivateKey,
      network: "mainnet",
      fee: 1_000,
      nonce: 9,
      sponsored: false,
      postConditionMode: PostConditionMode.Deny,
      postConditions: prepared.transaction.params.postConditions,
    });
    transactionHex = Buffer.from(transaction.serializeBytes()).toString("hex");
    txid = `0x${transaction.txid()}`;
    api.getTransaction.mockResolvedValue({
      tx_id: txid,
      status: "success",
      block: { height: 9_100, index_hash: `0x${"cd".repeat(32)}` },
    });
    api.getBlock.mockResolvedValue({
      canonical: true,
      index_block_hash: `0x${"cd".repeat(32)}`,
    });
    await wallet.submit(prepared.id, txid, "2026-07-19T12:01:00.000Z");
    await expect(wallet.refresh(prepared.id, "2026-07-19T12:02:00.000Z")).resolves.toMatchObject({
      status: "confirmed",
      verification: { outcome: "canonical-success", canonical: true },
    });

    const reconciled = await new ObserveManagerClaimPlanner(store.transactionEngine).observe({
      ...input,
      observedAt: "2026-07-19T12:03:00.000Z",
      observedSignerEarnedSats: 0n,
      feeSnapshot: { state: "present", effectiveFeeBips: input.feeSnapshot.effectiveFeeBips },
      effect: { remaining: false, completionEvidenceSha256: "34".repeat(32) },
      authoritative: { complete: true, canonical: true, finalityDepth: 1 },
    });
    expect(reconciled.status).toBe("reconciled");
    await expect(wallet.refresh(prepared.id, "2026-07-19T12:04:00.000Z")).resolves.toMatchObject({
      status: "complete",
      verification: { outcome: "complete", canonical: true },
    });
    expect(store.transactionEngine.listAttempts(result.job.jobId)).toEqual([]);
    expect(store.transactionEngine.getNonceReservationForJob(result.job.jobId)).toBeNull();
  });

  it("supersedes a prepared browser claim when Force Observe is enabled before signing", async () => {
    const { store, input, result } = await plannedMainnet();
    readSetupSnapshotMock.mockResolvedValue(mainnetSetupSnapshot(input));
    const readerFactory = vi.fn();
    const wallet = new OnboardingWalletIntentService({
      store,
      runtimeSettings: {
        clients: () => ({
          config: { network: "mainnet", nodeRpcUrl: "http://node:20443" },
          node: {},
          api: {},
        }),
      } as unknown as RuntimeSettingsController,
      readFreshState: mainnetWalletState,
      readWalletState: mainnetWalletState,
      transactionEngineRequestedMode: "observe",
      observeManagerClaimWalletJob: vi.fn(async () => observation(result)),
      readerFactory,
    });

    const prepared = await wallet.prepare({
      action: "claim-rewards",
      actorPrincipal: mainnetWalletActor,
      jobId: result.job.jobId,
    });
    expect(prepared.status).toBe("prepared");

    store.transactionEngine.forceObserve({
      reason: "emergency stop",
      actor: "operator",
      forcedAt: "2026-07-19T12:01:00.000Z",
    });

    await expect(wallet.refresh(prepared.id, "2026-07-19T12:02:00.000Z")).resolves.toMatchObject({
      id: prepared.id,
      status: "superseded",
      txid: null,
      verification: { outcome: "superseded", canonical: null },
    });
    expect(readerFactory).not.toHaveBeenCalled();
  });

  it("supersedes the wallet binding instead of replanning when the engine job changes", async () => {
    const { store, result } = await planned();
    const prepared = await prepareManagerClaimWalletIntent({
      repository: store.transactionEngine,
      jobId: result.job.jobId,
      actorPrincipal: walletActor,
      observation: observation(result),
      live: live(),
    });
    store.transactionEngine.transitionLogicalJob({
      jobId: result.job.jobId,
      expectedState: "preflighted",
      expectedStateVersion: result.job.stateVersion,
      nextState: "superseded",
      supersessionReason: "authoritative-manager-claim-facts-changed",
      changedAt: "2026-07-19T12:01:00.000Z",
    });
    expect(
      managerClaimWalletJobStatus({
        repository: store.transactionEngine,
        binding: prepared.facts.job,
      }),
    ).toBe("superseded");
  });

  it("rejects a disabled adapter and a rotated accepted attestation", async () => {
    const disabled = await planned();
    disabled.store.transactionEngine.disableAdapter({
      adapterId: "reference-manager-claim-rewards",
      reason: "operator stop",
      actor: "operator",
      disabledAt: "2026-07-19T12:01:00.000Z",
    });
    await expect(
      prepareManagerClaimWalletIntent({
        repository: disabled.store.transactionEngine,
        jobId: disabled.result.job.jobId,
        actorPrincipal: walletActor,
        observation: observation(disabled.result),
        live: live(),
      }),
    ).rejects.toThrow("adapter is disabled");

    const rotated = await planned();
    const previous = await rotated.store.transactionEngine.get("stacks-labs");
    if (!previous) throw new Error("Expected accepted attestation");
    const document = signedAttestation(2);
    const digest = compatibilityAttestationPayloadSha256(document.payload);
    await rotated.store.transactionEngine.accept(
      {
        acceptedState: {
          issuer: document.payload.issuer,
          revision: document.payload.revision,
          payloadSha256: digest,
          verifiedAt: "2026-07-19T12:01:00.000Z",
        },
        document,
        acceptedAt: "2026-07-19T12:01:00.000Z",
      },
      previous.acceptedState,
    );
    await expect(
      prepareManagerClaimWalletIntent({
        repository: rotated.store.transactionEngine,
        jobId: rotated.result.job.jobId,
        actorPrincipal: walletActor,
        observation: observation(rotated.result),
        live: live(),
      }),
    ).rejects.toThrow("compatibility attestation expired or changed");
  });

  it("blocks new preparation after emergency Force Observe without invalidating reads", async () => {
    const { store, result } = await planned();
    const prepared = await prepareManagerClaimWalletIntent({
      repository: store.transactionEngine,
      jobId: result.job.jobId,
      actorPrincipal: walletActor,
      observation: observation(result),
      live: live(),
    });
    store.transactionEngine.forceObserve({
      reason: "emergency stop",
      actor: "operator",
      forcedAt: "2026-07-19T12:01:00.000Z",
    });

    await expect(
      prepareManagerClaimWalletIntent({
        repository: store.transactionEngine,
        jobId: result.job.jobId,
        actorPrincipal: walletActor,
        observation: observation(result),
        live: live(),
      }),
    ).rejects.toThrow("Emergency Observe mode");
    expect(
      readManagerClaimWalletIntent({
        repository: store.transactionEngine,
        jobId: result.job.jobId,
        actorPrincipal: walletActor,
        live: live(),
      }).facts,
    ).toEqual(prepared.facts);
  });
});
