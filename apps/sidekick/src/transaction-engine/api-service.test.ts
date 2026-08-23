import {
  MANAGER_CLAIM_REWARDS_ADAPTER_ID,
  MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
} from "@stx-labs/signer-sidekick-protocol/manager-claim-rewards";
import { afterEach, describe, expect, it } from "vitest";
import { openSidekickStore, type SidekickStore } from "../storage/store.js";
import { RepositoryTransactionEngineApiService } from "./api-service.js";
import {
  legacyClaimAttestationDigest,
  legacyClaimGasPayer,
  legacyClaimManager,
  legacyManagerClaimFacts,
  seedLegacyApproval,
  seedLegacyManagerClaimJob,
} from "./legacy-manager-claim.fixture.js";
import { transactionEngineDocumentSha256 } from "./repository.js";

const initial = "2026-07-17T12:00:00.000Z";
const awaitingAt = "2026-07-17T12:01:00.000Z";
const initialNow = "2026-07-17T12:05:00.000Z";
const retiredGuidance = "This retired job is read-only; prepare a current operation from Rewards";
const openStores: SidekickStore[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
});

async function memoryStore(): Promise<SidekickStore> {
  const opened = await openSidekickStore(":memory:", initial);
  openStores.push(opened.store);
  return opened.store;
}

/** Historical Assist jobs are the ones that carry approvals; their policy still reads `assist`. */
function assistFacts(observedAt = initial) {
  return legacyManagerClaimFacts({
    observedAt,
    controls: { mode: "assist", adapterEnabled: true, rewardsPaused: false },
  });
}

async function awaitingJob(store: SidekickStore) {
  return await seedLegacyManagerClaimJob(store, {
    facts: assistFacts(awaitingAt),
    state: "awaiting_approval",
    stateVersion: 2,
  });
}

function service(
  store: SidekickStore,
  clock: { value: string },
  adapterAvailability?: () => { available: boolean; reason: string | null },
) {
  return new RepositoryTransactionEngineApiService({
    repository: store.transactionEngine,
    requestedMode: "operator-run",
    finalityDepth: 6,
    now: () => new Date(clock.value),
    ...(adapterAvailability ? { adapterAvailability } : {}),
  });
}

describe("repository transaction-engine API service", () => {
  it("maps effective status and stable cursor pages from strict stored manager-claim records", async () => {
    const store = await memoryStore();
    const replacementFacts = assistFacts(awaitingAt);
    replacementFacts.chainAnchor = {
      ...replacementFacts.chainAnchor,
      stacksBlockHeight: 9_001,
      burnBlockHeight: 4_101,
      cyclePosition: 51,
      indexBlockHash: `0x${"bc".repeat(32)}`,
    };
    const { job: awaiting } = await seedLegacyManagerClaimJob(store, {
      facts: replacementFacts,
      state: "awaiting_approval",
      stateVersion: 2,
      updatedAt: "2026-07-17T12:02:00.000Z",
    });
    const { job: superseded } = await seedLegacyManagerClaimJob(store, {
      facts: assistFacts(initial),
      state: "superseded",
      stateVersion: 1,
      supersessionReason: "authoritative-manager-claim-facts-changed",
      supersededByJobId: awaiting.jobId,
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
      items: [{ jobId: superseded.jobId, state: "superseded" }],
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
        managerPrincipal: legacyClaimManager,
        hashes: {
          intentSha256: awaiting.intentSha256,
          policySha256: awaiting.policySha256,
          attestationSha256: legacyClaimAttestationDigest,
        },
      },
      approvalWindow: {
        eligible: false,
        expiresAt: null,
        reason: "Single-job approvals are retired; run reward calls from Rewards",
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
    const store = await memoryStore();
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
      `The approval or compatibility attestation expired. ${retiredGuidance}`,
    ],
    [
      "approval-invalid-before-broadcast-commitment",
      `Approval changed before broadcast. ${retiredGuidance}`,
    ],
    [
      "broadcast-rejected:node-rejection",
      `Broadcast was rejected by the node. Review the rejection. ${retiredGuidance}`,
    ],
    [
      "foreign-gas-payer-nonce-activity",
      `Another transaction used the retired job's gas-payer nonce. ${retiredGuidance}`,
    ],
    [
      "canonical-transaction-abort_by_response",
      `The transaction failed on-chain: abort by response. Review the failure. ${retiredGuidance}`,
    ],
  ])("preserves durable block classification %s while displaying read-only guidance", async (blockReason, displayReason) => {
    const store = await memoryStore();
    const { job } = await awaitingJob(store);
    const api = service(store, { value: initialNow });
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
          "This retired job is blocked and read-only; prepare a current operation from Rewards",
      },
    });
    await expect(api.listJobs({ cursor: null, limit: 1 })).resolves.toMatchObject({
      items: [{ state: "blocked", blockReason: displayReason }],
    });
  });

  it("exposes nonce, txid, and whitelisted reconciliation evidence without signed material", async () => {
    const store = await memoryStore();
    const { job, records } = await awaitingJob(store);
    const api = service(store, { value: initialNow });
    const approval = seedLegacyApproval(store, job, { actor: "operator:a", createdAt: initialNow });
    const signed = store.transactionEngine.commitApprovedSignedAttempt({
      jobId: job.jobId,
      expectedJobStateVersion: job.stateVersion,
      approvalId: approval.approvalId,
      expectedApprovalVersion: approval.approvalVersion,
      expectedApprovalSha256: approval.approvalSha256,
      gasPayerPrincipal: legacyClaimGasPayer,
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
      predicate: records.reconciliation,
      predicateSha256: transactionEngineDocumentSha256(records.reconciliation),
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
    const store = await memoryStore();
    const { job } = await awaitingJob(store);
    const clock = { value: initialNow };
    const api = service(store, clock);
    seedLegacyApproval(store, job, { actor: "operator:a", createdAt: initialNow });

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
