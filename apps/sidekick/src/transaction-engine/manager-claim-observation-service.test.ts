import { POX5_TESTNET_COMPATIBILITY } from "@stx-labs/signer-sidekick-protocol/known-network-compatibility";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChainAnchor } from "../chain-anchor.js";
import type { OperatorAnchorSnapshot } from "../operator-anchor-snapshot.js";
import type { StxRewardStatus } from "../reward-status.js";
import { openSidekickStore, type SidekickStore } from "../storage/store.js";
import {
  legacyClaimManager,
  legacyManagerClaimFacts,
  seedLegacyManagerClaimJob,
} from "./legacy-manager-claim.fixture.js";
import {
  type ManagerClaimObservationInput,
  ManagerClaimObservationService,
} from "./manager-claim-observation-service.js";

const observedAt = "2026-07-17T12:00:00.000Z";
const manager = legacyClaimManager;
const runId = "1f53f216-71c3-4b72-865d-53e81a426bc8";
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

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
});

async function memoryStore(): Promise<SidekickStore> {
  const { store } = await openSidekickStore(":memory:", observedAt);
  stores.push(store);
  return store;
}

/** The durable legacy job this service may still reconcile, planned from the same testnet facts. */
async function seedPlannedJob(store: SidekickStore) {
  return await seedLegacyManagerClaimJob(store, {
    state: "preflighted",
    facts: legacyManagerClaimFacts({
      network: { kind: "testnet", chainId: POX5_TESTNET_COMPATIBILITY.networkId },
      manager: {
        contract: manager,
        profile: {
          id: POX5_TESTNET_COMPATIBILITY.referenceManager.profileId,
          recognitionTier: "reference-render",
          sourceSha256: POX5_TESTNET_COMPATIBILITY.referenceManager.sourceSha256,
        },
        observedSourceSha256: POX5_TESTNET_COMPATIBILITY.referenceManager.sourceSha256,
      },
      contracts: {
        pox5: POX5_TESTNET_COMPATIBILITY.pox5.contractId,
        sbtcToken: POX5_TESTNET_COMPATIBILITY.sbtc.tokenContract,
      },
    }),
  });
}

function setup(): OperatorAnchorSnapshot {
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
  } as unknown as OperatorAnchorSnapshot;
}

function baseRewards(overrides: Partial<StxRewardStatus> = {}): StxRewardStatus {
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
    ingestion: { runId, completedAt: observedAt },
    global: {
      lastRewardComputeBurnHeight: "4099",
      lastComputedRewardCycle: String(anchor.rewardCycle),
      rewardsPerToken: "123456789",
      signerEarnedBeforeManagerClaimSats: "1234",
      signerEarnedAcrossBucketsSats: "1234",
    },
    calculation: {
      state: "completed",
      targetRewardCycle: anchor.rewardCycle,
      targetCheckpoint: "first-half",
      expectedLastRewardComputeBurnHeight: 4_099,
      observedLastRewardComputeBurnHeight: "4099",
    },
    buckets: [],
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
  } as unknown as StxRewardStatus;
}

function rewards(overrides: Partial<StxRewardStatus> = {}): StxRewardStatus {
  const base = baseRewards(overrides);
  if (base.buckets.length > 0) return base;
  // Derive the STX bucket from `global` so the tests that override the earned amount stay
  // internally consistent. Shares stay at zero so participation tracks earnings alone.
  const stxEarned = base.global.signerEarnedBeforeManagerClaimSats;
  return {
    ...base,
    global: { ...base.global, signerEarnedAcrossBucketsSats: stxEarned },
    buckets: [
      {
        bondIndex: null,
        managerSharesSats: "0",
        signerEarnedBeforeManagerClaimSats: stxEarned,
        rewardsPerToken: base.global.rewardsPerToken,
        feeSnapshotBips: base.manager.feeSnapshotBips,
        participating: stxEarned !== "0",
      },
    ],
  } as StxRewardStatus;
}

function input(): ManagerClaimObservationInput {
  return { setup: setup(), rewards: rewards(), observedAt };
}

function service(store: SidekickStore, finalityDepth = 1): ManagerClaimObservationService {
  const canonicalAnchors = new Map<number, { indexBlockHash: string; burnBlockHeight: number }>([
    [9_001, { indexBlockHash: `0x${"cd".repeat(32)}`, burnBlockHeight: 4_101 }],
    [9_002, { indexBlockHash: `0x${"de".repeat(32)}`, burnBlockHeight: 4_102 }],
  ]);
  return new ManagerClaimObservationService({
    repository: store.transactionEngine,
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
    } as never,
    finalityDepth,
  });
}

