import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  type AcceptedCompatibilityAttestationState,
  compatibilityAttestationPayloadSha256,
  type SignedCompatibilityAttestation,
  signedCompatibilityAttestationSchema,
} from "@stx-labs/signer-sidekick-protocol/compatibility-attestation";
import { validatePrincipal } from "@stx-labs/signer-sidekick-protocol/principals";
import { z } from "zod";
import { type ChainAnchor, chainAnchorSchema } from "../chain-anchor.js";
import type {
  CompatibilityAttestationRepository,
  StoredCompatibilityAttestation,
} from "./attestation-controller.js";
import {
  assertTransactionJobTransition,
  type TransactionJobState,
  transactionJobStates,
} from "./state-machine.js";

const identifierSchema = z.string().min(1).max(500);
const uuidSchema = z.string().uuid();
const instantSchema = z.iso.datetime();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const txidSchema = z.string().regex(/^0x[0-9a-f]{64}$/);
const unsignedIntegerTextSchema = z.string().regex(/^(0|[1-9]\d*)$/);
const principalSchema = z.string().refine(validatePrincipal, "Invalid Stacks principal");
const issuerSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/);
const sqliteBatchSize = 400;

export class TransactionEngineConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransactionEngineConflictError";
  }
}

export class InFlightLogicalJobConflictError extends TransactionEngineConflictError {
  constructor(
    readonly jobId: string,
    readonly state: TransactionJobState,
  ) {
    super(`In-flight logical job ${jobId} in state ${state} cannot be superseded`);
    this.name = "InFlightLogicalJobConflictError";
  }
}

export class TransactionEngineCasError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransactionEngineCasError";
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON cannot contain non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON accepts only parsed JSON values");
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Canonical JSON accepts only parsed JSON values");
}

function canonicalDocument(value: unknown): { encoded: string; sha256: string; value: unknown } {
  const encoded = canonicalJson(value);
  return {
    encoded,
    sha256: createHash("sha256").update(encoded, "utf8").digest("hex"),
    value: JSON.parse(encoded) as unknown,
  };
}

