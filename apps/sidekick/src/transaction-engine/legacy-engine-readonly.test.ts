import type { DatabaseSync } from "node:sqlite";
import { getAddressFromPublicKey, privateKeyToPublic } from "@stacks/transactions";
import { afterEach, describe, expect, it } from "vitest";
import { openSidekickStore, type SidekickStore } from "../storage/store.js";
import { RepositoryTransactionEngineApiService } from "./api-service.js";
import {
  type ManagerClaimObserveFacts,
  ObserveManagerClaimPlanner,
} from "./manager-claim-observer.js";
import { transactionEngineDocumentSha256 } from "./repository.js";

const stores: SidekickStore[] = [];
const observedAt = "2026-07-17T12:00:00.000Z";
const manager = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.signer-manager";
const publicKey = privateKeyToPublic(`${"11".repeat(32)}01`);

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function remainingClaim(): ManagerClaimObserveFacts {
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
      payloadSha256: "34".repeat(32),
      current: false,
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
      principal: getAddressFromPublicKey(publicKey, "testnet"),
      publicKey,
      observedNonce: 7n,
      estimatedFeeUstx: 1_000n,
      maximumFeeUstx: 2_000n,
    },
    controls: { mode: "observe", adapterEnabled: true, rewardsPaused: false },
    effect: { remaining: true, completionEvidenceSha256: null },
    authoritative: { complete: true, canonical: true, finalityDepth: 1 },
  };
}

function seedHistoricalJob(store: SidekickStore) {
  const db = (store.transactionEngine as unknown as { db: DatabaseSync }).db;
  const jobId = "00000000-0000-4000-8000-000000000001";
  const intent = { schemaVersion: 1, kind: "historical-manager-claim" };
  const policy = { schemaVersion: 1, mode: "observe" };
  const anchor = remainingClaim().chainAnchor;
  const intentSha256 = transactionEngineDocumentSha256(intent);
  const policySha256 = transactionEngineDocumentSha256(policy);
  db.prepare(
    `INSERT INTO transaction_jobs (
      job_id, idempotency_key, operation_scope_key, adapter_id, adapter_revision,
      manager_principal, intent_sha256, policy_sha256, intent_json, policy_json,
      chain_anchor_json, attestation_issuer, attestation_revision,
      attestation_payload_sha256, state, state_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 0, ?, ?)`,
  ).run(
    jobId,
    "historical:claim:5",
    "historical:claim:5",
    "reference-manager-claim-rewards",
    2,
    manager,
    intentSha256,
    policySha256,
    JSON.stringify(intent),
    JSON.stringify(policy),
    JSON.stringify(anchor),
    "stacks-labs",
    1,
    "34".repeat(32),
    observedAt,
    observedAt,
  );
  const approval = { schemaVersion: 1, decision: "approve", jobId };
  db.prepare(
    `INSERT INTO transaction_approvals (
      approval_id, job_id, intent_sha256, policy_sha256, approval_sha256, approval_json,
      actor, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "00000000-0000-4000-8000-000000000002",
    jobId,
    intentSha256,
    policySha256,
    transactionEngineDocumentSha256(approval),
    JSON.stringify(approval),
    "operator:test",
    observedAt,
    "2026-07-17T12:30:00.000Z",
  );
  return { db, jobId, intent, anchor };
}

describe("retired single-job engine boundary", () => {
  it("never creates new work from current manager-claim facts", async () => {
    const opened = await openSidekickStore(":memory:", observedAt);
    stores.push(opened.store);

    await expect(
      new ObserveManagerClaimPlanner(opened.store.transactionEngine).observe(remainingClaim()),
    ).rejects.toThrow(
      "Legacy manager-claim jobs are read-only; prepare a current operation from Rewards",
    );
    expect(opened.store.transactionEngine.listLogicalJobs()).toMatchObject({ items: [], total: 0 });
  });

  it("keeps the historical API read-only while preserving emergency controls", async () => {
    const opened = await openSidekickStore(":memory:", observedAt);
    stores.push(opened.store);
    const api = new RepositoryTransactionEngineApiService({
      repository: opened.store.transactionEngine,
      requestedMode: "operator-run",
      finalityDepth: 6,
      now: () => new Date(observedAt),
    });

    expect(await api.listJobs({ cursor: null, limit: 10 })).toMatchObject({ items: [], total: 0 });
    await api.forceObserve({ reason: "operator emergency stop" }, "operator:test");
    expect(api.status()).toMatchObject({
      mode: "observe",
      forcedObserve: { active: true, reason: "operator emergency stop" },
    });
    await api.disableAdapter(
      "reference-manager-claim-rewards",
      { reason: "disable retired adapter" },
      "operator:test",
    );
    expect(api.status().adapters[0]).toMatchObject({ enabled: false, availability: "disabled" });
  });

  it("reads and reconciles durable legacy history without reopening its authority path", async () => {
    const opened = await openSidekickStore(":memory:", observedAt);
    stores.push(opened.store);
    const { db, jobId, intent, anchor } = seedHistoricalJob(opened.store);

    expect(opened.store.transactionEngine.getLogicalJob(jobId)).toMatchObject({
      jobId,
      state: "confirmed",
      intent,
    });
    expect(opened.store.transactionEngine.getLatestApproval(jobId)).toMatchObject({
      jobId,
      actor: "operator:test",
    });
    expect(opened.store.transactionEngine.listLogicalJobs()).toMatchObject({ total: 1 });
    expect(opened.store.transactionEngine.logicalJobStats()).toMatchObject({
      total: 1,
      active: 1,
    });

    const predicate = { schemaVersion: 1, effect: "manager-claim-complete" };
    opened.store.transactionEngine.appendReconciliationObservation({
      observationId: "00000000-0000-4000-8000-000000000003",
      jobId,
      predicate,
      predicateSha256: transactionEngineDocumentSha256(predicate),
      chainAnchor: anchor,
      authoritative: true,
      canonical: true,
      finalityDepth: 6,
      outcome: "external_success",
      effectRemaining: false,
      observedAt,
    });
    const reconciled = opened.store.transactionEngine.transitionLogicalJob({
      jobId,
      expectedState: "confirmed",
      expectedStateVersion: 0,
      nextState: "reconciled",
      changedAt: "2026-07-17T12:01:00.000Z",
    });
    expect(reconciled.state).toBe("reconciled");
    expect(opened.store.transactionEngine.listReconciliationObservations(jobId)).toHaveLength(1);
    expect(() =>
      db.prepare("UPDATE transaction_jobs SET intent_json = '{}' WHERE job_id = ?").run(jobId),
    ).toThrow("transaction job intent is immutable");
  });
});
