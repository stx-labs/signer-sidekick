import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type CompatibilityAttestationPayload,
  type CompatibilityAttestationTrustKey,
  compatibilityAttestationPayloadSha256,
  compatibilityAttestationSigningBytes,
  type SignedCompatibilityAttestation,
} from "@stx-labs/signer-sidekick-protocol/compatibility-attestation";
import { POX5_TESTNET_COMPATIBILITY } from "@stx-labs/signer-sidekick-protocol/known-network-compatibility";
import { afterEach, describe, expect, it } from "vitest";
import type { ChainAnchor } from "../chain-anchor.js";
import { openSidekickStore, type SidekickStore } from "../storage/store.js";
import { CompatibilityAttestationController } from "./attestation-controller.js";
import {
  type CommitApprovedSignedAttemptInput,
  InFlightLogicalJobConflictError,
  type StoredTransactionApproval,
  type StoredTransactionJob,
  TransactionEngineCasError,
  TransactionEngineConflictError,
  transactionEngineDocumentSha256,
} from "./repository.js";

const time = {
  initial: "2026-07-17T12:00:00.000Z",
  one: "2026-07-17T12:01:00.000Z",
  two: "2026-07-17T12:02:00.000Z",
  three: "2026-07-17T12:03:00.000Z",
  four: "2026-07-17T12:04:00.000Z",
  five: "2026-07-17T12:05:00.000Z",
  six: "2026-07-17T12:06:00.000Z",
  expiry: "2026-07-17T13:00:00.000Z",
};
const manager = "ST3PF13W7Z0RRM42A8VZRVFQ75SV1K26RXEP8YGKJ.signer-manager";
const gasPayer = "ST3PF13W7Z0RRM42A8VZRVFQ75SV1K26RXEP8YGKJ";
const keys = generateKeyPairSync("ed25519");
const trustKey: CompatibilityAttestationTrustKey = {
  keyId: "release-a",
  issuer: "stacks-labs",
  algorithm: "ed25519",
  publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
};
const anchor: ChainAnchor = {
  stacksBlockHeight: 8_600_000,
  indexBlockHash: `0x${"33".repeat(32)}`,
  burnBlockHeight: 960_240,
  rewardCycle: 91,
  rewardCycleLength: 2_100,
  prepareCycleLength: 100,
  cyclePosition: 1_050,
  phase: "reward",
  checkpoint: "second-half",
};

const openStores: SidekickStore[] = [];
const temporaryDirectories: string[] = [];
const attestationScope = {
  network: POX5_TESTNET_COMPATIBILITY.network,
  networkId: POX5_TESTNET_COMPATIBILITY.networkId,
} as const;