/** Authoritative facts showing the claim was completed externally `delta` blocks after planning. */
function completedObservationInput(options: {
  stacksBlockHeight: number;
  indexBlockHash: string;
  samePassConfirmedJobIds?: readonly string[];
}): ManagerClaimObservationInput {
  const delta = options.stacksBlockHeight - anchor.stacksBlockHeight;
  const value = input();
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

describe("manager-claim observation after the single-job engine retirement", () => {
  it("stays idle on the manual wallet path for a remaining claim and never creates work", async () => {
    const store = await memoryStore();

    await expect(service(store).observe(input())).resolves.toEqual({
      status: "idle",
      blocks: [],
      reason: "manual-wallet-available",
    });
    expect(store.transactionEngine.logicalJobStats().total).toBe(0);
  });

  it("blocks reward reads that target the anchor cycle during a first-half checkpoint", async () => {
    const store = await memoryStore();
    const invalidInput = input();
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
      blocks: [
        {
          code: "reward-checkpoint-mismatch",
          message:
            "Reward data is not aligned with the current claim checkpoint. Sidekick will retry as the chain advances",
        },
      ],
    });
  });

  it("waits for finality before reconciling external completion of a planned legacy claim", async () => {
    const store = await memoryStore();
    const { job } = await seedPlannedJob(store);
    const observer = service(store);

    const completed = await observer.observe(
      completedObservationInput({
        stacksBlockHeight: anchor.stacksBlockHeight + 1,
        indexBlockHash: `0x${"cd".repeat(32)}`,
      }),
    );
    expect(completed).toMatchObject({
      status: "planned",
      result: { created: false, job: { jobId: job.jobId, state: "confirmed" } },
    });

    const finalized = await observer.observe(
      completedObservationInput({
        stacksBlockHeight: anchor.stacksBlockHeight + 2,
        indexBlockHash: `0x${"de".repeat(32)}`,
      }),
    );
    expect(finalized).toMatchObject({
      status: "reconciled",
      result: { created: false, job: { jobId: job.jobId, state: "reconciled" } },
    });
    expect(store.transactionEngine.logicalJobStats().total).toBe(1);
  });

  it("does not advance local finality when recovery omitted the job or disagrees with inclusion", async () => {
    for (const disagreement of ["not-in-page", "noncanonical-inclusion"] as const) {
      const store = await memoryStore();
      const { job } = await seedPlannedJob(store);
      const observer = service(store);
      const canonical = disagreement === "not-in-page";
      vi.spyOn(store.transactionEngine, "listAttempts").mockReturnValue([
        {
          attemptId: "00000000-0000-4000-8000-000000000011",
          jobId: job.jobId,
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
      const samePassConfirmedJobIds = disagreement === "noncanonical-inclusion" ? [job.jobId] : [];

      await expect(
        observer.observe(
          completedObservationInput({
            stacksBlockHeight: anchor.stacksBlockHeight + 1,
            indexBlockHash: `0x${"cd".repeat(32)}`,
            samePassConfirmedJobIds,
          }),
        ),
      ).resolves.toMatchObject({ status: "planned", result: { job: { state: "confirmed" } } });
      await expect(
        observer.observe(
          completedObservationInput({
            stacksBlockHeight: anchor.stacksBlockHeight + 2,
            indexBlockHash: `0x${"de".repeat(32)}`,
            samePassConfirmedJobIds,
          }),
        ),
      ).resolves.toMatchObject({ status: "planned", result: { job: { state: "confirmed" } } });
    }
  });

  it("does not fabricate retrospective jobs for a completed effect", async () => {
    const store = await memoryStore();
    const completeInput = input();
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

  it("stays idle when buckets participate but nothing is settled in them", async () => {
    const store = await memoryStore();
    const idle = rewards({
      global: {
        ...rewards().global,
        signerEarnedBeforeManagerClaimSats: "0",
        signerEarnedAcrossBucketsSats: "0",
      },
      buckets: [
        {
          bondIndex: null,
          managerSharesSats: "0",
          signerEarnedBeforeManagerClaimSats: "0",
          rewardsPerToken: "123456789",
          feeSnapshotBips: null,
          participating: false,
        },
        {
          bondIndex: "2",
          managerSharesSats: "100000",
          signerEarnedBeforeManagerClaimSats: "0",
          rewardsPerToken: "0",
          feeSnapshotBips: null,
          participating: true,
        },
      ],
    } as Partial<StxRewardStatus>);

    // `claim-rewards` reverts when the whole call totals zero, so proposing it would hand the
    // operator a transaction that cannot succeed.
    await expect(service(store).observe({ ...input(), rewards: idle })).resolves.toEqual({
      status: "idle",
      blocks: [],
      reason: "buckets-present-nothing-claimable",
    });
    expect(store.transactionEngine.logicalJobStats().total).toBe(0);
  });
});
