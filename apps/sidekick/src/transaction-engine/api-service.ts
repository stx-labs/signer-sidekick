import { isDeepStrictEqual } from "node:util";
import {
  type EngineAdapterStatus,
  type EngineApproval,
  type EngineApprovalReview,
  type EngineAttempt,
  type EngineDisableAdapterRequest,
  type EngineDisableAdapterResponse,
  type EngineForceObserveRequest,
  type EngineForceObserveResponse,
  type EngineJobDetail,
  type EngineJobPage,
  type EngineJobState,
  type EngineJobSummary,
  type EngineReconciliation,
  type EngineStatus,
  engineApprovalReviewSchema,
  engineApprovalSchema,
  engineDisableAdapterResponseSchema,
  engineForceObserveResponseSchema,
  engineJobDetailSchema,
  engineJobPageSchema,
  engineStatusSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import {
  MANAGER_CLAIM_REWARDS_ADAPTER_ID,
  MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
} from "@stx-labs/signer-sidekick-protocol/manager-claim-rewards";
import { z } from "zod";
import type { TransactionEngineApiService } from "../server.js";
import { copyValidDate } from "../time.js";
import {
  type ManagerClaimIntentRecord,
  type ManagerClaimPolicyRecord,
  parseManagerClaimIntentRecord,
  parseManagerClaimPolicyRecord,
} from "./manager-claim-observer.js";
import {
  type LogicalJobPage,
  type StoredReconciliationObservation,
  type StoredTransactionApproval,
  type StoredTransactionAttempt,
  type StoredTransactionJob,
  TransactionEngineCasError,
  TransactionEngineConflictError,
  type TransactionEngineRepository,
  transactionEngineDocumentSha256,
} from "./repository.js";
import type { TransactionEngineMode } from "./runtime-config.js";

const instantSchema = z.iso.datetime();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const approvalDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    decision: z.literal("approve"),
    jobId: z.string().uuid(),
    intentSha256: sha256Schema,
    policySha256: sha256Schema,
    attestationSha256: sha256Schema,
    expiresAt: instantSchema,
  })
  .strict();
const cursorSchema = z
  .object({
    version: z.literal(1),
    createdAt: instantSchema,
    jobId: z.string().uuid(),
    filterSha256: sha256Schema,
  })
  .strict();

type ApprovalDocument = z.infer<typeof approvalDocumentSchema>;
type ApiErrorStatus = 400 | 404 | 409;
export type TransactionEngineApiServiceErrorCode =
  | "engine_adapter_not_found"
  | "engine_approval_expiry_invalid"
  | "engine_approval_hash_mismatch"
  | "engine_approval_not_available"
  | "engine_approval_not_found"
  | "engine_job_not_found"
  | "engine_state_conflict"
  | "invalid_engine_cursor"
  | "invalid_engine_pagination";

const transactionEngineApiErrorMessages: Record<TransactionEngineApiServiceErrorCode, string> = {
  engine_adapter_not_found: "This transaction adapter no longer exists. Refresh Operations",
  engine_approval_expiry_invalid:
    "Approval expiry is outside the current window. Refresh the job and submit a valid expiry",
  engine_approval_hash_mismatch: "The transaction job changed. Refresh it before approving",
  engine_approval_not_available: "Approval is no longer available for this job. Refresh it",
  engine_approval_not_found: "This job has no approval to invalidate. Refresh it",
  engine_job_not_found: "This transaction job no longer exists. Refresh Operations",
  engine_state_conflict: "Transaction state changed. Refresh and try again",
  invalid_engine_cursor: "The transaction job cursor is invalid. Refresh Operations",
  invalid_engine_pagination: "The transaction job page is invalid. Refresh Operations",
};

export class TransactionEngineApiServiceError extends Error {
  constructor(
    readonly statusCode: ApiErrorStatus,
    readonly responseCode: TransactionEngineApiServiceErrorCode,
  ) {
    super(transactionEngineApiErrorMessages[responseCode]);
    this.name = "TransactionEngineApiServiceError";
  }
}

export interface RepositoryTransactionEngineApiServiceOptions {
  repository: TransactionEngineRepository;
  requestedMode: TransactionEngineMode;
  finalityDepth: number;
  now?: () => Date;
  adapterAvailability?: () => { available: boolean; reason: string | null };
}

