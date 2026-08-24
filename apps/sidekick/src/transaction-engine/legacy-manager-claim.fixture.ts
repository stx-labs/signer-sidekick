import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Cl, cvToHex, getAddressFromPublicKey, privateKeyToPublic } from "@stacks/transactions";
import {
  MANAGER_CLAIM_REWARDS_ADAPTER_ID,
  MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
  MANAGER_CLAIM_REWARDS_FUNCTION_NAME,
  type ManagerClaimRewardsPlan,
  planManagerClaimRewards,
} from "@stx-labs/signer-sidekick-protocol/manager-claim-rewards";
import type { SidekickStore } from "../storage/store.js";
import {
  bondBucketsDigest,
  type ManagerClaimIntentRecord,
  type ManagerClaimObserveFacts,
  type ManagerClaimPolicyRecord,
  type ManagerClaimReconciliationPredicate,
  managerClaimObserveFactsSchema,
  managerClaimOperationScopeKey,
  managerClaimReviewMaterialSchema,
} from "./manager-claim-observer.js";
import {
  type StoredTransactionApproval,
  type StoredTransactionJob,
  transactionEngineDocumentSha256,
} from "./repository.js";

/**
 * Test fixture for the retired single-job manager-claim engine (ADR 0010, S3.1/S3.2).
 *
 * Production no longer creates these jobs, approvals, or attestations; the read-only history path
 * (Action workspace, Activity, reconciliation of an already-planned claim) still parses the durable
 * records. These helpers rebuild the exact record shape the retired planner wrote and insert it
 * directly into the frozen tables so the read path stays covered without reviving any authority.
 */

export const legacyClaimPublicKey: string = privateKeyToPublic(`${"11".repeat(32)}01`) as string;
export const legacyClaimGasPayer = getAddressFromPublicKey(legacyClaimPublicKey, "testnet");
export const legacyClaimManager = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.signer-manager";
export const legacyClaimAttestationDigest = "34".repeat(32);

export function legacyManagerClaimFacts(
  overrides: Partial<ManagerClaimObserveFacts> = {},
): ManagerClaimObserveFacts {
  return {
    schemaVersion: 1,
    observedAt: "2026-07-17T12:00:00.000Z",
    network: { kind: "testnet", chainId: 0x8000_0005 },
    manager: {
      contract: legacyClaimManager,
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
      payloadSha256: legacyClaimAttestationDigest,
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
      principal: legacyClaimGasPayer,
      publicKey: legacyClaimPublicKey,
      observedNonce: 7n,
      estimatedFeeUstx: 1_000n,
      maximumFeeUstx: 2_000n,
    },
    controls: { mode: "observe", adapterEnabled: true, rewardsPaused: false },
    effect: { remaining: true, completionEvidenceSha256: null },
    authoritative: { complete: true, canonical: true, finalityDepth: 1 },
    ...overrides,
  };
}

export interface LegacyManagerClaimRecords {
  plan: ManagerClaimRewardsPlan;
  intent: ManagerClaimIntentRecord;
  intentSha256: string;
  policy: ManagerClaimPolicyRecord;
  policySha256: string;
  reconciliation: ManagerClaimReconciliationPredicate;
  reconciliationSha256: string;
  scopeKey: string;
  idempotencyKey: string;
}

