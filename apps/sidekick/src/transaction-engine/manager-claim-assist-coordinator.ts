import { isDeepStrictEqual } from "node:util";
import {
  MANAGER_CLAIM_REWARDS_ADAPTER_ID,
  MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
} from "@stx-labs/signer-sidekick-protocol/manager-claim-rewards";
import { type ChainAnchor, chainAnchorSchema, chainAnchorsEqual } from "../chain-anchor.js";
import type { GasPayerMempoolActivityResult, TransactionSummary } from "../chain-clients.js";
import { copyValidDate, parseCanonicalInstant } from "../time.js";
import {
  type AdmissionBlock,
  evaluateTransactionAdmission,
  type TransactionAdmissionInput,
} from "./admission.js";
import {
  type CanonicalAnchorProofApi,
  proveCanonicalInclusionRelationship,
} from "./canonical-anchor-proof.js";
import type { GasPayerSigner } from "./gas-payer-signer.js";
import type { LiveTransactionReader } from "./live-transaction-reader.js";
import {
  parseManagerClaimIntentRecord,
  parseManagerClaimPolicyRecord,
} from "./manager-claim-observer.js";
import { evaluateNonceOwnership } from "./nonce-policy.js";
import {
  type StoredNonceReservation,
  type StoredTransactionApproval,
  type StoredTransactionAttempt,
  type StoredTransactionInclusion,
  type StoredTransactionJob,
  type TransactionEngineRepository,
  transactionEngineDocumentSha256,
} from "./repository.js";
import type {
  NoRetryTransactionBroadcaster,
  TransactionBroadcastResult,
} from "./transaction-broadcaster.js";

type AssistRepository = Pick<
  TransactionEngineRepository,
  | "getLogicalJob"
  | "getActiveApproval"
  | "getNonceReservationForJob"
  | "transitionLogicalJob"
  | "commitApprovedSignedAttempt"
  | "transitionNonceReservation"
  | "listAttempts"
  | "transitionAttempt"
  | "updateAmbiguousAttemptInclusion"
  | "appendReconciliationObservation"
>;

type AssistSigner = Pick<GasPayerSigner, "principal" | "publicKey" | "signManagerClaimRewardsPlan">;

type AssistBroadcaster = Pick<NoRetryTransactionBroadcaster, "broadcast">;
type AssistReader = Pick<
  LiveTransactionReader,
  "readAnchoredAccount" | "lookupIndexedTransaction" | "lookupUnconfirmedTransaction"
>;

interface AssistApiReader extends CanonicalAnchorProofApi {
  getTransaction(txid: string): Promise<TransactionSummary>;
  enumerateGasPayerMempoolActivity(
    principal: string,
    options?: { pageSize?: number; maxPages?: number; maxTransactions?: number },
  ): Promise<GasPayerMempoolActivityResult>;
}

export interface ManagerClaimAssistCoordinatorOptions {
  repository: AssistRepository;
  signer: AssistSigner;
  broadcaster: AssistBroadcaster;
  reader: AssistReader;
  api: AssistApiReader;
  /** Canonical block depth required before a local terminal outcome releases its nonce. */
  finalityDepth: number;
  /** Trusted process clock; injected only for deterministic tests. */
  now?: () => Date;
}

export interface ManagerClaimAssistExecutionInput {
  jobId: string;
  /** Fresh, caller-collected broadcast facts. Durable bindings are checked again below. */
  admission: TransactionAdmissionInput;
}

export type ManagerClaimAssistExecutionBlockCode =
  | "job-not-found"
  | "job-not-executable"
  | "assist-policy-required"
  | "approval-missing-or-expired"
  | "approval-mismatch"
  | "admission-binding-mismatch"
  | "admission-denied"
  | "account-observation-unavailable"
  | "anchored-nonce-mismatch"
  | "mempool-observation-unavailable"
  | "foreign-nonce-activity"
  | "nonce-policy-denied";

export type ManagerClaimAssistExecutionResult =
  | {
      status: "blocked";
      code: ManagerClaimAssistExecutionBlockCode;
      message: string;
      admissionBlocks: readonly AdmissionBlock[];
    }
  | {
      status: "persisted-attempt";
      jobId: string;
      attemptId: string;
      attemptState: StoredTransactionAttempt["state"];
      txid: string;
      recoveryRequired: boolean;
    }
  | {
      status: "submitted" | "ambiguous" | "rejected";
      jobId: string;
      attemptId: string;
      txid: string;
    };

export interface ManagerClaimAssistRecoveryInput {
  jobId: string;
  /** A current canonical anchor chosen by the caller for the account-nonce observation. */
  liveAnchor: ChainAnchor;
  observedAt: string;
}

export type ManagerClaimAssistRecoveryResult =
  | { status: "job-not-found" | "no-persisted-attempt"; jobId: string }
  | {
      status: "already-resolved";
      jobId: string;
      attemptId: string;
      attemptState: StoredTransactionAttempt["state"];
      txid: string;
    }
  | {
      status: "observation-unavailable";
      jobId: string;
      attemptId: string;
      txid: string;
      reason: string;
    }
  | {
      status: "confirmed";
      jobId: string;
      attemptId: string;
      txid: string;
      indexBlockHash: string;
    }
  | {
      status: "aborted";
      jobId: string;
      attemptId: string;
      txid: string;
      executionStatus: "abort_by_response" | "abort_by_post_condition";
      finalityDepth: number;
      finalized: boolean;
    }
  | {
      status: "noncanonical";
      jobId: string;
      attemptId: string;
      txid: string;
    }
  | {
      status: "foreign-activity";
      jobId: string;
      attemptId: string;
      txid: string;
      reservedNonce: string;
      observedAccountNonce: string;
      localConfirmationObserved: boolean;
    }
  | {
      status: "externally-reconciled";
      jobId: string;
      attemptId: string;
      txid: string;
      nonceState: "resolved" | "unresolved";
      reason: "no-local-transaction" | "local-transaction-unconfirmed";
    }
  | {
      status: "manual-intervention-required";
      jobId: string;
      attemptId: string;
      txid: string;
      nonce: string;
      resolution: "automatic-replacement-unsupported";
      cause:
        | "persisted-before-broadcast"
        | "not-found"
        | "still-unconfirmed"
        | "lookup-inconclusive";
    };

interface DurableAssistContext {
  job: StoredTransactionJob;
  approval: StoredTransactionApproval;
  intent: ReturnType<typeof parseManagerClaimIntentRecord>;
  policy: ReturnType<typeof parseManagerClaimPolicyRecord>;
}

