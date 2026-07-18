import { generateKeyPairSync, sign } from "node:crypto";
import { falseCV, getAddressFromPublicKey, privateKeyToPublic, trueCV } from "@stacks/transactions";
import {
  type CompatibilityAttestationPayload,
  compatibilityAttestationPayloadSha256,
  compatibilityAttestationSigningBytes,
  type SignedCompatibilityAttestation,
  type VerifiedCompatibilityAttestation,
} from "@stx-labs/signer-sidekick-protocol/compatibility-attestation";
import { POX5_TESTNET_COMPATIBILITY } from "@stx-labs/signer-sidekick-protocol/known-network-compatibility";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChainAnchor } from "../chain-anchor.js";
import type { StxRewardStatus } from "../reward-status.js";
import type { SetupSnapshot } from "../setup-snapshot.js";
import {
  openSidekickStore,
  type SidekickStore,
  type SignerStakerRun,
  type StoredSignerStaker,
} from "../storage/store.js";
import {
  type ManagerClaimApprovalRevalidationInput,
  type ManagerClaimEvidenceStore,
  type ManagerClaimObservationInput,
  ManagerClaimObservationService,
} from "./manager-claim-observation-service.js";
import { transactionEngineDocumentSha256 } from "./repository.js";

const observedAt = "2026-07-17T12:00:00.000Z";
const manager = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.signer-manager";
const staker = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";
const sourceId = "api:testnet:complete";
const publicKey = privateKeyToPublic(`${"11".repeat(32)}01`);
const gasPayer = getAddressFromPublicKey(publicKey, "testnet");
const attestationKeys = generateKeyPairSync("ed25519");
const stores: SidekickStore[] = [];

const anchor: ChainAnchor = {
  stacksBlockHeight: 9_000,
  indexBlockHash: `0x${"ab".repeat(32)}`,
  burnBlockHeight: 4_100,
  rewardCycle: 5,
  rewardCycleLength: 100,
  prepareCycleLength: 10,
  cyclePosition: 50,
  phase: "reward",
  checkpoint: "second-half",
};

const run: SignerStakerRun = {
  runId: "1f53f216-71c3-4b72-865d-53e81a426bc8",
  sourceId,
  managerPrincipal: manager,
  status: "completed",
  authoritative: true,
  reconciliationComplete: true,
  chainAnchor: anchor,
  cursor: null,
  pagesProcessed: 1,
  itemsProcessed: 1,
  startedAt: observedAt,
  updatedAt: observedAt,
  completedAt: observedAt,
};

function roster(overrides: Partial<StoredSignerStaker> = {}): StoredSignerStaker {
  return {
    managerPrincipal: manager,
    stakerPrincipal: staker,
    hasStx: true,
    hasBtc: false,
    stxNodeVerified: true,
    active: true,
    sourceId,
    verificationSourceId: "node:testnet:local",
    lastSeenRunId: run.runId,
    firstSeenAt: observedAt,
    lastSeenAt: observedAt,
    position: null,
    ...overrides,
  };
}

function evidenceStore(
  runValue: SignerStakerRun | null = run,
  rosterValue: StoredSignerStaker[] = [roster()],
): ManagerClaimEvidenceStore {
  return {
    getLatestCompletedSignerStakerRun: vi.fn().mockReturnValue(runValue),
    listSignerStakers: vi.fn().mockReturnValue(rosterValue),
  };
}

function payload(): CompatibilityAttestationPayload {
  return {
    schemaVersion: 1,
    issuer: "stacks-labs",
    revision: 1,
    issuedAt: "2026-07-17T00:00:00.000Z",
    notBefore: "2026-07-17T00:00:00.000Z",
    expiresAt: "2026-07-18T00:00:00.000Z",
    profile: POX5_TESTNET_COMPATIBILITY,
  };
}

function signedAttestation(): SignedCompatibilityAttestation {
  const value = payload();
  return {
    schemaVersion: 1,
    algorithm: "ed25519",
    keyId: "release-a",
    payload: value,
    signature: sign(
      null,
      compatibilityAttestationSigningBytes(value),
      attestationKeys.privateKey,
    ).toString("base64"),
  };
}