interface JobMaterial {
  intent: ManagerClaimIntentRecord;
  policy: ManagerClaimPolicyRecord;
  review: EngineApprovalReview;
}

const managerClaimAdapter = {
  id: MANAGER_CLAIM_REWARDS_ADAPTER_ID,
  revision: MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
} as const;
const managerClaimAdapterLabel = "Reference manager claim rewards";

function boundedReason(value: string | null): string | null {
  return value === null ? null : value.slice(0, 1_000);
}

const observedBlockMessages: Readonly<Record<string, string>> = {
  "adapter-disabled": "Manager-claim transactions are disabled",
  "manager-profile-ineligible": "Reward claims require a verified reference manager",
  "manager-source-mismatch": "Manager source does not match its verified profile",
  "attestation-not-current": "Compatibility attestation expired. Install a current attestation",
  "rewards-paused": "Manager rewards are paused",
  "fee-cap-exceeded": "Estimated claim fee exceeds the configured cap",
  "external-completion-mismatch":
    "External completion evidence does not bind the active manager claim",
};

const approvalRevalidationMessages: Readonly<Record<string, string>> = {
  "approval-binding-changed": "Approval no longer matches this job",
  "planned-anchor-noncanonical": "The approved chain anchor is no longer canonical",
  "runtime-mode-changed":
    "The runtime is no longer in Assist mode; restore Assist first if intended",
  "network-identity-changed": "The configured network changed",
  "contract-identity-changed": "The PoX-5 or sBTC contract changed",
  "manager-identity-changed": "The manager identity or source changed",
  "attestation-changed": "The compatibility attestation changed",
  "attestation-expired": "The approval or compatibility attestation expired",
  "reward-checkpoint-changed": "The reward checkpoint changed",
  "claim-amount-changed": "The claim amount or no-bond proof changed",
  "fee-snapshot-changed": "The manager fee changed",
  "rewards-paused": "PoX-5 rewards were paused after approval; wait until rewards resume",
  "gas-payer-changed":
    "The configured gas-payer identity changed; check Assist configuration first",
  "gas-nonce-changed": "The gas-payer nonce changed after approval",
  "gas-balance-insufficient":
    "The gas-payer balance no longer covers the approved fee; fund the gas payer first",
  "fee-policy-changed": "The Assist fee policy changed; review configuration first",
};

const newCurrentJobGuidance =
  "Sync chain data to prepare a new current job, then review and approve it";

function operatorJobBlockReason(value: string | null): string | null {
  const reason = boundedReason(value);
  if (reason === null) return null;

  const observedCodes = reason.split(",");
  if (observedCodes.every((code) => observedBlockMessages[code] !== undefined)) {
    return observedCodes.map((code) => observedBlockMessages[code]).join("; ");
  }

  if (reason.startsWith("approval-revalidation:")) {
    const code = reason.slice("approval-revalidation:".length);
    if (code === "adapter-disabled") {
      return "Assist or manager-claim transactions were disabled. This job cannot continue. If Assist becomes available later, sync chain data to prepare a new current job, then review and approve it";
    }
    const cause = approvalRevalidationMessages[code] ?? "The approved job failed revalidation";
    return boundedReason(`${cause}. ${newCurrentJobGuidance}`);
  }

  if (reason === "approval-invalid-before-broadcast-commitment") {
    return `Approval changed before broadcast. ${newCurrentJobGuidance}`;
  }
  if (reason.startsWith("broadcast-rejected:")) {
    return `Broadcast was rejected by the node. Review the rejection. If the claim is still needed, ${newCurrentJobGuidance.toLowerCase()}`;
  }
  if (reason === "foreign-gas-payer-nonce-activity") {
    return `Another transaction used the Assist gas-payer nonce. Resolve the nonce conflict. ${newCurrentJobGuidance}`;
  }
  if (reason.startsWith("canonical-transaction-")) {
    const executionStatus = reason.slice("canonical-transaction-".length).replaceAll("_", " ");
    return boundedReason(
      `The transaction failed on-chain: ${executionStatus}. Review the failure. If the claim is still needed, ${newCurrentJobGuidance.toLowerCase()}`,
    );
  }
  return reason;
}

