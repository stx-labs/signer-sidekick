import { isDeepStrictEqual } from "node:util";
import {
  type EngineAdapterStatus,
  type EngineApproval,
  type EngineApprovalRequest,
  type EngineApprovalResponse,
  type EngineApprovalReview,
  type EngineAttempt,
  type EngineDisableAdapterRequest,
  type EngineDisableAdapterResponse,
  type EngineForceObserveRequest,
  type EngineForceObserveResponse,
  type EngineInvalidateApprovalRequest,
  type EngineInvalidateApprovalResponse,
  type EngineJobDetail,
  type EngineJobPage,
  type EngineJobSummary,
  type EngineReconciliation,
  type EngineStatus,
  engineApprovalResponseSchema,
  engineApprovalReviewSchema,
  engineApprovalSchema,
  engineDisableAdapterResponseSchema,
  engineForceObserveResponseSchema,
  engineInvalidateApprovalResponseSchema,
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

export class TransactionEngineApiServiceError extends Error {
  constructor(
    readonly statusCode: ApiErrorStatus,
    readonly responseCode: TransactionEngineApiServiceErrorCode,
  ) {
    super(responseCode);
    this.name = "TransactionEngineApiServiceError";
  }
}

export interface RepositoryTransactionEngineApiServiceOptions {
  repository: TransactionEngineRepository;
  requestedMode: TransactionEngineMode;
  maximumApprovalMinutes: number;
  finalityDepth: number;
  now?: () => Date;
  adapterAvailability?: () => { available: boolean; reason: string | null };
  onApproved?: (jobId: string) => Promise<void>;
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

function approvalDocument(
  job: StoredTransactionJob,
  request: EngineApprovalRequest,
): ApprovalDocument {
  return approvalDocumentSchema.parse({
    schemaVersion: 1,
    decision: "approve",
    jobId: job.jobId,
    intentSha256: request.intentSha256,
    policySha256: request.policySha256,
    attestationSha256: job.attestation.payloadSha256,
    expiresAt: request.expiresAt,
  });
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
  readonly #maximumApprovalMilliseconds: number;
  readonly #finalityDepth: number;
  readonly #clock: () => Date;
  readonly #adapterAvailability: () => { available: boolean; reason: string | null };
  readonly #onApproved: ((jobId: string) => Promise<void>) | null;

  constructor(options: RepositoryTransactionEngineApiServiceOptions) {
    this.#repository = options.repository;
    this.#requestedMode = z.enum(["observe", "assist"]).parse(options.requestedMode);
    this.#maximumApprovalMilliseconds =
      z
        .number()
        .int()
        .min(1)
        .max(24 * 60)
        .parse(options.maximumApprovalMinutes) * 60_000;
    this.#finalityDepth = z.number().int().min(1).max(144).parse(options.finalityDepth);
    this.#clock = options.now ?? (() => new Date());
    this.#adapterAvailability =
      options.adapterAvailability ?? (() => ({ available: true, reason: null }));
    this.#onApproved = options.onApproved ?? null;
  }

  #now(): Date {
    const now = this.#clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("Transaction engine API clock returned an invalid instant");
    }
    return new Date(now.getTime());
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

  async listJobs(options: { cursor: string | null; limit: number }): Promise<EngineJobPage> {
    const limit = z.number().int().min(1).max(100).safeParse(options.limit);
    if (!limit.success) {
      throw new TransactionEngineApiServiceError(400, "invalid_engine_pagination");
    }
    if (options.cursor !== null) parseCursor(options.cursor);
    let page: LogicalJobPage;
    try {
      page = this.#repository.listLogicalJobs({
        limit: limit.data,
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
      blockReason: boundedReason(job.blockReason),
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

  #approvalDeadline(job: StoredTransactionJob): string {
    return new Date(Date.parse(job.updatedAt) + this.#maximumApprovalMilliseconds).toISOString();
  }

  #approvalWindow(
    job: StoredTransactionJob,
    material: JobMaterial,
    approval: EngineApproval | null,
    now: Date,
  ): EngineJobDetail["approvalWindow"] {
    if (approval !== null) {
      return {
        eligible: false,
        expiresAt: approval.expiresAt,
        reason:
          approval.invalidatedAt === null
            ? now.getTime() >= Date.parse(approval.expiresAt)
              ? "The existing approval has expired"
              : "The job already has an active approval"
            : "The approval was invalidated",
      };
    }
    if (job.state !== "awaiting_approval") {
      return {
        eligible: false,
        expiresAt: null,
        reason: "The job is not awaiting approval",
      };
    }
    if (material.policy.mode !== "assist" || !material.policy.approvalRequired) {
      return {
        eligible: false,
        expiresAt: null,
        reason: "The sealed policy does not use approval",
      };
    }
    if (!material.policy.adapterEnabled) {
      return { eligible: false, expiresAt: null, reason: "The sealed adapter policy is disabled" };
    }
    if (material.policy.rewardsPaused) {
      return { eligible: false, expiresAt: null, reason: "Manager rewards are paused" };
    }
    const forced = this.#repository.getForceObserveControl();
    if (forced !== null) {
      return { eligible: false, expiresAt: null, reason: "The engine is forced to Observe mode" };
    }
    if (this.#requestedMode !== "assist") {
      return {
        eligible: false,
        expiresAt: null,
        reason: "The engine is configured for Observe mode",
      };
    }
    if (this.#repository.getDisabledAdapterControl(job.adapterId) !== null) {
      return { eligible: false, expiresAt: null, reason: "The adapter is irreversibly disabled" };
    }
    const expiresAt = this.#approvalDeadline(job);
    if (now.getTime() >= Date.parse(expiresAt)) {
      return { eligible: false, expiresAt, reason: "The approval window has expired" };
    }
    return { eligible: true, expiresAt, reason: null };
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
      blockReason: boundedReason(job.blockReason),
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

  #matchesApprovalRequest(
    approval: StoredTransactionApproval,
    request: EngineApprovalRequest,
    actor: string,
  ): boolean {
    const document = parseStoredApprovalDocument(approval);
    return (
      approval.invalidatedAt === null &&
      approval.actor === actor &&
      document.intentSha256 === request.intentSha256 &&
      document.policySha256 === request.policySha256 &&
      document.expiresAt === request.expiresAt
    );
  }

  async approve(
    jobId: string,
    request: EngineApprovalRequest,
    actor: string,
  ): Promise<EngineApprovalResponse> {
    const job = this.#repository.getLogicalJob(jobId);
    if (job === null) {
      throw new TransactionEngineApiServiceError(404, "engine_job_not_found");
    }
    const material = jobMaterial(job);
    if (request.intentSha256 !== job.intentSha256 || request.policySha256 !== job.policySha256) {
      throw new TransactionEngineApiServiceError(409, "engine_approval_hash_mismatch");
    }
    z.string().min(1).max(500).parse(actor);
    const existing = this.#repository.getLatestApproval(job.jobId);
    if (existing !== null) {
      if (this.#matchesApprovalRequest(existing, request, actor)) {
        await this.#onApproved?.(job.jobId);
        const currentJob = this.#repository.getLogicalJob(job.jobId);
        assertStoredState(currentJob !== null);
        return engineApprovalResponseSchema.parse({
          approval: mapApproval(existing, currentJob, jobMaterial(currentJob)),
          job: this.#jobDetail(currentJob, this.#now()),
          created: false,
        });
      }
      throw new TransactionEngineApiServiceError(409, "engine_approval_not_available");
    }

    const now = this.#now();
    const window = this.#approvalWindow(job, material, null, now);
    if (!window.eligible || window.expiresAt === null) {
      throw new TransactionEngineApiServiceError(409, "engine_approval_not_available");
    }
    const requestedExpiry = Date.parse(request.expiresAt);
    if (requestedExpiry <= now.getTime() || requestedExpiry > Date.parse(window.expiresAt)) {
      throw new TransactionEngineApiServiceError(409, "engine_approval_expiry_invalid");
    }
    const document = approvalDocument(job, request);
    let stored: StoredTransactionApproval;
    let created: boolean;
    try {
      const result = this.#repository.createApproval({
        jobId: job.jobId,
        expectedJobStateVersion: job.stateVersion,
        intentSha256: request.intentSha256,
        policySha256: request.policySha256,
        approval: document,
        approvalSha256: transactionEngineDocumentSha256(document),
        actor,
        createdAt: now.toISOString(),
        expiresAt: request.expiresAt,
      });
      stored = result.approval;
      created = result.created;
    } catch (error) {
      if (
        error instanceof TransactionEngineConflictError ||
        error instanceof TransactionEngineCasError
      ) {
        const raced = this.#repository.getLatestApproval(job.jobId);
        if (raced !== null && this.#matchesApprovalRequest(raced, request, actor)) {
          stored = raced;
          created = false;
        } else {
          repositoryMutationConflict(error);
        }
      } else {
        throw error;
      }
    }
    await this.#onApproved?.(job.jobId);
    const currentJob = this.#repository.getLogicalJob(job.jobId);
    assertStoredState(currentJob !== null);
    return engineApprovalResponseSchema.parse({
      approval: mapApproval(stored, currentJob, jobMaterial(currentJob)),
      job: this.#jobDetail(currentJob, this.#now()),
      created,
    });
  }

  async invalidateApproval(
    jobId: string,
    request: EngineInvalidateApprovalRequest,
    actor: string,
  ): Promise<EngineInvalidateApprovalResponse> {
    const job = this.#repository.getLogicalJob(jobId);
    if (job === null) {
      throw new TransactionEngineApiServiceError(404, "engine_job_not_found");
    }
    z.string().min(1).max(500).parse(actor);
    const latest = this.#repository.getLatestApproval(job.jobId);
    if (latest === null) {
      throw new TransactionEngineApiServiceError(404, "engine_approval_not_found");
    }
    if (latest.invalidatedAt !== null) {
      if (latest.invalidationReason !== request.reason) {
        throw new TransactionEngineApiServiceError(409, "engine_approval_not_available");
      }
      return engineInvalidateApprovalResponseSchema.parse({
        approval: mapApproval(latest, job, jobMaterial(job)),
        job: this.#jobDetail(job, this.#now()),
      });
    }
    let invalidated: StoredTransactionApproval;
    try {
      invalidated = this.#repository.invalidateApproval({
        approvalId: latest.approvalId,
        expectedApprovalVersion: latest.approvalVersion,
        reason: request.reason,
        invalidatedAt: this.#now().toISOString(),
      });
    } catch (error) {
      if (error instanceof TransactionEngineCasError) {
        const raced = this.#repository.getLatestApproval(job.jobId);
        if (
          raced !== null &&
          raced.invalidatedAt !== null &&
          raced.invalidationReason === request.reason
        ) {
          invalidated = raced;
        } else {
          repositoryMutationConflict(error);
        }
      } else {
        repositoryMutationConflict(error);
      }
    }
    return engineInvalidateApprovalResponseSchema.parse({
      approval: mapApproval(invalidated, job, jobMaterial(job)),
      job: this.#jobDetail(job, this.#now()),
    });
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