async function memoryStore(): Promise<{
  store: SidekickStore;
  attestation: VerifiedCompatibilityAttestation;
}> {
  const { store } = await openSidekickStore(":memory:", observedAt);
  stores.push(store);
  const document = signedAttestation();
  const digest = compatibilityAttestationPayloadSha256(document.payload);
  const acceptedState = {
    issuer: document.payload.issuer,
    revision: document.payload.revision,
    payloadSha256: digest,
    verifiedAt: observedAt,
  };
  await store.transactionEngine.accept({ acceptedState, document, acceptedAt: observedAt }, null);
  return {
    store,
    attestation: {
      document,
      profile: document.payload.profile,
      payloadSha256: digest,
      verifiedAt: observedAt,
      acceptedState,
    },
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function setup(): SetupSnapshot {
  return {
    chainAnchor: anchor,
    preflight: {
      status: "pass",
      network: "testnet",
      node: {
        networkId: POX5_TESTNET_COMPATIBILITY.networkId,
        burnBlockHeight: anchor.burnBlockHeight,
        stacksTipHeight: anchor.stacksBlockHeight,
      },
      pox: {
        pox5ContractId: POX5_TESTNET_COMPATIBILITY.pox5.contractId,
        sourceSha256: POX5_TESTNET_COMPATIBILITY.pox5.sourceSha256,
        sbtcTokenContract: POX5_TESTNET_COMPATIBILITY.sbtc.tokenContract,
        sbtcRegistryContract: POX5_TESTNET_COMPATIBILITY.sbtc.registryContract,
      },
      compatibility: { status: "matched" },
    },
    manager: {
      managerPrincipal: manager,
      automationEligible: true,
      source: {
        tier: "reference-render",
        profileId: POX5_TESTNET_COMPATIBILITY.referenceManager.profileId,
        sha256: POX5_TESTNET_COMPATIBILITY.referenceManager.sourceSha256,
        match: "exact",
      },
    },
    registration: null,
    setup: { status: "ready" },
  } as unknown as SetupSnapshot;
}

function rewards(overrides: Partial<StxRewardStatus> = {}): StxRewardStatus {
  return {
    status: "ready",
    managerPrincipal: manager,
    pox5ContractId: POX5_TESTNET_COMPATIBILITY.pox5.contractId,
    rewardCycle: anchor.rewardCycle,
    observedAt: {
      timestamp: observedAt,
      burnBlockHeight: anchor.burnBlockHeight,
      stacksTipHeight: anchor.stacksBlockHeight,
    },
    ingestion: { runId: run.runId, completedAt: observedAt },
    global: {
      lastRewardComputeBurnHeight: "4099",
      lastComputedRewardCycle: String(anchor.rewardCycle),
      rewardsPerToken: "123456789",
      signerEarnedBeforeManagerClaimSats: "1234",
    },
    manager: {
      configuredFeeBips: "500",
      feeSnapshotBips: null,
      earnedFeesSats: "0",
      withdrawalLiabilitySats: "0",
      unclaimedStakerRewardsSats: "0",
    },
    totals: {
      stakers: 1,
      grossSats: "1234",
      earnedSats: "1234",
      feeSats: "0",
      actionableClaims: 1,
      l1ClaimsWaitingForFeeThreshold: 0,
    },
    stakers: [],
    ...overrides,
  };
}

function reader(overrides: Record<string, unknown> = {}) {
  return {
    readAnchoredAccount: vi.fn().mockResolvedValue({
      status: "observed",
      httpStatus: 200,
      value: {
        principal: gasPayer,
        indexBlockHash: anchor.indexBlockHash,
        balanceUstx: 10_000n,
        lockedUstx: 0n,
        unlockHeight: 0n,
        nonce: 7n,
      },
    }),
    estimateUnsignedTransactionFee: vi.fn().mockResolvedValue({
      status: "observed",
      httpStatus: 200,
      value: {
        estimates: {
          low: { feeRate: 1, feeUstx: 800n },
          middle: { feeRate: 2, feeUstx: 1_000n },
          high: { feeRate: 3, feeUstx: 1_200n },
        },
      },
    }),
    ...overrides,
  };
}

function input(attestation: VerifiedCompatibilityAttestation): ManagerClaimObservationInput {
  return {
    setup: setup(),
    rewards: rewards(),
    sourceId,
    requestedMode: "observe",
    gasPayer: { principal: gasPayer, publicKey },
    maximumFeeUstx: 2_000n,
    attestation,
    observedAt,
  };
}

function service(
  store: SidekickStore,
  projection: ManagerClaimEvidenceStore = evidenceStore(),
  node = { getDataVar: vi.fn().mockResolvedValue(falseCV()) },
  liveReader = reader(),
  finalityDepth = 1,
): ManagerClaimObservationService {
  const canonicalAnchors = new Map<number, { indexBlockHash: string; burnBlockHeight: number }>([
    [9_001, { indexBlockHash: `0x${"cd".repeat(32)}`, burnBlockHeight: 4_101 }],
    [9_002, { indexBlockHash: `0x${"de".repeat(32)}`, burnBlockHeight: 4_102 }],
    [9_101, { indexBlockHash: `0x${"cd".repeat(32)}`, burnBlockHeight: 4_160 }],
    [9_102, { indexBlockHash: `0x${"de".repeat(32)}`, burnBlockHeight: 4_160 }],
  ]);
  return new ManagerClaimObservationService({
    repository: store.transactionEngine,
    evidenceStore: projection,
    node,
    api: {
      getStatus: vi.fn().mockResolvedValue({
        server_version: "test",
        status: "ready",
        chain_tip: {
          block_height: 20_000,
          block_hash: `0x${"fa".repeat(32)}`,
          index_block_hash: `0x${"fb".repeat(32)}`,
          burn_block_height: 10_000,
        },
      }),
      getBlock: vi.fn(async (height: number) => {
        const known = canonicalAnchors.get(height);
        if (!known) throw new Error(`Unknown canonical test block ${height}`);
        return {
          canonical: true,
          height,
          hash: `0x${"fc".repeat(32)}`,
          index_block_hash: known.indexBlockHash,
          parent_block_hash: `0x${"fd".repeat(32)}`,
          parent_index_block_hash: `0x${"fe".repeat(32)}`,
          burn_block_height: known.burnBlockHeight,
        };
      }),
    },
    liveReader: liveReader as never,
    finalityDepth,
  });
}

async function approvedRevalidationFixture(options: { revalidationNonce?: bigint } = {}) {
  const { store, attestation } = await memoryStore();
  const anchoredReader = reader({
    readAnchoredAccount: vi.fn(async (_principal: string, tip: string) => ({
      status: "observed",
      httpStatus: 200,
      value: {
        principal: gasPayer,
        indexBlockHash: tip,
        balanceUstx: 10_000n,
        lockedUstx: 0n,
        unlockHeight: 0n,
        nonce: tip === anchor.indexBlockHash ? 7n : (options.revalidationNonce ?? 7n),
      },
    })),
  });
  const projection = evidenceStore();
  const observer = service(
    store,
    projection,
    { getDataVar: vi.fn().mockResolvedValue(falseCV()) },
    anchoredReader,
  );
  const planningInput = input(attestation);
  planningInput.requestedMode = "assist";
  const planned = await observer.observe(planningInput);
  if (planned.status !== "planned") throw new Error("Expected an approved test plan");
  const approvalDocument = {
    schemaVersion: 1,
    jobId: planned.result.job.jobId,
    intentSha256: planned.result.job.intentSha256,
    policySha256: planned.result.job.policySha256,
    actor: "operator:test",
  };
  const approval = store.transactionEngine.createApproval({
    jobId: planned.result.job.jobId,
    expectedJobStateVersion: planned.result.job.stateVersion,
    intentSha256: planned.result.job.intentSha256,
    policySha256: planned.result.job.policySha256,
    approval: approvalDocument,
    approvalSha256: transactionEngineDocumentSha256(approvalDocument),
    actor: "operator:test",
    createdAt: observedAt,
    expiresAt: "2026-07-17T13:00:00.000Z",
  }).approval;
  const liveAnchor: ChainAnchor = {
    ...anchor,
    stacksBlockHeight: anchor.stacksBlockHeight + 1,
    indexBlockHash: `0x${"cd".repeat(32)}`,
    burnBlockHeight: anchor.burnBlockHeight + 1,
    cyclePosition: anchor.cyclePosition + 1,
  };
  const fresh = input(attestation) as ManagerClaimApprovalRevalidationInput;
  fresh.observedAt = "2026-07-17T12:01:00.000Z";
  fresh.requestedMode = "assist";
  fresh.setup = structuredClone(fresh.setup);
  fresh.setup.chainAnchor = liveAnchor;
  fresh.setup.preflight.node.burnBlockHeight = liveAnchor.burnBlockHeight;
  fresh.setup.preflight.node.stacksTipHeight = liveAnchor.stacksBlockHeight;
  fresh.rewards = rewards({
    observedAt: {
      timestamp: fresh.observedAt,
      burnBlockHeight: liveAnchor.burnBlockHeight,
      stacksTipHeight: liveAnchor.stacksBlockHeight,
    },
  });
  fresh.job = planned.result.job;
  fresh.approval = approval;
  fresh.anchorProof = {
    status: "proven",
    plannedAnchor: anchor,
    liveAnchor,
    apiTipHeight: liveAnchor.stacksBlockHeight,
    apiTipIndexBlockHash: liveAnchor.indexBlockHash,
  };
  return { store, observer, fresh, projection, anchoredReader };
}

function completedObservationInput(
  attestation: VerifiedCompatibilityAttestation,
  options: {
    stacksBlockHeight: number;
    indexBlockHash: string;
    samePassConfirmedJobIds?: readonly string[];
  },
): ManagerClaimObservationInput {
  const delta = options.stacksBlockHeight - anchor.stacksBlockHeight;
  const value = input(attestation);
  value.attestation = null;
  value.gasPayer = null;
  value.observedAt = `2026-07-17T12:${String(delta).padStart(2, "0")}:00.000Z`;
  value.setup = {
    ...value.setup,
    chainAnchor: {
      ...anchor,
      stacksBlockHeight: options.stacksBlockHeight,
      burnBlockHeight: anchor.burnBlockHeight + delta,
      cyclePosition: anchor.cyclePosition + delta,
      indexBlockHash: options.indexBlockHash,
    },
  };
  value.rewards = rewards({
    observedAt: {
      timestamp: value.observedAt,
      burnBlockHeight: anchor.burnBlockHeight + delta,
      stacksTipHeight: options.stacksBlockHeight,
    },
    global: { ...rewards().global, signerEarnedBeforeManagerClaimSats: "0" },
    manager: { ...rewards().manager, feeSnapshotBips: "500" },
  });
  value.samePassConfirmedJobIds = options.samePassConfirmedJobIds ?? [];
  return value;
}

describe("live manager-claim observation", () => {
  it("revalidates the same immutable approved job at the same or a newer canonical anchor", async () => {
    const { store, observer, fresh, projection } = await approvedRevalidationFixture();
    const createOrSupersede = vi.spyOn(store.transactionEngine, "createOrSupersedeLogicalJob");
    vi.mocked(projection.getLatestCompletedSignerStakerRun).mockClear();
    vi.mocked(projection.listSignerStakers).mockClear();

    await expect(observer.revalidateApprovedJob(fresh)).resolves.toMatchObject({
      status: "valid",
      job: { jobId: fresh.job.jobId },
      liveAnchor: fresh.setup.chainAnchor,
      admission: {
        liveFingerprintMatches: true,
        anchorCanonical: true,
        anchorDescendant: true,
        prerequisitesComplete: true,
        feeStateMatches: true,
      },
    });
    expect(createOrSupersede).not.toHaveBeenCalled();
    expect(projection.getLatestCompletedSignerStakerRun).not.toHaveBeenCalled();
    expect(projection.listSignerStakers).not.toHaveBeenCalled();

    const sameAnchor = structuredClone(fresh);
    sameAnchor.setup = setup();
    sameAnchor.rewards = rewards();
    sameAnchor.anchorProof = {
      status: "proven",
      plannedAnchor: anchor,
      liveAnchor: anchor,
      apiTipHeight: anchor.stacksBlockHeight,
      apiTipIndexBlockHash: anchor.indexBlockHash,
    };
    await expect(observer.revalidateApprovedJob(sameAnchor)).resolves.toMatchObject({
      status: "valid",
      job: { jobId: fresh.job.jobId },
    });
    expect(createOrSupersede).not.toHaveBeenCalled();
  });

  it("retains approval when canonical proof or an authoritative source is transiently unavailable", async () => {
    const proofUnavailable = await approvedRevalidationFixture();
    proofUnavailable.fresh.anchorProof = {
      status: "unavailable",
      reason: "api-unavailable",
    };
    await expect(
      proofUnavailable.observer.revalidateApprovedJob(proofUnavailable.fresh),
    ).resolves.toMatchObject({
      status: "blocked",
      disposition: "retained",
      code: "canonical-proof-unavailable",
    });
    expect(
      proofUnavailable.store.transactionEngine.getActiveApproval(
        proofUnavailable.fresh.job.jobId,
        proofUnavailable.fresh.observedAt,
      ),
    ).not.toBeNull();

    const rewardUnavailable = await approvedRevalidationFixture();
    rewardUnavailable.fresh.rewards = null;
    await expect(
      rewardUnavailable.observer.revalidateApprovedJob(rewardUnavailable.fresh),
    ).resolves.toMatchObject({
      status: "blocked",
      disposition: "retained",
      code: "reward-status-unavailable",
    });
    expect(
      rewardUnavailable.store.transactionEngine.getActiveApproval(
        rewardUnavailable.fresh.job.jobId,
        rewardUnavailable.fresh.observedAt,
      ),
    ).not.toBeNull();
  });

  it.each([
    [
      "manager source",
      (value: ManagerClaimApprovalRevalidationInput) => {
        value.setup.manager.source.sha256 = "11".repeat(32);
      },
      "manager-identity-changed",
    ],
    [
      "PoX contract",
      (value: ManagerClaimApprovalRevalidationInput) => {
        value.setup.preflight.pox.pox5ContractId = manager.replace("signer-manager", "pox-5");
      },
      "contract-identity-changed",
    ],
    [
      "attestation digest",
      (value: ManagerClaimApprovalRevalidationInput) => {
        value.attestation = structuredClone(value.attestation);
        if (value.attestation) value.attestation.payloadSha256 = "22".repeat(32);
      },
      "attestation-changed",
    ],
    [
      "calculation checkpoint",
      (value: ManagerClaimApprovalRevalidationInput) => {
        if (value.rewards) value.rewards.global.lastRewardComputeBurnHeight = "4098";
      },
      "reward-checkpoint-changed",
    ],
    [
      "rewards per token",
      (value: ManagerClaimApprovalRevalidationInput) => {
        if (value.rewards) value.rewards.global.rewardsPerToken = "123456788";
      },
      "reward-checkpoint-changed",
    ],
    [
      "earned amount",
      (value: ManagerClaimApprovalRevalidationInput) => {
        if (value.rewards) value.rewards.global.signerEarnedBeforeManagerClaimSats = "1233";
      },
      "claim-amount-changed",
    ],
    [
      "fee snapshot",
      (value: ManagerClaimApprovalRevalidationInput) => {
        if (value.rewards) value.rewards.manager.configuredFeeBips = "501";
      },
      "fee-snapshot-changed",
    ],
    [
      "fee policy",
      (value: ManagerClaimApprovalRevalidationInput) => {
        value.maximumFeeUstx = 3_000n;
      },
      "fee-policy-changed",
    ],
  ] as const)("invalidates approval when the approved %s changes", async (_label, mutate, code) => {
    const { store, observer, fresh } = await approvedRevalidationFixture();
    mutate(fresh);
    await expect(observer.revalidateApprovedJob(fresh)).resolves.toMatchObject({
      status: "blocked",
      disposition: "invalidated",
      code,
      job: { state: "blocked" },
    });
    expect(store.transactionEngine.getActiveApproval(fresh.job.jobId)).toBeNull();
  });

  it("invalidates approval when the anchored gas nonce changes", async () => {
    const { store, observer, fresh } = await approvedRevalidationFixture({
      revalidationNonce: 8n,
    });
    await expect(observer.revalidateApprovedJob(fresh)).resolves.toMatchObject({
      status: "blocked",
      disposition: "invalidated",
      code: "gas-nonce-changed",
      job: { state: "blocked" },
    });
    expect(store.transactionEngine.getActiveApproval(fresh.job.jobId)).toBeNull();
  });

  it("reconciles a completed effect instead of returning executable admission", async () => {
    const { observer, fresh } = await approvedRevalidationFixture();
    fresh.rewards = rewards({
      observedAt: {
        timestamp: fresh.observedAt,
        burnBlockHeight: fresh.setup.chainAnchor.burnBlockHeight,
        stacksTipHeight: fresh.setup.chainAnchor.stacksBlockHeight,
      },
      global: {
        ...rewards().global,
        signerEarnedBeforeManagerClaimSats: "0",
      },
      manager: { ...rewards().manager, feeSnapshotBips: "500" },
    });
    await expect(observer.revalidateApprovedJob(fresh)).resolves.toMatchObject({
      status: "completed",
      outcome: { status: "planned", result: { job: { state: "confirmed" } } },
    });
  });

  it("does not advance local finality when recovery omitted the job or disagrees with inclusion", async () => {
    for (const disagreement of ["not-in-page", "noncanonical-inclusion"] as const) {
      const { store, attestation } = await memoryStore();
      const observer = service(store);
      const planned = await observer.observe(input(attestation));
      if (planned.status !== "planned") throw new Error("Expected a local-finality test plan");
      const canonical = disagreement === "not-in-page";
      vi.spyOn(store.transactionEngine, "listAttempts").mockReturnValue([
        {
          attemptId: "00000000-0000-4000-8000-000000000011",
          jobId: planned.result.job.jobId,
          attemptNumber: 1,
          nonceReservationId: "00000000-0000-4000-8000-000000000012",
          feeUstx: "1000",
          feePolicyRevision: 1,
          signedTransactionRef: "sealed",
          precomputedTxid: `0x${"44".repeat(32)}`,
          state: "confirmed",
          stateVersion: 1,
          submissionResult: null,
          inclusion: {
            schemaVersion: 1,
            txid: `0x${"44".repeat(32)}`,
            executionStatus: "success",
            stacksBlockHeight: anchor.stacksBlockHeight,
            blockHash: `0x${"45".repeat(32)}`,
            indexBlockHash: anchor.indexBlockHash,
            canonical,
            observedAt,
          },
          submittedAt: observedAt,
          resolvedAt: null,
          createdAt: observedAt,
          updatedAt: observedAt,
        },
      ]);
      const first = completedObservationInput(attestation, {
        stacksBlockHeight: anchor.stacksBlockHeight + 1,
        indexBlockHash: `0x${"cd".repeat(32)}`,
        samePassConfirmedJobIds:
          disagreement === "noncanonical-inclusion" ? [planned.result.job.jobId] : [],
      });
      const second = completedObservationInput(attestation, {
        stacksBlockHeight: anchor.stacksBlockHeight + 2,
        indexBlockHash: `0x${"de".repeat(32)}`,
        samePassConfirmedJobIds:
          disagreement === "noncanonical-inclusion" ? [planned.result.job.jobId] : [],
      });

      await expect(observer.observe(first)).resolves.toMatchObject({
        status: "planned",
        result: { job: { state: "confirmed" } },
      });
      await expect(observer.observe(second)).resolves.toMatchObject({
        status: "planned",
        result: { job: { state: "confirmed" } },
      });
    }
  });

  it("plans one fixed anchored vector with exact fee estimation and duplicate idempotency", async () => {
    const { store, attestation } = await memoryStore();
    const liveReader = reader();
    const observer = service(
      store,
      evidenceStore(),
      { getDataVar: vi.fn().mockResolvedValue(falseCV()) },
      liveReader,
    );

    const first = await observer.observe(input(attestation));
    const duplicate = await observer.observe(input(attestation));

    expect(first).toMatchObject({
      status: "planned",
      result: {
        created: true,
        job: { state: "preflighted" },
        plan: { material: { transaction: { nonce: "7", fee: "1000" } } },
      },
    });
    expect(duplicate).toMatchObject({
      status: "planned",
      result: {
        created: false,
        job: { jobId: first.status === "planned" ? first.result.job.jobId : "" },
      },
    });
    expect(liveReader.estimateUnsignedTransactionFee).toHaveBeenCalledTimes(2);
  });

  it("moves fresh Assist work into a bounded approval state but honors forced Observe", async () => {
    const assistedStore = await memoryStore();
    const assistedInput = input(assistedStore.attestation);
    assistedInput.requestedMode = "assist";
    await expect(service(assistedStore.store).observe(assistedInput)).resolves.toMatchObject({
      status: "planned",
      result: {
        job: { state: "awaiting_approval" },
        records: { policy: { mode: "assist", approvalRequired: true } },
      },
    });

    const observedStore = await memoryStore();
    observedStore.store.transactionEngine.forceObserve({
      reason: "Safety stop",
      actor: "operator:test",
      forcedAt: observedAt,
    });
    const forcedInput = input(observedStore.attestation);
    forcedInput.requestedMode = "assist";
    await expect(service(observedStore.store).observe(forcedInput)).resolves.toMatchObject({
      status: "planned",
      result: {
        job: { state: "preflighted" },
        records: { policy: { mode: "observe", approvalRequired: false } },
      },
    });
  });

  it("fails closed before creating work for incomplete/bonded rosters and bad attestations", async () => {
    const { store, attestation } = await memoryStore();
    const incomplete = await service(store, evidenceStore(null)).observe(input(attestation));
    expect(incomplete).toMatchObject({
      status: "blocked",
      blocks: [{ code: "roster-proof-incomplete" }],
    });

    const bonded = await service(store, evidenceStore(run, [roster({ hasBtc: true })])).observe(
      input(attestation),
    );
    expect(bonded).toMatchObject({
      status: "blocked",
      blocks: [{ code: "bond-participation-present" }],
    });

    const mismatched = structuredClone(attestation);
    mismatched.profile = {
      ...mismatched.profile,
      networkId: mismatched.profile.networkId + 1,
    };
    const badAttestation = await service(store).observe(input(mismatched));
    expect(badAttestation).toMatchObject({
      status: "blocked",
      blocks: [{ code: "attestation-fingerprint-mismatch" }],
    });
    expect(store.transactionEngine.logicalJobStats().total).toBe(0);
  });

  it("blocks paused rewards, unavailable account reads, fee caps, and low gas balance", async () => {
    const { store, attestation } = await memoryStore();
    const paused = await service(
      store,
      evidenceStore(),
      { getDataVar: vi.fn().mockResolvedValue(trueCV()) },
      reader(),
    ).observe(input(attestation));
    expect(paused).toMatchObject({ status: "blocked", blocks: [{ code: "rewards-paused" }] });

    const missingAccount = await service(
      store,
      evidenceStore(),
      { getDataVar: vi.fn().mockResolvedValue(falseCV()) },
      reader({
        readAnchoredAccount: vi.fn().mockResolvedValue({
          status: "unavailable",
          httpStatus: 503,
          reason: "http-error",
        }),
      }),
    ).observe(input(attestation));
    expect(missingAccount).toMatchObject({
      status: "blocked",
      blocks: [{ code: "node-read-unavailable" }],
    });

    const cappedInput = input(attestation);
    cappedInput.maximumFeeUstx = 900n;
    const capped = await service(store).observe(cappedInput);
    expect(capped).toMatchObject({ status: "blocked", blocks: [{ code: "fee-cap-exceeded" }] });

    const lowBalance = await service(
      store,
      evidenceStore(),
      { getDataVar: vi.fn().mockResolvedValue(falseCV()) },
      reader({
        readAnchoredAccount: vi.fn().mockResolvedValue({
          status: "observed",
          httpStatus: 200,
          value: {
            principal: gasPayer,
            indexBlockHash: anchor.indexBlockHash,
            balanceUstx: 999n,
            lockedUstx: 0n,
            unlockHeight: 0n,
            nonce: 7n,
          },
        }),
      }),
    ).observe(input(attestation));
    expect(lowBalance).toMatchObject({
      status: "blocked",
      blocks: [{ code: "gas-balance-insufficient" }],
    });
  });

  it("creates and reconciles the distinct second calculation with the insert-only fee snapshot", async () => {
    const { store, attestation } = await memoryStore();
    const first = await service(store).observe(input(attestation));
    expect(first).toMatchObject({
      status: "planned",
      result: {
        created: true,
        records: {
          intent: {
            review: { checkpoint: { calculationCheckpoint: "first-half", rewardCycle: 5 } },
          },
        },
      },
    });

    const secondObservedAt = "2026-07-17T12:01:00.000Z";
    const secondAnchor: ChainAnchor = {
      ...anchor,
      stacksBlockHeight: anchor.stacksBlockHeight + 100,
      indexBlockHash: `0x${"bc".repeat(32)}`,
      burnBlockHeight: 4_160,
      rewardCycle: 6,
      cyclePosition: 10,
      checkpoint: "first-half",
    };
    const secondRun: SignerStakerRun = {
      ...run,
      runId: "2f53f216-71c3-4b72-865d-53e81a426bc8",
      chainAnchor: secondAnchor,
      startedAt: secondObservedAt,
      updatedAt: secondObservedAt,
      completedAt: secondObservedAt,
    };
    const secondInput = input(attestation);
    secondInput.observedAt = secondObservedAt;
    secondInput.setup = { ...secondInput.setup, chainAnchor: secondAnchor };
    secondInput.rewards = rewards({
      rewardCycle: 5,
      observedAt: {
        timestamp: secondObservedAt,
        burnBlockHeight: secondAnchor.burnBlockHeight,
        stacksTipHeight: secondAnchor.stacksBlockHeight,
      },
      ingestion: { runId: secondRun.runId, completedAt: secondObservedAt },
      global: {
        lastRewardComputeBurnHeight: "4149",
        lastComputedRewardCycle: "5",
        rewardsPerToken: "223456789",
        signerEarnedBeforeManagerClaimSats: "777",
      },
      manager: {
        ...rewards().manager,
        configuredFeeBips: "900",
        feeSnapshotBips: "500",
      },
    });
    const second = await service(
      store,
      evidenceStore(secondRun, [roster({ lastSeenRunId: secondRun.runId })]),
    ).observe(secondInput);

    expect(second).toMatchObject({
      status: "planned",
      result: {
        created: true,
        plan: {
          material: {
            call: { rewardCycle: "5" },
            rewardObservation: { calculationCheckpoint: "second-half" },
            feeSnapshot: { state: "present", effectiveFeeBips: "500" },
            expectedEffect: { amount: "777", condition: "eq", postConditionMode: "deny" },
          },
        },
        records: {
          intent: {
            review: {
              checkpoint: { calculationCheckpoint: "second-half", rewardCycle: 5 },
              fee: { snapshot: { state: "present", feeBips: 500 } },
            },
          },
        },
      },
    });
    if (first.status !== "planned" || second.status !== "planned") {
      throw new Error("Expected two planned calculation jobs");
    }
    expect(second.result.job.jobId).not.toBe(first.result.job.jobId);
    expect(second.result.job.operationScopeKey).not.toBe(first.result.job.operationScopeKey);

    const completeInput = structuredClone(secondInput);
    completeInput.attestation = null;
    completeInput.gasPayer = null;
    completeInput.observedAt = "2026-07-17T12:02:00.000Z";
    completeInput.setup.chainAnchor = {
      ...secondAnchor,
      stacksBlockHeight: secondAnchor.stacksBlockHeight + 1,
      indexBlockHash: `0x${"cd".repeat(32)}`,
    };
    completeInput.rewards = rewards({
      rewardCycle: 5,
      observedAt: {
        timestamp: completeInput.observedAt,
        burnBlockHeight: secondAnchor.burnBlockHeight,
        stacksTipHeight: secondAnchor.stacksBlockHeight + 1,
      },
      ingestion: { runId: secondRun.runId, completedAt: secondObservedAt },
      global: {
        lastRewardComputeBurnHeight: "4149",
        lastComputedRewardCycle: "5",
        rewardsPerToken: "223456789",
        signerEarnedBeforeManagerClaimSats: "0",
      },
      manager: {
        ...rewards().manager,
        configuredFeeBips: "900",
        feeSnapshotBips: "500",
      },
    });
    const confirming = await service(store, evidenceStore(null, [])).observe(completeInput);
    expect(confirming).toMatchObject({
      status: "planned",
      result: { job: { jobId: second.result.job.jobId, state: "confirmed" } },
    });

    const finalInput = structuredClone(completeInput);
    finalInput.observedAt = "2026-07-17T12:03:00.000Z";
    finalInput.setup.chainAnchor.stacksBlockHeight += 1;
    finalInput.setup.chainAnchor.indexBlockHash = `0x${"de".repeat(32)}`;
    if (finalInput.rewards) {
      finalInput.rewards.observedAt.timestamp = finalInput.observedAt;
      finalInput.rewards.observedAt.stacksTipHeight += 1;
    }
    await expect(
      service(store, evidenceStore(null, [])).observe(finalInput),
    ).resolves.toMatchObject({
      status: "reconciled",
      result: { job: { jobId: second.result.job.jobId, state: "reconciled" } },
    });
  });

  it("blocks reward reads that target the anchor cycle during a first-half checkpoint", async () => {
    const { store, attestation } = await memoryStore();
    const invalidInput = input(attestation);
    invalidInput.setup = {
      ...invalidInput.setup,
      chainAnchor: {
        ...anchor,
        burnBlockHeight: 4_160,
        rewardCycle: 6,
        cyclePosition: 10,
        checkpoint: "first-half",
      },
    };
    invalidInput.rewards = rewards({
      rewardCycle: 6,
      observedAt: {
        timestamp: observedAt,
        burnBlockHeight: 4_160,
        stacksTipHeight: anchor.stacksBlockHeight,
      },
      global: {
        ...rewards().global,
        lastRewardComputeBurnHeight: "4149",
        lastComputedRewardCycle: "6",
      },
    });

    await expect(service(store).observe(invalidInput)).resolves.toMatchObject({
      status: "blocked",
      blocks: [{ code: "reward-checkpoint-mismatch" }],
    });
  });

  it("waits for finality before reconciling external completion without current authority", async () => {
    const { store, attestation } = await memoryStore();
    const observer = service(store);
    const planned = await observer.observe(input(attestation));
    expect(planned.status).toBe("planned");

    const completeInput = input(attestation);
    completeInput.attestation = null;
    completeInput.gasPayer = null;
    completeInput.observedAt = "2026-07-17T12:01:00.000Z";
    completeInput.setup = {
      ...completeInput.setup,
      chainAnchor: {
        ...anchor,
        stacksBlockHeight: anchor.stacksBlockHeight + 1,
        burnBlockHeight: anchor.burnBlockHeight + 1,
        cyclePosition: anchor.cyclePosition + 1,
        indexBlockHash: `0x${"cd".repeat(32)}`,
      },
    };
    completeInput.rewards = rewards({
      observedAt: {
        timestamp: completeInput.observedAt,
        burnBlockHeight: anchor.burnBlockHeight + 1,
        stacksTipHeight: anchor.stacksBlockHeight + 1,
      },
      global: {
        ...rewards().global,
        signerEarnedBeforeManagerClaimSats: "0",
      },
      manager: { ...rewards().manager, feeSnapshotBips: "500" },
    });
    const completionRun = { ...run, chainAnchor: completeInput.setup.chainAnchor };
    const completed = await service(store, evidenceStore(completionRun, [roster()])).observe(
      completeInput,
    );

    expect(completed).toMatchObject({
      status: "planned",
      result: { created: false, job: { state: "confirmed" } },
    });

    const finalizedInput = structuredClone(completeInput);
    finalizedInput.observedAt = "2026-07-17T12:02:00.000Z";
    finalizedInput.setup.chainAnchor = {
      ...completeInput.setup.chainAnchor,
      stacksBlockHeight: anchor.stacksBlockHeight + 2,
      burnBlockHeight: anchor.burnBlockHeight + 2,
      cyclePosition: anchor.cyclePosition + 2,
      indexBlockHash: `0x${"de".repeat(32)}`,
    };
    finalizedInput.rewards = rewards({
      observedAt: {
        timestamp: finalizedInput.observedAt,
        burnBlockHeight: anchor.burnBlockHeight + 2,
        stacksTipHeight: anchor.stacksBlockHeight + 2,
      },
      global: {
        ...rewards().global,
        signerEarnedBeforeManagerClaimSats: "0",
      },
      manager: { ...rewards().manager, feeSnapshotBips: "500" },
    });
    const finalized = await service(
      store,
      evidenceStore({ ...run, chainAnchor: finalizedInput.setup.chainAnchor }, [roster()]),
    ).observe(finalizedInput);

    expect(finalized).toMatchObject({
      status: "reconciled",
      result: { created: false, job: { state: "reconciled" } },
    });
  });

  it("does not fabricate retrospective jobs for a completed effect", async () => {
    const { store, attestation } = await memoryStore();
    const completeInput = input(attestation);
    completeInput.rewards = rewards({
      global: { ...rewards().global, signerEarnedBeforeManagerClaimSats: "0" },
      manager: { ...rewards().manager, feeSnapshotBips: "500" },
    });

    await expect(service(store).observe(completeInput)).resolves.toEqual({
      status: "idle",
      blocks: [],
      reason: "external-completion-without-local-work",
    });
    expect(store.transactionEngine.logicalJobStats().total).toBe(0);
  });
});