function storedStateFailure(): never {
  throw new Error("Transaction engine durable state failed integrity validation");
}

function assertStoredState(condition: boolean): asserts condition {
  if (!condition) storedStateFailure();
}

function parseCursor(cursor: string): void {
  if (cursor.length < 1 || cursor.length > 2_000) {
    throw new TransactionEngineApiServiceError(400, "invalid_engine_cursor");
  }
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    cursorSchema.parse(decoded);
  } catch {
    throw new TransactionEngineApiServiceError(400, "invalid_engine_cursor");
  }
}

function jobMaterial(job: StoredTransactionJob): JobMaterial {
  assertStoredState(transactionEngineDocumentSha256(job.intent) === job.intentSha256);
  assertStoredState(transactionEngineDocumentSha256(job.policy) === job.policySha256);

  const intent = parseManagerClaimIntentRecord(job.intent);
  const policy = parseManagerClaimPolicyRecord(job.policy);
  const review = engineApprovalReviewSchema.parse({
    ...intent.review,
    hashes: {
      intentSha256: job.intentSha256,
      policySha256: job.policySha256,
      attestationSha256: job.attestation.payloadSha256,
    },
  });

  assertStoredState(job.adapterId === MANAGER_CLAIM_REWARDS_ADAPTER_ID);
  assertStoredState(job.adapterRevision === MANAGER_CLAIM_REWARDS_ADAPTER_REVISION);
  assertStoredState(isDeepStrictEqual(review.adapter, managerClaimAdapter));
  assertStoredState(review.managerPrincipal === job.managerPrincipal);
  assertStoredState(isDeepStrictEqual(review.anchor, job.chainAnchor));
  assertStoredState(intent.operationScopeKey === job.operationScopeKey);
  assertStoredState(
    isDeepStrictEqual(intent.acceptedAttestation, {
      issuer: job.attestation.issuer,
      revision: job.attestation.revision,
      payloadSha256: job.attestation.payloadSha256,
    }),
  );
  assertStoredState(intent.reconciliation.managerContract === job.managerPrincipal);
  assertStoredState(intent.reconciliation.rewardCycle === review.checkpoint.rewardCycle.toString());
  assertStoredState(
    review.expectedEffect.reconciliationPredicate === JSON.stringify(intent.reconciliation),
  );
  assertStoredState(
    intent.reconciliation.expectedEffect.asset === review.expectedEffect.asset.assetId,
  );
  assertStoredState(
    intent.reconciliation.expectedEffect.recipient === review.expectedEffect.recipient.principal,
  );
  assertStoredState(
    intent.reconciliation.expectedEffect.amountSats === review.expectedEffect.asset.maximumOutflow,
  );
  assertStoredState(policy.estimatedFeeUstx === review.fee.estimatedFeeUstx);
  assertStoredState(policy.maximumFeeUstx === review.fee.maximumFeeUstx);

  return { intent, policy, review };
}

function parseStoredApprovalDocument(approval: StoredTransactionApproval): ApprovalDocument {
  const document = approvalDocumentSchema.parse(approval.approval);
  assertStoredState(transactionEngineDocumentSha256(document) === approval.approvalSha256);
  assertStoredState(document.jobId === approval.jobId);
  assertStoredState(document.intentSha256 === approval.intentSha256);
  assertStoredState(document.policySha256 === approval.policySha256);
  assertStoredState(document.expiresAt === approval.expiresAt);
  return document;
}

function mapApproval(
  approval: StoredTransactionApproval,
  job: StoredTransactionJob,
  material: JobMaterial,
): EngineApproval {
  const document = parseStoredApprovalDocument(approval);
  assertStoredState(approval.jobId === job.jobId);
  assertStoredState(approval.intentSha256 === job.intentSha256);
  assertStoredState(approval.policySha256 === job.policySha256);
  assertStoredState(document.attestationSha256 === job.attestation.payloadSha256);
  return engineApprovalSchema.parse({
    approvalId: approval.approvalId,
    jobId: approval.jobId,
    review: material.review,
    approvalSha256: approval.approvalSha256,
    actor: approval.actor,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
    invalidatedAt: approval.invalidatedAt,
    invalidationReason: boundedReason(approval.invalidationReason),
    version: approval.approvalVersion,
  });
}