export function transactionEngineDocumentSha256(value: unknown): string {
  return canonicalDocument(value).sha256;
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function booleanInteger(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

function requireChanges(changes: number | bigint, message: string): void {
  if (changes !== 1 && changes !== 1n) throw new TransactionEngineCasError(message);
}

const jobRowSchema = z.object({
  job_id: uuidSchema,
  idempotency_key: identifierSchema,
  operation_scope_key: identifierSchema,
  adapter_id: identifierSchema,
  adapter_revision: z.number().int().positive(),
  manager_principal: principalSchema,
  intent_sha256: sha256Schema,
  policy_sha256: sha256Schema,
  intent_json: z.string(),
  policy_json: z.string(),
  chain_anchor_json: z.string(),
  attestation_issuer: issuerSchema,
  attestation_revision: z.number().int().positive(),
  attestation_payload_sha256: sha256Schema,
  state: z.enum(transactionJobStates),
  state_version: z.number().int().nonnegative(),
  block_reason: z.string().nullable(),
  supersession_reason: z.string().nullable(),
  superseded_by_job_id: uuidSchema.nullable(),
  created_at: instantSchema,
  updated_at: instantSchema,
});

type JobRow = z.infer<typeof jobRowSchema>;

export interface StoredTransactionJob {
  jobId: string;
  idempotencyKey: string;
  operationScopeKey: string;
  adapterId: string;
  adapterRevision: number;
  managerPrincipal: string;
  intentSha256: string;
  policySha256: string;
  intent: unknown;
  policy: unknown;
  chainAnchor: ChainAnchor;
  attestation: {
    issuer: string;
    revision: number;
    payloadSha256: string;
  };
  state: TransactionJobState;
  stateVersion: number;
  blockReason: string | null;
  supersessionReason: string | null;
  supersededByJobId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLogicalJobInput {
  jobId?: string;
  idempotencyKey: string;
  operationScopeKey?: string;
  adapterId: string;
  adapterRevision: number;
  managerPrincipal: string;
  intent: unknown;
  intentSha256: string;
  policy: unknown;
  policySha256: string;
  chainAnchor: ChainAnchor;
  attestation: {
    issuer: string;
    revision: number;
    payloadSha256: string;
  };
  createdAt: string;
}

interface ParsedCreateLogicalJobInput {
  jobId: string;
  idempotencyKey: string;
  operationScopeKey: string;
  adapterId: string;
  adapterRevision: number;
  managerPrincipal: string;
  intent: ReturnType<typeof canonicalDocument>;
  policy: ReturnType<typeof canonicalDocument>;
  chainAnchor: ChainAnchor;
  chainAnchorJson: string;
  attestation: {
    issuer: string;
    revision: number;
    payloadSha256: string;
  };
  createdAt: string;
}

function parseCreateLogicalJobInput(input: CreateLogicalJobInput): ParsedCreateLogicalJobInput {
  const intent = canonicalDocument(input.intent);
  const policy = canonicalDocument(input.policy);
  const intentSha256 = sha256Schema.parse(input.intentSha256);
  const policySha256 = sha256Schema.parse(input.policySha256);
  if (intent.sha256 !== intentSha256) {
    throw new TransactionEngineConflictError("Intent hash does not match canonical intent JSON");
  }
  if (policy.sha256 !== policySha256) {
    throw new TransactionEngineConflictError("Policy hash does not match canonical policy JSON");
  }
  const chainAnchor = chainAnchorSchema.parse(input.chainAnchor);
  return {
    jobId: uuidSchema.parse(input.jobId ?? randomUUID()),
    idempotencyKey: identifierSchema.parse(input.idempotencyKey),
    operationScopeKey: identifierSchema.parse(input.operationScopeKey ?? input.idempotencyKey),
    adapterId: identifierSchema.parse(input.adapterId),
    adapterRevision: z.number().int().positive().parse(input.adapterRevision),
    managerPrincipal: principalSchema.parse(input.managerPrincipal),
    intent,
    policy,
    chainAnchor,
    chainAnchorJson: canonicalJson(chainAnchor),
    attestation: {
      issuer: issuerSchema.parse(input.attestation.issuer),
      revision: z.number().int().positive().parse(input.attestation.revision),
      payloadSha256: sha256Schema.parse(input.attestation.payloadSha256),
    },
    createdAt: instantSchema.parse(input.createdAt),
  };
}

function mapJob(row: JobRow): StoredTransactionJob {
  return {
    jobId: row.job_id,
    idempotencyKey: row.idempotency_key,
    operationScopeKey: row.operation_scope_key,
    adapterId: row.adapter_id,
    adapterRevision: row.adapter_revision,
    managerPrincipal: row.manager_principal,
    intentSha256: row.intent_sha256,
    policySha256: row.policy_sha256,
    intent: parseJson(row.intent_json),
    policy: parseJson(row.policy_json),
    chainAnchor: chainAnchorSchema.parse(parseJson(row.chain_anchor_json)),
    attestation: {
      issuer: row.attestation_issuer,
      revision: row.attestation_revision,
      payloadSha256: row.attestation_payload_sha256,
    },
    state: row.state,
    stateVersion: row.state_version,
    blockReason: row.block_reason,
    supersessionReason: row.supersession_reason,
    supersededByJobId: row.superseded_by_job_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function jobMatchesInput(row: JobRow, input: ParsedCreateLogicalJobInput): boolean {
  return (
    row.idempotency_key === input.idempotencyKey &&
    row.operation_scope_key === input.operationScopeKey &&
    row.adapter_id === input.adapterId &&
    row.adapter_revision === input.adapterRevision &&
    row.manager_principal === input.managerPrincipal &&
    row.intent_sha256 === input.intent.sha256 &&
    row.policy_sha256 === input.policy.sha256 &&
    row.intent_json === input.intent.encoded &&
    row.policy_json === input.policy.encoded &&
    row.chain_anchor_json === input.chainAnchorJson &&
    row.attestation_issuer === input.attestation.issuer &&
    row.attestation_revision === input.attestation.revision &&
    row.attestation_payload_sha256 === input.attestation.payloadSha256
  );
}

function assertAcceptedJobAttestation(db: DatabaseSync, value: ParsedCreateLogicalJobInput): void {
  const accepted = db
    .prepare(
      `SELECT revision, payload_sha256 FROM accepted_compatibility_attestations
       WHERE issuer = ?`,
    )
    .get(value.attestation.issuer) as { revision: number; payload_sha256: string } | undefined;
  if (
    accepted === undefined ||
    accepted.revision !== value.attestation.revision ||
    accepted.payload_sha256 !== value.attestation.payloadSha256
  ) {
    throw new TransactionEngineConflictError(
      "Logical job attestation is not the currently accepted issuer revision and digest",
    );
  }
}

function insertPreparedJob(db: DatabaseSync, value: ParsedCreateLogicalJobInput): JobRow {
  db.prepare(
    `INSERT INTO transaction_jobs (
      job_id, idempotency_key, operation_scope_key,
      adapter_id, adapter_revision, manager_principal,
      intent_sha256, policy_sha256, intent_json, policy_json, chain_anchor_json,
      attestation_issuer, attestation_revision, attestation_payload_sha256,
      state, state_version, block_reason, supersession_reason,
      superseded_by_job_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 0, NULL, NULL, NULL, ?, ?)`,
  ).run(
    value.jobId,
    value.idempotencyKey,
    value.operationScopeKey,
    value.adapterId,
    value.adapterRevision,
    value.managerPrincipal,
    value.intent.sha256,
    value.policy.sha256,
    value.intent.encoded,
    value.policy.encoded,
    value.chainAnchorJson,
    value.attestation.issuer,
    value.attestation.revision,
    value.attestation.payloadSha256,
    value.createdAt,
    value.createdAt,
  );
  const created = db.prepare("SELECT * FROM transaction_jobs WHERE job_id = ?").get(value.jobId);
  if (created === undefined) throw new Error("Logical job insert did not persist");
  return jobRowSchema.parse(created);
}

const approvalRowSchema = z.object({
  approval_id: uuidSchema,
  job_id: uuidSchema,
  intent_sha256: sha256Schema,
  policy_sha256: sha256Schema,
  approval_sha256: sha256Schema,
  approval_json: z.string(),
  actor: z.string().min(1),
  created_at: instantSchema,
  expires_at: instantSchema,
  invalidated_at: instantSchema.nullable(),
  invalidation_reason: z.string().nullable(),
  approval_version: z.number().int().nonnegative(),
});

export interface StoredTransactionApproval {
  approvalId: string;
  jobId: string;
  intentSha256: string;
  policySha256: string;
  approvalSha256: string;
  approval: unknown;
  actor: string;
  createdAt: string;
  expiresAt: string;
  invalidatedAt: string | null;
  invalidationReason: string | null;
  approvalVersion: number;
}

function mapApproval(input: unknown): StoredTransactionApproval {
  const row = approvalRowSchema.parse(input);
  return {
    approvalId: row.approval_id,
    jobId: row.job_id,
    intentSha256: row.intent_sha256,
    policySha256: row.policy_sha256,
    approvalSha256: row.approval_sha256,
    approval: parseJson(row.approval_json),
    actor: row.actor,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    invalidatedAt: row.invalidated_at,
    invalidationReason: row.invalidation_reason,
    approvalVersion: row.approval_version,
  };
}

const nonceReservationStates = ["reserved", "ambiguous", "resolved"] as const;
export type NonceReservationState = (typeof nonceReservationStates)[number];

const nonceRowSchema = z.object({
  reservation_id: uuidSchema,
  gas_payer_principal: principalSchema,
  job_id: uuidSchema,
  nonce: unsignedIntegerTextSchema,
  observed_account_nonce: unsignedIntegerTextSchema,
  state: z.enum(nonceReservationStates),
  state_version: z.number().int().nonnegative(),
  foreign_activity: z.union([z.literal(0), z.literal(1)]),
  created_at: instantSchema,
  updated_at: instantSchema,
  resolved_at: instantSchema.nullable(),
});

type NonceRow = z.infer<typeof nonceRowSchema>;

export interface StoredNonceReservation {
  reservationId: string;
  gasPayerPrincipal: string;
  jobId: string;
  nonce: string;
  observedAccountNonce: string;
  state: NonceReservationState;
  stateVersion: number;
  foreignActivity: boolean;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

function mapNonceReservation(input: unknown): StoredNonceReservation {
  const row = nonceRowSchema.parse(input);
  return {
    reservationId: row.reservation_id,
    gasPayerPrincipal: row.gas_payer_principal,
    jobId: row.job_id,
    nonce: row.nonce,
    observedAccountNonce: row.observed_account_nonce,
    state: row.state,
    stateVersion: row.state_version,
    foreignActivity: row.foreign_activity === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

const attemptStates = [
  "signed",
  "submitted",
  "ambiguous",
  "confirmed",
  "rejected",
  "reconciled",
] as const;
export type TransactionAttemptState = (typeof attemptStates)[number];

const attemptTransitions = {
  signed: ["submitted", "ambiguous", "rejected"],
  submitted: ["confirmed", "ambiguous", "rejected"],
  ambiguous: ["submitted", "confirmed", "rejected"],
  confirmed: ["ambiguous", "reconciled"],
  rejected: [],
  reconciled: [],
} as const satisfies Record<TransactionAttemptState, readonly TransactionAttemptState[]>;

const attemptRowSchema = z.object({
  attempt_id: uuidSchema,
  job_id: uuidSchema,
  attempt_number: z.number().int().positive(),
  nonce_reservation_id: uuidSchema,
  fee_ustx: unsignedIntegerTextSchema,
  fee_policy_revision: z.number().int().positive(),
  signed_transaction_ref: z.string().min(1),
  precomputed_txid: txidSchema,
  state: z.enum(attemptStates),
  state_version: z.number().int().nonnegative(),
  submission_result_json: z.string().nullable(),
  inclusion_record_json: z.string().nullable(),
  submitted_at: instantSchema.nullable(),
  resolved_at: instantSchema.nullable(),
  created_at: instantSchema,
  updated_at: instantSchema,
});

type AttemptRow = z.infer<typeof attemptRowSchema>;

export interface StoredTransactionAttempt {
  attemptId: string;
  jobId: string;
  attemptNumber: number;
  nonceReservationId: string;
  feeUstx: string;
  feePolicyRevision: number;
  signedTransactionRef: string;
  precomputedTxid: string;
  state: TransactionAttemptState;
  stateVersion: number;
  submissionResult: unknown | null;
  inclusion: StoredTransactionInclusion | null;
  submittedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommitApprovedSignedAttemptInput {
  attemptId?: string;
  reservationId?: string;
  jobId: string;
  expectedJobStateVersion: number;
  approvalId: string;
  expectedApprovalVersion: number;
  expectedApprovalSha256: string;
  gasPayerPrincipal: string;
  nonce: string;
  observedAccountNonce: string;
  feeUstx: string;
  feePolicyRevision: number;
  signedTransactionRef: string;
  precomputedTxid: string;
  committedAt: string;
}

export interface CommittedApprovedSignedAttempt {
  job: StoredTransactionJob;
  reservation: StoredNonceReservation;
  attempt: StoredTransactionAttempt;
  created: boolean;
}

export const transactionExecutionStatuses = [
  "success",
  "abort_by_response",
  "abort_by_post_condition",
] as const;
export type TransactionExecutionStatus = (typeof transactionExecutionStatuses)[number];

const transactionInclusionSchema = z
  .object({
    schemaVersion: z.literal(1),
    txid: txidSchema,
    executionStatus: z.enum(transactionExecutionStatuses),
    stacksBlockHeight: z.number().int().nonnegative().safe(),
    blockHash: txidSchema,
    indexBlockHash: txidSchema,
    canonical: z.boolean(),
    observedAt: instantSchema,
  })
  .strict();

export type StoredTransactionInclusion = z.infer<typeof transactionInclusionSchema>;

function mapAttemptRow(row: AttemptRow): StoredTransactionAttempt {
  return {
    attemptId: row.attempt_id,
    jobId: row.job_id,
    attemptNumber: row.attempt_number,
    nonceReservationId: row.nonce_reservation_id,
    feeUstx: row.fee_ustx,
    feePolicyRevision: row.fee_policy_revision,
    signedTransactionRef: row.signed_transaction_ref,
    precomputedTxid: row.precomputed_txid,
    state: row.state,
    stateVersion: row.state_version,
    submissionResult:
      row.submission_result_json === null ? null : parseJson(row.submission_result_json),
    inclusion:
      row.inclusion_record_json === null
        ? null
        : transactionInclusionSchema.parse(parseJson(row.inclusion_record_json)),
    submittedAt: row.submitted_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const reconciliationOutcomes = [
  "pending",
  "satisfied",
  "not_satisfied",
  "external_success",
  "noncanonical",
  "ambiguous",
  "blocked",
] as const;

export type ReconciliationOutcome = (typeof reconciliationOutcomes)[number];

const observationRowSchema = z.object({
  observation_id: uuidSchema,
  job_id: uuidSchema,
  predicate_sha256: sha256Schema,
  predicate_json: z.string(),
  chain_anchor_json: z.string(),
  authoritative: z.union([z.literal(0), z.literal(1)]),
  canonical: z.union([z.literal(0), z.literal(1)]),
  finality_depth: z.number().int().nonnegative(),
  outcome: z.enum(reconciliationOutcomes),
  effect_remaining: z.union([z.literal(0), z.literal(1)]),
  reason: z.string().nullable(),
  observed_at: instantSchema,
});

export interface StoredReconciliationObservation {
  observationId: string;
  jobId: string;
  predicateSha256: string;
  predicate: unknown;
  chainAnchor: ChainAnchor;
  authoritative: boolean;
  canonical: boolean;
  finalityDepth: number;
  outcome: ReconciliationOutcome;
  effectRemaining: boolean;
  reason: string | null;
  observedAt: string;
}

function mapObservation(input: unknown): StoredReconciliationObservation {
  const row = observationRowSchema.parse(input);
  return {
    observationId: row.observation_id,
    jobId: row.job_id,
    predicateSha256: row.predicate_sha256,
    predicate: parseJson(row.predicate_json),
    chainAnchor: chainAnchorSchema.parse(parseJson(row.chain_anchor_json)),
    authoritative: row.authoritative === 1,
    canonical: row.canonical === 1,
    finalityDepth: row.finality_depth,
    outcome: row.outcome,
    effectRemaining: row.effect_remaining === 1,
    reason: row.reason,
    observedAt: row.observed_at,
  };
}

const attestationRowSchema = z.object({
  issuer: issuerSchema,
  revision: z.number().int().positive(),
  payload_sha256: sha256Schema,
  verified_at: instantSchema,
  document_json: z.string(),
  accepted_at: instantSchema,
  row_version: z.number().int().nonnegative(),
});

const forceObserveRowSchema = z.object({
  singleton_id: z.literal(1),
  reason: z.string().min(1).max(1_000),
  actor: z.string().min(1).max(500),
  forced_at: instantSchema,
});

const disabledAdapterRowSchema = z.object({
  adapter_id: identifierSchema,
  reason: z.string().min(1).max(1_000),
  actor: z.string().min(1).max(500),
  disabled_at: instantSchema,
});

export interface StoredForceObserveControl {
  active: true;
  reason: string;
  actor: string;
  forcedAt: string;
}

export interface StoredDisabledAdapterControl {
  adapterId: string;
  disabled: true;
  reason: string;
  actor: string;
  disabledAt: string;
}

export interface LogicalJobListOptions {
  limit?: number;
  cursor?: string;
  adapterId?: string;
  managerPrincipal?: string;
  states?: readonly TransactionJobState[];
}

export interface LogicalJobPage {
  items: StoredTransactionJob[];
  nextCursor: string | null;
  total: number;
}

export interface LogicalJobStats {
  total: number;
  active: number;
  awaitingApproval: number;
  ambiguous: number;
}

const jobCursorSchema = z
  .object({
    version: z.literal(1),
    createdAt: instantSchema,
    jobId: uuidSchema,
    filterSha256: sha256Schema,
  })
  .strict();

type AttestationRow = z.infer<typeof attestationRowSchema>;

function authorityControlReason(db: DatabaseSync, adapterId: string): string | null {
  const forced = db.prepare("SELECT 1 AS active FROM engine_force_observe_control").get();
  if (forced !== undefined) return "Engine is irreversibly forced to Observe mode";
  const disabled = db
    .prepare("SELECT 1 AS disabled FROM engine_adapter_disable_controls WHERE adapter_id = ?")
    .get(adapterId);
  return disabled === undefined ? null : `Adapter ${adapterId} is irreversibly disabled`;
}

function encodeJobCursor(value: z.infer<typeof jobCursorSchema>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeJobCursor(cursor: string, filterSha256: string): z.infer<typeof jobCursorSchema> {
  const encoded = z.string().min(1).max(2_000).parse(cursor);
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new TransactionEngineConflictError("Logical job cursor is invalid");
  }
  const value = jobCursorSchema.parse(decoded);
  if (value.filterSha256 !== filterSha256) {
    throw new TransactionEngineConflictError("Logical job cursor does not match its filters");
  }
  return value;
}

function acceptedStateMatches(
  row: AttestationRow,
  expected: AcceptedCompatibilityAttestationState,
): boolean {
  return (
    row.issuer === expected.issuer &&
    row.revision === expected.revision &&
    row.payload_sha256 === expected.payloadSha256 &&
    row.verified_at === expected.verifiedAt
  );
}

export class TransactionEngineRepository implements CompatibilityAttestationRepository {
  constructor(private readonly db: DatabaseSync) {}

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private jobRow(jobId: string): JobRow | null {
    const row = this.db
      .prepare("SELECT * FROM transaction_jobs WHERE job_id = ?")
      .get(uuidSchema.parse(jobId));
    return row === undefined ? null : jobRowSchema.parse(row);
  }

  getLogicalJob(jobId: string): StoredTransactionJob | null {
    const row = this.jobRow(jobId);
    return row === null ? null : mapJob(row);
  }

  getLogicalJobByTxid(txid: string): StoredTransactionJob | null {
    const row = this.db
      .prepare(
        `SELECT transaction_jobs.* FROM transaction_jobs
         INNER JOIN transaction_attempts
           ON transaction_attempts.job_id = transaction_jobs.job_id
         WHERE transaction_attempts.precomputed_txid = ?
         LIMIT 1`,
      )
      .get(txidSchema.parse(txid));
    return row === undefined ? null : mapJob(jobRowSchema.parse(row));
  }

  getLogicalJobSupersededBy(jobId: string): StoredTransactionJob | null {
    const row = this.db
      .prepare(
        `SELECT * FROM transaction_jobs WHERE superseded_by_job_id = ?
         ORDER BY updated_at DESC, job_id ASC LIMIT 1`,
      )
      .get(uuidSchema.parse(jobId));
    return row === undefined ? null : mapJob(jobRowSchema.parse(row));
  }

  getActiveLogicalJob(idempotencyKey: string): StoredTransactionJob | null {
    const row = this.db
      .prepare(
        `SELECT * FROM transaction_jobs
         WHERE idempotency_key = ? AND state NOT IN ('reconciled', 'superseded')`,
      )
      .get(identifierSchema.parse(idempotencyKey));
    return row === undefined ? null : mapJob(jobRowSchema.parse(row));
  }

  getActiveLogicalJobForScope(operationScopeKey: string): StoredTransactionJob | null {
    const row = this.db
      .prepare(
        `SELECT * FROM transaction_jobs
         WHERE operation_scope_key = ? AND state NOT IN ('reconciled', 'superseded')`,
      )
      .get(identifierSchema.parse(operationScopeKey));
    return row === undefined ? null : mapJob(jobRowSchema.parse(row));
  }

  getLatestLogicalJobForScope(operationScopeKey: string): StoredTransactionJob | null {
    const row = this.db
      .prepare(
        `SELECT * FROM transaction_jobs WHERE operation_scope_key = ?
         ORDER BY created_at DESC, job_id DESC LIMIT 1`,
      )
      .get(identifierSchema.parse(operationScopeKey));
    return row === undefined ? null : mapJob(jobRowSchema.parse(row));
  }

  listLogicalJobs(options: LogicalJobListOptions = {}): LogicalJobPage {
    const limit = z
      .number()
      .int()
      .min(1)
      .max(200)
      .parse(options.limit ?? 50);
    const adapterId =
      options.adapterId === undefined ? null : identifierSchema.parse(options.adapterId);
    const managerPrincipal =
      options.managerPrincipal === undefined
        ? null
        : principalSchema.parse(options.managerPrincipal);
    const states = Array.from(
      new Set((options.states ?? []).map((state) => z.enum(transactionJobStates).parse(state))),
    ).sort();
    const filterSha256 = transactionEngineDocumentSha256({
      adapterId,
      managerPrincipal,
      states,
    });
    const cursor =
      options.cursor === undefined ? null : decodeJobCursor(options.cursor, filterSha256);
    const conditions: string[] = [];
    const filterParameters: SQLInputValue[] = [];
    if (adapterId !== null) {
      conditions.push("adapter_id = ?");
      filterParameters.push(adapterId);
    }
    if (managerPrincipal !== null) {
      conditions.push("manager_principal = ?");
      filterParameters.push(managerPrincipal);
    }
    if (states.length > 0) {
      conditions.push(`state IN (${states.map(() => "?").join(", ")})`);
      filterParameters.push(...states);
    }
    const baseWhere = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const totalValue = this.db
      .prepare(`SELECT count(*) AS count FROM transaction_jobs ${baseWhere}`)
      .get(...filterParameters);
    const total = z.object({ count: z.number().int().nonnegative() }).parse(totalValue).count;

    const pageConditions = [...conditions];
    const pageParameters = [...filterParameters];
    if (cursor !== null) {
      pageConditions.push("(created_at < ? OR (created_at = ? AND job_id < ?))");
      pageParameters.push(cursor.createdAt, cursor.createdAt, cursor.jobId);
    }
    const pageWhere = pageConditions.length === 0 ? "" : `WHERE ${pageConditions.join(" AND ")}`;
    const rows = this.db
      .prepare(
        `SELECT * FROM transaction_jobs ${pageWhere}
         ORDER BY created_at DESC, job_id DESC LIMIT ?`,
      )
      .all(...pageParameters, limit + 1)
      .map((row) => jobRowSchema.parse(row));
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(mapJob),
      nextCursor:
        hasMore && last !== undefined
          ? encodeJobCursor({
              version: 1,
              createdAt: last.created_at,
              jobId: last.job_id,
              filterSha256,
            })
          : null,
      total,
    };
  }

  logicalJobStats(): LogicalJobStats {
    const row = this.db
      .prepare(
        `SELECT
          count(*) AS total,
          COALESCE(sum(CASE WHEN state NOT IN ('reconciled', 'superseded') THEN 1 ELSE 0 END), 0)
            AS active,
          COALESCE(sum(CASE WHEN state = 'awaiting_approval' THEN 1 ELSE 0 END), 0)
            AS awaiting_approval,
          COALESCE(sum(CASE WHEN state = 'ambiguous' THEN 1 ELSE 0 END), 0)
            AS ambiguous
         FROM transaction_jobs`,
      )
      .get();
    const value = z
      .object({
        total: z.number().int().nonnegative(),
        active: z.number().int().nonnegative(),
        awaiting_approval: z.number().int().nonnegative(),
        ambiguous: z.number().int().nonnegative(),
      })
      .parse(row);
    return {
      total: value.total,
      active: value.active,
      awaitingApproval: value.awaiting_approval,
      ambiguous: value.ambiguous,
    };
  }

  createLogicalJob(input: CreateLogicalJobInput): { job: StoredTransactionJob; created: boolean } {
    const value = parseCreateLogicalJobInput(input);
    return this.transaction(() => {
      assertAcceptedJobAttestation(this.db, value);

      const existingRow = this.db
        .prepare(
          `SELECT * FROM transaction_jobs
           WHERE idempotency_key = ? AND state <> 'superseded'
           ORDER BY created_at DESC, job_id DESC LIMIT 1`,
        )
        .get(value.idempotencyKey);
      if (existingRow !== undefined) {
        const existing = jobRowSchema.parse(existingRow);
        if (jobMatchesInput(existing, value)) return { job: mapJob(existing), created: false };
        throw new TransactionEngineConflictError(
          `Checkpoint ${value.idempotencyKey} already has different durable work`,
        );
      }

      const created = insertPreparedJob(this.db, value);
      return { job: mapJob(created), created: true };
    });
  }

  createOrSupersedeLogicalJob(
    input: CreateLogicalJobInput,
    options: { changedAt: string; reason: string },
  ): { job: StoredTransactionJob; created: boolean; supersededJobId: string | null } {
    const value = parseCreateLogicalJobInput(input);
    const changedAt = instantSchema.parse(options.changedAt);
    const reason = z.string().min(1).max(2_000).parse(options.reason);
    return this.transaction(() => {
      assertAcceptedJobAttestation(this.db, value);
      const sameIdempotency = this.db
        .prepare(
          `SELECT * FROM transaction_jobs
           WHERE idempotency_key = ? AND state <> 'superseded'
           ORDER BY created_at DESC, job_id DESC LIMIT 1`,
        )
        .get(value.idempotencyKey);
      if (sameIdempotency !== undefined) {
        const existing = jobRowSchema.parse(sameIdempotency);
        if (jobMatchesInput(existing, value)) {
          return { job: mapJob(existing), created: false, supersededJobId: null };
        }
        throw new TransactionEngineConflictError(
          `Checkpoint ${value.idempotencyKey} already has different durable work`,
        );
      }

      const activeValue = this.db
        .prepare(
          `SELECT * FROM transaction_jobs
           WHERE operation_scope_key = ? AND state NOT IN ('reconciled', 'superseded')`,
        )
        .get(value.operationScopeKey);
      const active = activeValue === undefined ? null : jobRowSchema.parse(activeValue);
      if (active !== null) {
        const activeAnchor = chainAnchorSchema.parse(parseJson(active.chain_anchor_json));
        if (
          value.chainAnchor.stacksBlockHeight < activeAnchor.stacksBlockHeight ||
          value.chainAnchor.burnBlockHeight < activeAnchor.burnBlockHeight
        ) {
          throw new TransactionEngineConflictError(
            "Older chain facts cannot supersede the active logical job",
          );
        }
        if (
          !(
            [
              "prepared",
              "preflighted",
              "awaiting_approval",
              "blocked",
              "noncanonical_reobserve",
            ] as TransactionJobState[]
          ).includes(active.state)
        ) {
          throw new InFlightLogicalJobConflictError(active.job_id, active.state);
        }
        assertTransactionJobTransition(active.state, "superseded");
        const superseded = this.db
          .prepare(
            `UPDATE transaction_jobs SET
              state = 'superseded', state_version = state_version + 1,
              block_reason = NULL, supersession_reason = ?,
              superseded_by_job_id = NULL, updated_at = ?
             WHERE job_id = ? AND state = ? AND state_version = ?`,
          )
          .run(reason, changedAt, active.job_id, active.state, active.state_version);
        requireChanges(superseded.changes, "Logical job supersession compare-and-swap failed");
        this.db
          .prepare(
            `UPDATE transaction_approvals SET
              invalidated_at = ?, invalidation_reason = ?, approval_version = approval_version + 1
             WHERE job_id = ? AND invalidated_at IS NULL`,
          )
          .run(changedAt, `job-superseded:${reason}`, active.job_id);
      }

      const created = insertPreparedJob(this.db, value);
      if (active !== null) {
        const related = this.db
          .prepare(
            `UPDATE transaction_jobs SET superseded_by_job_id = ?
             WHERE job_id = ? AND state = 'superseded'`,
          )
          .run(created.job_id, active.job_id);
        requireChanges(related.changes, "Logical job supersession relationship update failed");
      }
      return {
        job: mapJob(created),
        created: true,
        supersededJobId: active?.job_id ?? null,
      };
    });
  }

  transitionLogicalJob(input: {
    jobId: string;
    expectedState: TransactionJobState;
    expectedStateVersion: number;
    nextState: TransactionJobState;
    changedAt: string;
    blockReason?: string;
    supersessionReason?: string;
    supersededByJobId?: string;
  }): StoredTransactionJob {
    const jobId = uuidSchema.parse(input.jobId);
    const expectedState = z.enum(transactionJobStates).parse(input.expectedState);
    const expectedStateVersion = z.number().int().nonnegative().parse(input.expectedStateVersion);
    const nextState = z.enum(transactionJobStates).parse(input.nextState);
    const changedAt = instantSchema.parse(input.changedAt);
    assertTransactionJobTransition(expectedState, nextState);
    const blockReason =
      nextState === "blocked" ? z.string().min(1).max(2_000).parse(input.blockReason) : null;
    const supersessionReason =
      nextState === "superseded"
        ? z.string().min(1).max(2_000).parse(input.supersessionReason)
        : null;
    const supersededByJobId =
      nextState === "superseded" && input.supersededByJobId !== undefined
        ? uuidSchema.parse(input.supersededByJobId)
        : null;
    if (supersededByJobId === jobId) {
      throw new TransactionEngineConflictError("A logical job cannot supersede itself");
    }
    if (expectedState === "awaiting_approval" && nextState === "nonce_reserved") {
      throw new TransactionEngineConflictError(
        "Nonce ownership requires an atomic approved signed-attempt commitment",
      );
    }

    return this.transaction(() => {
      const existing = this.jobRow(jobId);
      if (
        existing === null ||
        existing.state !== expectedState ||
        existing.state_version !== expectedStateVersion
      ) {
        throw new TransactionEngineCasError("Logical job state/version compare-and-swap failed");
      }
      if (["awaiting_approval", "nonce_reserved", "broadcast"].includes(nextState)) {
        const controlReason = authorityControlReason(this.db, existing.adapter_id);
        if (controlReason !== null) throw new TransactionEngineConflictError(controlReason);
      }
      if (supersededByJobId !== null && this.jobRow(supersededByJobId) === null) {
        throw new TransactionEngineConflictError("Superseding logical job does not exist");
      }
      const result = this.db
        .prepare(
          `UPDATE transaction_jobs SET
            state = ?, state_version = state_version + 1, block_reason = ?,
            supersession_reason = ?, superseded_by_job_id = ?, updated_at = ?
           WHERE job_id = ? AND state = ? AND state_version = ?`,
        )
        .run(
          nextState,
          blockReason,
          supersessionReason,
          supersededByJobId,
          changedAt,
          jobId,
          expectedState,
          expectedStateVersion,
        );
      requireChanges(result.changes, "Logical job state/version compare-and-swap failed");

      if (
        [
          "prepared",
          "confirmed",
          "blocked",
          "superseded",
          "reconciled",
          "noncanonical_reobserve",
        ].includes(nextState)
      ) {
        this.db
          .prepare(
            `UPDATE transaction_approvals SET
              invalidated_at = ?, invalidation_reason = ?, approval_version = approval_version + 1
             WHERE job_id = ? AND invalidated_at IS NULL`,
          )
          .run(changedAt, `job-transition:${nextState}`, jobId);
      }
      const updated = this.jobRow(jobId);
      if (updated === null) throw new Error("Logical job disappeared after transition");
      return mapJob(updated);
    });
  }

  createApproval(input: {
    approvalId?: string;
    jobId: string;
    expectedJobStateVersion: number;
    intentSha256: string;
    policySha256: string;
    approval: unknown;
    approvalSha256: string;
    actor: string;
    createdAt: string;
    expiresAt: string;
  }): { approval: StoredTransactionApproval; created: boolean } {
    const approvalId = uuidSchema.parse(input.approvalId ?? randomUUID());
    const jobId = uuidSchema.parse(input.jobId);
    const expectedVersion = z.number().int().nonnegative().parse(input.expectedJobStateVersion);
    const intentSha256 = sha256Schema.parse(input.intentSha256);
    const policySha256 = sha256Schema.parse(input.policySha256);
    const approval = canonicalDocument(input.approval);
    if (approval.sha256 !== sha256Schema.parse(input.approvalSha256)) {
      throw new TransactionEngineConflictError(
        "Approval hash does not match canonical approval JSON",
      );
    }
    const actor = z.string().min(1).max(500).parse(input.actor);
    const createdAt = instantSchema.parse(input.createdAt);
    const expiresAt = instantSchema.parse(input.expiresAt);
    if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
      throw new TransactionEngineConflictError("Approval expiry must be after creation time");
    }

    return this.transaction(() => {
      const job = this.jobRow(jobId);
      if (
        job === null ||
        job.state !== "awaiting_approval" ||
        job.state_version !== expectedVersion
      ) {
        throw new TransactionEngineCasError(
          "Approval logical job state/version compare-and-swap failed",
        );
      }
      const controlReason = authorityControlReason(this.db, job.adapter_id);
      if (controlReason !== null) throw new TransactionEngineConflictError(controlReason);
      if (job.intent_sha256 !== intentSha256 || job.policy_sha256 !== policySha256) {
        throw new TransactionEngineConflictError(
          "Approval does not bind the logical job intent and policy hashes",
        );
      }
      const active = this.db
        .prepare("SELECT * FROM transaction_approvals WHERE job_id = ? AND invalidated_at IS NULL")
        .get(jobId);
      if (active !== undefined) {
        const existing = approvalRowSchema.parse(active);
        if (
          existing.intent_sha256 === intentSha256 &&
          existing.policy_sha256 === policySha256 &&
          existing.approval_sha256 === approval.sha256 &&
          existing.approval_json === approval.encoded &&
          existing.actor === actor &&
          existing.created_at === createdAt &&
          existing.expires_at === expiresAt
        ) {
          return { approval: mapApproval(existing), created: false };
        }
        throw new TransactionEngineConflictError("Logical job already has an active approval");
      }
      this.db
        .prepare(
          `INSERT INTO transaction_approvals (
            approval_id, job_id, intent_sha256, policy_sha256, approval_sha256,
            approval_json, actor, created_at, expires_at, invalidated_at,
            invalidation_reason, approval_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0)`,
        )
        .run(
          approvalId,
          jobId,
          intentSha256,
          policySha256,
          approval.sha256,
          approval.encoded,
          actor,
          createdAt,
          expiresAt,
        );
      const created = this.db
        .prepare("SELECT * FROM transaction_approvals WHERE approval_id = ?")
        .get(approvalId);
      if (created === undefined) throw new Error("Approval insert did not persist");
      return { approval: mapApproval(created), created: true };
    });
  }

  getActiveApproval(jobId: string, at?: string): StoredTransactionApproval | null {
    const parsedJobId = uuidSchema.parse(jobId);
    const parsedAt = at === undefined ? undefined : instantSchema.parse(at);
    const row =
      parsedAt === undefined
        ? this.db
            .prepare(
              "SELECT * FROM transaction_approvals WHERE job_id = ? AND invalidated_at IS NULL",
            )
            .get(parsedJobId)
        : this.db
            .prepare(
              `SELECT * FROM transaction_approvals
               WHERE job_id = ? AND invalidated_at IS NULL AND expires_at > ?`,
            )
            .get(parsedJobId, parsedAt);
    return row === undefined ? null : mapApproval(row);
  }

  getLatestApproval(jobId: string): StoredTransactionApproval | null {
    const row = this.db
      .prepare(
        `SELECT * FROM transaction_approvals WHERE job_id = ?
         ORDER BY created_at DESC, approval_id DESC LIMIT 1`,
      )
      .get(uuidSchema.parse(jobId));
    return row === undefined ? null : mapApproval(row);
  }

  invalidateApproval(input: {
    approvalId: string;
    expectedApprovalVersion: number;
    reason: string;
    invalidatedAt: string;
  }): StoredTransactionApproval {
    const approvalId = uuidSchema.parse(input.approvalId);
    const expectedVersion = z.number().int().nonnegative().parse(input.expectedApprovalVersion);
    const reason = z.string().min(1).max(2_000).parse(input.reason);
    const invalidatedAt = instantSchema.parse(input.invalidatedAt);
    return this.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE transaction_approvals SET
            invalidated_at = ?, invalidation_reason = ?, approval_version = approval_version + 1
           WHERE approval_id = ? AND approval_version = ? AND invalidated_at IS NULL`,
        )
        .run(invalidatedAt, reason, approvalId, expectedVersion);
      requireChanges(result.changes, "Approval version compare-and-swap failed");
      const row = this.db
        .prepare("SELECT * FROM transaction_approvals WHERE approval_id = ?")
        .get(approvalId);
      if (row === undefined) throw new Error("Approval disappeared after invalidation");
      return mapApproval(row);
    });
  }

  getNonceReservation(reservationId: string): StoredNonceReservation | null {
    const row = this.db
      .prepare("SELECT * FROM gas_payer_nonce_reservations WHERE reservation_id = ?")
      .get(uuidSchema.parse(reservationId));
    return row === undefined ? null : mapNonceReservation(row);
  }

  getNonceReservationForJob(jobId: string): StoredNonceReservation | null {
    const row = this.db
      .prepare(
        `SELECT * FROM gas_payer_nonce_reservations WHERE job_id = ?
         ORDER BY created_at DESC, reservation_id DESC LIMIT 1`,
      )
      .get(uuidSchema.parse(jobId));
    return row === undefined ? null : mapNonceReservation(row);
  }

  transitionNonceReservation(input: {
    reservationId: string;
    expectedState: Exclude<NonceReservationState, "resolved">;
    expectedStateVersion: number;
    nextState: NonceReservationState;
    foreignActivity: boolean;
    changedAt: string;
  }): StoredNonceReservation {
    const reservationId = uuidSchema.parse(input.reservationId);
    const expectedState = z.enum(["reserved", "ambiguous"]).parse(input.expectedState);
    const expectedVersion = z.number().int().nonnegative().parse(input.expectedStateVersion);
    const nextState = z.enum(nonceReservationStates).parse(input.nextState);
    if (
      (expectedState === "reserved" && !["ambiguous", "resolved"].includes(nextState)) ||
      (expectedState === "ambiguous" &&
        nextState !== "resolved" &&
        !(nextState === "ambiguous" && input.foreignActivity))
    ) {
      throw new TransactionEngineConflictError(
        `Nonce reservation cannot transition from ${expectedState} to ${nextState}`,
      );
    }
    const changedAt = instantSchema.parse(input.changedAt);
    return this.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE gas_payer_nonce_reservations SET
            state = ?, state_version = state_version + 1, foreign_activity = ?,
            updated_at = ?, resolved_at = ?
           WHERE reservation_id = ? AND state = ? AND state_version = ?`,
        )
        .run(
          nextState,
          booleanInteger(input.foreignActivity),
          changedAt,
          nextState === "resolved" ? changedAt : null,
          reservationId,
          expectedState,
          expectedVersion,
        );
      requireChanges(result.changes, "Nonce reservation state/version compare-and-swap failed");
      const row = this.db
        .prepare("SELECT * FROM gas_payer_nonce_reservations WHERE reservation_id = ?")
        .get(reservationId);
      if (row === undefined) throw new Error("Nonce reservation disappeared after transition");
      return mapNonceReservation(row);
    });
  }

  commitApprovedSignedAttempt(
    input: CommitApprovedSignedAttemptInput,
  ): CommittedApprovedSignedAttempt {
    const attemptId = uuidSchema.parse(input.attemptId ?? randomUUID());
    const reservationId = uuidSchema.parse(input.reservationId ?? randomUUID());
    const jobId = uuidSchema.parse(input.jobId);
    const expectedJobVersion = z.number().int().nonnegative().parse(input.expectedJobStateVersion);
    const approvalId = uuidSchema.parse(input.approvalId);
    const expectedApprovalVersion = z
      .number()
      .int()
      .nonnegative()
      .parse(input.expectedApprovalVersion);
    const expectedApprovalSha256 = sha256Schema.parse(input.expectedApprovalSha256);
    const gasPayer = principalSchema.parse(input.gasPayerPrincipal);
    const nonce = unsignedIntegerTextSchema.parse(input.nonce);
    const observedAccountNonce = unsignedIntegerTextSchema.parse(input.observedAccountNonce);
    const feeUstx = unsignedIntegerTextSchema.parse(input.feeUstx);
    const feePolicyRevision = z.number().int().positive().parse(input.feePolicyRevision);
    const signedTransactionRef = z.string().min(1).max(10_000).parse(input.signedTransactionRef);
    const txid = txidSchema.parse(input.precomputedTxid);
    const committedAt = instantSchema.parse(input.committedAt);

    return this.transaction(() => {
      // An exact persisted txid is a prior durable fact, not fresh authority. Return it without
      // reauthorizing or mutating anything so callers can only enter the no-rebroadcast path.
      const exactTxid = this.db
        .prepare("SELECT * FROM transaction_attempts WHERE precomputed_txid = ?")
        .get(txid);
      if (exactTxid !== undefined) {
        const existing = attemptRowSchema.parse(exactTxid);
        const existingReservationRow = this.db
          .prepare("SELECT * FROM gas_payer_nonce_reservations WHERE reservation_id = ?")
          .get(existing.nonce_reservation_id);
        const existingJob = this.jobRow(existing.job_id);
        if (existingReservationRow === undefined || existingJob === null) {
          throw new Error("Persisted signed attempt has incomplete durable bindings");
        }
        const existingReservation = nonceRowSchema.parse(existingReservationRow);
        if (
          existing.job_id !== jobId ||
          existing.fee_ustx !== feeUstx ||
          existing.fee_policy_revision !== feePolicyRevision ||
          existing.signed_transaction_ref !== signedTransactionRef ||
          existingReservation.job_id !== jobId ||
          existingReservation.gas_payer_principal !== gasPayer ||
          existingReservation.nonce !== nonce ||
          existingReservation.observed_account_nonce !== observedAccountNonce
        ) {
          throw new TransactionEngineConflictError(
            "Precomputed txid already binds another signed commitment",
          );
        }
        return {
          job: mapJob(existingJob),
          reservation: mapNonceReservation(existingReservation),
          attempt: mapAttemptRow(existing),
          created: false,
        };
      }

      let job = this.jobRow(jobId);
      if (
        job === null ||
        !(job.state === "awaiting_approval" || job.state === "nonce_reserved") ||
        job.state_version !== expectedJobVersion
      ) {
        throw new TransactionEngineCasError(
          "Signed commitment logical job state/version compare-and-swap failed",
        );
      }
      const controlReason = authorityControlReason(this.db, job.adapter_id);
      if (controlReason !== null) throw new TransactionEngineConflictError(controlReason);

      const approvalRow = this.db
        .prepare(
          `SELECT * FROM transaction_approvals
           WHERE approval_id = ? AND job_id = ? AND approval_version = ?
             AND invalidated_at IS NULL AND expires_at > ?`,
        )
        .get(approvalId, jobId, expectedApprovalVersion, committedAt);
      if (approvalRow === undefined) {
        throw new TransactionEngineConflictError(
          "Signed commitment requires the exact active unexpired approval",
        );
      }
      const approval = approvalRowSchema.parse(approvalRow);
      if (
        approval.approval_sha256 !== expectedApprovalSha256 ||
        approval.intent_sha256 !== job.intent_sha256 ||
        approval.policy_sha256 !== job.policy_sha256
      ) {
        throw new TransactionEngineConflictError(
          "Signed commitment approval does not exactly bind the logical job",
        );
      }

      if (job.state === "awaiting_approval") {
        const transitioned = this.db
          .prepare(
            `UPDATE transaction_jobs SET
              state = 'nonce_reserved', state_version = state_version + 1, updated_at = ?
             WHERE job_id = ? AND state = 'awaiting_approval' AND state_version = ?`,
          )
          .run(committedAt, jobId, expectedJobVersion);
        requireChanges(
          transitioned.changes,
          "Signed commitment logical job state/version compare-and-swap failed",
        );
        job = this.jobRow(jobId);
        if (job === null) throw new Error("Logical job disappeared during signed commitment");
      }

      const jobReservationRow = this.db
        .prepare(
          `SELECT * FROM gas_payer_nonce_reservations
           WHERE job_id = ? AND resolved_at IS NULL
           ORDER BY created_at DESC, reservation_id DESC LIMIT 1`,
        )
        .get(jobId);
      let reservation: NonceRow;
      if (jobReservationRow !== undefined) {
        reservation = nonceRowSchema.parse(jobReservationRow);
        if (
          reservation.gas_payer_principal !== gasPayer ||
          reservation.nonce !== nonce ||
          reservation.observed_account_nonce !== observedAccountNonce
        ) {
          throw new TransactionEngineConflictError(
            "Existing job nonce reservation does not match the signed commitment",
          );
        }
      } else {
        const unresolved = this.db
          .prepare(
            `SELECT * FROM gas_payer_nonce_reservations
             WHERE gas_payer_principal = ? AND resolved_at IS NULL`,
          )
          .get(gasPayer);
        if (unresolved !== undefined) {
          throw new TransactionEngineConflictError(
            "Gas payer already has an unresolved nonce reservation",
          );
        }
        this.db
          .prepare(
            `INSERT INTO gas_payer_nonce_reservations (
              reservation_id, gas_payer_principal, job_id, nonce, observed_account_nonce,
              state, state_version, foreign_activity, created_at, updated_at, resolved_at
            ) VALUES (?, ?, ?, ?, ?, 'reserved', 0, 0, ?, ?, NULL)`,
          )
          .run(
            reservationId,
            gasPayer,
            jobId,
            nonce,
            observedAccountNonce,
            committedAt,
            committedAt,
          );
        const createdReservation = this.db
          .prepare("SELECT * FROM gas_payer_nonce_reservations WHERE reservation_id = ?")
          .get(reservationId);
        if (createdReservation === undefined) {
          throw new Error("Nonce reservation insert did not persist");
        }
        reservation = nonceRowSchema.parse(createdReservation);
      }

      const existingForJob = this.db
        .prepare("SELECT attempt_id FROM transaction_attempts WHERE job_id = ?")
        .get(jobId);
      if (existingForJob !== undefined) {
        throw new TransactionEngineConflictError(
          "V1 permits only one signed transaction attempt per logical job",
        );
      }

      this.db
        .prepare(
          `INSERT INTO transaction_attempts (
            attempt_id, job_id, attempt_number, nonce_reservation_id, fee_ustx,
            fee_policy_revision, signed_transaction_ref, precomputed_txid,
            state, state_version, submission_result_json, inclusion_record_json,
            submitted_at, resolved_at, created_at, updated_at
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'signed', 0, NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          attemptId,
          jobId,
          reservation.reservation_id,
          feeUstx,
          feePolicyRevision,
          signedTransactionRef,
          txid,
          committedAt,
          committedAt,
        );
      const created = this.db
        .prepare("SELECT * FROM transaction_attempts WHERE attempt_id = ?")
        .get(attemptId);
      if (created === undefined) throw new Error("Signed attempt insert did not persist");
      return {
        job: mapJob(job),
        reservation: mapNonceReservation(reservation),
        attempt: mapAttemptRow(attemptRowSchema.parse(created)),
        created: true,
      };
    });
  }

  getAttempt(attemptId: string): StoredTransactionAttempt | null {
    const row = this.db
      .prepare("SELECT * FROM transaction_attempts WHERE attempt_id = ?")
      .get(uuidSchema.parse(attemptId));
    return row === undefined ? null : mapAttemptRow(attemptRowSchema.parse(row));
  }

  listAttempts(jobId: string): StoredTransactionAttempt[] {
    return this.db
      .prepare("SELECT * FROM transaction_attempts WHERE job_id = ? ORDER BY attempt_number")
      .all(uuidSchema.parse(jobId))
      .map((row) => mapAttemptRow(attemptRowSchema.parse(row)));
  }

  /** Returns attempts grouped by job without issuing one query per Activity record. */
  listAttemptsForActivity(jobIds: readonly string[]): Map<string, StoredTransactionAttempt[]> {
    const ids = [...new Set(jobIds.map((jobId) => uuidSchema.parse(jobId)))];
    const attempts = new Map<string, StoredTransactionAttempt[]>();
    for (let offset = 0; offset < ids.length; offset += sqliteBatchSize) {
      const batch = ids.slice(offset, offset + sqliteBatchSize);
      if (batch.length === 0) continue;
      const placeholders = batch.map(() => "?").join(", ");
      const rows = this.db
        .prepare(
          `SELECT * FROM transaction_attempts
           WHERE job_id IN (${placeholders})
           ORDER BY job_id ASC, attempt_number ASC`,
        )
        .all(...batch);
      for (const row of rows) {
        const attempt = mapAttemptRow(attemptRowSchema.parse(row));
        const values = attempts.get(attempt.jobId) ?? [];
        values.push(attempt);
        attempts.set(attempt.jobId, values);
      }
    }
    return attempts;
  }

  transitionAttempt(input: {
    attemptId: string;
    expectedState: TransactionAttemptState;
    expectedStateVersion: number;
    nextState: TransactionAttemptState;
    changedAt: string;
    submissionResult?: unknown;
    inclusion?: StoredTransactionInclusion;
  }): StoredTransactionAttempt {
    const attemptId = uuidSchema.parse(input.attemptId);
    const expectedState = z.enum(attemptStates).parse(input.expectedState);
    const expectedVersion = z.number().int().nonnegative().parse(input.expectedStateVersion);
    const nextState = z.enum(attemptStates).parse(input.nextState);
    if (
      !(attemptTransitions[expectedState] as readonly TransactionAttemptState[]).includes(nextState)
    ) {
      throw new TransactionEngineConflictError(
        `Transaction attempt cannot transition from ${expectedState} to ${nextState}`,
      );
    }
    const changedAt = instantSchema.parse(input.changedAt);
    const resultJson =
      input.submissionResult === undefined ? undefined : canonicalJson(input.submissionResult);
    const inclusion =
      input.inclusion === undefined ? undefined : transactionInclusionSchema.parse(input.inclusion);
    const inclusionJson = inclusion === undefined ? undefined : canonicalJson(inclusion);
    if (
      (nextState === "submitted" || nextState === "ambiguous") &&
      expectedState === "signed" &&
      resultJson === undefined
    ) {
      throw new TransactionEngineConflictError(
        "First submission transition requires a durable submission result",
      );
    }
    return this.transaction(() => {
      const existingRow = this.db
        .prepare("SELECT * FROM transaction_attempts WHERE attempt_id = ?")
        .get(attemptId);
      if (existingRow === undefined) {
        throw new TransactionEngineCasError("Attempt state/version compare-and-swap failed");
      }
      const existing = attemptRowSchema.parse(existingRow);
      if (existing.state !== expectedState || existing.state_version !== expectedVersion) {
        throw new TransactionEngineCasError("Attempt state/version compare-and-swap failed");
      }
      if (inclusion !== undefined && inclusion.txid !== existing.precomputed_txid) {
        throw new TransactionEngineConflictError(
          "Transaction inclusion txid does not bind the persisted attempt",
        );
      }
      if (
        nextState === "confirmed" &&
        (inclusion === undefined || inclusion.executionStatus !== "success" || !inclusion.canonical)
      ) {
        throw new TransactionEngineConflictError(
          "A confirmed attempt requires a canonical successful inclusion record",
        );
      }
      const submittedAt =
        existing.submitted_at ??
        (nextState === "submitted" || nextState === "ambiguous" ? changedAt : null);
      const resolvedAt = ["rejected", "reconciled"].includes(nextState)
        ? changedAt
        : existing.resolved_at;
      const result = this.db
        .prepare(
          `UPDATE transaction_attempts SET
            state = ?, state_version = state_version + 1,
            submission_result_json = ?, inclusion_record_json = ?,
            submitted_at = ?, resolved_at = ?, updated_at = ?
           WHERE attempt_id = ? AND state = ? AND state_version = ?`,
        )
        .run(
          nextState,
          resultJson ?? existing.submission_result_json,
          inclusionJson ?? existing.inclusion_record_json,
          submittedAt,
          resolvedAt,
          changedAt,
          attemptId,
          expectedState,
          expectedVersion,
        );
      requireChanges(result.changes, "Attempt state/version compare-and-swap failed");
      const row = this.db
        .prepare("SELECT * FROM transaction_attempts WHERE attempt_id = ?")
        .get(attemptId);
      if (row === undefined) throw new Error("Attempt disappeared after transition");
      return mapAttemptRow(attemptRowSchema.parse(row));
    });
  }

  updateAmbiguousAttemptInclusion(input: {
    attemptId: string;
    expectedStateVersion: number;
    inclusion: StoredTransactionInclusion;
    changedAt: string;
  }): StoredTransactionAttempt {
    const attemptId = uuidSchema.parse(input.attemptId);
    const expectedVersion = z.number().int().nonnegative().parse(input.expectedStateVersion);
    const inclusion = transactionInclusionSchema.parse(input.inclusion);
    const changedAt = instantSchema.parse(input.changedAt);
    return this.transaction(() => {
      const existingRow = this.db
        .prepare("SELECT * FROM transaction_attempts WHERE attempt_id = ?")
        .get(attemptId);
      if (existingRow === undefined) {
        throw new TransactionEngineCasError("Attempt state/version compare-and-swap failed");
      }
      const existing = attemptRowSchema.parse(existingRow);
      if (existing.state !== "ambiguous" || existing.state_version !== expectedVersion) {
        throw new TransactionEngineCasError("Attempt state/version compare-and-swap failed");
      }
      if (inclusion.txid !== existing.precomputed_txid) {
        throw new TransactionEngineConflictError(
          "Transaction inclusion txid does not bind the persisted attempt",
        );
      }
      const result = this.db
        .prepare(
          `UPDATE transaction_attempts SET
            state_version = state_version + 1,
            inclusion_record_json = ?, updated_at = ?
           WHERE attempt_id = ? AND state = 'ambiguous' AND state_version = ?`,
        )
        .run(canonicalJson(inclusion), changedAt, attemptId, expectedVersion);
      requireChanges(result.changes, "Attempt state/version compare-and-swap failed");
      const row = this.db
        .prepare("SELECT * FROM transaction_attempts WHERE attempt_id = ?")
        .get(attemptId);
      if (row === undefined) throw new Error("Attempt disappeared after inclusion update");
      return mapAttemptRow(attemptRowSchema.parse(row));
    });
  }

  appendReconciliationObservation(input: {
    observationId?: string;
    jobId: string;
    predicate: unknown;
    predicateSha256: string;
    chainAnchor: ChainAnchor;
    authoritative: boolean;
    canonical: boolean;
    finalityDepth: number;
    outcome: ReconciliationOutcome;
    effectRemaining: boolean;
    reason?: string;
    observedAt: string;
  }): { observation: StoredReconciliationObservation; created: boolean } {
    const observationId = uuidSchema.parse(input.observationId ?? randomUUID());
    const jobId = uuidSchema.parse(input.jobId);
    const predicate = canonicalDocument(input.predicate);
    if (predicate.sha256 !== sha256Schema.parse(input.predicateSha256)) {
      throw new TransactionEngineConflictError(
        "Predicate hash does not match canonical predicate JSON",
      );
    }
    const anchor = chainAnchorSchema.parse(input.chainAnchor);
    const anchorJson = canonicalJson(anchor);
    const finalityDepth = z.number().int().nonnegative().parse(input.finalityDepth);
    const outcome = z.enum(reconciliationOutcomes).parse(input.outcome);
    const reason =
      input.reason === undefined ? null : z.string().min(1).max(2_000).parse(input.reason);
    const observedAt = instantSchema.parse(input.observedAt);
    return this.transaction(() => {
      if (this.jobRow(jobId) === null) {
        throw new TransactionEngineConflictError("Reconciliation logical job does not exist");
      }
      const existing = this.db
        .prepare("SELECT * FROM transaction_reconciliation_observations WHERE observation_id = ?")
        .get(observationId);
      if (existing !== undefined) {
        const row = observationRowSchema.parse(existing);
        if (
          row.job_id === jobId &&
          row.predicate_sha256 === predicate.sha256 &&
          row.predicate_json === predicate.encoded &&
          row.chain_anchor_json === anchorJson &&
          row.authoritative === booleanInteger(input.authoritative) &&
          row.canonical === booleanInteger(input.canonical) &&
          row.finality_depth === finalityDepth &&
          row.outcome === outcome &&
          row.effect_remaining === booleanInteger(input.effectRemaining) &&
          row.reason === reason &&
          row.observed_at === observedAt
        ) {
          return { observation: mapObservation(row), created: false };
        }
        throw new TransactionEngineConflictError(
          "Reconciliation observation ID already binds different evidence",
        );
      }
      this.db
        .prepare(
          `INSERT INTO transaction_reconciliation_observations (
            observation_id, job_id, predicate_sha256, predicate_json, chain_anchor_json,
            authoritative, canonical, finality_depth, outcome, effect_remaining,
            reason, observed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          observationId,
          jobId,
          predicate.sha256,
          predicate.encoded,
          anchorJson,
          booleanInteger(input.authoritative),
          booleanInteger(input.canonical),
          finalityDepth,
          outcome,
          booleanInteger(input.effectRemaining),
          reason,
          observedAt,
        );
      const row = this.db
        .prepare("SELECT * FROM transaction_reconciliation_observations WHERE observation_id = ?")
        .get(observationId);
      if (row === undefined) throw new Error("Reconciliation observation insert did not persist");
      return { observation: mapObservation(row), created: true };
    });
  }

  listReconciliationObservations(jobId: string): StoredReconciliationObservation[] {
    return this.db
      .prepare(
        `SELECT * FROM transaction_reconciliation_observations
         WHERE job_id = ? ORDER BY observed_at, observation_id`,
      )
      .all(uuidSchema.parse(jobId))
      .map(mapObservation);
  }

  getForceObserveControl(): StoredForceObserveControl | null {
    const row = this.db.prepare("SELECT * FROM engine_force_observe_control").get();
    if (row === undefined) return null;
    const value = forceObserveRowSchema.parse(row);
    return {
      active: true,
      reason: value.reason,
      actor: value.actor,
      forcedAt: value.forced_at,
    };
  }

  forceObserve(input: { reason: string; actor: string; forcedAt: string }): {
    control: StoredForceObserveControl;
    created: boolean;
    invalidatedApprovals: number;
  } {
    const reason = z.string().min(1).max(1_000).parse(input.reason);
    const actor = z.string().min(1).max(500).parse(input.actor);
    const forcedAt = instantSchema.parse(input.forcedAt);
    return this.transaction(() => {
      const existing = this.getForceObserveControl();
      if (existing !== null) {
        return { control: existing, created: false, invalidatedApprovals: 0 };
      }
      this.db
        .prepare(
          `INSERT INTO engine_force_observe_control (singleton_id, reason, actor, forced_at)
           VALUES (1, ?, ?, ?)`,
        )
        .run(reason, actor, forcedAt);
      const invalidated = this.db
        .prepare(
          `UPDATE transaction_approvals SET
            invalidated_at = ?, invalidation_reason = 'emergency-force-observe',
            approval_version = approval_version + 1
           WHERE invalidated_at IS NULL`,
        )
        .run(forcedAt);
      const control = this.getForceObserveControl();
      if (control === null) throw new Error("Force Observe control insert did not persist");
      return {
        control,
        created: true,
        invalidatedApprovals: Number(invalidated.changes),
      };
    });
  }

  getDisabledAdapterControl(adapterId: string): StoredDisabledAdapterControl | null {
    const row = this.db
      .prepare("SELECT * FROM engine_adapter_disable_controls WHERE adapter_id = ?")
      .get(identifierSchema.parse(adapterId));
    if (row === undefined) return null;
    const value = disabledAdapterRowSchema.parse(row);
    return {
      adapterId: value.adapter_id,
      disabled: true,
      reason: value.reason,
      actor: value.actor,
      disabledAt: value.disabled_at,
    };
  }

  listDisabledAdapterControls(): StoredDisabledAdapterControl[] {
    return this.db
      .prepare("SELECT * FROM engine_adapter_disable_controls ORDER BY adapter_id")
      .all()
      .map((row) => {
        const value = disabledAdapterRowSchema.parse(row);
        return {
          adapterId: value.adapter_id,
          disabled: true as const,
          reason: value.reason,
          actor: value.actor,
          disabledAt: value.disabled_at,
        };
      });
  }

  disableAdapter(input: { adapterId: string; reason: string; actor: string; disabledAt: string }): {
    control: StoredDisabledAdapterControl;
    created: boolean;
    invalidatedApprovals: number;
  } {
    const adapterId = identifierSchema.parse(input.adapterId);
    const reason = z.string().min(1).max(1_000).parse(input.reason);
    const actor = z.string().min(1).max(500).parse(input.actor);
    const disabledAt = instantSchema.parse(input.disabledAt);
    return this.transaction(() => {
      const existing = this.getDisabledAdapterControl(adapterId);
      if (existing !== null) {
        return { control: existing, created: false, invalidatedApprovals: 0 };
      }
      this.db
        .prepare(
          `INSERT INTO engine_adapter_disable_controls (
            adapter_id, reason, actor, disabled_at
          ) VALUES (?, ?, ?, ?)`,
        )
        .run(adapterId, reason, actor, disabledAt);
      const invalidated = this.db
        .prepare(
          `UPDATE transaction_approvals SET
            invalidated_at = ?, invalidation_reason = 'adapter-disabled',
            approval_version = approval_version + 1
           WHERE invalidated_at IS NULL
             AND job_id IN (SELECT job_id FROM transaction_jobs WHERE adapter_id = ?)`,
        )
        .run(disabledAt, adapterId);
      const control = this.getDisabledAdapterControl(adapterId);
      if (control === null) throw new Error("Adapter disable control insert did not persist");
      return {
        control,
        created: true,
        invalidatedApprovals: Number(invalidated.changes),
      };
    });
  }

  async get(issuer: string): Promise<StoredCompatibilityAttestation | null> {
    const row = this.db
      .prepare("SELECT * FROM accepted_compatibility_attestations WHERE issuer = ?")
      .get(issuerSchema.parse(issuer));
    if (row === undefined) return null;
    const value = attestationRowSchema.parse(row);
    return {
      acceptedState: {
        issuer: value.issuer,
        revision: value.revision,
        payloadSha256: value.payload_sha256,
        verifiedAt: value.verified_at,
      },
      document: signedCompatibilityAttestationSchema.parse(parseJson(value.document_json)),
      acceptedAt: value.accepted_at,
    };
  }

  async accept(
    record: StoredCompatibilityAttestation,
    expected: AcceptedCompatibilityAttestationState | null,
  ): Promise<void> {
    const document: SignedCompatibilityAttestation = signedCompatibilityAttestationSchema.parse(
      record.document,
    );
    const acceptedState = {
      issuer: issuerSchema.parse(record.acceptedState.issuer),
      revision: z.number().int().positive().parse(record.acceptedState.revision),
      payloadSha256: sha256Schema.parse(record.acceptedState.payloadSha256),
      verifiedAt: instantSchema.parse(record.acceptedState.verifiedAt),
    };
    const acceptedAt = instantSchema.parse(record.acceptedAt);
    if (document.payload.issuer !== acceptedState.issuer) {
      throw new TransactionEngineConflictError(
        "Accepted attestation issuer does not match its document",
      );
    }
    if (document.payload.revision !== acceptedState.revision) {
      throw new TransactionEngineConflictError(
        "Accepted attestation revision does not match its document",
      );
    }
    if (compatibilityAttestationPayloadSha256(document.payload) !== acceptedState.payloadSha256) {
      throw new TransactionEngineConflictError(
        "Accepted attestation digest does not match its document",
      );
    }
    const documentJson = canonicalJson(document);
    this.transaction(() => {
      const existingValue = this.db
        .prepare("SELECT * FROM accepted_compatibility_attestations WHERE issuer = ?")
        .get(acceptedState.issuer);
      if (existingValue === undefined) {
        if (expected !== null) {
          throw new TransactionEngineCasError("Attestation compare-and-swap failed");
        }
        this.db
          .prepare(
            `INSERT INTO accepted_compatibility_attestations (
              issuer, revision, payload_sha256, verified_at, document_json,
              accepted_at, row_version
            ) VALUES (?, ?, ?, ?, ?, ?, 0)`,
          )
          .run(
            acceptedState.issuer,
            acceptedState.revision,
            acceptedState.payloadSha256,
            acceptedState.verifiedAt,
            documentJson,
            acceptedAt,
          );
        return;
      }
      const existing = attestationRowSchema.parse(existingValue);
      if (expected === null || !acceptedStateMatches(existing, expected)) {
        throw new TransactionEngineCasError("Attestation revision/digest compare-and-swap failed");
      }
      if (acceptedState.revision < existing.revision) {
        throw new TransactionEngineConflictError("Attestation revision cannot be downgraded");
      }
      if (
        acceptedState.revision === existing.revision &&
        acceptedState.payloadSha256 !== existing.payload_sha256
      ) {
        throw new TransactionEngineConflictError(
          "Attestation revision cannot be rebound to a different digest",
        );
      }
      const result = this.db
        .prepare(
          `UPDATE accepted_compatibility_attestations SET
            revision = ?, payload_sha256 = ?, verified_at = ?, document_json = ?,
            accepted_at = ?, row_version = row_version + 1
           WHERE issuer = ? AND row_version = ?`,
        )
        .run(
          acceptedState.revision,
          acceptedState.payloadSha256,
          acceptedState.verifiedAt,
          documentJson,
          acceptedAt,
          acceptedState.issuer,
          existing.row_version,
        );
      requireChanges(result.changes, "Attestation row compare-and-swap failed");
    });
  }
}