/** Rebuilds the exact intent/policy/sealed-plan records the retired planner persisted. */
export async function buildLegacyManagerClaimRecords(
  facts: ManagerClaimObserveFacts,
): Promise<LegacyManagerClaimRecords> {
  const value = managerClaimObserveFactsSchema.parse(facts);
  const scopeKey = managerClaimOperationScopeKey({
    network: value.network,
    managerContract: value.manager.contract,
    rewardCycle: value.rewardCheckpoint.rewardCycle,
    calculationCheckpoint: value.rewardCheckpoint.calculationCheckpoint,
    lastRewardComputeBurnHeight: value.rewardCheckpoint.lastRewardComputeBurnHeight,
    rewardsPerToken: value.rewardCheckpoint.rewardsPerToken,
  });
  const plan = await planManagerClaimRewards({
    schemaVersion: 1,
    adapterRevision: MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
    network: value.network,
    managerContract: value.manager.contract,
    pox5Contract: value.contracts.pox5,
    sbtcTokenContract: value.contracts.sbtcToken,
    rewardCycle: value.rewardCheckpoint.rewardCycle,
    expectedSbtcOutflow: value.expectedSignerOutflowSats,
    chainAnchor: {
      ...value.chainAnchor,
      rewardCycle: BigInt(value.chainAnchor.rewardCycle),
    },
    attestationDigest: value.acceptedAttestation.payloadSha256,
    managerSourceFingerprint: value.manager.observedSourceSha256,
    rewardObservation: {
      calculationCheckpoint: value.rewardCheckpoint.calculationCheckpoint,
      lastRewardComputeBurnHeight: value.rewardCheckpoint.lastRewardComputeBurnHeight,
      rewardsPerToken: value.rewardCheckpoint.rewardsPerToken,
    },
    stxEarnedSats: value.stxEarnedSats,
    bondBuckets: value.bondBuckets,
    feeSnapshot: value.feeSnapshot,
    sender: { principal: value.gasPayer.principal, publicKey: value.gasPayer.publicKey },
    nonce: value.gasPayer.observedNonce,
    fee: value.gasPayer.estimatedFeeUstx,
  });
  const reconciliation: ManagerClaimReconciliationPredicate = {
    schemaVersion: 1,
    kind: "reference-manager-claim-rewards",
    managerContract: value.manager.contract,
    rewardCycle: value.rewardCheckpoint.rewardCycle.toString(),
    rewardCheckpoint: {
      calculationCheckpoint: value.rewardCheckpoint.calculationCheckpoint,
      lastRewardComputeBurnHeight: value.rewardCheckpoint.lastRewardComputeBurnHeight,
      rewardsPerToken: value.rewardCheckpoint.rewardsPerToken.toString(),
    },
    bondBucketsSha256: bondBucketsDigest(value),
    expectedFeeSnapshot: {
      state: "present",
      effectiveFeeBips: value.feeSnapshot.effectiveFeeBips.toString(),
    },
    expectedEffect: {
      asset: plan.material.expectedEffect.asset,
      sender: plan.material.expectedEffect.sender,
      recipient: plan.material.expectedEffect.recipient,
      amountSats: plan.material.expectedEffect.amount,
    },
  };
  const intent: ManagerClaimIntentRecord = {
    schemaVersion: 1,
    kind: "reference-manager-claim-rewards",
    operationScopeKey: scopeKey,
    managerProfile: {
      id: value.manager.profile.id,
      recognitionTier: value.manager.profile.recognitionTier,
      expectedSourceSha256: value.manager.profile.sourceSha256,
      observedSourceSha256: value.manager.observedSourceSha256,
    },
    acceptedAttestation: {
      issuer: value.acceptedAttestation.issuer,
      revision: value.acceptedAttestation.revision,
      payloadSha256: value.acceptedAttestation.payloadSha256,
    },
    review: managerClaimReviewMaterialSchema.parse({
      adapter: {
        id: MANAGER_CLAIM_REWARDS_ADAPTER_ID,
        revision: MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
      },
      network: `${value.network.kind}:${value.network.chainId}`,
      managerPrincipal: value.manager.contract,
      call: {
        contract: value.manager.contract,
        functionName: MANAGER_CLAIM_REWARDS_FUNCTION_NAME,
        arguments: [
          {
            name: "bond-periods",
            clarityValue: cvToHex(
              Cl.list(value.bondBuckets.map(({ bondIndex }) => Cl.uint(bondIndex))),
            ),
            displayValue: `[${value.bondBuckets.map(({ bondIndex }) => bondIndex).join(", ")}]`,
          },
          {
            name: "reward-cycle",
            clarityValue: `u${value.rewardCheckpoint.rewardCycle}`,
            displayValue: value.rewardCheckpoint.rewardCycle.toString(),
          },
        ],
      },
      anchor: value.chainAnchor,
      checkpoint: {
        rewardCycle: Number(value.rewardCheckpoint.rewardCycle),
        calculationCheckpoint: value.rewardCheckpoint.calculationCheckpoint,
        lastRewardComputeHeight: value.rewardCheckpoint.lastRewardComputeBurnHeight,
        rewardsPerToken: value.rewardCheckpoint.rewardsPerToken.toString(),
      },
      expectedEffect: {
        recipient: { kind: "manager", principal: value.manager.contract },
        asset: {
          assetId: plan.material.expectedEffect.asset,
          symbol: "sBTC",
          maximumOutflow: plan.material.expectedEffect.amount,
          unit: "sats",
        },
        postconditions: [
          `${plan.material.expectedEffect.sender} sends exactly ${plan.material.expectedEffect.amount} sats of ${plan.material.expectedEffect.asset}`,
        ],
        reconciliationPredicate: JSON.stringify(reconciliation),
      },
      fee: {
        snapshot: {
          state: value.feeSnapshot.state === "absent" ? "missing" : "present",
          feeBips: Number(value.feeSnapshot.effectiveFeeBips),
          source: `manager-profile:${value.manager.profile.id}`,
        },
        estimatedFeeUstx: value.gasPayer.estimatedFeeUstx.toString(),
        maximumFeeUstx: value.gasPayer.maximumFeeUstx.toString(),
        policyRevision: 1,
      },
      expectedPostState: JSON.stringify({ predicate: reconciliation, effectRemaining: false }),
    }),
    sealedPlan: plan,
    reconciliation,
  };
  const policy: ManagerClaimPolicyRecord = {
    schemaVersion: 1,
    kind: "reference-manager-claim-rewards-policy",
    mode: value.controls.mode,
    adapterEnabled: value.controls.adapterEnabled,
    rewardsPaused: value.controls.rewardsPaused,
    maximumFeeUstx: value.gasPayer.maximumFeeUstx.toString(),
    estimatedFeeUstx: value.gasPayer.estimatedFeeUstx.toString(),
    approvalRequired: value.controls.mode === "assist",
    nonceReservationAllowed: value.controls.mode === "assist",
    signingAllowed: value.controls.mode === "assist",
    broadcastAllowed: value.controls.mode === "assist",
  };
  const intentSha256 = transactionEngineDocumentSha256(intent);
  const policySha256 = transactionEngineDocumentSha256(policy);
  return {
    plan,
    intent,
    intentSha256,
    policy,
    policySha256,
    reconciliation,
    reconciliationSha256: transactionEngineDocumentSha256(reconciliation),
    scopeKey,
    idempotencyKey: `manager-claim-job:${transactionEngineDocumentSha256({
      intentSha256,
      policySha256,
    })}`,
  };
}

