import { generateKeyPairSync, sign } from "node:crypto";
import { getAddressFromPublicKey, privateKeyToPublic } from "@stacks/transactions";
import {
  type CompatibilityAttestationPayload,
  compatibilityAttestationPayloadSha256,
  compatibilityAttestationSigningBytes,
  type SignedCompatibilityAttestation,
} from "@stx-labs/signer-sidekick-protocol/compatibility-attestation";
import { POX5_TESTNET_COMPATIBILITY } from "@stx-labs/signer-sidekick-protocol/known-network-compatibility";
import {
  MANAGER_CLAIM_REWARDS_ADAPTER_ID,
  MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
} from "@stx-labs/signer-sidekick-protocol/manager-claim-rewards";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openSidekickStore, type SidekickStore } from "../storage/store.js";
import {
  RepositoryTransactionEngineApiService,
  TransactionEngineApiServiceError,
} from "./api-service.js";
import {
  type ManagerClaimObserveFacts,
  ObserveManagerClaimPlanner,
} from "./manager-claim-observer.js";
import { transactionEngineDocumentSha256 } from "./repository.js";

const initial = "2026-07-17T12:00:00.000Z";
const awaitingAt = "2026-07-17T12:01:00.000Z";
const initialNow = "2026-07-17T12:05:00.000Z";
const manager = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.signer-manager";
const publicKey = privateKeyToPublic(`${"11".repeat(32)}01`);
const gasPayer = getAddressFromPublicKey(publicKey, "testnet");
const attestationKeys = generateKeyPairSync("ed25519");
const openStores: SidekickStore[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
});