function approvalState(
  policy: ManagerClaimPolicyRecord,
  approval: EngineApproval | null,
  now: Date,
): EngineJobSummary["approvalState"] {
  if (!policy.approvalRequired) return "not-required";
  if (approval === null) return "awaiting";
  if (approval.invalidatedAt !== null) return "invalidated";
  if (now.getTime() >= Date.parse(approval.expiresAt)) return "expired";
  return "approved";
}

function mapAttempt(attempt: StoredTransactionAttempt, nonce: string): EngineAttempt {
  const inclusion = attempt.inclusion;
  return {
    attemptNumber: attempt.attemptNumber,
    state: attempt.state,
    nonce,
    feeUstx: attempt.feeUstx,
    txid: attempt.precomputedTxid,
    submittedAt: attempt.submittedAt,
    confirmation:
      inclusion === null
        ? null
        : {
            stacksBlockHeight: inclusion.stacksBlockHeight,
            blockHash: inclusion.blockHash,
            indexBlockHash: inclusion.indexBlockHash,
            executionStatus: inclusion.executionStatus,
            canonical: inclusion.canonical,
            finalized: attempt.state === "reconciled",
            observedAt: inclusion.observedAt,
          },
  };
}

function reconciliationOutcome(
  job: StoredTransactionJob,
  observation: StoredReconciliationObservation,
): EngineReconciliation["outcome"] {
  if (job.state === "superseded") return "superseded";
  if (!observation.authoritative || !observation.canonical) return "unknown";
  if (observation.outcome === "satisfied" && !observation.effectRemaining) return "satisfied";
  if (observation.outcome === "not_satisfied") return "not-satisfied";
  if (observation.outcome === "external_success" && !observation.effectRemaining) {
    return "external-success";
  }
  return "unknown";
}

function mapReconciliation(
  job: StoredTransactionJob,
  material: JobMaterial,
  observation: StoredReconciliationObservation | undefined,
  finalityDepth: number,
): EngineReconciliation | null {
  if (observation === undefined) return null;
  assertStoredState(
    transactionEngineDocumentSha256(observation.predicate) === observation.predicateSha256,
  );
  assertStoredState(
    observation.predicateSha256 === transactionEngineDocumentSha256(material.intent.reconciliation),
  );
  const evidence: EngineReconciliation["evidence"] = [
    { source: "database", field: "predicate_sha256", value: observation.predicateSha256 },
    { source: "database", field: "authoritative", value: String(observation.authoritative) },
    { source: "database", field: "finality_depth", value: String(observation.finalityDepth) },
    { source: "database", field: "effect_remaining", value: String(observation.effectRemaining) },
  ];
  if (observation.reason !== null) {
    evidence.push({
      source: "database",
      field: "reason",
      value: observation.reason.slice(0, 10_000),
    });
  }
  return {
    predicate: material.review.expectedEffect.reconciliationPredicate,
    observedAt: observation.observedAt,
    anchor: observation.chainAnchor,
    outcome: reconciliationOutcome(job, observation),
    canonical: observation.canonical,
    finalized:
      observation.authoritative &&
      observation.canonical &&
      observation.finalityDepth >= finalityDepth,
    evidence,
  };
}

function repositoryMutationConflict(error: unknown): never {
  if (
    error instanceof TransactionEngineConflictError ||
    error instanceof TransactionEngineCasError
  ) {
    throw new TransactionEngineApiServiceError(409, "engine_state_conflict");
  }
  throw error;
}

export class RepositoryTransactionEngineApiService implements TransactionEngineApiService {
  readonly #repository: TransactionEngineRepository;
  readonly #requestedMode: TransactionEngineMode;
  readonly #finalityDepth: number;
  readonly #clock: () => Date;
  readonly #adapterAvailability: () => { available: boolean; reason: string | null };

  constructor(options: RepositoryTransactionEngineApiServiceOptions) {
    this.#repository = options.repository;
    this.#requestedMode = z.enum(["observe", "operator-run"]).parse(options.requestedMode);
    this.#finalityDepth = z.number().int().min(1).max(144).parse(options.finalityDepth);
    this.#clock = options.now ?? (() => new Date());
    this.#adapterAvailability =
      options.adapterAvailability ?? (() => ({ available: true, reason: null }));
  }