function rawDatabase(store: SidekickStore): DatabaseSync {
  return (store.transactionEngine as unknown as { db: DatabaseSync }).db;
}

export interface SeedLegacyManagerClaimJobOptions {
  facts?: ManagerClaimObserveFacts;
  jobId?: string;
  state?: StoredTransactionJob["state"];
  stateVersion?: number;
  createdAt?: string;
  updatedAt?: string;
  blockReason?: string;
  supersessionReason?: string;
  supersededByJobId?: string;
  /**
   * The retired planner appended one `pending` reconciliation observation when it planned a
   * claim; historical rows carry it, so seed it by default.
   */
  pendingObservation?: boolean;
}

/** Inserts one durable legacy manager-claim job exactly as the retired planner persisted it. */
export async function seedLegacyManagerClaimJob(
  store: SidekickStore,
  options: SeedLegacyManagerClaimJobOptions = {},
): Promise<{ job: StoredTransactionJob; records: LegacyManagerClaimRecords }> {
  const facts = options.facts ?? legacyManagerClaimFacts();
  const records = await buildLegacyManagerClaimRecords(facts);
  const jobId = options.jobId ?? randomUUID();
  const state = options.state ?? "preflighted";
  const createdAt = options.createdAt ?? facts.observedAt;
  rawDatabase(store)
    .prepare(
      `INSERT INTO transaction_jobs (
        job_id, idempotency_key, operation_scope_key, adapter_id, adapter_revision,
        manager_principal, intent_sha256, policy_sha256, intent_json, policy_json,
        chain_anchor_json, attestation_issuer, attestation_revision, attestation_payload_sha256,
        state, state_version, block_reason, supersession_reason, superseded_by_job_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      jobId,
      records.idempotencyKey,
      records.scopeKey,
      MANAGER_CLAIM_REWARDS_ADAPTER_ID,
      MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
      facts.manager.contract,
      records.intentSha256,
      records.policySha256,
      JSON.stringify(records.intent),
      JSON.stringify(records.policy),
      JSON.stringify(facts.chainAnchor),
      facts.acceptedAttestation.issuer,
      facts.acceptedAttestation.revision,
      facts.acceptedAttestation.payloadSha256,
      state,
      options.stateVersion ?? 0,
      options.blockReason ?? null,
      options.supersessionReason ?? null,
      options.supersededByJobId ?? null,
      createdAt,
      options.updatedAt ?? createdAt,
    );
  if (options.pendingObservation !== false) {
    store.transactionEngine.appendReconciliationObservation({
      jobId,
      predicate: records.reconciliation,
      predicateSha256: records.reconciliationSha256,
      chainAnchor: facts.chainAnchor,
      authoritative: true,
      canonical: true,
      finalityDepth: facts.authoritative.finalityDepth,
      outcome: "pending",
      effectRemaining: true,
      observedAt: createdAt,
    });
  }
  const job = store.transactionEngine.getLogicalJob(jobId);
  if (job === null) throw new Error("Seeded legacy manager-claim job did not persist");
  return { job, records };
}

/** Inserts one historical approval row in the exact shape the retired approval API wrote. */
export function seedLegacyApproval(
  store: SidekickStore,
  job: StoredTransactionJob,
  options: { actor?: string; createdAt?: string; expiresAt?: string; approvalId?: string } = {},
): StoredTransactionApproval {
  const expiresAt = options.expiresAt ?? "2026-07-17T12:31:00.000Z";
  const document = {
    schemaVersion: 1,
    decision: "approve",
    jobId: job.jobId,
    intentSha256: job.intentSha256,
    policySha256: job.policySha256,
    attestationSha256: job.attestation.payloadSha256,
    expiresAt,
  };
  rawDatabase(store)
    .prepare(
      `INSERT INTO transaction_approvals (
        approval_id, job_id, intent_sha256, policy_sha256, approval_sha256, approval_json,
        actor, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      options.approvalId ?? randomUUID(),
      job.jobId,
      job.intentSha256,
      job.policySha256,
      transactionEngineDocumentSha256(document),
      JSON.stringify(document),
      options.actor ?? "operator:test",
      options.createdAt ?? job.updatedAt,
      expiresAt,
    );
  const approval = store.transactionEngine.getLatestApproval(job.jobId);
  if (approval === null) throw new Error("Seeded legacy approval did not persist");
  return approval;
}

/** Records an accepted attestation row so `createLogicalJob` accepts matching historical input. */
export function seedAcceptedAttestation(
  store: SidekickStore,
  options: { issuer?: string; revision?: number; payloadSha256?: string; at?: string } = {},
): { issuer: string; revision: number; payloadSha256: string } {
  const issuer = options.issuer ?? "stacks-labs";
  const revision = options.revision ?? 1;
  const payloadSha256 = options.payloadSha256 ?? legacyClaimAttestationDigest;
  const at = options.at ?? "2026-07-17T12:00:00.000Z";
  rawDatabase(store)
    .prepare(
      `INSERT INTO accepted_compatibility_attestations (
        issuer, revision, payload_sha256, verified_at, document_json, accepted_at
      ) VALUES (?, ?, ?, ?, '{}', ?)`,
    )
    .run(issuer, revision, payloadSha256, at, at);
  return { issuer, revision, payloadSha256 };
}