function blocked(
  code: ManagerClaimAssistExecutionBlockCode,
  message: string,
  admissionBlocks: readonly AdmissionBlock[] = [],
): ManagerClaimAssistExecutionResult {
  return { status: "blocked", code, message, admissionBlocks };
}

function exactInstant(value: Date): string | null {
  return Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

function parseObservedAt(value: string): string {
  if (!parseCanonicalInstant(value)) {
    throw new TypeError("Recovery observedAt must be a canonical ISO instant");
  }
  return value;
}

function exactApproval(job: StoredTransactionJob, approval: StoredTransactionApproval): boolean {
  const expected = {
    schemaVersion: 1,
    decision: "approve",
    jobId: job.jobId,
    intentSha256: job.intentSha256,
    policySha256: job.policySha256,
    attestationSha256: job.attestation.payloadSha256,
    expiresAt: approval.expiresAt,
  } as const;
  const expectedSha256 = transactionEngineDocumentSha256(expected);
  return (
    approval.jobId === job.jobId &&
    approval.intentSha256 === job.intentSha256 &&
    approval.policySha256 === job.policySha256 &&
    approval.invalidatedAt === null &&
    approval.actor.length > 0 &&
    Date.parse(approval.createdAt) < Date.parse(approval.expiresAt) &&
    approval.approvalSha256 === expectedSha256 &&
    transactionEngineDocumentSha256(approval.approval) === expectedSha256 &&
    isDeepStrictEqual(approval.approval, expected)
  );
}

function admissionBindingMismatch(
  input: TransactionAdmissionInput,
  context: DurableAssistContext,
  signer: AssistSigner,
): string | null {
  const { job, approval, intent, policy } = context;
  const plan = intent.sealedPlan;
  const observedAt = exactInstant(input.now);
  if (observedAt === null) return "Admission time is invalid";
  if (input.mode !== "assist") {
    return "Execution requires Assist admission";
  }
  if (input.intentHash !== job.intentSha256 || input.policyHash !== job.policySha256) {
    return "Admission hashes do not bind the durable job";
  }
  if (
    input.expectedAttestationSha256 !== job.attestation.payloadSha256 ||
    input.attestation?.payloadSha256 !== job.attestation.payloadSha256
  ) {
    return "Admission attestation does not bind the durable job";
  }
  if (
    input.expectedAdapter.id !== job.adapterId ||
    input.expectedAdapter.revision !== job.adapterRevision
  ) {
    return "Admission adapter does not bind the durable job";
  }
  if (!chainAnchorsEqual(input.plannedAnchor, job.chainAnchor)) {
    return "Admission planned anchor does not bind the durable job";
  }
  if (
    input.fee.transactionFeeUstx !== BigInt(plan.material.transaction.fee) ||
    input.fee.maximumFeeUstx !== BigInt(policy.maximumFeeUstx)
  ) {
    return "Admission fee values do not bind the sealed policy";
  }
  if (
    input.approval?.intentHash !== approval.intentSha256 ||
    input.approval.policyHash !== approval.policySha256 ||
    input.approval.expiresAt !== approval.expiresAt ||
    input.approval.invalidatedAt !== null
  ) {
    return "Admission approval does not bind the current durable approval";
  }
  if (
    input.signer?.principal !== signer.principal ||
    input.signer.expectedPrincipal !== plan.material.sender.principal ||
    signer.principal !== plan.material.sender.principal ||
    signer.publicKey !== plan.material.sender.publicKey
  ) {
    return "Admission signer does not bind the sealed gas payer";
  }
  return null;
}

function signedTransactionReference(input: {
  intentHash: string;
  unsignedTransactionSha256: string;
  nonce: string;
}): string {
  return [
    "manager-claim-regenerable",
    "v1",
    input.intentHash,
    input.unsignedTransactionSha256,
    input.nonce,
  ].join(":");
}

function persistedAttemptResult(
  jobId: string,
  attempt: StoredTransactionAttempt,
): ManagerClaimAssistExecutionResult {
  return {
    status: "persisted-attempt",
    jobId,
    attemptId: attempt.attemptId,
    attemptState: attempt.state,
    txid: attempt.precomputedTxid,
    recoveryRequired: !["confirmed", "rejected", "reconciled"].includes(attempt.state),
  };
}

function submissionRecord(result: TransactionBroadcastResult): object {
  return { schemaVersion: 1, kind: "manager-claim-broadcast", ...result };
}

function recoverySubmissionRecord(kind: string, txid: string): object {
  return { schemaVersion: 1, kind, txid };
}

function sameInclusionFacts(
  left: StoredTransactionInclusion | null,
  right: StoredTransactionInclusion,
): boolean {
  return (
    left !== null &&
    left.txid === right.txid &&
    left.executionStatus === right.executionStatus &&
    left.stacksBlockHeight === right.stacksBlockHeight &&
    left.blockHash === right.blockHash &&
    left.indexBlockHash === right.indexBlockHash &&
    left.canonical === right.canonical
  );
}

export class ManagerClaimAssistCoordinator {
  readonly #repository: AssistRepository;
  readonly #signer: AssistSigner;
  readonly #broadcaster: AssistBroadcaster;
  readonly #reader: AssistReader;
  readonly #api: AssistApiReader;
  readonly #finalityDepth: number;
  readonly #clock: () => Date;

  constructor(options: ManagerClaimAssistCoordinatorOptions) {
    this.#repository = options.repository;
    this.#signer = options.signer;
    this.#broadcaster = options.broadcaster;
    this.#reader = options.reader;
    this.#api = options.api;
    if (
      !Number.isSafeInteger(options.finalityDepth) ||
      options.finalityDepth < 1 ||
      options.finalityDepth > 144
    ) {
      throw new TypeError("Assist coordinator finalityDepth must be an integer from 1 through 144");
    }
    this.#finalityDepth = options.finalityDepth;
    this.#clock = options.now ?? (() => new Date());
  }

  #now(): Date {
    const now = copyValidDate(this.#clock());
    if (!now) {
      throw new Error("Assist coordinator clock returned an invalid instant");
    }
    return now;
  }

  #normalizePersistedAttempt(
    job: StoredTransactionJob,
    attempt: StoredTransactionAttempt,
    at: string,
  ): void {
    const reservation = this.#repository.getNonceReservationForJob(job.jobId);
    if (attempt.state === "submitted" && job.state === "nonce_reserved") {
      this.#repository.transitionLogicalJob({
        jobId: job.jobId,
        expectedState: "nonce_reserved",
        expectedStateVersion: job.stateVersion,
        nextState: "broadcast",
        changedAt: at,
      });
      return;
    }
    if (attempt.state === "ambiguous") {
      if (job.state === "nonce_reserved" || job.state === "broadcast") {
        this.#repository.transitionLogicalJob({
          jobId: job.jobId,
          expectedState: job.state,
          expectedStateVersion: job.stateVersion,
          nextState: "ambiguous",
          changedAt: at,
        });
      }
      if (reservation?.state === "reserved") {
        this.#repository.transitionNonceReservation({
          reservationId: reservation.reservationId,
          expectedState: "reserved",
          expectedStateVersion: reservation.stateVersion,
          nextState: "ambiguous",
          foreignActivity: false,
          changedAt: at,
        });
      }
      return;
    }
    if (attempt.state === "rejected") {
      if (
        job.state === "nonce_reserved" ||
        job.state === "broadcast" ||
        job.state === "ambiguous"
      ) {
        this.#repository.transitionLogicalJob({
          jobId: job.jobId,
          expectedState: job.state,
          expectedStateVersion: job.stateVersion,
          nextState: "blocked",
          blockReason: "broadcast-rejected:durable-attempt-result",
          changedAt: at,
        });
      }
      if (reservation?.state === "reserved" || reservation?.state === "ambiguous") {
        this.#repository.transitionNonceReservation({
          reservationId: reservation.reservationId,
          expectedState: reservation.state,
          expectedStateVersion: reservation.stateVersion,
          nextState: "resolved",
          foreignActivity: reservation.foreignActivity,
          changedAt: at,
        });
      }
    }
  }

  #durableContext(
    jobId: string,
    at: string,
  ): DurableAssistContext | ManagerClaimAssistExecutionResult {
    const job = this.#repository.getLogicalJob(jobId);
    if (job === null)
      return blocked("job-not-found", "This transaction job no longer exists. Refresh Operations");
    const attempts = this.#repository.listAttempts(job.jobId);
    const existing = attempts.at(-1);
    if (existing) {
      this.#normalizePersistedAttempt(job, existing, at);
      return persistedAttemptResult(job.jobId, existing);
    }
    if (
      !(
        job.state === "preflighted" ||
        job.state === "awaiting_approval" ||
        job.state === "nonce_reserved"
      )
    ) {
      if (job.state === "blocked") {
        return blocked(
          "job-not-executable",
          "This job is blocked and cannot start Assist. Resolve its block reason, then sync chain data to prepare a new current job, review, and approve it",
        );
      }
      return blocked(
        "job-not-executable",
        `This job is ${job.state.replaceAll("_", " ")} and cannot start Assist. Refresh Operations`,
      );
    }
    if (
      job.adapterId !== MANAGER_CLAIM_REWARDS_ADAPTER_ID ||
      job.adapterRevision !== MANAGER_CLAIM_REWARDS_ADAPTER_REVISION
    ) {
      return blocked("job-not-executable", "This job is not a supported manager-claim transaction");
    }
    const intent = parseManagerClaimIntentRecord(job.intent);
    const policy = parseManagerClaimPolicyRecord(job.policy);
    if (
      policy.mode !== "assist" ||
      !policy.approvalRequired ||
      !policy.nonceReservationAllowed ||
      !policy.signingAllowed ||
      !policy.broadcastAllowed
    ) {
      return blocked("assist-policy-required", "This job does not permit Assist execution");
    }
    const approval = this.#repository.getActiveApproval(job.jobId, at);
    if (approval === null) {
      return blocked(
        "approval-missing-or-expired",
        "Approval is missing or expired. Sync chain data to prepare a new current job, then review and approve it",
      );
    }
    if (!exactApproval(job, approval)) {
      return blocked(
        "approval-mismatch",
        "Approval no longer matches this job. Sync chain data to prepare a new current job, then review and approve it",
      );
    }
    return { job, approval, intent, policy };
  }

  async execute(
    input: ManagerClaimAssistExecutionInput,
  ): Promise<ManagerClaimAssistExecutionResult> {
    const executionNow = this.#now();
    const at = executionNow.toISOString();
    const durable = this.#durableContext(input.jobId, at);
    if ("status" in durable) return durable;

    const mismatch = admissionBindingMismatch(input.admission, durable, this.#signer);
    if (mismatch !== null) return blocked("admission-binding-mismatch", mismatch);
    const admission = evaluateTransactionAdmission({ ...input.admission, now: executionNow });
    if (!admission.admitted) {
      return blocked(
        "admission-denied",
        `Assist checks failed: ${admission.blocks.map(({ message }) => message).join("; ")}`,
        admission.blocks,
      );
    }

    const plan = durable.intent.sealedPlan;
    const account = await this.#reader.readAnchoredAccount(
      this.#signer.principal,
      input.admission.liveAnchor.indexBlockHash,
    );
    if (account.status !== "observed") {
      const message =
        account.status === "schema-invalid"
          ? "The gas-payer account response is incompatible with Sidekick. Check node compatibility"
          : account.reason === "http-error"
            ? "The node rejected the gas-payer account request. Check its URL and access settings"
            : "Gas-payer account state is unavailable. Check node connectivity and try again";
      return blocked("account-observation-unavailable", message);
    }
    const sealedNonce = BigInt(plan.material.transaction.nonce);
    if (
      account.value.principal !== this.#signer.principal ||
      account.value.indexBlockHash !== input.admission.liveAnchor.indexBlockHash ||
      account.value.nonce !== sealedNonce
    ) {
      return blocked(
        "anchored-nonce-mismatch",
        "The gas-payer nonce changed. Sync chain data and prepare a new job",
      );
    }
    let mempool: GasPayerMempoolActivityResult;
    try {
      mempool = await this.#api.enumerateGasPayerMempoolActivity(this.#signer.principal);
    } catch {
      return blocked(
        "mempool-observation-unavailable",
        "Gas-payer mempool activity could not be read. Check Reference API connectivity and compatibility",
      );
    }
    if (mempool.status !== "complete") {
      return blocked(
        "mempool-observation-unavailable",
        `Gas-payer mempool enumeration is incomplete (${mempool.reason}; pages=${mempool.pagesRead}; observed=${mempool.observedTransactionCount}; reported=${mempool.reportedTotal})`,
      );
    }
    if (mempool.nonceActivities.some(({ nonce }) => nonce >= sealedNonce)) {
      return blocked(
        "foreign-nonce-activity",
        "Another transaction is using this gas-payer nonce. Resolve it before using Assist",
      );
    }
    const nonceDecision = evaluateNonceOwnership({
      expectedAccountNonce: sealedNonce,
      observedAccountNonce: account.value.nonce,
      unresolved: [],
      observedTransactions: [],
      proposal: {
        nonce: sealedNonce,
        intentHash: durable.job.intentSha256,
        feeUstx: BigInt(plan.material.transaction.fee),
        maximumFeeUstx: BigInt(durable.policy.maximumFeeUstx),
      },
    });
    if (!nonceDecision.allowed || nonceDecision.action !== "reserve-initial") {
      return blocked(
        "nonce-policy-denied",
        "Sidekick cannot safely reserve the gas-payer nonce. Resolve existing nonce activity first",
      );
    }

    if (durable.job.state === "preflighted") {
      return blocked(
        "approval-missing-or-expired",
        "This job is not ready for its approval. Refresh Operations",
      );
    }

    const signed = await this.#signer.signManagerClaimRewardsPlan(plan);
    if (
      signed.intentHash !== plan.intentHash ||
      signed.unsignedTransactionSha256 !== plan.unsignedTransactionSha256 ||
      signed.nonce !== sealedNonce.toString() ||
      signed.fee !== plan.material.transaction.fee
    ) {
      throw new Error("Sealed signer output does not bind the manager-claim plan");
    }
    const commitmentNow = this.#now();
    const commitmentAt = commitmentNow.toISOString();
    const currentApproval = this.#repository.getActiveApproval(durable.job.jobId, commitmentAt);
    const commitmentAdmission = evaluateTransactionAdmission({
      ...input.admission,
      now: commitmentNow,
    });
    if (
      currentApproval === null ||
      currentApproval.approvalId !== durable.approval.approvalId ||
      currentApproval.approvalVersion !== durable.approval.approvalVersion ||
      !exactApproval(durable.job, currentApproval) ||
      !commitmentAdmission.admitted
    ) {
      this.#repository.transitionLogicalJob({
        jobId: durable.job.jobId,
        expectedState: durable.job.state,
        expectedStateVersion: durable.job.stateVersion,
        nextState: "blocked",
        blockReason: "approval-invalid-before-broadcast-commitment",
        changedAt: commitmentAt,
      });
      const existingReservation = this.#repository.getNonceReservationForJob(durable.job.jobId);
      if (existingReservation?.state === "reserved" || existingReservation?.state === "ambiguous") {
        this.#repository.transitionNonceReservation({
          reservationId: existingReservation.reservationId,
          expectedState: existingReservation.state,
          expectedStateVersion: existingReservation.stateVersion,
          nextState: "resolved",
          foreignActivity: existingReservation.foreignActivity,
          changedAt: commitmentAt,
        });
      }
      return blocked(
        "approval-missing-or-expired",
        "Approval changed before broadcast. Sync chain data to prepare a new current job, then review and approve it",
        commitmentAdmission.blocks,
      );
    }
    const persisted = this.#repository.commitApprovedSignedAttempt({
      jobId: durable.job.jobId,
      expectedJobStateVersion: durable.job.stateVersion,
      approvalId: durable.approval.approvalId,
      expectedApprovalVersion: durable.approval.approvalVersion,
      expectedApprovalSha256: durable.approval.approvalSha256,
      gasPayerPrincipal: this.#signer.principal,
      nonce: sealedNonce.toString(),
      observedAccountNonce: account.value.nonce.toString(),
      feeUstx: signed.fee,
      feePolicyRevision: durable.intent.review.fee.policyRevision,
      signedTransactionRef: signedTransactionReference(signed),
      precomputedTxid: signed.precomputedTxid,
      committedAt: commitmentAt,
    });
    if (!persisted.created) {
      return persistedAttemptResult(persisted.job.jobId, persisted.attempt);
    }
    const job = persisted.job;
    const reserved = persisted.reservation;

    // No retry and no catch: an unexpected process failure leaves the persisted `signed` attempt
    // for recovery, and a restart is forbidden from broadcasting it again.
    const rawBroadcast = await this.#broadcaster.broadcast(signed);
    const broadcast: TransactionBroadcastResult =
      rawBroadcast.txid !== null && rawBroadcast.txid !== signed.precomputedTxid
        ? {
            status: "ambiguous",
            txid: signed.precomputedTxid,
            httpStatus: rawBroadcast.httpStatus,
            reason: "invalid-success-response",
          }
        : rawBroadcast;
    const submissionResult = submissionRecord(broadcast);
    if (broadcast.status === "accepted") {
      const attempt = this.#repository.transitionAttempt({
        attemptId: persisted.attempt.attemptId,
        expectedState: "signed",
        expectedStateVersion: persisted.attempt.stateVersion,
        nextState: "submitted",
        submissionResult,
        changedAt: commitmentAt,
      });
      this.#repository.transitionLogicalJob({
        jobId: job.jobId,
        expectedState: "nonce_reserved",
        expectedStateVersion: job.stateVersion,
        nextState: "broadcast",
        changedAt: commitmentAt,
      });
      return {
        status: "submitted",
        jobId: job.jobId,
        attemptId: attempt.attemptId,
        txid: attempt.precomputedTxid,
      };
    }
    if (broadcast.status === "ambiguous") {
      const attempt = this.#repository.transitionAttempt({
        attemptId: persisted.attempt.attemptId,
        expectedState: "signed",
        expectedStateVersion: persisted.attempt.stateVersion,
        nextState: "ambiguous",
        submissionResult,
        changedAt: commitmentAt,
      });
      this.#repository.transitionLogicalJob({
        jobId: job.jobId,
        expectedState: "nonce_reserved",
        expectedStateVersion: job.stateVersion,
        nextState: "ambiguous",
        changedAt: commitmentAt,
      });
      this.#repository.transitionNonceReservation({
        reservationId: reserved.reservationId,
        expectedState: "reserved",
        expectedStateVersion: reserved.stateVersion,
        nextState: "ambiguous",
        foreignActivity: false,
        changedAt: commitmentAt,
      });
      return {
        status: "ambiguous",
        jobId: job.jobId,
        attemptId: attempt.attemptId,
        txid: attempt.precomputedTxid,
      };
    }

    const attempt = this.#repository.transitionAttempt({
      attemptId: persisted.attempt.attemptId,
      expectedState: "signed",
      expectedStateVersion: persisted.attempt.stateVersion,
      nextState: "rejected",
      submissionResult,
      changedAt: commitmentAt,
    });
    this.#repository.transitionLogicalJob({
      jobId: job.jobId,
      expectedState: "nonce_reserved",
      expectedStateVersion: job.stateVersion,
      nextState: "blocked",
      blockReason: `broadcast-rejected:${broadcast.reason}`,
      changedAt: commitmentAt,
    });
    this.#repository.transitionNonceReservation({
      reservationId: reserved.reservationId,
      expectedState: "reserved",
      expectedStateVersion: reserved.stateVersion,
      nextState: "resolved",
      foreignActivity: false,
      changedAt: commitmentAt,
    });
    return {
      status: "rejected",
      jobId: job.jobId,
      attemptId: attempt.attemptId,
      txid: attempt.precomputedTxid,
    };
  }

  #markAmbiguous(
    job: StoredTransactionJob,
    attempt: StoredTransactionAttempt,
    reservation: StoredNonceReservation,
    at: string,
    foreignActivity: boolean,
    inclusion?: StoredTransactionInclusion,
  ): {
    job: StoredTransactionJob;
    attempt: StoredTransactionAttempt;
    reservation: StoredNonceReservation;
  } {
    let currentAttempt = attempt;
    if (
      attempt.state === "signed" ||
      attempt.state === "submitted" ||
      attempt.state === "confirmed"
    ) {
      currentAttempt = this.#repository.transitionAttempt({
        attemptId: attempt.attemptId,
        expectedState: attempt.state,
        expectedStateVersion: attempt.stateVersion,
        nextState: "ambiguous",
        ...(inclusion === undefined ? {} : { inclusion }),
        ...(attempt.state === "signed"
          ? {
              submissionResult: recoverySubmissionRecord(
                foreignActivity ? "recovery-foreign-activity" : "recovery-no-broadcast-result",
                attempt.precomputedTxid,
              ),
            }
          : {}),
        changedAt: at,
      });
    }
    let currentJob = job;
    if (job.state === "confirmed") {
      currentJob = this.#repository.transitionLogicalJob({
        jobId: job.jobId,
        expectedState: "confirmed",
        expectedStateVersion: job.stateVersion,
        nextState: "noncanonical_reobserve",
        changedAt: at,
      });
    } else if (job.state === "nonce_reserved" || job.state === "broadcast") {
      currentJob = this.#repository.transitionLogicalJob({
        jobId: job.jobId,
        expectedState: job.state,
        expectedStateVersion: job.stateVersion,
        nextState: "ambiguous",
        changedAt: at,
      });
    }
    let currentReservation = reservation;
    if (reservation.state === "reserved") {
      currentReservation = this.#repository.transitionNonceReservation({
        reservationId: reservation.reservationId,
        expectedState: "reserved",
        expectedStateVersion: reservation.stateVersion,
        nextState: "ambiguous",
        foreignActivity,
        changedAt: at,
      });
    } else if (
      reservation.state === "ambiguous" &&
      foreignActivity &&
      !reservation.foreignActivity
    ) {
      currentReservation = this.#repository.transitionNonceReservation({
        reservationId: reservation.reservationId,
        expectedState: "ambiguous",
        expectedStateVersion: reservation.stateVersion,
        nextState: "ambiguous",
        foreignActivity: true,
        changedAt: at,
      });
    }
    return { job: currentJob, attempt: currentAttempt, reservation: currentReservation };
  }

  #blockForeignActivity(
    job: StoredTransactionJob,
    attempt: StoredTransactionAttempt,
    reservation: StoredNonceReservation,
    at: string,
  ): void {
    const ambiguous = this.#markAmbiguous(job, attempt, reservation, at, true);
    if (
      ambiguous.job.state === "nonce_reserved" ||
      ambiguous.job.state === "broadcast" ||
      ambiguous.job.state === "ambiguous" ||
      ambiguous.job.state === "confirmed" ||
      ambiguous.job.state === "noncanonical_reobserve"
    ) {
      this.#repository.transitionLogicalJob({
        jobId: ambiguous.job.jobId,
        expectedState: ambiguous.job.state,
        expectedStateVersion: ambiguous.job.stateVersion,
        nextState: "blocked",
        blockReason: "foreign-gas-payer-nonce-activity",
        changedAt: at,
      });
    }
  }

  #confirm(
    job: StoredTransactionJob,
    attempt: StoredTransactionAttempt,
    at: string,
    inclusion: StoredTransactionInclusion,
  ): void {
    let currentAttempt = attempt;
    if (currentAttempt.state === "signed") {
      currentAttempt = this.#repository.transitionAttempt({
        attemptId: currentAttempt.attemptId,
        expectedState: "signed",
        expectedStateVersion: currentAttempt.stateVersion,
        nextState: "ambiguous",
        submissionResult: recoverySubmissionRecord(
          "recovery-confirmed-after-unknown-submit",
          currentAttempt.precomputedTxid,
        ),
        changedAt: at,
      });
    }
    if (currentAttempt.state === "submitted" || currentAttempt.state === "ambiguous") {
      currentAttempt = this.#repository.transitionAttempt({
        attemptId: currentAttempt.attemptId,
        expectedState: currentAttempt.state,
        expectedStateVersion: currentAttempt.stateVersion,
        nextState: "confirmed",
        inclusion,
        changedAt: at,
      });
    }

    let currentJob = job;
    if (currentJob.state === "nonce_reserved") {
      currentJob = this.#repository.transitionLogicalJob({
        jobId: currentJob.jobId,
        expectedState: "nonce_reserved",
        expectedStateVersion: currentJob.stateVersion,
        nextState: "ambiguous",
        changedAt: at,
      });
    }
    if (
      currentJob.state === "broadcast" ||
      currentJob.state === "ambiguous" ||
      currentJob.state === "noncanonical_reobserve"
    ) {
      currentJob = this.#repository.transitionLogicalJob({
        jobId: currentJob.jobId,
        expectedState: currentJob.state,
        expectedStateVersion: currentJob.stateVersion,
        nextState: "confirmed",
        changedAt: at,
      });
    }

    // The nonce remains exclusively reserved through authoritative effect reconciliation and
    // configured finality. First inclusion is not a terminal outcome.
  }

  #recognizeUnconfirmed(
    job: StoredTransactionJob,
    attempt: StoredTransactionAttempt,
    at: string,
  ): void {
    if (attempt.state !== "signed") return;
    this.#repository.transitionAttempt({
      attemptId: attempt.attemptId,
      expectedState: "signed",
      expectedStateVersion: attempt.stateVersion,
      nextState: "submitted",
      submissionResult: recoverySubmissionRecord(
        "recovery-unconfirmed-observed",
        attempt.precomputedTxid,
      ),
      changedAt: at,
    });
    if (job.state === "nonce_reserved") {
      this.#repository.transitionLogicalJob({
        jobId: job.jobId,
        expectedState: "nonce_reserved",
        expectedStateVersion: job.stateVersion,
        nextState: "broadcast",
        changedAt: at,
      });
    }
  }

  #inclusion(
    attempt: StoredTransactionAttempt,
    summary: TransactionSummary,
    canonical: boolean,
    observedAt: string,
  ): StoredTransactionInclusion {
    return {
      schemaVersion: 1,
      txid: attempt.precomputedTxid as `0x${string}`,
      executionStatus: summary.status,
      stacksBlockHeight: summary.block.height,
      blockHash: summary.block.hash,
      indexBlockHash: summary.block.index_hash,
      canonical,
      observedAt,
    };
  }

  #appendNoncanonicalEvidence(
    job: StoredTransactionJob,
    liveAnchor: ChainAnchor,
    at: string,
  ): void {
    const intent = parseManagerClaimIntentRecord(job.intent);
    const predicateSha256 = transactionEngineDocumentSha256(intent.reconciliation);
    this.#repository.appendReconciliationObservation({
      jobId: job.jobId,
      predicate: intent.reconciliation,
      predicateSha256,
      chainAnchor: liveAnchor,
      authoritative: true,
      canonical: false,
      finalityDepth: 0,
      outcome: "noncanonical",
      effectRemaining: true,
      reason: "Previously observed local transaction inclusion is no longer canonical",
      observedAt: at,
    });
  }

  #storeAmbiguousInclusion(
    job: StoredTransactionJob,
    attempt: StoredTransactionAttempt,
    reservation: StoredNonceReservation,
    inclusion: StoredTransactionInclusion,
    at: string,
  ): {
    job: StoredTransactionJob;
    attempt: StoredTransactionAttempt;
    reservation: StoredNonceReservation;
  } {
    const ambiguous = this.#markAmbiguous(job, attempt, reservation, at, false, inclusion);
    if (!sameInclusionFacts(ambiguous.attempt.inclusion, inclusion)) {
      if (ambiguous.attempt.state !== "ambiguous") {
        throw new Error("Only an ambiguous attempt may retain provisional inclusion evidence");
      }
      ambiguous.attempt = this.#repository.updateAmbiguousAttemptInclusion({
        attemptId: ambiguous.attempt.attemptId,
        expectedStateVersion: ambiguous.attempt.stateVersion,
        inclusion,
        changedAt: at,
      });
    }
    return ambiguous;
  }

  #markPriorInclusionNoncanonical(
    job: StoredTransactionJob,
    attempt: StoredTransactionAttempt,
    reservation: StoredNonceReservation,
    liveAnchor: ChainAnchor,
    at: string,
  ): {
    job: StoredTransactionJob;
    attempt: StoredTransactionAttempt;
    reservation: StoredNonceReservation;
  } {
    if (attempt.inclusion === null || !attempt.inclusion.canonical) {
      return this.#markAmbiguous(job, attempt, reservation, at, false);
    }
    const result = this.#storeAmbiguousInclusion(
      job,
      attempt,
      reservation,
      { ...attempt.inclusion, canonical: false, observedAt: at },
      at,
    );
    this.#appendNoncanonicalEvidence(job, liveAnchor, at);
    return result;
  }

  #prepareCanonicalInclusion(
    job: StoredTransactionJob,
    attempt: StoredTransactionAttempt,
    reservation: StoredNonceReservation,
    inclusion: StoredTransactionInclusion,
    liveAnchor: ChainAnchor,
    at: string,
  ): {
    job: StoredTransactionJob;
    attempt: StoredTransactionAttempt;
    reservation: StoredNonceReservation;
  } {
    if (attempt.inclusion === null || sameInclusionFacts(attempt.inclusion, inclusion)) {
      return { job, attempt, reservation };
    }
    return this.#markPriorInclusionNoncanonical(job, attempt, reservation, liveAnchor, at);
  }

  #inclusionFinalityDepth(liveAnchor: ChainAnchor, inclusion: StoredTransactionInclusion): number {
    return liveAnchor.stacksBlockHeight < inclusion.stacksBlockHeight
      ? 0
      : liveAnchor.stacksBlockHeight - inclusion.stacksBlockHeight;
  }

  async #holdOrFinalizeCanonicalAbort(
    job: StoredTransactionJob,
    attempt: StoredTransactionAttempt,
    reservation: StoredNonceReservation,
    inclusion: StoredTransactionInclusion,
    liveAnchor: ChainAnchor,
    at: string,
  ): Promise<
    | { status: "retained"; finalityDepth: number; finalized: boolean }
    | { status: "proof-unavailable"; finalityDepth: number; reason: string }
  > {
    const prepared = this.#prepareCanonicalInclusion(
      job,
      attempt,
      reservation,
      inclusion,
      liveAnchor,
      at,
    );
    const held = this.#storeAmbiguousInclusion(
      prepared.job,
      prepared.attempt,
      prepared.reservation,
      inclusion,
      at,
    );
    const finalityDepth = this.#inclusionFinalityDepth(liveAnchor, inclusion);
    if (finalityDepth < this.#finalityDepth) {
      return { status: "retained", finalityDepth, finalized: false };
    }
    const proof = await proveCanonicalInclusionRelationship(this.#api, inclusion, liveAnchor);
    if (proof.status !== "proven") {
      return {
        status: "proof-unavailable",
        finalityDepth,
        reason: `Canonical abort ancestry proof is ${proof.status} (${proof.reason})`,
      };
    }
    this.#repository.transitionAttempt({
      attemptId: held.attempt.attemptId,
      expectedState: "ambiguous",
      expectedStateVersion: held.attempt.stateVersion,
      nextState: "rejected",
      inclusion,
      changedAt: at,
    });
    if (held.job.state !== "blocked" && held.job.state !== "reconciled") {
      this.#repository.transitionLogicalJob({
        jobId: held.job.jobId,
        expectedState: held.job.state,
        expectedStateVersion: held.job.stateVersion,
        nextState: "blocked",
        blockReason: `canonical-transaction-${inclusion.executionStatus}`,
        changedAt: at,
      });
    }
    if (held.reservation.state !== "resolved") {
      this.#repository.transitionNonceReservation({
        reservationId: held.reservation.reservationId,
        expectedState: held.reservation.state,
        expectedStateVersion: held.reservation.stateVersion,
        nextState: "resolved",
        foreignActivity: held.reservation.foreignActivity,
        changedAt: at,
      });
    }
    return { status: "retained", finalityDepth, finalized: true };
  }

  #finalizeReconciled(
    attempt: StoredTransactionAttempt,
    reservation: StoredNonceReservation,
    at: string,
  ): void {
    if (attempt.state === "confirmed") {
      this.#repository.transitionAttempt({
        attemptId: attempt.attemptId,
        expectedState: "confirmed",
        expectedStateVersion: attempt.stateVersion,
        nextState: "reconciled",
        changedAt: at,
      });
    }
    if (reservation.state !== "resolved") {
      this.#repository.transitionNonceReservation({
        reservationId: reservation.reservationId,
        expectedState: reservation.state,
        expectedStateVersion: reservation.stateVersion,
        nextState: "resolved",
        foreignActivity: reservation.foreignActivity,
        changedAt: at,
      });
    }
  }

  async recover(input: ManagerClaimAssistRecoveryInput): Promise<ManagerClaimAssistRecoveryResult> {
    const at = parseObservedAt(input.observedAt);
    const liveAnchor = chainAnchorSchema.parse(input.liveAnchor);
    let job = this.#repository.getLogicalJob(input.jobId);
    if (job === null) return { status: "job-not-found", jobId: input.jobId };
    const attempts = this.#repository.listAttempts(job.jobId);
    let attempt = attempts.at(-1);
    if (!attempt) return { status: "no-persisted-attempt", jobId: job.jobId };
    let reservation = this.#repository.getNonceReservationForJob(job.jobId);

    if (attempt.state === "rejected" || attempt.state === "reconciled") {
      this.#normalizePersistedAttempt(job, attempt, at);
      if (
        attempt.state === "reconciled" &&
        reservation !== null &&
        reservation.state !== "resolved"
      ) {
        this.#repository.transitionNonceReservation({
          reservationId: reservation.reservationId,
          expectedState: reservation.state,
          expectedStateVersion: reservation.stateVersion,
          nextState: "resolved",
          foreignActivity: reservation.foreignActivity,
          changedAt: at,
        });
      }
      return {
        status: "already-resolved",
        jobId: job.jobId,
        attemptId: attempt.attemptId,
        attemptState: attempt.state,
        txid: attempt.precomputedTxid,
      };
    }
    if (reservation === null || reservation.state === "resolved") {
      return {
        status: "observation-unavailable",
        jobId: job.jobId,
        attemptId: attempt.attemptId,
        txid: attempt.precomputedTxid,
        reason: "The persisted attempt has no unresolved nonce reservation",
      };
    }
    this.#normalizePersistedAttempt(job, attempt, at);
    job = this.#repository.getLogicalJob(job.jobId) ?? job;
    reservation = this.#repository.getNonceReservationForJob(job.jobId) ?? reservation;

    let mempool: GasPayerMempoolActivityResult;
    try {
      mempool = await this.#api.enumerateGasPayerMempoolActivity(reservation.gasPayerPrincipal);
    } catch {
      return {
        status: "observation-unavailable",
        jobId: job.jobId,
        attemptId: attempt.attemptId,
        txid: attempt.precomputedTxid,
        reason: "Gas-payer mempool activity is unavailable",
      };
    }
    if (mempool.status !== "complete") {
      return {
        status: "observation-unavailable",
        jobId: job.jobId,
        attemptId: attempt.attemptId,
        txid: attempt.precomputedTxid,
        reason: `Gas-payer mempool enumeration is incomplete (${mempool.reason}; pages=${mempool.pagesRead}; observed=${mempool.observedTransactionCount}; reported=${mempool.reportedTotal})`,
      };
    }
    const reservedNonce = BigInt(reservation.nonce);
    const attemptTxid = attempt.precomputedTxid;
    const recognizedLocalMempool = mempool.nonceActivities.find(
      ({ txid, role, nonce, sponsor }) =>
        txid === attemptTxid && role === "origin" && nonce === reservedNonce && sponsor === null,
    );
    const inconsistentLocalMempool = mempool.nonceActivities.find(
      (activity) => activity.txid === attemptTxid && activity !== recognizedLocalMempool,
    );
    if (inconsistentLocalMempool !== undefined) {
      return {
        status: "observation-unavailable",
        jobId: job.jobId,
        attemptId: attempt.attemptId,
        txid: attempt.precomputedTxid,
        reason: "Recognized local mempool activity violates the sealed unsponsored nonce binding",
      };
    }
    const foreignMempool = mempool.nonceActivities.find(
      (activity) => activity.nonce >= reservedNonce && activity !== recognizedLocalMempool,
    );
    if (foreignMempool !== undefined) {
      this.#blockForeignActivity(job, attempt, reservation, at);
      return {
        status: "foreign-activity",
        jobId: job.jobId,
        attemptId: attempt.attemptId,
        txid: attempt.precomputedTxid,
        reservedNonce: reservation.nonce,
        observedAccountNonce: reservation.observedAccountNonce,
        localConfirmationObserved: false,
      };
    }

    const indexedResult = await this.#reader.lookupIndexedTransaction(attempt.precomputedTxid);
    const unconfirmedResult =
      indexedResult.status === "observed" && indexedResult.value.isCanonical
        ? null
        : await this.#reader.lookupUnconfirmedTransaction(attempt.precomputedTxid);
    const account = await this.#reader.readAnchoredAccount(
      reservation.gasPayerPrincipal,
      liveAnchor.indexBlockHash,
    );
    if (account.status !== "observed") {
      return {
        status: "observation-unavailable",
        jobId: job.jobId,
        attemptId: attempt.attemptId,
        txid: attempt.precomputedTxid,
        reason: `Account nonce observation is ${account.status}`,
      };
    }
    if (
      account.value.principal !== reservation.gasPayerPrincipal ||
      account.value.indexBlockHash !== liveAnchor.indexBlockHash
    ) {
      return {
        status: "observation-unavailable",
        jobId: job.jobId,
        attemptId: attempt.attemptId,
        txid: attempt.precomputedTxid,
        reason: "Account nonce observation does not bind the requested principal and anchor",
      };
    }

    const observedNonce = account.value.nonce;
    if (indexedResult.status === "observed" && !indexedResult.value.isCanonical) {
      const hadNoInclusion = attempt.inclusion === null;
      const noncanonical = this.#markPriorInclusionNoncanonical(
        job,
        attempt,
        reservation,
        liveAnchor,
        at,
      );
      if (hadNoInclusion) this.#appendNoncanonicalEvidence(job, liveAnchor, at);
      job = noncanonical.job;
      attempt = noncanonical.attempt;
      reservation = noncanonical.reservation;
      return {
        status: "noncanonical",
        jobId: job.jobId,
        attemptId: attempt.attemptId,
        txid: attempt.precomputedTxid,
      };
    }
    if (indexedResult.status === "observed" && indexedResult.value.isCanonical) {
      if (
        indexedResult.value.blockHeight === null ||
        indexedResult.value.nonce !== reservedNonce ||
        observedNonce < reservedNonce + 1n
      ) {
        return {
          status: "observation-unavailable",
          jobId: job.jobId,
          attemptId: attempt.attemptId,
          txid: attempt.precomputedTxid,
          reason: "Indexed confirmation and account nonce are inconsistent",
        };
      }
      let summary: TransactionSummary;
      try {
        summary = await this.#api.getTransaction(attempt.precomputedTxid);
      } catch {
        return {
          status: "observation-unavailable",
          jobId: job.jobId,
          attemptId: attempt.attemptId,
          txid: attempt.precomputedTxid,
          reason: "Reference API execution status is unavailable for the indexed transaction",
        };
      }
      if (
        summary.tx_id !== attempt.precomputedTxid ||
        summary.block.height !== Number(indexedResult.value.blockHeight) ||
        summary.block.index_hash !== indexedResult.value.indexBlockHash
      ) {
        return {
          status: "observation-unavailable",
          jobId: job.jobId,
          attemptId: attempt.attemptId,
          txid: attempt.precomputedTxid,
          reason: "Node and Reference API transaction inclusion facts disagree",
        };
      }
      const inclusion = this.#inclusion(attempt, summary, true, at);
      const foreignActivity = reservation.foreignActivity || observedNonce > reservedNonce + 1n;
      if (foreignActivity) {
        this.#blockForeignActivity(job, attempt, reservation, at);
        return {
          status: "foreign-activity",
          jobId: job.jobId,
          attemptId: attempt.attemptId,
          txid: attempt.precomputedTxid,
          reservedNonce: reservation.nonce,
          observedAccountNonce: observedNonce.toString(),
          localConfirmationObserved: true,
        };
      }
      if (summary.status !== "success") {
        const abort = await this.#holdOrFinalizeCanonicalAbort(
          job,
          attempt,
          reservation,
          inclusion,
          liveAnchor,
          at,
        );
        if (abort.status === "proof-unavailable") {
          return {
            status: "observation-unavailable",
            jobId: job.jobId,
            attemptId: attempt.attemptId,
            txid: attempt.precomputedTxid,
            reason: abort.reason,
          };
        }
        return {
          status: "aborted",
          jobId: job.jobId,
          attemptId: attempt.attemptId,
          txid: attempt.precomputedTxid,
          executionStatus: summary.status,
          finalityDepth: abort.finalityDepth,
          finalized: abort.finalized,
        };
      }
      const prepared = this.#prepareCanonicalInclusion(
        job,
        attempt,
        reservation,
        inclusion,
        liveAnchor,
        at,
      );
      this.#confirm(prepared.job, prepared.attempt, at, inclusion);
      if (job.state === "reconciled") {
        const confirmed = this.#repository.listAttempts(job.jobId).at(-1);
        const currentReservation = this.#repository.getNonceReservationForJob(job.jobId);
        if (
          confirmed?.state === "confirmed" &&
          currentReservation !== null &&
          currentReservation.state !== "resolved" &&
          this.#inclusionFinalityDepth(liveAnchor, inclusion) >= this.#finalityDepth
        ) {
          const proof = await proveCanonicalInclusionRelationship(this.#api, inclusion, liveAnchor);
          if (proof.status !== "proven") {
            return {
              status: "observation-unavailable",
              jobId: job.jobId,
              attemptId: attempt.attemptId,
              txid: attempt.precomputedTxid,
              reason: `Canonical success ancestry proof is ${proof.status} (${proof.reason})`,
            };
          }
          this.#finalizeReconciled(confirmed, currentReservation, at);
          return {
            status: "already-resolved",
            jobId: job.jobId,
            attemptId: attempt.attemptId,
            attemptState: "reconciled",
            txid: attempt.precomputedTxid,
          };
        }
      }
      return {
        status: "confirmed",
        jobId: job.jobId,
        attemptId: attempt.attemptId,
        txid: attempt.precomputedTxid,
        indexBlockHash: indexedResult.value.indexBlockHash,
      };
    }

    const unconfirmedObserved =
      unconfirmedResult?.status === "observed" || recognizedLocalMempool !== undefined;
    if (observedNonce !== reservedNonce) {
      this.#blockForeignActivity(job, attempt, reservation, at);
      return {
        status: "foreign-activity",
        jobId: job.jobId,
        attemptId: attempt.attemptId,
        txid: attempt.precomputedTxid,
        reservedNonce: reservation.nonce,
        observedAccountNonce: observedNonce.toString(),
        localConfirmationObserved: false,
      };
    }

    const lookupInconclusive =
      indexedResult.status === "unavailable" ||
      indexedResult.status === "schema-invalid" ||
      unconfirmedResult?.status === "unavailable" ||
      unconfirmedResult?.status === "schema-invalid";
    if (indexedResult.status === "not-found" && attempt.inclusion !== null) {
      const noncanonical = this.#markPriorInclusionNoncanonical(
        job,
        attempt,
        reservation,
        liveAnchor,
        at,
      );
      job = noncanonical.job;
      attempt = noncanonical.attempt;
      reservation = noncanonical.reservation;
    }
    if (job.state === "reconciled") {
      const retained = this.#markAmbiguous(job, attempt, reservation, at, false);
      attempt = retained.attempt;
      reservation = retained.reservation;
      if (unconfirmedObserved) {
        return {
          status: "externally-reconciled",
          jobId: job.jobId,
          attemptId: attempt.attemptId,
          txid: attempt.precomputedTxid,
          nonceState: "unresolved",
          reason: "local-transaction-unconfirmed",
        };
      }
      if (lookupInconclusive) {
        return {
          status: "observation-unavailable",
          jobId: job.jobId,
          attemptId: attempt.attemptId,
          txid: attempt.precomputedTxid,
          reason: "Transaction lookup is inconclusive after external reconciliation",
        };
      }
      return {
        status: "externally-reconciled",
        jobId: job.jobId,
        attemptId: attempt.attemptId,
        txid: attempt.precomputedTxid,
        nonceState: "unresolved",
        reason: "no-local-transaction",
      };
    }

    if (unconfirmedObserved) {
      this.#recognizeUnconfirmed(job, attempt, at);
    } else {
      this.#markAmbiguous(job, attempt, reservation, at, false);
    }
    const cause = unconfirmedObserved
      ? "still-unconfirmed"
      : lookupInconclusive
        ? "lookup-inconclusive"
        : attempt.state === "signed"
          ? "persisted-before-broadcast"
          : "not-found";
    return {
      status: "manual-intervention-required",
      jobId: job.jobId,
      attemptId: attempt.attemptId,
      txid: attempt.precomputedTxid,
      nonce: reservation.nonce,
      resolution: "automatic-replacement-unsupported",
      cause,
    };
  }
}