function attestationPayload(): CompatibilityAttestationPayload {
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
  const payload = attestationPayload();
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

async function memoryStore(): Promise<{ store: SidekickStore; digest: string }> {
  const opened = await openSidekickStore(":memory:", initial);
  openStores.push(opened.store);
  const document = signedAttestation();
  const digest = compatibilityAttestationPayloadSha256(document.payload);
  await opened.store.transactionEngine.accept(
    {
      acceptedState: {
        issuer: document.payload.issuer,
        revision: document.payload.revision,
        payloadSha256: digest,
        verifiedAt: initial,
      },
      document,
      acceptedAt: initial,
    },
    null,
  );
  return { store: opened.store, digest };
}

function facts(digest: string, observedAt = initial): ManagerClaimObserveFacts {
  return {
    schemaVersion: 1,
    observedAt,
    network: { kind: "testnet", chainId: 0x8000_0005 },
    manager: {
      contract: manager,
      profile: {
        id: "reference-testnet",
        recognitionTier: "reference-render",
        sourceSha256: "12".repeat(32),
      },
      observedSourceSha256: "12".repeat(32),
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
      publicKey,
      observedNonce: 7n,
      estimatedFeeUstx: 1_000n,
      maximumFeeUstx: 2_000n,
    },
    controls: { mode: "assist", adapterEnabled: true, rewardsPaused: false },
    effect: { remaining: true, completionEvidenceSha256: null },
    authoritative: { complete: true, canonical: true, finalityDepth: 1 },
  };
}

async function awaitingJob(store: SidekickStore, digest: string) {
  const planned = await new ObserveManagerClaimPlanner(store.transactionEngine).observe(
    facts(digest),
  );
  const job = store.transactionEngine.transitionLogicalJob({
    jobId: planned.job.jobId,
    expectedState: "preflighted",
    expectedStateVersion: planned.job.stateVersion,
    nextState: "awaiting_approval",
    changedAt: awaitingAt,
  });
  return { planned, job };
}

function service(
  store: SidekickStore,
  clock: { value: string },
  adapterAvailability?: () => { available: boolean; reason: string | null },
  onApproved?: (jobId: string) => Promise<void>,
) {
  return new RepositoryTransactionEngineApiService({
    repository: store.transactionEngine,
    requestedMode: "operator-run",
    legacyApprovals: true,
    maximumApprovalMinutes: 30,
    finalityDepth: 6,
    now: () => new Date(clock.value),
    ...(adapterAvailability ? { adapterAvailability } : {}),
    ...(onApproved ? { onApproved } : {}),
  });
}

function approvalRequest(
  job: Awaited<ReturnType<typeof awaitingJob>>["job"],
  expiresAt = "2026-07-17T12:31:00.000Z",
) {
  return {
    decision: "approve" as const,
    intentSha256: job.intentSha256,
    policySha256: job.policySha256,
    expiresAt,
  };
}

describe("repository transaction-engine API service", () => {
  it("maps effective status and stable cursor pages from strict stored manager-claim records", async () => {
    const { store, digest } = await memoryStore();
    const planner = new ObserveManagerClaimPlanner(store.transactionEngine);
    const first = await planner.observe(facts(digest));
    const changed = structuredClone(facts(digest, awaitingAt));
    changed.chainAnchor.stacksBlockHeight += 1;
    changed.chainAnchor.burnBlockHeight += 1;
    changed.chainAnchor.cyclePosition += 1;
    changed.chainAnchor.indexBlockHash = `0x${"bc".repeat(32)}`;
    const second = await planner.observe(changed);
    const awaiting = store.transactionEngine.transitionLogicalJob({
      jobId: second.job.jobId,
      expectedState: "preflighted",
      expectedStateVersion: second.job.stateVersion,
      nextState: "awaiting_approval",
      changedAt: "2026-07-17T12:02:00.000Z",
    });
    const api = service(store, { value: initialNow });

    expect(api.status()).toMatchObject({
      mode: "operator-run",
      forcedObserve: { active: false },
      adapters: [
        {
          adapter: {
            id: MANAGER_CLAIM_REWARDS_ADAPTER_ID,
            revision: MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
          },
          mode: "operator-run",
          enabled: true,
          availability: "available",
        },
      ],
      jobs: { active: 1, awaitingApproval: 1, ambiguous: 0 },
    });

    const firstPage = await api.listJobs({ cursor: null, limit: 1 });
    expect(firstPage).toMatchObject({
      schemaVersion: 1,
      total: 2,
      items: [{ jobId: awaiting.jobId, mode: "assist", approvalState: "awaiting" }],
    });
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await api.listJobs({ cursor: firstPage.nextCursor, limit: 1 });
    expect(secondPage).toMatchObject({
      total: 2,
      nextCursor: null,
      items: [{ jobId: first.job.jobId, state: "superseded" }],
    });

    await expect(
      api.listJobs({
        cursor: null,
        limit: 100,
        states: ["prepared", "preflighted", "awaiting_approval", "blocked", "ambiguous"],
      }),
    ).resolves.toMatchObject({
      total: 1,
      nextCursor: null,
      items: [{ jobId: awaiting.jobId, state: "awaiting_approval" }],
    });

    const detail = await api.getJob(awaiting.jobId);
    expect(detail).toMatchObject({
      jobId: awaiting.jobId,
      review: {
        adapter: {
          id: MANAGER_CLAIM_REWARDS_ADAPTER_ID,
          revision: MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
        },
        managerPrincipal: manager,
        hashes: {
          intentSha256: awaiting.intentSha256,
          policySha256: awaiting.policySha256,
          attestationSha256: digest,
        },
      },
      approvalWindow: {
        eligible: true,
        expiresAt: "2026-07-17T12:32:00.000Z",
        reason: null,
      },
      reconciliation: { outcome: "unknown", canonical: true, finalized: false },
    });
    await expect(api.listJobs({ cursor: "not-a-cursor", limit: 1 })).rejects.toMatchObject({
      statusCode: 400,
      responseCode: "invalid_engine_cursor",
      message: "The transaction job cursor is invalid. Refresh Operations",
    });
  });

  it("reports fail-closed live prerequisite availability without disabling the adapter", async () => {
    const { store } = await memoryStore();
    const api = service(store, { value: initialNow }, () => ({
      available: false,
      reason: "Complete anchored no-bond proof is unavailable",
    }));

    expect(api.status().adapters).toEqual([
      expect.objectContaining({
        enabled: true,
        availability: "blocked",
        blockReason: "Complete anchored no-bond proof is unavailable",
      }),
    ]);
  });

  it.each([
    [
      "manager-source-mismatch,rewards-paused",
      "Manager source does not match its verified profile; Manager rewards are paused",
    ],
    [
      "approval-revalidation:attestation-expired",
      "The approval or compatibility attestation expired. Sync chain data to prepare a new current job, then review and approve it",
    ],
    [
      "approval-invalid-before-broadcast-commitment",
      "Approval changed before broadcast. Sync chain data to prepare a new current job, then review and approve it",
    ],
    [
      "broadcast-rejected:node-rejection",
      "Broadcast was rejected by the node. Review the rejection. If the claim is still needed, sync chain data to prepare a new current job, then review and approve it",
    ],
    [
      "foreign-gas-payer-nonce-activity",
      "Another transaction used the Assist gas-payer nonce. Resolve the nonce conflict. Sync chain data to prepare a new current job, then review and approve it",
    ],
    [
      "canonical-transaction-abort_by_response",
      "The transaction failed on-chain: abort by response. Review the failure. If the claim is still needed, sync chain data to prepare a new current job, then review and approve it",
    ],
  ])("preserves durable block classification %s while displaying recovery guidance", async (blockReason, displayReason) => {
    const { store, digest } = await memoryStore();
    const { job } = await awaitingJob(store, digest);
    const api = service(store, { value: initialNow });
    await api.approve(job.jobId, approvalRequest(job), "operator:test");
    const blocked = store.transactionEngine.transitionLogicalJob({
      jobId: job.jobId,
      expectedState: "awaiting_approval",
      expectedStateVersion: job.stateVersion,
      nextState: "blocked",
      blockReason,
      changedAt: initialNow,
    });
    expect(blocked.blockReason).toBe(blockReason);

    await expect(api.getJob(job.jobId)).resolves.toMatchObject({
      state: "blocked",
      blockReason: displayReason,
      approvalWindow: {
        eligible: false,
        reason:
          "This job is blocked. Resolve its block reason, then sync chain data to prepare a new current job, review, and approve it",
      },
    });
    await expect(api.listJobs({ cursor: null, limit: 1 })).resolves.toMatchObject({
      items: [{ state: "blocked", blockReason: displayReason }],
    });
  });

  it("creates one exact hash-and-expiry-bound approval and invalidates it idempotently", async () => {
    const { store, digest } = await memoryStore();
    const { job } = await awaitingJob(store, digest);
    const clock = { value: initialNow };
    const api = service(store, clock);

    await expect(
      api.approve(job.jobId, approvalRequest(job, "2026-07-17T12:31:00.001Z"), "operator:a"),
    ).rejects.toMatchObject({
      statusCode: 409,
      responseCode: "engine_approval_expiry_invalid",
      message:
        "Approval expiry is outside the current window. Refresh the job and submit a valid expiry",
    });
    const request = approvalRequest(job);
    const created = await api.approve(job.jobId, request, "operator:a");
    expect(created).toMatchObject({
      created: true,
      approval: {
        actor: "operator:a",
        expiresAt: request.expiresAt,
        invalidatedAt: null,
      },
      job: { approvalWindow: { eligible: false } },
    });
    expect(store.transactionEngine.getLatestApproval(job.jobId)?.approval).toEqual({
      schemaVersion: 1,
      decision: "approve",
      jobId: job.jobId,
      intentSha256: job.intentSha256,
      policySha256: job.policySha256,
      attestationSha256: digest,
      expiresAt: request.expiresAt,
    });

    clock.value = "2026-07-17T12:06:00.000Z";
    await expect(api.approve(job.jobId, request, "operator:a")).resolves.toMatchObject({
      created: false,
      approval: { approvalId: created.approval.approvalId },
    });
    await expect(
      api.approve(job.jobId, { ...request, intentSha256: "ff".repeat(32) }, "operator:a"),
    ).rejects.toMatchObject({
      statusCode: 409,
      responseCode: "engine_approval_hash_mismatch",
      message: "The transaction job changed. Refresh it before approving",
    });

    const invalidation = {
      decision: "invalidate" as const,
      reason: "Operator withdrew approval",
    };
    const invalidated = await api.invalidateApproval(job.jobId, invalidation, "operator:a");
    expect(invalidated.approval).toMatchObject({
      approvalId: created.approval.approvalId,
      invalidatedAt: clock.value,
      invalidationReason: invalidation.reason,
      version: 1,
    });
    await expect(
      api.invalidateApproval(job.jobId, invalidation, "operator:a"),
    ).resolves.toMatchObject({ approval: { approvalId: created.approval.approvalId, version: 1 } });
    await expect(
      api.invalidateApproval(
        job.jobId,
        { ...invalidation, reason: "A different audit reason" },
        "operator:a",
      ),
    ).rejects.toBeInstanceOf(TransactionEngineApiServiceError);
  });

  it("retries the idempotent execution callback when approval persistence outlives a callback failure", async () => {
    const { store, digest } = await memoryStore();
    const { job } = await awaitingJob(store, digest);
    let calls = 0;
    const onApproved = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("execution callback failed");
    });
    const api = service(store, { value: initialNow }, undefined, onApproved);
    const request = approvalRequest(job);

    await expect(api.approve(job.jobId, request, "operator:a")).rejects.toThrow(
      "execution callback failed",
    );
    expect(store.transactionEngine.getActiveApproval(job.jobId, initialNow)).toMatchObject({
      actor: "operator:a",
      expiresAt: request.expiresAt,
    });

    await expect(api.approve(job.jobId, request, "operator:a")).resolves.toMatchObject({
      created: false,
    });
    expect(onApproved).toHaveBeenCalledTimes(2);
    expect(onApproved).toHaveBeenNthCalledWith(1, job.jobId);
    expect(onApproved).toHaveBeenNthCalledWith(2, job.jobId);
  });

  it("exposes nonce, txid, and whitelisted reconciliation evidence without signed material", async () => {
    const { store, digest } = await memoryStore();
    const { planned, job } = await awaitingJob(store, digest);
    const clock = { value: initialNow };
    const api = service(store, clock);
    await api.approve(job.jobId, approvalRequest(job), "operator:a");
    const approval = store.transactionEngine.getActiveApproval(
      job.jobId,
      "2026-07-17T12:06:00.000Z",
    );
    if (approval === null) throw new Error("Expected active approval");
    const signed = store.transactionEngine.commitApprovedSignedAttempt({
      jobId: job.jobId,
      expectedJobStateVersion: job.stateVersion,
      approvalId: approval.approvalId,
      expectedApprovalVersion: approval.approvalVersion,
      expectedApprovalSha256: approval.approvalSha256,
      gasPayerPrincipal: gasPayer,
      nonce: "7",
      observedAccountNonce: "7",
      feeUstx: "1000",
      feePolicyRevision: 1,
      signedTransactionRef: "vault://do-not-expose-signed-attempt",
      precomputedTxid: `0x${"34".repeat(32)}`,
      committedAt: "2026-07-17T12:06:00.000Z",
    }).attempt;
    store.transactionEngine.transitionAttempt({
      attemptId: signed.attemptId,
      expectedState: "signed",
      expectedStateVersion: signed.stateVersion,
      nextState: "submitted",
      submissionResult: {
        accepted: true,
        signedTransactionBytes: "do-not-expose-submission-bytes",
      },
      changedAt: "2026-07-17T12:06:30.000Z",
    });
    store.transactionEngine.appendReconciliationObservation({
      jobId: job.jobId,
      predicate: planned.records.reconciliation,
      predicateSha256: transactionEngineDocumentSha256(planned.records.reconciliation),
      chainAnchor: job.chainAnchor,
      authoritative: true,
      canonical: true,
      finalityDepth: 6,
      outcome: "external_success",
      effectRemaining: false,
      reason: "Authoritative manager state shows completion",
      observedAt: "2026-07-17T12:07:00.000Z",
    });

    const detail = await api.getJob(job.jobId);
    expect(detail).toMatchObject({
      nonce: { value: "7", state: "reserved", foreignActivity: false },
      attempts: [
        {
          attemptNumber: 1,
          state: "submitted",
          nonce: "7",
          feeUstx: "1000",
          txid: signed.precomputedTxid,
          submittedAt: "2026-07-17T12:06:30.000Z",
          confirmation: null,
        },
      ],
      reconciliation: {
        outcome: "external-success",
        canonical: true,
        finalized: true,
        evidence: expect.arrayContaining([
          { source: "database", field: "finality_depth", value: "6" },
          { source: "database", field: "effect_remaining", value: "false" },
        ]),
      },
    });
    const encoded = JSON.stringify(detail);
    expect(encoded).not.toContain("do-not-expose-signed-attempt");
    expect(encoded).not.toContain("do-not-expose-submission-bytes");
  });

  it("maps irreversible Force Observe and adapter disable controls without reviving authority", async () => {
    const { store, digest } = await memoryStore();
    const { job } = await awaitingJob(store, digest);
    const clock = { value: initialNow };
    const api = service(store, clock);
    await api.approve(job.jobId, approvalRequest(job), "operator:a");

    const forced = await api.forceObserve(
      { decision: "force-observe", reason: "Emergency stop" },
      "operator:a",
    );
    expect(forced.status).toMatchObject({
      mode: "observe",
      forcedObserve: { active: true, reason: "Emergency stop", actor: "operator:a" },
      adapters: [{ mode: "observe", enabled: true, availability: "available" }],
    });
    expect(await api.getJob(job.jobId)).toMatchObject({
      approval: {
        invalidatedAt: initialNow,
        invalidationReason: "emergency-force-observe",
      },
    });
    const repeated = await api.forceObserve(
      { decision: "force-observe", reason: "A later reason cannot replace it" },
      "operator:b",
    );
    expect(repeated.status.forcedObserve).toMatchObject({
      reason: "Emergency stop",
      actor: "operator:a",
    });

    await expect(
      api.disableAdapter(
        "unknown-adapter",
        { decision: "disable", reason: "Unknown" },
        "operator:a",
      ),
    ).rejects.toMatchObject({
      statusCode: 404,
      responseCode: "engine_adapter_not_found",
      message: "This transaction adapter no longer exists. Refresh Operations",
    });
    const disabled = await api.disableAdapter(
      MANAGER_CLAIM_REWARDS_ADAPTER_ID,
      { decision: "disable", reason: "Adapter circuit breaker" },
      "operator:a",
    );
    expect(disabled).toMatchObject({
      adapter: {
        enabled: false,
        availability: "disabled",
        blockReason: "Adapter circuit breaker",
      },
      status: { mode: "observe" },
    });
  });
});