  #now(): Date {
    const now = copyValidDate(this.#clock());
    if (!now) {
      throw new Error("Transaction engine API clock returned an invalid instant");
    }
    return now;
  }

  #effectiveMode(): TransactionEngineMode {
    return this.#repository.getForceObserveControl() === null ? this.#requestedMode : "observe";
  }

  #adapterStatus(): EngineAdapterStatus {
    const disabled = this.#repository.getDisabledAdapterControl(MANAGER_CLAIM_REWARDS_ADAPTER_ID);
    const availability = this.#adapterAvailability();
    const availabilityReason = availability.available
      ? null
      : (boundedReason(availability.reason) ?? "Live adapter prerequisites are not satisfied");
    return {
      adapter: managerClaimAdapter,
      label: managerClaimAdapterLabel,
      mode: this.#effectiveMode(),
      enabled: disabled === null,
      availability:
        disabled !== null ? "disabled" : availability.available ? "available" : "blocked",
      blockReason: disabled !== null ? boundedReason(disabled.reason) : availabilityReason,
    };
  }

  status(): EngineStatus {
    const now = this.#now();
    const forced = this.#repository.getForceObserveControl();
    const jobs = this.#repository.logicalJobStats();
    return engineStatusSchema.parse({
      schemaVersion: 1,
      mode: forced === null ? this.#requestedMode : "observe",
      forcedObserve:
        forced === null
          ? { active: false, reason: null, actor: null, forcedAt: null }
          : {
              active: true,
              reason: boundedReason(forced.reason),
              actor: forced.actor,
              forcedAt: forced.forcedAt,
            },
      adapters: [this.#adapterStatus()],
      jobs: {
        active: jobs.active,
        awaitingApproval: jobs.awaitingApproval,
        ambiguous: jobs.ambiguous,
      },
      generatedAt: now.toISOString(),
    });
  }

  async listJobs(options: {
    cursor: string | null;
    limit: number;
    states?: readonly EngineJobState[];
  }): Promise<EngineJobPage> {
    const limit = z.number().int().min(1).max(100).safeParse(options.limit);
    if (!limit.success) {
      throw new TransactionEngineApiServiceError(400, "invalid_engine_pagination");
    }
    if (options.cursor !== null) parseCursor(options.cursor);
    let page: LogicalJobPage;
    try {
      page = this.#repository.listLogicalJobs({
        limit: limit.data,
        ...(options.states === undefined ? {} : { states: options.states }),
        ...(options.cursor === null ? {} : { cursor: options.cursor }),
      });
    } catch (error) {
      if (error instanceof TransactionEngineConflictError) {
        throw new TransactionEngineApiServiceError(400, "invalid_engine_cursor");
      }
      throw error;
    }
    const now = this.#now();
    return engineJobPageSchema.parse({
      schemaVersion: 1,
      items: page.items.map((job) => this.#jobSummary(job, now)),
      nextCursor: page.nextCursor,
      total: page.total,
    });
  }

  #jobSummary(job: StoredTransactionJob, now: Date): EngineJobSummary {
    const material = jobMaterial(job);
    const storedApproval = this.#repository.getLatestApproval(job.jobId);
    const approval = storedApproval === null ? null : mapApproval(storedApproval, job, material);
    return {
      jobId: job.jobId,
      mode: material.policy.mode,
      state: job.state,
      blockReason: operatorJobBlockReason(job.blockReason),
      adapter: material.review.adapter,
      network: material.review.network,
      managerPrincipal: material.review.managerPrincipal,
      contract: material.review.call.contract,
      functionName: material.review.call.functionName,
      rewardCycle: material.review.checkpoint.rewardCycle,
      approvalState: approvalState(material.policy, approval, now),
      updatedAt: job.updatedAt,
    };
  }

  #approvalWindow(
    job: StoredTransactionJob,
    _material: JobMaterial,
    approval: EngineApproval | null,
    now: Date,
  ): EngineJobDetail["approvalWindow"] {
    if (job.state === "blocked") {
      return {
        eligible: false,
        expiresAt: approval?.expiresAt ?? null,
        reason:
          "This job is blocked. Resolve its block reason, then sync chain data to prepare a new current job, review, and approve it",
      };
    }
    if (approval !== null) {
      return {
        eligible: false,
        expiresAt: approval.expiresAt,
        reason:
          approval.invalidatedAt === null
            ? now.getTime() >= Date.parse(approval.expiresAt)
              ? `Approval expired. ${newCurrentJobGuidance}`
              : "This job is already approved"
            : "Approval was invalidated",
      };
    }
    if (job.state !== "awaiting_approval") {
      return {
        eligible: false,
        expiresAt: null,
        reason: "This job is not awaiting approval",
      };
    }
    // Single-job Assist approvals are retired (ADR 0010): operator-run signs only inside sealed
    // reward runs. Jobs that still await approval stay visible for review but never become
    // eligible here.
    return {
      eligible: false,
      expiresAt: null,
      reason: "Single-job approvals are retired; run reward calls from Rewards",
    };
  }

  #jobDetail(job: StoredTransactionJob, now: Date): EngineJobDetail {
    const material = jobMaterial(job);
    const storedApproval = this.#repository.getLatestApproval(job.jobId);
    const approval = storedApproval === null ? null : mapApproval(storedApproval, job, material);
    const reservation = this.#repository.getNonceReservationForJob(job.jobId);
    const attempts = this.#repository.listAttempts(job.jobId);
    const attemptNonces = new Map(
      attempts.map((attempt) => {
        const attemptReservation = this.#repository.getNonceReservation(attempt.nonceReservationId);
        assertStoredState(attemptReservation !== null);
        assertStoredState(attemptReservation.jobId === job.jobId);
        return [attempt.attemptId, attemptReservation.nonce] as const;
      }),
    );
    const observations = this.#repository.listReconciliationObservations(job.jobId);
    return engineJobDetailSchema.parse({
      schemaVersion: 1,
      jobId: job.jobId,
      mode: material.policy.mode,
      state: job.state,
      stateVersion: job.stateVersion,
      blockReason: operatorJobBlockReason(job.blockReason),
      supersededByJobId: job.supersededByJobId,
      review: material.review,
      approvalWindow: this.#approvalWindow(job, material, approval, now),
      approval,
      nonce:
        reservation === null
          ? null
          : {
              value: reservation.nonce,
              state: reservation.state,
              foreignActivity: reservation.foreignActivity,
            },
      attempts: attempts.map((attempt) =>
        mapAttempt(attempt, attemptNonces.get(attempt.attemptId) ?? storedStateFailure()),
      ),
      reconciliation: mapReconciliation(job, material, observations.at(-1), this.#finalityDepth),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  }

  async getJob(jobId: string): Promise<EngineJobDetail | null> {
    const job = this.#repository.getLogicalJob(jobId);
    return job === null ? null : this.#jobDetail(job, this.#now());
  }

  async forceObserve(
    request: EngineForceObserveRequest,
    actor: string,
  ): Promise<EngineForceObserveResponse> {
    try {
      this.#repository.forceObserve({
        reason: request.reason,
        actor,
        forcedAt: this.#now().toISOString(),
      });
    } catch (error) {
      repositoryMutationConflict(error);
    }
    return engineForceObserveResponseSchema.parse({ status: this.status() });
  }

  async disableAdapter(
    adapterId: string,
    request: EngineDisableAdapterRequest,
    actor: string,
  ): Promise<EngineDisableAdapterResponse> {
    if (adapterId !== MANAGER_CLAIM_REWARDS_ADAPTER_ID) {
      throw new TransactionEngineApiServiceError(404, "engine_adapter_not_found");
    }
    try {
      this.#repository.disableAdapter({
        adapterId,
        reason: request.reason,
        actor,
        disabledAt: this.#now().toISOString(),
      });
    } catch (error) {
      repositoryMutationConflict(error);
    }
    const status = this.status();
    const adapter = status.adapters.find((candidate) => candidate.adapter.id === adapterId);
    assertStoredState(adapter !== undefined);
    return engineDisableAdapterResponseSchema.parse({ adapter, status });
  }
}
