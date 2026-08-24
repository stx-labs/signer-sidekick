import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ChainAnchor } from "../chain-anchor.js";
import { openSidekickStore, type SidekickStore } from "../storage/store.js";
import { seedAcceptedAttestation, seedLegacyApproval } from "./legacy-manager-claim.fixture.js";
import {
  type CommitApprovedSignedAttemptInput,
  type StoredTransactionApproval,
  type StoredTransactionJob,
  TransactionEngineCasError,
  transactionEngineDocumentSha256,
} from "./repository.js";

const time = {
  initial: "2026-07-17T12:00:00.000Z",
  one: "2026-07-17T12:01:00.000Z",
  two: "2026-07-17T12:02:00.000Z",
  three: "2026-07-17T12:03:00.000Z",
  four: "2026-07-17T12:04:00.000Z",
  five: "2026-07-17T12:05:00.000Z",
  expiry: "2026-07-17T13:00:00.000Z",
};
const manager = "ST3PF13W7Z0RRM42A8VZRVFQ75SV1K26RXEP8YGKJ.signer-manager";
const gasPayer = "ST3PF13W7Z0RRM42A8VZRVFQ75SV1K26RXEP8YGKJ";
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

afterEach(async () => {
  for (const store of openStores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function memoryStore(): Promise<{ store: SidekickStore; digest: string }> {
  const { store } = await openSidekickStore(":memory:", time.initial);
  openStores.push(store);
  return { store, digest: seedAcceptedAttestation(store).payloadSha256 };
}

function jobInput(digest: string, overrides: Record<string, unknown> = {}) {
  const intent = { operation: "claim-staker-rewards", rewardCycle: 91, amountSats: "1000" };
  const policy = { mode: "assist", maximumFeeUstx: "5000" };
  return {
    idempotencyKey: "claim:91:second-half:height-960240",
    operationScopeKey: "claim:91:second-half:height-960240",
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

/** Historical approvals and attempts are seeded directly: production no longer writes them. */
function approveAndCommit(store: SidekickStore, digest: string) {
  const awaiting = progressToAwaitingApproval(store, digest);
  const approval = seedLegacyApproval(store, awaiting, {
    createdAt: time.two,
    expiresAt: time.expiry,
  });
  const committed = store.transactionEngine.commitApprovedSignedAttempt(
    commitmentInput(awaiting, approval),
  );
  return { ...committed, approval };
}

describe("transaction engine repository", () => {
  it("enforces allowlisted job transitions and state/version compare-and-swap", async () => {
    const { store, digest } = await memoryStore();
    const awaiting = progressToAwaitingApproval(store, digest);

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
  });

  it("loads Activity attempts for many jobs without per-job reads", async () => {
    const { store, digest } = await memoryStore();
    const { job, attempt } = approveAndCommit(store, digest);
    const withoutAttempt = store.transactionEngine.createLogicalJob(
      jobInput(digest, {
        idempotencyKey: "claim:activity-without-attempt",
        operationScopeKey: "claim:activity-without-attempt",
      }),
    ).job;

    const attempts = store.transactionEngine.listAttemptsForActivity([
      withoutAttempt.jobId,
      job.jobId,
      job.jobId,
    ]);

    expect(attempts.get(job.jobId)).toEqual([attempt]);
    expect(attempts.has(withoutAttempt.jobId)).toBe(false);
    expect(store.transactionEngine.getLogicalJobByTxid(attempt.precomputedTxid)?.jobId).toBe(
      job.jobId,
    );
    expect(store.transactionEngine.getLogicalJobByTxid(`0x${"ff".repeat(32)}`)).toBeNull();
  });

  it("loads the direct job that a replacement superseded", async () => {
    const { store, digest } = await memoryStore();
    const operationScopeKey = "claim:activity-supersession";
    const first = store.transactionEngine.createLogicalJob(
      jobInput(digest, { operationScopeKey }),
    ).job;
    const replacementIntent = {
      operation: "claim-staker-rewards",
      rewardCycle: 91,
      amountSats: "2000",
    };
    const replacement = store.transactionEngine.createOrSupersedeLogicalJob(
      jobInput(digest, {
        idempotencyKey: "claim:91:second-half:height-960241",
        operationScopeKey,
        intent: replacementIntent,
        intentSha256: transactionEngineDocumentSha256(replacementIntent),
        chainAnchor: {
          ...anchor,
          stacksBlockHeight: anchor.stacksBlockHeight + 1,
          burnBlockHeight: anchor.burnBlockHeight + 1,
          indexBlockHash: `0x${"44".repeat(32)}`,
        },
        createdAt: time.one,
      }),
      { changedAt: time.one, reason: "newer anchored facts" },
    );

    expect(replacement.supersededJobId).toBe(first.jobId);
    expect(store.transactionEngine.getLogicalJobSupersededBy(replacement.job.jobId)?.jobId).toBe(
      first.jobId,
    );
  });

  it("keeps reconciliation evidence append-only and restores all durable state after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sidekick-engine-restart-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "sidekick.sqlite");
    const opened = await openSidekickStore(path, time.initial);
    const digest = seedAcceptedAttestation(opened.store).payloadSha256;
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

  it("persists irreversible Force Observe, invalidates approvals, and blocks new authority", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sidekick-engine-force-observe-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "sidekick.sqlite");
    const opened = await openSidekickStore(path, time.initial);
    const digest = seedAcceptedAttestation(opened.store).payloadSha256;
    const awaiting = progressToAwaitingApproval(opened.store, digest);
    const approval = seedLegacyApproval(opened.store, awaiting, {
      createdAt: time.two,
      expiresAt: time.expiry,
    });

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
    const secondPrepared = store.transactionEngine.createLogicalJob(
      jobInput(digest, {
        idempotencyKey: "other:claim:91",
        operationScopeKey: "other:claim:91",
        adapterId: "other-reviewed-adapter",
        createdAt: time.one,
      }),
    ).job;
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
    const firstApproval = seedLegacyApproval(store, first, {
      createdAt: time.two,
      expiresAt: time.expiry,
    });
    seedLegacyApproval(store, second, { createdAt: time.two, expiresAt: time.expiry });

    const disabled = store.transactionEngine.disableAdapter({
      adapterId: first.adapterId,
      reason: "adapter circuit breaker",
      actor: "operator:test",
      disabledAt: time.three,
    });
    expect(disabled).toMatchObject({ created: true, invalidatedApprovals: 1 });
    expect(store.transactionEngine.getLatestApproval(first.jobId)?.invalidatedAt).toBe(time.three);
    expect(store.transactionEngine.getLatestApproval(second.jobId)?.invalidatedAt).toBeNull();
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
});