afterEach(async () => {
  for (const store of openStores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function payload(revision = 1): CompatibilityAttestationPayload {
  return {
    schemaVersion: 1,
    issuer: "stacks-labs",
    revision,
    issuedAt: "2026-07-17T00:00:00.000Z",
    notBefore: "2026-07-17T00:00:00.000Z",
    expiresAt: "2026-07-18T00:00:00.000Z",
    profile: POX5_TESTNET_COMPATIBILITY,
  };
}

function signed(value: CompatibilityAttestationPayload): SignedCompatibilityAttestation {
  return {
    schemaVersion: 1,
    algorithm: "ed25519",
    keyId: "release-a",
    payload: value,
    signature: sign(null, compatibilityAttestationSigningBytes(value), keys.privateKey).toString(
      "base64",
    ),
  };
}

async function acceptAttestation(store: SidekickStore, revision = 1): Promise<string> {
  const document = signed(payload(revision));
  const digest = compatibilityAttestationPayloadSha256(document.payload);
  await store.transactionEngine.accept(
    {
      acceptedState: {
        issuer: document.payload.issuer,
        revision,
        payloadSha256: digest,
        verifiedAt: time.initial,
      },
      document,
      acceptedAt: time.initial,
    },
    null,
  );
  return digest;
}

async function memoryStore(): Promise<{ store: SidekickStore; digest: string }> {
  const { store } = await openSidekickStore(":memory:", time.initial);
  openStores.push(store);
  return { store, digest: await acceptAttestation(store) };
}

function jobInput(digest: string, overrides: Record<string, unknown> = {}) {
  const intent = { operation: "claim-staker-rewards", rewardCycle: 91, amountSats: "1000" };
  const policy = { mode: "assist", maximumFeeUstx: "5000" };
  return {
    idempotencyKey: "claim:91:second-half:height-960240",
    adapterId: "manager-claim-staker-rewards",
    adapterRevision: 1,
    managerPrincipal: manager,
    intent,
    intentSha256: transactionEngineDocumentSha256(intent),
    policy,
    policySha256: transactionEngineDocumentSha256(policy),
    chainAnchor: anchor,
    attestation: { issuer: "stacks-labs", revision: 1, payloadSha256: digest },
    createdAt: time.initial,
    ...overrides,
  };
}

function progressToAwaitingApproval(store: SidekickStore, digest: string) {
  const created = store.transactionEngine.createLogicalJob(jobInput(digest)).job;
  const preflighted = store.transactionEngine.transitionLogicalJob({
    jobId: created.jobId,
    expectedState: "prepared",
    expectedStateVersion: 0,
    nextState: "preflighted",
    changedAt: time.one,
  });
  return store.transactionEngine.transitionLogicalJob({
    jobId: created.jobId,
    expectedState: "preflighted",
    expectedStateVersion: preflighted.stateVersion,
    nextState: "awaiting_approval",
    changedAt: time.two,
  });
}

function approveJob(store: SidekickStore, awaiting: StoredTransactionJob) {
  const approvalDocument = {
    intentSha256: awaiting.intentSha256,
    policySha256: awaiting.policySha256,
    maximumFeeUstx: "5000",
  };
  const approval = store.transactionEngine.createApproval({
    jobId: awaiting.jobId,
    expectedJobStateVersion: awaiting.stateVersion,
    intentSha256: awaiting.intentSha256,
    policySha256: awaiting.policySha256,
    approval: approvalDocument,
    approvalSha256: transactionEngineDocumentSha256(approvalDocument),
    actor: "operator:test",
    createdAt: time.two,
    expiresAt: time.expiry,
  }).approval;
  return approval;
}

function commitmentInput(
  job: StoredTransactionJob,
  approval: StoredTransactionApproval,
  overrides: Partial<CommitApprovedSignedAttemptInput> = {},
): CommitApprovedSignedAttemptInput {
  return {
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
    signedTransactionRef: "vault://signed/attempt-1",
    precomputedTxid: `0x${"11".repeat(32)}`,
    committedAt: time.three,
    ...overrides,
  };
}

function approveAndCommit(store: SidekickStore, digest: string) {
  const awaiting = progressToAwaitingApproval(store, digest);
  const approval = approveJob(store, awaiting);
  const committed = store.transactionEngine.commitApprovedSignedAttempt(
    commitmentInput(awaiting, approval),
  );
  return { ...committed, approval };
}

describe("transaction engine repository", () => {
  it("creates one immutable logical job per checkpoint and makes exact repeats idempotent", async () => {
    const { store, digest } = await memoryStore();
    const input = jobInput(digest);

    const first = store.transactionEngine.createLogicalJob(input);
    const repeated = store.transactionEngine.createLogicalJob(input);

    expect(first.created).toBe(true);
    expect(repeated).toMatchObject({ created: false, job: { jobId: first.job.jobId } });
    expect(repeated.job).toMatchObject({
      state: "prepared",
      intent: input.intent,
      policy: input.policy,
      chainAnchor: anchor,
    });
    expect(() =>
      store.transactionEngine.createLogicalJob(
        jobInput(digest, {
          intent: { operation: "claim-staker-rewards", amountSats: "1001" },
          intentSha256: transactionEngineDocumentSha256({
            operation: "claim-staker-rewards",
            amountSats: "1001",
          }),
        }),
      ),
    ).toThrow(TransactionEngineConflictError);
    expect(() =>
      store.transactionEngine.createLogicalJob({ ...input, intentSha256: "0".repeat(64) }),
    ).toThrow("Intent hash does not match");
  });

  it("enforces allowlisted job transitions, state/version CAS, and approval invalidation", async () => {
    const { store, digest } = await memoryStore();
    const awaiting = progressToAwaitingApproval(store, digest);
    const approvalDocument = { jobId: awaiting.jobId, maximumFeeUstx: "5000" };
    const approval = store.transactionEngine.createApproval({
      jobId: awaiting.jobId,
      expectedJobStateVersion: awaiting.stateVersion,
      intentSha256: awaiting.intentSha256,
      policySha256: awaiting.policySha256,
      approval: approvalDocument,
      approvalSha256: transactionEngineDocumentSha256(approvalDocument),
      actor: "operator:test",
      createdAt: time.two,
      expiresAt: time.expiry,
    }).approval;

    expect(() =>
      store.transactionEngine.transitionLogicalJob({
        jobId: awaiting.jobId,
        expectedState: "awaiting_approval",
        expectedStateVersion: awaiting.stateVersion,
        nextState: "broadcast",
        changedAt: time.three,
      }),
    ).toThrow("cannot transition");
    expect(() =>
      store.transactionEngine.transitionLogicalJob({
        jobId: awaiting.jobId,
        expectedState: "awaiting_approval",
        expectedStateVersion: awaiting.stateVersion,
        nextState: "nonce_reserved",
        changedAt: time.three,
      }),
    ).toThrow("atomic approved signed-attempt commitment");
    const blocked = store.transactionEngine.transitionLogicalJob({
      jobId: awaiting.jobId,
      expectedState: "awaiting_approval",
      expectedStateVersion: awaiting.stateVersion,
      nextState: "blocked",
      blockReason: "authoritative evidence changed",
      changedAt: time.three,
    });
    expect(blocked).toMatchObject({ state: "blocked", stateVersion: 3 });
    expect(store.transactionEngine.getActiveApproval(awaiting.jobId)).toBeNull();
    expect(() =>
      store.transactionEngine.transitionLogicalJob({
        jobId: awaiting.jobId,
        expectedState: "awaiting_approval",
        expectedStateVersion: awaiting.stateVersion,
        nextState: "blocked",
        blockReason: "stale",
        changedAt: time.four,
      }),
    ).toThrow(TransactionEngineCasError);
    expect(() =>
      store.transactionEngine.invalidateApproval({
        approvalId: approval.approvalId,
        expectedApprovalVersion: 0,
        reason: "again",
        invalidatedAt: time.four,
      }),
    ).toThrow(TransactionEngineCasError);
  });

  it("persists exact approvals with expiry and version compare-and-swap", async () => {
    const { store, digest } = await memoryStore();
    const awaiting = progressToAwaitingApproval(store, digest);
    const document = { recipient: manager, maximumFeeUstx: "5000", arguments: ["u91"] };
    const input = {
      jobId: awaiting.jobId,
      expectedJobStateVersion: awaiting.stateVersion,
      intentSha256: awaiting.intentSha256,
      policySha256: awaiting.policySha256,
      approval: document,
      approvalSha256: transactionEngineDocumentSha256(document),
      actor: "operator:test",
      createdAt: time.two,
      expiresAt: time.expiry,
    };
    const first = store.transactionEngine.createApproval(input);
    const exact = store.transactionEngine.createApproval(input);
    expect(first.created).toBe(true);
    expect(exact).toMatchObject({
      created: false,
      approval: { approvalId: first.approval.approvalId },
    });
    expect(store.transactionEngine.getActiveApproval(awaiting.jobId, time.three)?.approval).toEqual(
      document,
    );
    expect(
      store.transactionEngine.getActiveApproval(awaiting.jobId, "2026-07-17T14:00:00.000Z"),
    ).toBeNull();
    const invalidated = store.transactionEngine.invalidateApproval({
      approvalId: first.approval.approvalId,
      expectedApprovalVersion: 0,
      reason: "operator cancelled",
      invalidatedAt: time.three,
    });
    expect(invalidated).toMatchObject({
      approvalVersion: 1,
      invalidationReason: "operator cancelled",
    });
    expect(store.transactionEngine.getLatestApproval(awaiting.jobId)).toEqual(invalidated);
  });

  it("fails closed on stale approval bindings and concurrent commitment CAS", async () => {
    const { store, digest } = await memoryStore();
    const awaiting = progressToAwaitingApproval(store, digest);
    const approval = approveJob(store, awaiting);
    const input = commitmentInput(awaiting, approval);

    for (const invalid of [
      { ...input, expectedApprovalVersion: approval.approvalVersion + 1 },
      { ...input, expectedApprovalSha256: "ff".repeat(32) },
      { ...input, committedAt: time.expiry },
    ]) {
      expect(() => store.transactionEngine.commitApprovedSignedAttempt(invalid)).toThrow(
        TransactionEngineConflictError,
      );
      expect(store.transactionEngine.getLogicalJob(awaiting.jobId)).toMatchObject({
        state: "awaiting_approval",
        stateVersion: awaiting.stateVersion,
      });
      expect(store.transactionEngine.getNonceReservationForJob(awaiting.jobId)).toBeNull();
      expect(store.transactionEngine.listAttempts(awaiting.jobId)).toEqual([]);
    }

    const committed = store.transactionEngine.commitApprovedSignedAttempt(input);
    expect(committed).toMatchObject({
      created: true,
      job: { state: "nonce_reserved", stateVersion: awaiting.stateVersion + 1 },
      reservation: { state: "reserved", nonce: "7" },
      attempt: { state: "signed", precomputedTxid: input.precomputedTxid },
    });
    expect(store.transactionEngine.commitApprovedSignedAttempt(input)).toMatchObject({
      created: false,
      attempt: { attemptId: committed.attempt.attemptId },
    });
    expect(() =>
      store.transactionEngine.commitApprovedSignedAttempt({
        ...input,
        signedTransactionRef: "vault://signed/concurrent-attempt",
        precomputedTxid: `0x${"99".repeat(32)}`,
      }),
    ).toThrow(TransactionEngineCasError);
    expect(store.transactionEngine.listAttempts(awaiting.jobId)).toHaveLength(1);
  });

  it("rolls back job state and nonce ownership when signed-attempt insertion fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sidekick-engine-commit-rollback-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "sidekick.sqlite");
    const opened = await openSidekickStore(path, time.initial);
    openStores.push(opened.store);
    const digest = await acceptAttestation(opened.store);
    const awaiting = progressToAwaitingApproval(opened.store, digest);
    const approval = approveJob(opened.store, awaiting);
    const fault = new DatabaseSync(path);
    fault.exec(`
      CREATE TRIGGER test_abort_signed_commitment
      BEFORE INSERT ON transaction_attempts
      BEGIN SELECT RAISE(ABORT, 'injected signed commitment failure'); END;
    `);
    fault.close();

    expect(() =>
      opened.store.transactionEngine.commitApprovedSignedAttempt(
        commitmentInput(awaiting, approval),
      ),
    ).toThrow("injected signed commitment failure");
    expect(opened.store.transactionEngine.getLogicalJob(awaiting.jobId)).toMatchObject({
      state: "awaiting_approval",
      stateVersion: awaiting.stateVersion,
    });
    expect(opened.store.transactionEngine.getNonceReservationForJob(awaiting.jobId)).toBeNull();
    expect(opened.store.transactionEngine.listAttempts(awaiting.jobId)).toEqual([]);
  });

  it("finishes an existing nonce-reserved commitment without replacing its reservation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sidekick-engine-legacy-reservation-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "sidekick.sqlite");
    const opened = await openSidekickStore(path, time.initial);
    openStores.push(opened.store);
    const digest = await acceptAttestation(opened.store);
    const awaiting = progressToAwaitingApproval(opened.store, digest);
    const approval = approveJob(opened.store, awaiting);
    const reservationId = randomUUID();
    const legacy = new DatabaseSync(path);
    legacy
      .prepare(
        `UPDATE transaction_jobs SET
          state = 'nonce_reserved', state_version = state_version + 1, updated_at = ?
         WHERE job_id = ?`,
      )
      .run(time.three, awaiting.jobId);
    legacy
      .prepare(
        `INSERT INTO gas_payer_nonce_reservations (
          reservation_id, gas_payer_principal, job_id, nonce, observed_account_nonce,
          state, state_version, foreign_activity, created_at, updated_at, resolved_at
        ) VALUES (?, ?, ?, '7', '7', 'reserved', 0, 0, ?, ?, NULL)`,
      )
      .run(reservationId, gasPayer, awaiting.jobId, time.three, time.three);
    legacy.close();
    const nonceReserved = opened.store.transactionEngine.getLogicalJob(awaiting.jobId);
    if (nonceReserved === null) throw new Error("Expected legacy nonce-reserved job");

    const committed = opened.store.transactionEngine.commitApprovedSignedAttempt(
      commitmentInput(nonceReserved, approval, { committedAt: time.four }),
    );
    expect(committed).toMatchObject({
      created: true,
      job: { state: "nonce_reserved", stateVersion: nonceReserved.stateVersion },
      reservation: { reservationId },
      attempt: { state: "signed" },
    });
  });

  it("allows one unresolved gas-payer nonce and releases it only after explicit resolution", async () => {
    const { store, digest } = await memoryStore();
    const { job, approval, reservation } = approveAndCommit(store, digest);
    const exact = store.transactionEngine.commitApprovedSignedAttempt(
      commitmentInput(job, approval),
    );
    expect(exact).toMatchObject({
      created: false,
      reservation: { reservationId: reservation.reservationId },
    });
    expect(store.transactionEngine.getNonceReservationForJob(job.jobId)).toEqual(reservation);

    const secondJob = store.transactionEngine.createLogicalJob(
      jobInput(digest, { idempotencyKey: "claim:92:first-half:height-962340" }),
    ).job;
    const preflighted = store.transactionEngine.transitionLogicalJob({
      jobId: secondJob.jobId,
      expectedState: "prepared",
      expectedStateVersion: 0,
      nextState: "preflighted",
      changedAt: time.one,
    });
    const waiting = store.transactionEngine.transitionLogicalJob({
      jobId: secondJob.jobId,
      expectedState: "preflighted",
      expectedStateVersion: preflighted.stateVersion,
      nextState: "awaiting_approval",
      changedAt: time.two,
    });
    const secondApproval = approveJob(store, waiting);
    const secondCommitment = commitmentInput(waiting, secondApproval, {
      nonce: "8",
      observedAccountNonce: "8",
      precomputedTxid: `0x${"22".repeat(32)}`,
      signedTransactionRef: "vault://signed/attempt-2",
    });
    expect(() => store.transactionEngine.commitApprovedSignedAttempt(secondCommitment)).toThrow(
      "already has an unresolved nonce",
    );
    expect(store.transactionEngine.getLogicalJob(waiting.jobId)).toMatchObject({
      state: "awaiting_approval",
      stateVersion: waiting.stateVersion,
    });

    const ambiguous = store.transactionEngine.transitionNonceReservation({
      reservationId: reservation.reservationId,
      expectedState: "reserved",
      expectedStateVersion: 0,
      nextState: "ambiguous",
      foreignActivity: false,
      changedAt: time.four,
    });
    const foreign = store.transactionEngine.transitionNonceReservation({
      reservationId: reservation.reservationId,
      expectedState: "ambiguous",
      expectedStateVersion: ambiguous.stateVersion,
      nextState: "ambiguous",
      foreignActivity: true,
      changedAt: time.five,
    });
    expect(foreign).toMatchObject({
      state: "ambiguous",
      stateVersion: ambiguous.stateVersion + 1,
      foreignActivity: true,
      resolvedAt: null,
    });
    const resolved = store.transactionEngine.transitionNonceReservation({
      reservationId: reservation.reservationId,
      expectedState: "ambiguous",
      expectedStateVersion: foreign.stateVersion,
      nextState: "resolved",
      foreignActivity: true,
      changedAt: time.six,
    });
    expect(resolved).toMatchObject({ state: "resolved", foreignActivity: true });
    expect(
      store.transactionEngine.commitApprovedSignedAttempt({
        ...secondCommitment,
        committedAt: time.six,
      }).created,
    ).toBe(true);
  });

  it("reuses a resolved rejected nonce but still rejects concurrent unresolved ownership", async () => {
    const { store, digest } = await memoryStore();
    const first = approveAndCommit(store, digest);
    store.transactionEngine.transitionAttempt({
      attemptId: first.attempt.attemptId,
      expectedState: "signed",
      expectedStateVersion: first.attempt.stateVersion,
      nextState: "rejected",
      submissionResult: { status: "deterministic-rejection", reason: "FeeTooLow" },
      changedAt: time.four,
    });
    store.transactionEngine.transitionLogicalJob({
      jobId: first.job.jobId,
      expectedState: "nonce_reserved",
      expectedStateVersion: first.job.stateVersion,
      nextState: "blocked",
      blockReason: "broadcast-rejected:FeeTooLow",
      changedAt: time.four,
    });
    store.transactionEngine.transitionNonceReservation({
      reservationId: first.reservation.reservationId,
      expectedState: "reserved",
      expectedStateVersion: first.reservation.stateVersion,
      nextState: "resolved",
      foreignActivity: false,
      changedAt: time.four,
    });

    const prepareAwaiting = (idempotencyKey: string) => {
      const prepared = store.transactionEngine.createLogicalJob(
        jobInput(digest, { idempotencyKey }),
      ).job;
      const preflighted = store.transactionEngine.transitionLogicalJob({
        jobId: prepared.jobId,
        expectedState: "prepared",
        expectedStateVersion: prepared.stateVersion,
        nextState: "preflighted",
        changedAt: time.one,
      });
      return store.transactionEngine.transitionLogicalJob({
        jobId: prepared.jobId,
        expectedState: "preflighted",
        expectedStateVersion: preflighted.stateVersion,
        nextState: "awaiting_approval",
        changedAt: time.two,
      });
    };

    const secondAwaiting = prepareAwaiting("claim:retry-same-nonce");
    const secondApproval = approveJob(store, secondAwaiting);
    const second = store.transactionEngine.commitApprovedSignedAttempt(
      commitmentInput(secondAwaiting, secondApproval, {
        nonce: "7",
        observedAccountNonce: "7",
        feeUstx: "1200",
        feePolicyRevision: 2,
        signedTransactionRef: "vault://signed/retry-after-rejection",
        precomputedTxid: `0x${"22".repeat(32)}`,
        committedAt: time.five,
      }),
    );
    expect(second).toMatchObject({
      created: true,
      reservation: { nonce: "7", state: "reserved" },
      attempt: { state: "signed" },
    });

    const thirdAwaiting = prepareAwaiting("claim:concurrent-same-nonce");
    const thirdApproval = approveJob(store, thirdAwaiting);
    expect(() =>
      store.transactionEngine.commitApprovedSignedAttempt(
        commitmentInput(thirdAwaiting, thirdApproval, {
          nonce: "7",
          observedAccountNonce: "7",
          signedTransactionRef: "vault://signed/concurrent-reuse",
          precomputedTxid: `0x${"33".repeat(32)}`,
          committedAt: time.six,
        }),
      ),
    ).toThrow("already has an unresolved nonce reservation");
    expect(store.transactionEngine.getLogicalJob(thirdAwaiting.jobId)).toMatchObject({
      state: "awaiting_approval",
      stateVersion: thirdAwaiting.stateVersion,
    });
    expect(store.transactionEngine.getNonceReservationForJob(thirdAwaiting.jobId)).toBeNull();
  });

  it("persists exactly one txid before submission and rejects any later attempt", async () => {
    const { store, digest } = await memoryStore();
    const { job, approval, attempt: initial } = approveAndCommit(store, digest);
    expect(initial).toMatchObject({ state: "signed", submittedAt: null });
    const submitted = store.transactionEngine.transitionAttempt({
      attemptId: initial.attemptId,
      expectedState: "signed",
      expectedStateVersion: 0,
      nextState: "submitted",
      submissionResult: { accepted: true },
      changedAt: time.four,
    });
    expect(submitted).toMatchObject({ state: "submitted", submissionResult: { accepted: true } });
    expect(() =>
      store.transactionEngine.commitApprovedSignedAttempt(
        commitmentInput(job, approval, {
          feeUstx: "1200",
          feePolicyRevision: 2,
          signedTransactionRef: "vault://signed/attempt-2",
          precomputedTxid: `0x${"22".repeat(32)}`,
          committedAt: time.five,
        }),
      ),
    ).toThrow("only one signed transaction attempt");
    expect(store.transactionEngine.listAttempts(job.jobId)).toEqual([
      expect.objectContaining({ attemptId: initial.attemptId, state: "submitted" }),
    ]);
  });

  it("keeps reconciliation evidence append-only and restores all durable state after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sidekick-engine-restart-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "sidekick.sqlite");
    const opened = await openSidekickStore(path, time.initial);
    const digest = await acceptAttestation(opened.store);
    const job = opened.store.transactionEngine.createLogicalJob(jobInput(digest)).job;
    const predicate = { kind: "last-reward-cycle", expected: "91" };
    const observation = opened.store.transactionEngine.appendReconciliationObservation({
      jobId: job.jobId,
      predicate,
      predicateSha256: transactionEngineDocumentSha256(predicate),
      chainAnchor: anchor,
      authoritative: true,
      canonical: true,
      finalityDepth: 7,
      outcome: "pending",
      effectRemaining: true,
      observedAt: time.one,
    }).observation;
    opened.store.close();

    const restarted = await openSidekickStore(path, time.two);
    openStores.push(restarted.store);
    expect(restarted.store.transactionEngine.getLogicalJob(job.jobId)).toMatchObject({
      jobId: job.jobId,
      chainAnchor: anchor,
    });
    expect(restarted.store.transactionEngine.listReconciliationObservations(job.jobId)).toEqual([
      observation,
    ]);
    restarted.store.close();
    openStores.splice(openStores.indexOf(restarted.store), 1);

    const raw = new DatabaseSync(path);
    expect(() =>
      raw
        .prepare(
          "UPDATE transaction_reconciliation_observations SET outcome = 'satisfied' WHERE observation_id = ?",
        )
        .run(observation.observationId),
    ).toThrow("evidence is immutable");
    expect(() =>
      raw.prepare("UPDATE transaction_jobs SET intent_json = '{}' WHERE job_id = ?").run(job.jobId),
    ).toThrow("intent is immutable");
    raw.close();
  });

  it("implements durable attestation revision/digest CAS for the controller", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sidekick-engine-attestation-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "sidekick.sqlite");
    const attestationPath = join(directory, "attestation.json");
    await writeFile(attestationPath, JSON.stringify(signed(payload())), { mode: 0o600 });
    const opened = await openSidekickStore(path, time.initial);
    const controller = new CompatibilityAttestationController(
      opened.store.transactionEngine,
      [trustKey],
      attestationScope,
    );
    const accepted = await controller.acceptFile(attestationPath, new Date(time.initial));
    opened.store.close();

    const restarted = await openSidekickStore(path, time.one);
    openStores.push(restarted.store);
    const cached = await new CompatibilityAttestationController(
      restarted.store.transactionEngine,
      [trustKey],
      attestationScope,
    ).verifyCached("stacks-labs", new Date(time.one));
    expect(cached?.payloadSha256).toBe(accepted.payloadSha256);
    await expect(
      restarted.store.transactionEngine.accept(
        {
          acceptedState: {
            ...accepted.acceptedState,
            verifiedAt: time.two,
          },
          document: accepted.document,
          acceptedAt: time.two,
        },
        null,
      ),
    ).rejects.toBeInstanceOf(TransactionEngineCasError);
  });

  it("persists irreversible Force Observe, invalidates approval, and blocks new authority", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sidekick-engine-force-observe-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "sidekick.sqlite");
    const opened = await openSidekickStore(path, time.initial);
    const digest = await acceptAttestation(opened.store);
    const awaiting = progressToAwaitingApproval(opened.store, digest);
    const approvalDocument = { intentSha256: awaiting.intentSha256, emergencyTest: true };
    const approval = opened.store.transactionEngine.createApproval({
      jobId: awaiting.jobId,
      expectedJobStateVersion: awaiting.stateVersion,
      intentSha256: awaiting.intentSha256,
      policySha256: awaiting.policySha256,
      approval: approvalDocument,
      approvalSha256: transactionEngineDocumentSha256(approvalDocument),
      actor: "operator:test",
      createdAt: time.two,
      expiresAt: time.expiry,
    }).approval;

    const forced = opened.store.transactionEngine.forceObserve({
      reason: "operator emergency stop",
      actor: "operator:test",
      forcedAt: time.three,
    });
    const repeated = opened.store.transactionEngine.forceObserve({
      reason: "a later caller cannot rewrite the audit record",
      actor: "operator:other",
      forcedAt: time.four,
    });
    expect(forced).toMatchObject({ created: true, invalidatedApprovals: 1 });
    expect(repeated).toEqual({
      control: forced.control,
      created: false,
      invalidatedApprovals: 0,
    });
    expect(opened.store.transactionEngine.getLatestApproval(awaiting.jobId)).toMatchObject({
      invalidationReason: "emergency-force-observe",
      approvalVersion: 1,
    });
    expect(() =>
      opened.store.transactionEngine.commitApprovedSignedAttempt(
        commitmentInput(awaiting, approval, { committedAt: time.four }),
      ),
    ).toThrow("forced to Observe");
    opened.store.close();

    const restarted = await openSidekickStore(path, time.five);
    openStores.push(restarted.store);
    expect(restarted.store.transactionEngine.getForceObserveControl()).toEqual(forced.control);
    const raw = new DatabaseSync(path);
    expect(() => raw.prepare("DELETE FROM engine_force_observe_control").run()).toThrow(
      "Force Observe is irreversible",
    );
    raw.close();
  });

  it("disables one adapter irreversibly and invalidates only its approvals", async () => {
    const { store, digest } = await memoryStore();
    const first = progressToAwaitingApproval(store, digest);
    const secondInput = jobInput(digest, {
      idempotencyKey: "other:claim:91",
      operationScopeKey: "other:claim:91",
      adapterId: "other-reviewed-adapter",
      createdAt: time.one,
    });
    const secondPrepared = store.transactionEngine.createLogicalJob(secondInput).job;
    const secondPreflighted = store.transactionEngine.transitionLogicalJob({
      jobId: secondPrepared.jobId,
      expectedState: "prepared",
      expectedStateVersion: 0,
      nextState: "preflighted",
      changedAt: time.one,
    });
    const second = store.transactionEngine.transitionLogicalJob({
      jobId: secondPrepared.jobId,
      expectedState: "preflighted",
      expectedStateVersion: secondPreflighted.stateVersion,
      nextState: "awaiting_approval",
      changedAt: time.two,
    });
    let firstApproval: StoredTransactionApproval | null = null;
    for (const job of [first, second]) {
      const document = { jobId: job.jobId };
      const created = store.transactionEngine.createApproval({
        jobId: job.jobId,
        expectedJobStateVersion: job.stateVersion,
        intentSha256: job.intentSha256,
        policySha256: job.policySha256,
        approval: document,
        approvalSha256: transactionEngineDocumentSha256(document),
        actor: "operator:test",
        createdAt: time.two,
        expiresAt: time.expiry,
      }).approval;
      if (job.jobId === first.jobId) firstApproval = created;
    }
    if (firstApproval === null) throw new Error("Expected the first adapter approval");

    const disabled = store.transactionEngine.disableAdapter({
      adapterId: first.adapterId,
      reason: "adapter circuit breaker",
      actor: "operator:test",
      disabledAt: time.three,
    });
    expect(disabled).toMatchObject({ created: true, invalidatedApprovals: 1 });
    expect(store.transactionEngine.getActiveApproval(first.jobId)).toBeNull();
    expect(store.transactionEngine.getActiveApproval(second.jobId)).not.toBeNull();
    expect(store.transactionEngine.listDisabledAdapterControls()).toEqual([disabled.control]);
    expect(
      store.transactionEngine.disableAdapter({
        adapterId: first.adapterId,
        reason: "cannot rewrite",
        actor: "operator:other",
        disabledAt: time.four,
      }),
    ).toMatchObject({ created: false, control: disabled.control });
    expect(() =>
      store.transactionEngine.commitApprovedSignedAttempt(
        commitmentInput(first, firstApproval, { committedAt: time.four }),
      ),
    ).toThrow("irreversibly disabled");
  });

  it("lists jobs with immutable keyset cursors and reports control-plane counts", async () => {
    const { store, digest } = await memoryStore();
    const jobs = [time.one, time.two, time.three].map(
      (createdAt, index) =>
        store.transactionEngine.createLogicalJob(
          jobInput(digest, {
            idempotencyKey: `list-job-${index}`,
            operationScopeKey: `list-scope-${index}`,
            createdAt,
          }),
        ).job,
    );
    const [oldest, middle, newest] = jobs;
    if (!oldest || !middle || !newest) {
      throw new Error("expected three seeded jobs");
    }
    const preflighted = store.transactionEngine.transitionLogicalJob({
      jobId: middle.jobId,
      expectedState: "prepared",
      expectedStateVersion: 0,
      nextState: "preflighted",
      changedAt: time.three,
    });
    store.transactionEngine.transitionLogicalJob({
      jobId: preflighted.jobId,
      expectedState: "preflighted",
      expectedStateVersion: preflighted.stateVersion,
      nextState: "awaiting_approval",
      changedAt: time.four,
    });

    const firstPage = store.transactionEngine.listLogicalJobs({ limit: 2 });
    if (firstPage.nextCursor === null) {
      throw new Error("expected a cursor for the second page");
    }
    const secondPage = store.transactionEngine.listLogicalJobs({
      limit: 2,
      cursor: firstPage.nextCursor,
    });
    expect(firstPage).toMatchObject({
      total: 3,
      items: [{ jobId: newest.jobId }, { jobId: middle.jobId }],
    });
    expect(secondPage).toMatchObject({
      total: 3,
      nextCursor: null,
      items: [{ jobId: oldest.jobId }],
    });
    expect(new Set([...firstPage.items, ...secondPage.items].map(({ jobId }) => jobId)).size).toBe(
      3,
    );
    expect(store.transactionEngine.logicalJobStats()).toEqual({
      total: 3,
      active: 3,
      awaitingApproval: 1,
      ambiguous: 0,
    });
    expect(
      store.transactionEngine.listLogicalJobs({ states: ["awaiting_approval"] }),
    ).toMatchObject({
      total: 1,
      items: [{ jobId: middle.jobId }],
    });
    expect(() =>
      store.transactionEngine.listLogicalJobs({
        cursor: firstPage.nextCursor,
        states: ["prepared"],
      }),
    ).toThrow("cursor does not match");
  });

  it("rolls back emergency control creation if approval invalidation fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sidekick-engine-control-rollback-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "sidekick.sqlite");
    const opened = await openSidekickStore(path, time.initial);
    openStores.push(opened.store);
    const digest = await acceptAttestation(opened.store);
    const awaiting = progressToAwaitingApproval(opened.store, digest);
    const document = { jobId: awaiting.jobId };
    opened.store.transactionEngine.createApproval({
      jobId: awaiting.jobId,
      expectedJobStateVersion: awaiting.stateVersion,
      intentSha256: awaiting.intentSha256,
      policySha256: awaiting.policySha256,
      approval: document,
      approvalSha256: transactionEngineDocumentSha256(document),
      actor: "operator:test",
      createdAt: time.two,
      expiresAt: time.expiry,
    });
    const fault = new DatabaseSync(path);
    fault.exec(`
      CREATE TRIGGER test_abort_force_observe
      BEFORE UPDATE ON transaction_approvals
      WHEN NEW.invalidation_reason = 'emergency-force-observe'
      BEGIN SELECT RAISE(ABORT, 'injected control failure'); END;
    `);
    fault.close();

    expect(() =>
      opened.store.transactionEngine.forceObserve({
        reason: "must roll back",
        actor: "operator:test",
        forcedAt: time.three,
      }),
    ).toThrow("injected control failure");
    expect(opened.store.transactionEngine.getForceObserveControl()).toBeNull();
    expect(opened.store.transactionEngine.getActiveApproval(awaiting.jobId)).not.toBeNull();
  });

  it("refuses to supersede an in-flight nonce-owned job", async () => {
    const { store, digest } = await memoryStore();
    const initialInput = jobInput(digest, {
      operationScopeKey: "in-flight-scope",
    });
    const prepared = store.transactionEngine.createLogicalJob(initialInput).job;
    const preflighted = store.transactionEngine.transitionLogicalJob({
      jobId: prepared.jobId,
      expectedState: "prepared",
      expectedStateVersion: 0,
      nextState: "preflighted",
      changedAt: time.one,
    });
    const awaiting = store.transactionEngine.transitionLogicalJob({
      jobId: prepared.jobId,
      expectedState: "preflighted",
      expectedStateVersion: preflighted.stateVersion,
      nextState: "awaiting_approval",
      changedAt: time.two,
    });
    const approval = approveJob(store, awaiting);
    const nonceOwned = store.transactionEngine.commitApprovedSignedAttempt(
      commitmentInput(awaiting, approval),
    ).job;
    const changedIntent = { operation: "claim-staker-rewards", amountSats: "1001" };
    const newerAnchor = {
      ...anchor,
      stacksBlockHeight: anchor.stacksBlockHeight + 1,
      burnBlockHeight: anchor.burnBlockHeight + 1,
      indexBlockHash: `0x${"44".repeat(32)}`,
    };
    expect(() =>
      store.transactionEngine.createOrSupersedeLogicalJob(
        jobInput(digest, {
          idempotencyKey: "in-flight-changed-job",
          operationScopeKey: "in-flight-scope",
          intent: changedIntent,
          intentSha256: transactionEngineDocumentSha256(changedIntent),
          chainAnchor: newerAnchor,
          createdAt: time.four,
        }),
        { changedAt: time.four, reason: "newer facts" },
      ),
    ).toThrow(InFlightLogicalJobConflictError);
    expect(store.transactionEngine.getLogicalJob(nonceOwned.jobId)?.state).toBe("nonce_reserved");
  });
});
