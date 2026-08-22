import { generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { TransactionAdmissionInput } from "./admission.js";
import { RepositoryTransactionEngineApiService } from "./api-service.js";
import { GasPayerSigner } from "./gas-payer-signer.js";
import type {
  IndexedTransactionObservation,
  LiveLookup,
  LiveObservation,
  UnconfirmedTransactionObservation,
} from "./live-transaction-reader.js";
import {
  ManagerClaimAssistCoordinator,
  type ManagerClaimAssistCoordinatorOptions,
} from "./manager-claim-assist-coordinator.js";
import {
  type ManagerClaimObserveFacts,
  ObserveManagerClaimPlanner,
} from "./manager-claim-observer.js";
import {
  type StoredTransactionApproval,
  type TransactionEngineRepository,
  transactionEngineDocumentSha256,
} from "./repository.js";
import type { TransactionBroadcastResult } from "./transaction-broadcaster.js";

const secretKey = `${"11".repeat(32)}01`;
const publicKey = privateKeyToPublic(secretKey);
const gasPayer = getAddressFromPublicKey(publicKey, "testnet");
const manager = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.signer-manager";
const initial = "2026-07-17T12:00:00.000Z";
const approvalAt = "2026-07-17T12:01:00.000Z";
const executionAt = "2026-07-17T12:02:00.000Z";
const recoveryAt = "2026-07-17T12:03:00.000Z";
const expiresAt = "2026-07-17T13:00:00.000Z";
const attestationKeys = generateKeyPairSync("ed25519");
const stores = new Set<SidekickStore>();
const signers = new Set<GasPayerSigner>();
const directories = new Set<string>();

afterEach(async () => {
  for (const signer of signers) signer.destroy();
  signers.clear();
  for (const store of stores) store.close();
  stores.clear();
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
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

async function acceptAttestation(store: SidekickStore): Promise<string> {
  const document = signedAttestation();
  const digest = compatibilityAttestationPayloadSha256(document.payload);
  await store.transactionEngine.accept(
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
  return digest;
}

function facts(digest: string): ManagerClaimObserveFacts {
  return {
    schemaVersion: 1,
    observedAt: initial,
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
    controls: {
      mode: "assist",
      adapterEnabled: true,
      rewardsPaused: false,
    },
    effect: { remaining: true, completionEvidenceSha256: null },
    authoritative: { complete: true, canonical: true, finalityDepth: 1 },
  };
}

type Planned = Awaited<ReturnType<ObserveManagerClaimPlanner["observe"]>>;

interface Fixture {
  directory: string;
  path: string;
  store: SidekickStore;
  signer: GasPayerSigner;
  digest: string;
  planned: Planned;
  approval: StoredTransactionApproval | null;
}

async function fixture(options: { approve?: boolean } = {}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "sidekick-manager-assist-"));
  directories.add(directory);
  const path = join(directory, "sidekick.sqlite");
  const opened = await openSidekickStore(path, initial);
  stores.add(opened.store);
  const digest = await acceptAttestation(opened.store);
  const planned = await new ObserveManagerClaimPlanner(opened.store.transactionEngine).observe(
    facts(digest),
  );
  const secretPath = join(directory, "gas-payer.key");
  await writeFile(secretPath, `${secretKey}\n`, { mode: 0o600 });
  await chmod(secretPath, 0o600);
  const signer = await GasPayerSigner.fromSecretFile({
    secretFilePath: secretPath,
    expectedPrincipal: gasPayer,
    network: "testnet",
  });
  signers.add(signer);

  let approval: StoredTransactionApproval | null = null;
  if (options.approve ?? true) {
    const awaiting = opened.store.transactionEngine.transitionLogicalJob({
      jobId: planned.job.jobId,
      expectedState: "preflighted",
      expectedStateVersion: planned.job.stateVersion,
      nextState: "awaiting_approval",
      changedAt: approvalAt,
    });
    const document = {
      schemaVersion: 1,
      decision: "approve",
      jobId: awaiting.jobId,
      intentSha256: awaiting.intentSha256,
      policySha256: awaiting.policySha256,
      attestationSha256: digest,
      expiresAt,
    } as const;
    approval = opened.store.transactionEngine.createApproval({
      jobId: awaiting.jobId,
      expectedJobStateVersion: awaiting.stateVersion,
      intentSha256: awaiting.intentSha256,
      policySha256: awaiting.policySha256,
      approval: document,
      approvalSha256: transactionEngineDocumentSha256(document),
      actor: "operator:test",
      createdAt: approvalAt,
      expiresAt,
    }).approval;
  }
  return { directory, path, store: opened.store, signer, digest, planned, approval };
}

function admission(value: Fixture): TransactionAdmissionInput {
  const job = value.store.transactionEngine.getLogicalJob(value.planned.job.jobId);
  if (!job || !value.approval || !value.planned.plan)
    throw new Error("Approved fixture is missing");
  return {
    mode: "assist",
    intentHash: job.intentSha256,
    policyHash: job.policySha256,
    attestation: { current: true, payloadSha256: value.digest },
    expectedAttestationSha256: value.digest,
    liveFingerprintMatches: true,
    adapter: {
      id: MANAGER_CLAIM_REWARDS_ADAPTER_ID,
      revision: MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
    },
    expectedAdapter: {
      id: MANAGER_CLAIM_REWARDS_ADAPTER_ID,
      revision: MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
    },
    plannedAnchor: job.chainAnchor,
    liveAnchor: job.chainAnchor,
    anchorCanonical: true,
    anchorDescendant: true,
    prerequisitesComplete: true,
    fee: {
      stateMatches: true,
      transactionFeeUstx: BigInt(value.planned.plan.material.transaction.fee),
      maximumFeeUstx: 2_000n,
    },
    approval: {
      intentHash: value.approval.intentSha256,
      policyHash: value.approval.policySha256,
      expiresAt: value.approval.expiresAt,
      invalidatedAt: value.approval.invalidatedAt,
    },
    signer: {
      available: true,
      principal: value.signer.principal,
      expectedPrincipal: value.signer.principal,
    },
    nonce: { owned: true, unresolvedAttempt: false, foreignActivity: false },
    authoritativeBlockers: [],
    now: new Date(executionAt),
  };
}

interface ReaderControl {
  accountNonce: bigint;
  indexed: LiveLookup<IndexedTransactionObservation>;
  unconfirmed: LiveLookup<UnconfirmedTransactionObservation>;
}

function reader(
  control: Partial<ReaderControl> = {},
): ManagerClaimAssistCoordinatorOptions["reader"] & { calls: string[] } {
  const calls: string[] = [];
  const accountNonce = control.accountNonce ?? 7n;
  const indexed = control.indexed ?? ({ status: "not-found", httpStatus: 404 } as const);
  const unconfirmed = control.unconfirmed ?? ({ status: "not-found", httpStatus: 404 } as const);
  return {
    calls,
    readAnchoredAccount: vi.fn(async (principal, indexBlockHash) => {
      calls.push("account");
      return {
        status: "observed",
        httpStatus: 200,
        value: {
          principal,
          indexBlockHash: indexBlockHash as `0x${string}`,
          balanceUstx: 10_000n,
          lockedUstx: 0n,
          unlockHeight: 0n,
          nonce: accountNonce,
        },
      } satisfies LiveObservation<{
        principal: string;
        indexBlockHash: `0x${string}`;
        balanceUstx: bigint;
        lockedUstx: bigint;
        unlockHeight: bigint;
        nonce: bigint;
      }>;
    }),
    lookupIndexedTransaction: vi.fn(async () => {
      calls.push("indexed");
      return indexed;
    }),
    lookupUnconfirmedTransaction: vi.fn(async () => {
      calls.push("unconfirmed");
      return unconfirmed;
    }),
  };
}

function broadcaster(result: TransactionBroadcastResult, preserveTxid = false) {
  return {
    broadcast: vi.fn(async (signed) =>
      preserveTxid || result.txid === null ? result : { ...result, txid: signed.precomputedTxid },
    ),
  };
}

function accepted(txid = `0x${"11".repeat(32)}`): TransactionBroadcastResult {
  return { status: "accepted", txid: txid as `0x${string}`, httpStatus: 200 };
}

function apiReader(
  overrides: Partial<ManagerClaimAssistCoordinatorOptions["api"]> = {},
): ManagerClaimAssistCoordinatorOptions["api"] {
  return {
    enumerateGasPayerMempoolActivity: vi.fn(async (principal) => ({
      status: "complete" as const,
      principal,
      nonceActivities: [],
      pagesRead: 1,
      observedTransactionCount: 0,
      reportedTotal: 0,
    })),
    getTransaction: vi.fn(async (txid) => ({
      tx_id: txid as `0x${string}`,
      status: "success" as const,
      block: {
        height: 9_001,
        hash: `0x${"bc".repeat(32)}` as const,
        index_hash: `0x${"cd".repeat(32)}` as const,
        time: 1,
        tx_index: 0,
      },
      bitcoin_block: { height: 4_100, time: 1 },
    })),
    getStatus: vi.fn(async () => ({
      server_version: "stacks-blockchain-api v9",
      status: "ready",
      chain_tip: {
        block_height: 9_100,
        block_hash: `0x${"aa".repeat(32)}` as const,
        index_block_hash: `0x${"bb".repeat(32)}` as const,
        burn_block_height: 4_200,
      },
    })),
    getBlock: vi.fn(async (height: number) => ({
      canonical: true,
      height,
      hash: `0x${"bc".repeat(32)}` as const,
      index_block_hash: `0x${"cd".repeat(32)}` as const,
      parent_block_hash: `0x${"de".repeat(32)}` as const,
      parent_index_block_hash: `0x${"ef".repeat(32)}` as const,
      burn_block_height: 4_100,
    })),
    ...overrides,
  };
}

function coordinator(
  value: Fixture,
  options: {
    repository?: ManagerClaimAssistCoordinatorOptions["repository"];
    signer?: ManagerClaimAssistCoordinatorOptions["signer"];
    reader?: ManagerClaimAssistCoordinatorOptions["reader"];
    broadcaster?: ManagerClaimAssistCoordinatorOptions["broadcaster"];
    api?: ManagerClaimAssistCoordinatorOptions["api"];
    finalityDepth?: number;
    now?: () => Date;
  } = {},
): ManagerClaimAssistCoordinator {
  return new ManagerClaimAssistCoordinator({
    repository: options.repository ?? value.store.transactionEngine,
    signer: options.signer ?? value.signer,
    reader: options.reader ?? reader(),
    broadcaster: options.broadcaster ?? broadcaster(accepted()),
    api: options.api ?? apiReader(),
    finalityDepth: options.finalityDepth ?? 2,
    now: options.now ?? (() => new Date(executionAt)),
  });
}

function repositoryOverride(
  repository: TransactionEngineRepository,
  overrides: Partial<ManagerClaimAssistCoordinatorOptions["repository"]>,
): ManagerClaimAssistCoordinatorOptions["repository"] {
  return new Proxy(repository, {
    get(target, property) {
      const override = overrides[property as keyof typeof overrides];
      if (override) return override;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function executeAccepted(value: Fixture) {
  const broadcast = broadcaster(accepted());
  const result = await coordinator(value, { broadcaster: broadcast }).execute({
    jobId: value.planned.job.jobId,
    admission: admission(value),
  });
  const attempt = value.store.transactionEngine.listAttempts(value.planned.job.jobId).at(-1);
  if (!attempt) throw new Error("Accepted execution did not persist an attempt");
  return { result, attempt, broadcast };
}

function recoveryAnchor(value: Fixture) {
  return {
    ...value.planned.job.chainAnchor,
    stacksBlockHeight: value.planned.job.chainAnchor.stacksBlockHeight + 1,
    indexBlockHash: `0x${"cd".repeat(32)}` as const,
  };
}

function indexedReader(
  attempt: { precomputedTxid: string },
  options: { canonical?: boolean; accountNonce?: bigint } = {},
) {
  return reader({
    accountNonce: options.accountNonce ?? (options.canonical === false ? 7n : 8n),
    indexed: {
      status: "observed",
      httpStatus: 200,
      value: {
        txid: attempt.precomputedTxid as `0x${string}`,
        transactionHex: "00",
        nonce: 7n,
        feeUstx: 1_000n,
        indexBlockHash: `0x${"cd".repeat(32)}`,
        blockHeight: 9_001n,
        isCanonical: options.canonical ?? true,
        resultRepr: "(ok true)",
      },
    },
  });
}

describe("manager-claim Assist execution coordinator", () => {
  it("executes from the exact minimal approval persisted by the operator API service", async () => {
    const value = await fixture({ approve: false });
    const awaiting = value.store.transactionEngine.transitionLogicalJob({
      jobId: value.planned.job.jobId,
      expectedState: "preflighted",
      expectedStateVersion: value.planned.job.stateVersion,
      nextState: "awaiting_approval",
      changedAt: approvalAt,
    });
    const api = new RepositoryTransactionEngineApiService({
      repository: value.store.transactionEngine,
      requestedMode: "operator-run",
      legacyApprovals: true,
      maximumApprovalMinutes: 30,
      finalityDepth: 6,
      now: () => new Date(approvalAt),
    });
    const apiExpiry = "2026-07-17T12:30:00.000Z";
    await api.approve(
      awaiting.jobId,
      {
        decision: "approve",
        intentSha256: awaiting.intentSha256,
        policySha256: awaiting.policySha256,
        expiresAt: apiExpiry,
      },
      "operator:api",
    );
    value.approval = value.store.transactionEngine.getActiveApproval(awaiting.jobId, executionAt);
    expect(value.approval).toMatchObject({ actor: "operator:api", expiresAt: apiExpiry });

    await expect(
      coordinator(value).execute({ jobId: awaiting.jobId, admission: admission(value) }),
    ).resolves.toMatchObject({ status: "submitted", jobId: awaiting.jobId });
  });

  it("requires the exact current approval and exact durable broadcast admission", async () => {
    const unapproved = await fixture({ approve: false });
    const unread = reader();
    const unsigned = vi.fn(unapproved.signer.signManagerClaimRewardsPlan.bind(unapproved.signer));
    const result = await coordinator(unapproved, {
      reader: unread,
      signer: {
        principal: unapproved.signer.principal,
        publicKey: unapproved.signer.publicKey,
        signManagerClaimRewardsPlan: unsigned,
      },
    }).execute({
      jobId: unapproved.planned.job.jobId,
      admission: {
        ...admission({
          ...unapproved,
          approval: {
            approvalId: crypto.randomUUID(),
            jobId: unapproved.planned.job.jobId,
            intentSha256: unapproved.planned.job.intentSha256,
            policySha256: unapproved.planned.job.policySha256,
            approvalSha256: "00".repeat(32),
            approval: {},
            actor: "none",
            createdAt: initial,
            expiresAt,
            invalidatedAt: null,
            invalidationReason: null,
            approvalVersion: 0,
          },
        }),
      },
    });
    expect(result).toMatchObject({
      status: "blocked",
      code: "approval-missing-or-expired",
      message:
        "Approval is missing or expired. Sync chain data to prepare a new current job, then review and approve it",
    });
    expect(unread.readAnchoredAccount).not.toHaveBeenCalled();
    expect(unsigned).not.toHaveBeenCalled();

    const value = await fixture();
    const bad = admission(value);
    bad.liveAnchor = { ...bad.liveAnchor, indexBlockHash: `0x${"cd".repeat(32)}` };
    bad.anchorDescendant = false;
    const denied = await coordinator(value).execute({
      jobId: value.planned.job.jobId,
      admission: bad,
    });
    expect(denied).toMatchObject({ status: "blocked", code: "admission-denied" });
    expect(denied.status === "blocked" ? denied.admissionBlocks : []).toContainEqual({
      code: "anchor-mismatch",
      message:
        "The live chain cannot yet be proven from the planned anchor. Wait for the Reference API to catch up",
    });
    expect(
      value.store.transactionEngine.getNonceReservationForJob(value.planned.job.jobId),
    ).toBeNull();
  });

  it("directs a blocked job to a newly prepared current job", async () => {
    const value = await fixture();
    const current = value.store.transactionEngine.getLogicalJob(value.planned.job.jobId);
    if (current === null) throw new Error("Approved fixture is missing its job");
    value.store.transactionEngine.transitionLogicalJob({
      jobId: current.jobId,
      expectedState: "awaiting_approval",
      expectedStateVersion: current.stateVersion,
      nextState: "blocked",
      blockReason: "approval-revalidation:attestation-expired",
      changedAt: executionAt,
    });

    await expect(
      coordinator(value).execute({ jobId: current.jobId, admission: admission(value) }),
    ).resolves.toMatchObject({
      status: "blocked",
      code: "job-not-executable",
      message:
        "This job is blocked and cannot start Assist. Resolve its block reason, then sync chain data to prepare a new current job, review, and approve it",
    });
  });

  it("refuses nonce drift at the sealed anchor before reserving or signing", async () => {
    const value = await fixture();
    const signing = vi.fn(value.signer.signManagerClaimRewardsPlan.bind(value.signer));
    const result = await coordinator(value, {
      reader: reader({ accountNonce: 8n }),
      signer: {
        principal: value.signer.principal,
        publicKey: value.signer.publicKey,
        signManagerClaimRewardsPlan: signing,
      },
    }).execute({ jobId: value.planned.job.jobId, admission: admission(value) });

    expect(result).toMatchObject({ status: "blocked", code: "anchored-nonce-mismatch" });
    expect(signing).not.toHaveBeenCalled();
    expect(
      value.store.transactionEngine.getNonceReservationForJob(value.planned.job.jobId),
    ).toBeNull();
    expect(value.store.transactionEngine.getLogicalJob(value.planned.job.jobId)?.state).toBe(
      "awaiting_approval",
    );
  });

  it("uses its trusted clock instead of a caller-supplied stale approval time", async () => {
    const value = await fixture();
    const live = reader();
    const staleAdmission = admission(value);
    staleAdmission.now = new Date(approvalAt);
    const result = await coordinator(value, {
      reader: live,
      now: () => new Date("2026-07-17T13:00:00.000Z"),
    }).execute({ jobId: value.planned.job.jobId, admission: staleAdmission });

    expect(result).toMatchObject({
      status: "blocked",
      code: "approval-missing-or-expired",
      message:
        "Approval is missing or expired. Sync chain data to prepare a new current job, then review and approve it",
    });
    expect(live.readAnchoredAccount).not.toHaveBeenCalled();
  });

  it("revalidates approval after signing without creating a nonce commitment on invalidation", async () => {
    const value = await fixture();
    if (!value.approval) throw new Error("Approved fixture is missing its approval");
    const invalidationAt = "2026-07-17T12:02:30.000Z";
    const signer = {
      principal: value.signer.principal,
      publicKey: value.signer.publicKey,
      signManagerClaimRewardsPlan: vi.fn(async (plan) => {
        value.store.transactionEngine.invalidateApproval({
          approvalId: value.approval?.approvalId ?? "",
          expectedApprovalVersion: value.approval?.approvalVersion ?? -1,
          reason: "operator cancelled during signing",
          invalidatedAt: invalidationAt,
        });
        return value.signer.signManagerClaimRewardsPlan(plan);
      }),
    };
    const send = broadcaster(accepted());
    const result = await coordinator(value, { signer, broadcaster: send }).execute({
      jobId: value.planned.job.jobId,
      admission: admission(value),
    });

    expect(result).toMatchObject({
      status: "blocked",
      code: "approval-missing-or-expired",
      message:
        "Approval changed before broadcast. Sync chain data to prepare a new current job, then review and approve it",
    });
    expect(send.broadcast).not.toHaveBeenCalled();
    expect(value.store.transactionEngine.listAttempts(value.planned.job.jobId)).toEqual([]);
    expect(value.store.transactionEngine.getLogicalJob(value.planned.job.jobId)).toMatchObject({
      state: "blocked",
      blockReason: "approval-invalid-before-broadcast-commitment",
    });
    expect(
      value.store.transactionEngine.getNonceReservationForJob(value.planned.job.jobId),
    ).toBeNull();
  });

  it("treats a broadcaster txid mismatch as ambiguous using only the persisted txid", async () => {
    const value = await fixture();
    const mismatched = broadcaster(
      { status: "accepted", txid: `0x${"99".repeat(32)}`, httpStatus: 200 },
      true,
    );
    const result = await coordinator(value, { broadcaster: mismatched }).execute({
      jobId: value.planned.job.jobId,
      admission: admission(value),
    });
    const attempt = value.store.transactionEngine.listAttempts(value.planned.job.jobId)[0];

    expect(result).toMatchObject({
      status: "ambiguous",
      txid: attempt?.precomputedTxid,
    });
    expect(result.status === "ambiguous" ? result.txid : null).not.toBe(`0x${"99".repeat(32)}`);
    expect(attempt).toMatchObject({
      state: "ambiguous",
      submissionResult: {
        status: "ambiguous",
        reason: "invalid-success-response",
        txid: attempt?.precomputedTxid,
      },
    });
  });

  it("reserves the sealed anchored nonce and persists a redacted reference and txid before broadcast", async () => {
    const value = await fixture();
    const events: string[] = [];
    const signer = {
      principal: value.signer.principal,
      publicKey: value.signer.publicKey,
      signManagerClaimRewardsPlan: vi.fn(async (plan) => {
        events.push("sign");
        expect(
          value.store.transactionEngine.getNonceReservationForJob(value.planned.job.jobId),
        ).toBeNull();
        expect(value.store.transactionEngine.listAttempts(value.planned.job.jobId)).toEqual([]);
        return value.signer.signManagerClaimRewardsPlan(plan);
      }),
    };
    const broadcast = {
      broadcast: vi.fn(async (signed) => {
        events.push("broadcast");
        const persisted = value.store.transactionEngine.listAttempts(value.planned.job.jobId);
        expect(persisted).toHaveLength(1);
        expect(persisted[0]).toMatchObject({
          state: "signed",
          precomputedTxid: signed.precomputedTxid,
        });
        expect(persisted[0]?.signedTransactionRef).toMatch(
          /^manager-claim-regenerable:v1:[0-9a-f]{64}:[0-9a-f]{64}:7$/,
        );
        expect(JSON.stringify(persisted)).not.toContain(
          Buffer.from(signed.signedTransactionBytes).toString("hex"),
        );
        return { status: "accepted", txid: signed.precomputedTxid, httpStatus: 200 } as const;
      }),
    };
    const result = await coordinator(value, { signer, broadcaster: broadcast }).execute({
      jobId: value.planned.job.jobId,
      admission: admission(value),
    });

    expect(result).toMatchObject({ status: "submitted", jobId: value.planned.job.jobId });
    expect(events).toEqual(["sign", "broadcast"]);
    expect(value.store.transactionEngine.getLogicalJob(value.planned.job.jobId)?.state).toBe(
      "broadcast",
    );
    expect(value.store.transactionEngine.listAttempts(value.planned.job.jobId)[0]?.state).toBe(
      "submitted",
    );
    expect(JSON.stringify(result)).not.toContain("signedTransactionBytes");
    expect(
      JSON.stringify(value.store.transactionEngine.listAttempts(value.planned.job.jobId)),
    ).not.toContain(secretKey);
  });

  it.each([
    {
      label: "an ambiguous transport result",
      broadcast: {
        status: "ambiguous",
        txid: `0x${"22".repeat(32)}`,
        httpStatus: null,
        reason: "timeout",
      } as const,
      result: "ambiguous",
      job: "ambiguous",
      attempt: "ambiguous",
      reservation: "ambiguous",
    },
    {
      label: "a node rejection with unresolved nonce ownership",
      broadcast: {
        status: "ambiguous",
        txid: `0x${"33".repeat(32)}`,
        httpStatus: 400,
        reason: "node-rejection",
        nodeMessage: "BadNonce",
      } as const,
      result: "ambiguous",
      job: "ambiguous",
      attempt: "ambiguous",
      reservation: "ambiguous",
    },
    {
      label: "a locally proven invalid signed attempt",
      broadcast: {
        status: "deterministic-rejection",
        txid: `0x${"34".repeat(32)}`,
        httpStatus: null,
        reason: "invalid-signed-attempt",
        nodeMessage: null,
      } as const,
      result: "rejected",
      job: "blocked",
      attempt: "rejected",
      reservation: "resolved",
      blockReason: "broadcast-rejected:invalid-signed-attempt",
    },
  ])("durably classifies $label without retry", async (expected) => {
    const value = await fixture();
    const send = broadcaster(expected.broadcast);
    const result = await coordinator(value, { broadcaster: send }).execute({
      jobId: value.planned.job.jobId,
      admission: admission(value),
    });
    expect(result.status).toBe(expected.result);
    expect(send.broadcast).toHaveBeenCalledOnce();
    expect(value.store.transactionEngine.getLogicalJob(value.planned.job.jobId)?.state).toBe(
      expected.job,
    );
    expect(value.store.transactionEngine.listAttempts(value.planned.job.jobId)[0]?.state).toBe(
      expected.attempt,
    );
    expect(
      value.store.transactionEngine.getNonceReservationForJob(value.planned.job.jobId)?.state,
    ).toBe(expected.reservation);
    if ("blockReason" in expected) {
      expect(
        value.store.transactionEngine.getLogicalJob(value.planned.job.jobId)?.blockReason,
      ).toBe(expected.blockReason);
    }
  });

  it.each([
    {
      label: "accepted",
      broadcast: { status: "accepted", txid: `0x${"44".repeat(32)}`, httpStatus: 200 } as const,
      attempt: "submitted",
      job: "broadcast",
      reservation: "reserved",
    },
    {
      label: "ambiguous",
      broadcast: {
        status: "ambiguous",
        txid: `0x${"55".repeat(32)}`,
        httpStatus: 503,
        reason: "server-error",
      } as const,
      attempt: "ambiguous",
      job: "ambiguous",
      reservation: "ambiguous",
    },
    {
      label: "rejected",
      broadcast: {
        status: "deterministic-rejection",
        txid: `0x${"66".repeat(32)}`,
        httpStatus: null,
        reason: "invalid-signed-attempt",
        nodeMessage: null,
      } as const,
      attempt: "rejected",
      job: "blocked",
      reservation: "resolved",
      blockReason: "broadcast-rejected:durable-attempt-result",
    },
  ])("finishes a persisted $label outcome after a crash without rebroadcast", async (expected) => {
    const value = await fixture();
    const transition = value.store.transactionEngine.transitionLogicalJob.bind(
      value.store.transactionEngine,
    );
    const interrupted = repositoryOverride(value.store.transactionEngine, {
      transitionLogicalJob: (input) => {
        if (input.nextState === expected.job) {
          throw new Error("simulated crash after attempt outcome");
        }
        return transition(input);
      },
    });
    await expect(
      coordinator(value, {
        repository: interrupted,
        broadcaster: broadcaster(expected.broadcast),
      }).execute({
        jobId: value.planned.job.jobId,
        admission: admission(value),
      }),
    ).rejects.toThrow("simulated crash after attempt outcome");
    expect(value.store.transactionEngine.listAttempts(value.planned.job.jobId)[0]?.state).toBe(
      expected.attempt,
    );
    expect(value.store.transactionEngine.getLogicalJob(value.planned.job.jobId)?.state).toBe(
      "nonce_reserved",
    );

    const forbidden = broadcaster(accepted());
    await expect(
      coordinator(value, { broadcaster: forbidden }).execute({
        jobId: value.planned.job.jobId,
        admission: admission(value),
      }),
    ).resolves.toMatchObject({ status: "persisted-attempt", attemptState: expected.attempt });
    expect(forbidden.broadcast).not.toHaveBeenCalled();
    expect(value.store.transactionEngine.getLogicalJob(value.planned.job.jobId)?.state).toBe(
      expected.job,
    );
    expect(
      value.store.transactionEngine.getNonceReservationForJob(value.planned.job.jobId)?.state,
    ).toBe(expected.reservation);
    if ("blockReason" in expected) {
      expect(
        value.store.transactionEngine.getLogicalJob(value.planned.job.jobId)?.blockReason,
      ).toBe(expected.blockReason);
    }
  });

  it("leaves no partial nonce ownership when the atomic signed commitment fails", async () => {
    const value = await fixture();
    const commit = vi.fn(() => {
      throw new Error("simulated crash before atomic commitment");
    });
    const interruptedRepository = repositoryOverride(value.store.transactionEngine, {
      commitApprovedSignedAttempt: commit,
    });
    await expect(
      coordinator(value, { repository: interruptedRepository }).execute({
        jobId: value.planned.job.jobId,
        admission: admission(value),
      }),
    ).rejects.toThrow("simulated crash");
    expect(value.store.transactionEngine.getLogicalJob(value.planned.job.jobId)).toMatchObject({
      state: "awaiting_approval",
    });
    expect(
      value.store.transactionEngine.getNonceReservationForJob(value.planned.job.jobId),
    ).toBeNull();
    expect(value.store.transactionEngine.listAttempts(value.planned.job.jobId)).toEqual([]);
    await expect(
      coordinator(value).execute({
        jobId: value.planned.job.jobId,
        admission: admission(value),
      }),
    ).resolves.toMatchObject({ status: "submitted" });
  });

  it("never rebroadcasts after a crash following the atomic signed commitment", async () => {
    const value = await fixture();
    const crash = { broadcast: vi.fn(async () => Promise.reject(new Error("process crashed"))) };
    await expect(
      coordinator(value, { broadcaster: crash }).execute({
        jobId: value.planned.job.jobId,
        admission: admission(value),
      }),
    ).rejects.toThrow("process crashed");
    expect(value.store.transactionEngine.listAttempts(value.planned.job.jobId)).toMatchObject([
      { state: "signed" },
    ]);
    expect(value.store.transactionEngine.getLogicalJob(value.planned.job.jobId)).toMatchObject({
      state: "nonce_reserved",
    });
    expect(
      value.store.transactionEngine.getNonceReservationForJob(value.planned.job.jobId),
    ).toMatchObject({ state: "reserved", nonce: "7" });

    value.store.close();
    stores.delete(value.store);
    const reopened = await openSidekickStore(value.path, recoveryAt);
    stores.add(reopened.store);
    value.store = reopened.store;
    const forbidden = broadcaster(accepted());
    const resumed = await coordinator(value, { broadcaster: forbidden }).execute({
      jobId: value.planned.job.jobId,
      admission: admission(value),
    });
    expect(resumed).toMatchObject({
      status: "persisted-attempt",
      attemptState: "signed",
      recoveryRequired: true,
    });
    expect(forbidden.broadcast).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "incomplete enumeration",
      activity: (principal: string) => ({
        status: "incomplete" as const,
        reason: "page-limit" as const,
        principal,
        nonceActivities: [],
        pagesRead: 10,
        observedTransactionCount: 0,
        reportedTotal: 1,
      }),
      code: "mempool-observation-unavailable",
    },
    {
      label: "same nonce",
      activity: (principal: string) => ({
        status: "complete" as const,
        principal,
        nonceActivities: [
          {
            txid: `0x${"44".repeat(32)}` as const,
            principal,
            nonce: 7n,
            role: "origin" as const,
            state: "mempool" as const,
            origin: { principal, nonce: 7n },
            sponsor: null,
          },
        ],
        pagesRead: 1,
        observedTransactionCount: 1,
        reportedTotal: 1,
      }),
      code: "foreign-nonce-activity",
    },
    {
      label: "higher nonce",
      activity: (principal: string) => ({
        status: "complete" as const,
        principal,
        nonceActivities: [
          {
            txid: `0x${"55".repeat(32)}` as const,
            principal,
            nonce: 8n,
            role: "origin" as const,
            state: "mempool" as const,
            origin: { principal, nonce: 8n },
            sponsor: null,
          },
        ],
        pagesRead: 1,
        observedTransactionCount: 1,
        reportedTotal: 1,
      }),
      code: "foreign-nonce-activity",
    },
  ])("blocks execution on $label mempool activity", async ({ activity, code }) => {
    const value = await fixture();
    const api = apiReader({
      enumerateGasPayerMempoolActivity: vi.fn(async (principal) => activity(principal)),
    });
    await expect(
      coordinator(value, { api }).execute({
        jobId: value.planned.job.jobId,
        admission: admission(value),
      }),
    ).resolves.toMatchObject(
      code === "mempool-observation-unavailable"
        ? {
            status: "blocked",
            code,
            message:
              "Gas-payer mempool enumeration is incomplete (page-limit; pages=10; observed=0; reported=1)",
          }
        : { status: "blocked", code },
    );
    expect(
      value.store.transactionEngine.getNonceReservationForJob(value.planned.job.jobId),
    ).toBeNull();
  });

  it("blocks execution when mempool enumeration is unavailable", async () => {
    const value = await fixture();
    const api = apiReader({
      enumerateGasPayerMempoolActivity: vi.fn(async () => {
        throw new Error("upstream unavailable");
      }),
    });
    await expect(
      coordinator(value, { api }).execute({
        jobId: value.planned.job.jobId,
        admission: admission(value),
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      code: "mempool-observation-unavailable",
      message:
        "Gas-payer mempool activity could not be read. Check Reference API connectivity and compatibility",
    });
  });

  it.each([
    {
      label: "rejected",
      account: { status: "unavailable" as const, httpStatus: 403, reason: "http-error" as const },
      message: "The node rejected the gas-payer account request. Check its URL and access settings",
    },
    {
      label: "incompatible",
      account: {
        status: "schema-invalid" as const,
        httpStatus: 200,
        reason: "unexpected-response" as const,
      },
      message:
        "The gas-payer account response is incompatible with Sidekick. Check node compatibility",
    },
  ])("reports a $label account read without calling it a catch-up delay", async ({
    account,
    message,
  }) => {
    const value = await fixture();
    const live = reader();
    live.readAnchoredAccount = vi.fn(async () => account);

    await expect(
      coordinator(value, { reader: live }).execute({
        jobId: value.planned.job.jobId,
        admission: admission(value),
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      code: "account-observation-unavailable",
      message,
    });
  });
});

describe("manager-claim Assist recovery coordinator", () => {
  it("probes indexed state before account state and durably recognizes confirmation", async () => {
    const value = await fixture();
    const executed = await executeAccepted(value);
    const live = reader({
      accountNonce: 8n,
      indexed: {
        status: "observed",
        httpStatus: 200,
        value: {
          txid: executed.attempt.precomputedTxid as `0x${string}`,
          transactionHex: "00",
          nonce: 7n,
          feeUstx: 1_000n,
          indexBlockHash: `0x${"cd".repeat(32)}`,
          blockHeight: 9_001n,
          isCanonical: true,
          resultRepr: "(ok true)",
        },
      },
    });
    const result = await coordinator(value, { reader: live }).recover({
      jobId: value.planned.job.jobId,
      liveAnchor: {
        ...value.planned.job.chainAnchor,
        stacksBlockHeight: 9_001,
        indexBlockHash: `0x${"cd".repeat(32)}`,
      },
      observedAt: recoveryAt,
    });

    expect(result).toMatchObject({ status: "confirmed", txid: executed.attempt.precomputedTxid });
    expect(live.calls).toEqual(["indexed", "account"]);
    expect(live.lookupUnconfirmedTransaction).not.toHaveBeenCalled();
    expect(value.store.transactionEngine.getLogicalJob(value.planned.job.jobId)?.state).toBe(
      "confirmed",
    );
    expect(value.store.transactionEngine.getAttempt(executed.attempt.attemptId)?.state).toBe(
      "confirmed",
    );
    expect(
      value.store.transactionEngine.getNonceReservationForJob(value.planned.job.jobId)?.state,
    ).toBe("reserved");
  });

  it.each([
    "abort_by_response",
    "abort_by_post_condition",
  ] as const)("holds a canonical %s execution through finality before rejection", async (executionStatus) => {
    const value = await fixture();
    const executed = await executeAccepted(value);
    const api = apiReader({
      getTransaction: vi.fn(async (txid) => ({
        tx_id: txid as `0x${string}`,
        status: executionStatus,
        block: {
          height: 9_001,
          hash: `0x${"bc".repeat(32)}`,
          index_hash: `0x${"cd".repeat(32)}`,
          time: 1,
          tx_index: 0,
        },
        bitcoin_block: { height: 4_100, time: 1 },
      })),
    });

    await expect(
      coordinator(value, { reader: indexedReader(executed.attempt), api }).recover({
        jobId: value.planned.job.jobId,
        liveAnchor: recoveryAnchor(value),
        observedAt: recoveryAt,
      }),
    ).resolves.toMatchObject({
      status: "aborted",
      executionStatus,
      finalityDepth: 0,
      finalized: false,
    });
    expect(value.store.transactionEngine.getAttempt(executed.attempt.attemptId)).toMatchObject({
      state: "ambiguous",
      inclusion: { executionStatus, canonical: true },
    });
    expect(value.store.transactionEngine.getLogicalJob(value.planned.job.jobId)?.state).toBe(
      "ambiguous",
    );
    expect(
      value.store.transactionEngine.getNonceReservationForJob(value.planned.job.jobId)?.state,
    ).toBe("ambiguous");

    await expect(
      coordinator(value, { reader: indexedReader(executed.attempt), api }).recover({
        jobId: value.planned.job.jobId,
        liveAnchor: { ...recoveryAnchor(value), stacksBlockHeight: 9_003 },
        observedAt: "2026-07-17T12:04:00.000Z",
      }),
    ).resolves.toMatchObject({
      status: "aborted",
      executionStatus,
      finalityDepth: 2,
      finalized: true,
    });
    expect(value.store.transactionEngine.getAttempt(executed.attempt.attemptId)?.state).toBe(
      "rejected",
    );
    expect(value.store.transactionEngine.getLogicalJob(value.planned.job.jobId)).toMatchObject({
      state: "blocked",
      blockReason: `canonical-transaction-${executionStatus}`,
    });
    expect(
      value.store.transactionEngine.getNonceReservationForJob(value.planned.job.jobId)?.state,
    ).toBe("resolved");
  });

  it("retains a final-depth abort when its inclusion is not proven on the live canonical ancestry", async () => {
    const value = await fixture();
    const executed = await executeAccepted(value);
    const api = apiReader({
      getTransaction: vi.fn(async (txid) => ({
        tx_id: txid as `0x${string}`,
        status: "abort_by_response" as const,
        block: {
          height: 9_001,
          hash: `0x${"bc".repeat(32)}` as const,
          index_hash: `0x${"cd".repeat(32)}` as const,
          time: 1,
          tx_index: 0,
        },
        bitcoin_block: { height: 4_100, time: 1 },
      })),
      getBlock: vi.fn(async (height: number) => ({
        canonical: true,
        height,
        hash: `0x${"bc".repeat(32)}` as const,
        index_block_hash:
          height === 9_001 ? (`0x${"ee".repeat(32)}` as const) : (`0x${"cd".repeat(32)}` as const),
        parent_block_hash: `0x${"de".repeat(32)}` as const,
        parent_index_block_hash: `0x${"ef".repeat(32)}` as const,
        burn_block_height: 4_100,
      })),
    });

    await expect(
      coordinator(value, {
        reader: indexedReader(executed.attempt),
        api,
        finalityDepth: 1,
      }).recover({
        jobId: value.planned.job.jobId,
        liveAnchor: { ...recoveryAnchor(value), stacksBlockHeight: 9_002 },
        observedAt: recoveryAt,
      }),
    ).resolves.toMatchObject({
      status: "observation-unavailable",
      reason: "Canonical abort ancestry proof is invalid (planned-anchor-mismatch)",
    });
    expect(value.store.transactionEngine.getAttempt(executed.attempt.attemptId)).toMatchObject({
      state: "ambiguous",
      inclusion: { executionStatus: "abort_by_response", canonical: true },
    });
    expect(
      value.store.transactionEngine.getNonceReservationForJob(value.planned.job.jobId),
    ).toMatchObject({ state: "ambiguous", resolvedAt: null });
  });

  it("holds an abort across a reorg and accepts the same transaction when it later succeeds", async () => {
    const value = await fixture();
    const executed = await executeAccepted(value);
    const abortApi = apiReader({
      getTransaction: vi.fn(async (txid) => ({
        tx_id: txid as `0x${string}`,
        status: "abort_by_response" as const,
        block: {
          height: 9_001,
          hash: `0x${"bc".repeat(32)}` as const,
          index_hash: `0x${"cd".repeat(32)}` as const,
          time: 1,
          tx_index: 0,
        },
        bitcoin_block: { height: 4_100, time: 1 },
      })),
    });
    await coordinator(value, {
      reader: indexedReader(executed.attempt),
      api: abortApi,
    }).recover({
      jobId: value.planned.job.jobId,
      liveAnchor: recoveryAnchor(value),
      observedAt: recoveryAt,
    });

    await expect(
      coordinator(value, {
        reader: indexedReader(executed.attempt, { canonical: false }),
      }).recover({
        jobId: value.planned.job.jobId,
        liveAnchor: { ...recoveryAnchor(value), stacksBlockHeight: 9_002 },
        observedAt: "2026-07-17T12:04:00.000Z",
      }),
    ).resolves.toMatchObject({ status: "noncanonical" });
    expect(value.store.transactionEngine.getAttempt(executed.attempt.attemptId)).toMatchObject({
      state: "ambiguous",
      inclusion: { executionStatus: "abort_by_response", canonical: false },
    });

    const remintedIndex = `0x${"ef".repeat(32)}` as const;
    const remintedReader = reader({
      accountNonce: 8n,
      indexed: {
        status: "observed",
        httpStatus: 200,
        value: {
          txid: executed.attempt.precomputedTxid as `0x${string}`,
          transactionHex: "00",
          nonce: 7n,
          feeUstx: 1_000n,
          indexBlockHash: remintedIndex,
          blockHeight: 9_002n,
          isCanonical: true,
          resultRepr: "(ok true)",
        },
      },
    });
    const successApi = apiReader({
      getTransaction: vi.fn(async (txid) => ({
        tx_id: txid as `0x${string}`,
        status: "success" as const,
        block: {
          height: 9_002,
          hash: `0x${"ad".repeat(32)}` as const,
          index_hash: remintedIndex,
          time: 2,
          tx_index: 1,
        },
        bitcoin_block: { height: 4_101, time: 2 },
      })),
    });
    await expect(
      coordinator(value, { reader: remintedReader, api: successApi }).recover({
        jobId: value.planned.job.jobId,
        liveAnchor: {
          ...recoveryAnchor(value),
          stacksBlockHeight: 9_002,
          indexBlockHash: remintedIndex,
        },
        observedAt: "2026-07-17T12:05:00.000Z",
      }),
    ).resolves.toMatchObject({ status: "confirmed", indexBlockHash: remintedIndex });
    expect(value.store.transactionEngine.getAttempt(executed.attempt.attemptId)).toMatchObject({
      state: "confirmed",
      inclusion: {
        executionStatus: "success",
        stacksBlockHeight: 9_002,
        indexBlockHash: remintedIndex,
        canonical: true,
      },
    });
    expect(
      value.store.transactionEngine.getNonceReservationForJob(value.planned.job.jobId),
    ).toMatchObject({ state: "ambiguous", resolvedAt: null });
  });

  it("keeps Core/API inclusion disagreement unresolved", async () => {
    const value = await fixture();
    const executed = await executeAccepted(value);
    const api = apiReader({
      getTransaction: vi.fn(async (txid) => ({
        tx_id: txid as `0x${string}`,
        status: "success" as const,
        block: {
          height: 9_001,
          hash: `0x${"bc".repeat(32)}` as const,
          index_hash: `0x${"ee".repeat(32)}` as const,
          time: 1,
          tx_index: 0,
        },
        bitcoin_block: { height: 4_100, time: 1 },
      })),
    });

    await expect(
      coordinator(value, { reader: indexedReader(executed.attempt), api }).recover({
        jobId: value.planned.job.jobId,
        liveAnchor: recoveryAnchor(value),
        observedAt: recoveryAt,
      }),
    ).resolves.toMatchObject({
      status: "observation-unavailable",
      reason: "Node and Reference API transaction inclusion facts disagree",
    });
    expect(value.store.transactionEngine.getAttempt(executed.attempt.attemptId)?.state).toBe(
      "submitted",
    );
    expect(
      value.store.transactionEngine.getNonceReservationForJob(value.planned.job.jobId)?.state,
    ).toBe("reserved");
  });

  it("blocks recovery before transaction resolution when the gas payer sponsors a same-nonce mempool transaction", async () => {
    const value = await fixture();
    const executed = await executeAccepted(value);
    const api = apiReader({
      enumerateGasPayerMempoolActivity: vi.fn(async (principal) => ({
        status: "complete" as const,
        principal,
        nonceActivities: [
          {
            txid: `0x${"66".repeat(32)}` as const,
            principal,
            nonce: 7n,
            role: "sponsor" as const,
            state: "mempool" as const,
            origin: { principal: manager.slice(0, manager.indexOf(".")), nonce: 3n },
            sponsor: { principal, nonce: 7n },
          },
        ],
        pagesRead: 1,
        observedTransactionCount: 1,
        reportedTotal: 1,
      })),
    });
    await expect(
      coordinator(value, { reader: indexedReader(executed.attempt), api }).recover({
        jobId: value.planned.job.jobId,
        liveAnchor: recoveryAnchor(value),
        observedAt: recoveryAt,
      }),
    ).resolves.toMatchObject({ status: "foreign-activity" });
    expect(value.store.transactionEngine.getLogicalJob(value.planned.job.jobId)).toMatchObject({
      state: "blocked",
      blockReason: "foreign-gas-payer-nonce-activity",
    });
    expect(
      value.store.transactionEngine.getNonceReservationForJob(value.planned.job.jobId),
    ).toMatchObject({ state: "ambiguous", foreignActivity: true, resolvedAt: null });
  });

  it("keeps recovery unresolved when mempool enumeration is incomplete", async () => {
    const value = await fixture();
    const executed = await executeAccepted(value);
    const api = apiReader({
      enumerateGasPayerMempoolActivity: vi.fn(async (principal) => ({
        status: "incomplete" as const,
        reason: "total-changed" as const,
        principal,
        nonceActivities: [],
        pagesRead: 2,
        observedTransactionCount: 0,
        reportedTotal: 1,
      })),
    });
    await expect(
      coordinator(value, { reader: indexedReader(executed.attempt), api }).recover({
        jobId: value.planned.job.jobId,
        liveAnchor: recoveryAnchor(value),
        observedAt: recoveryAt,
      }),
    ).resolves.toMatchObject({ status: "observation-unavailable" });
    expect(value.store.transactionEngine.getAttempt(executed.attempt.attemptId)?.state).toBe(
      "submitted",
    );
  });

  it("persists a reorg, holds the nonce, and restores confirmation only when canonical success returns", async () => {
    const value = await fixture();
    const executed = await executeAccepted(value);
    await coordinator(value, { reader: indexedReader(executed.attempt) }).recover({
      jobId: value.planned.job.jobId,
      liveAnchor: recoveryAnchor(value),
      observedAt: recoveryAt,
    });

    const reorgAt = "2026-07-17T12:04:00.000Z";
    await expect(
      coordinator(value, {
        reader: indexedReader(executed.attempt, { canonical: false }),
      }).recover({
        jobId: value.planned.job.jobId,
        liveAnchor: { ...recoveryAnchor(value), stacksBlockHeight: 9_002 },
        observedAt: reorgAt,
      }),
    ).resolves.toMatchObject({ status: "noncanonical" });
    expect(value.store.transactionEngine.getAttempt(executed.attempt.attemptId)).toMatchObject({
      state: "ambiguous",
      inclusion: { canonical: false, executionStatus: "success" },
    });
    expect(value.store.transactionEngine.getLogicalJob(value.planned.job.jobId)?.state).toBe(
      "noncanonical_reobserve",
    );
    expect(
      value.store.transactionEngine.getNonceReservationForJob(value.planned.job.jobId),
    ).toMatchObject({ state: "ambiguous", resolvedAt: null });
    expect(
      value.store.transactionEngine.listReconciliationObservations(value.planned.job.jobId).at(-1),
    ).toMatchObject({ outcome: "noncanonical", canonical: false });

    await expect(
      coordinator(value, { reader: indexedReader(executed.attempt) }).recover({
        jobId: value.planned.job.jobId,
        liveAnchor: { ...recoveryAnchor(value), stacksBlockHeight: 9_003 },
        observedAt: "2026-07-17T12:05:00.000Z",
      }),
    ).resolves.toMatchObject({ status: "confirmed" });
    expect(value.store.transactionEngine.getAttempt(executed.attempt.attemptId)?.state).toBe(
      "confirmed",
    );
    expect(value.store.transactionEngine.getLogicalJob(value.planned.job.jobId)?.state).toBe(
      "confirmed",
    );
    expect(
      value.store.transactionEngine.getNonceReservationForJob(value.planned.job.jobId)?.state,
    ).toBe("ambiguous");
  });

  it("replaces a stale confirmed inclusion when the same transaction is re-mined in a new block", async () => {
    const value = await fixture();
    const executed = await executeAccepted(value);
    await coordinator(value, { reader: indexedReader(executed.attempt) }).recover({
      jobId: value.planned.job.jobId,
      liveAnchor: recoveryAnchor(value),
      observedAt: recoveryAt,
    });
    expect(
      value.store.transactionEngine.getAttempt(executed.attempt.attemptId)?.inclusion,
    ).toMatchObject({ stacksBlockHeight: 9_001, indexBlockHash: `0x${"cd".repeat(32)}` });

    const remintedIndex = `0x${"ef".repeat(32)}` as const;
    const live = reader({
      accountNonce: 8n,
      indexed: {
        status: "observed",
        httpStatus: 200,
        value: {
          txid: executed.attempt.precomputedTxid as `0x${string}`,
          transactionHex: "00",
          nonce: 7n,
          feeUstx: 1_000n,
          indexBlockHash: remintedIndex,
          blockHeight: 9_002n,
          isCanonical: true,
          resultRepr: "(ok true)",
        },
      },
    });
    const api = apiReader({
      getTransaction: vi.fn(async (txid) => ({
        tx_id: txid as `0x${string}`,
        status: "success" as const,
        block: {
          height: 9_002,
          hash: `0x${"ad".repeat(32)}` as const,
          index_hash: remintedIndex,
          time: 2,
          tx_index: 1,
        },
        bitcoin_block: { height: 4_101, time: 2 },
      })),
    });
    await expect(
      coordinator(value, { reader: live, api }).recover({
        jobId: value.planned.job.jobId,
        liveAnchor: {
          ...recoveryAnchor(value),
          stacksBlockHeight: 9_002,
          indexBlockHash: remintedIndex,
        },
        observedAt: "2026-07-17T12:04:00.000Z",
      }),
    ).resolves.toMatchObject({ status: "confirmed", indexBlockHash: remintedIndex });
    expect(value.store.transactionEngine.getAttempt(executed.attempt.attemptId)).toMatchObject({
      state: "confirmed",
      inclusion: {
        stacksBlockHeight: 9_002,
        indexBlockHash: remintedIndex,
        canonical: true,
      },
    });
    expect(
      value.store.transactionEngine.listReconciliationObservations(value.planned.job.jobId).at(-1),
    ).toMatchObject({ outcome: "noncanonical", canonical: false });
    expect(
      value.store.transactionEngine.getNonceReservationForJob(value.planned.job.jobId),
    ).toMatchObject({ state: "ambiguous", resolvedAt: null });
  });

  it("recognizes foreign account-nonce movement and leaves the nonce unresolved", async () => {
    const value = await fixture();
    const executed = await executeAccepted(value);
    const live = reader({ accountNonce: 8n });
    const result = await coordinator(value, { reader: live }).recover({
      jobId: value.planned.job.jobId,
      liveAnchor: {
        ...value.planned.job.chainAnchor,
        stacksBlockHeight: 9_001,
        indexBlockHash: `0x${"cd".repeat(32)}`,
      },
      observedAt: recoveryAt,
    });

    expect(result).toMatchObject({
      status: "foreign-activity",
      reservedNonce: "7",
      observedAccountNonce: "8",
      localConfirmationObserved: false,
    });
    expect(live.calls).toEqual(["indexed", "unconfirmed", "account"]);
    expect(value.store.transactionEngine.getLogicalJob(value.planned.job.jobId)).toMatchObject({
      state: "blocked",
      blockReason: "foreign-gas-payer-nonce-activity",
    });
    expect(value.store.transactionEngine.getAttempt(executed.attempt.attemptId)?.state).toBe(
      "ambiguous",
    );
    expect(
      value.store.transactionEngine.getNonceReservationForJob(value.planned.job.jobId),
    ).toMatchObject({ state: "ambiguous", foreignActivity: true, resolvedAt: null });
  });

  it("promotes an already-ambiguous reservation to a durable foreign-activity stop", async () => {
    const value = await fixture();
    const executed = await coordinator(value, {
      broadcaster: broadcaster({
        status: "ambiguous",
        txid: `0x${"91".repeat(32)}`,
        httpStatus: 400,
        reason: "node-rejection",
        nodeMessage: "BadNonce",
      }),
    }).execute({
      jobId: value.planned.job.jobId,
      admission: admission(value),
    });
    expect(executed.status).toBe("ambiguous");
    expect(
      value.store.transactionEngine.getNonceReservationForJob(value.planned.job.jobId),
    ).toMatchObject({ state: "ambiguous", foreignActivity: false });

    const result = await coordinator(value, { reader: reader({ accountNonce: 8n }) }).recover({
      jobId: value.planned.job.jobId,
      liveAnchor: recoveryAnchor(value),
      observedAt: recoveryAt,
    });

    expect(result).toMatchObject({
      status: "foreign-activity",
      observedAccountNonce: "8",
      localConfirmationObserved: false,
    });
    expect(
      value.store.transactionEngine.getNonceReservationForJob(value.planned.job.jobId),
    ).toMatchObject({ state: "ambiguous", foreignActivity: true, resolvedAt: null });
  });

  it("requires manual intervention for a pending attempt without signing or broadcasting", async () => {
    const value = await fixture();
    const executed = await executeAccepted(value);
    const live = reader({
      accountNonce: 7n,
      unconfirmed: {
        status: "observed",
        httpStatus: 200,
        value: {
          txid: executed.attempt.precomputedTxid as `0x${string}`,
          transactionHex: "00",
          nonce: 7n,
          feeUstx: 1_000n,
          location: { kind: "mempool" },
        },
      },
    });
    const forbiddenSigner = {
      principal: value.signer.principal,
      publicKey: value.signer.publicKey,
      signManagerClaimRewardsPlan: vi.fn(
        value.signer.signManagerClaimRewardsPlan.bind(value.signer),
      ),
    };
    const forbiddenBroadcast = broadcaster(accepted());
    const commit = vi.spyOn(value.store.transactionEngine, "commitApprovedSignedAttempt");
    const result = await coordinator(value, {
      signer: forbiddenSigner,
      broadcaster: forbiddenBroadcast,
      reader: live,
    }).recover({
      jobId: value.planned.job.jobId,
      liveAnchor: value.planned.job.chainAnchor,
      observedAt: recoveryAt,
    });

    expect(result).toMatchObject({
      status: "manual-intervention-required",
      resolution: "automatic-replacement-unsupported",
      cause: "still-unconfirmed",
      nonce: "7",
    });
    expect(live.calls).toEqual(["indexed", "unconfirmed", "account"]);
    expect(forbiddenSigner.signManagerClaimRewardsPlan).not.toHaveBeenCalled();
    expect(forbiddenBroadcast.broadcast).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(
      value.store.transactionEngine.getNonceReservationForJob(value.planned.job.jobId),
    ).toMatchObject({ state: "reserved", resolvedAt: null });
  });

  it("turns a persisted pre-broadcast crash into manual intervention, never a retry", async () => {
    const value = await fixture();
    const crash = { broadcast: vi.fn(async () => Promise.reject(new Error("process crashed"))) };
    await expect(
      coordinator(value, { broadcaster: crash }).execute({
        jobId: value.planned.job.jobId,
        admission: admission(value),
      }),
    ).rejects.toThrow("process crashed");
    const attempt = value.store.transactionEngine.listAttempts(value.planned.job.jobId)[0];
    if (!attempt) throw new Error("Crash fixture did not persist its attempt");
    const noRetry = broadcaster(accepted());
    const result = await coordinator(value, { broadcaster: noRetry, reader: reader() }).recover({
      jobId: value.planned.job.jobId,
      liveAnchor: value.planned.job.chainAnchor,
      observedAt: recoveryAt,
    });
    expect(result).toMatchObject({
      status: "manual-intervention-required",
      resolution: "automatic-replacement-unsupported",
      cause: "persisted-before-broadcast",
      attemptId: attempt.attemptId,
      nonce: "7",
    });
    expect(noRetry.broadcast).not.toHaveBeenCalled();
    expect(value.store.transactionEngine.getAttempt(attempt.attemptId)?.state).toBe("ambiguous");
    expect(value.store.transactionEngine.getLogicalJob(value.planned.job.jobId)?.state).toBe(
      "ambiguous",
    );
    expect(
      value.store.transactionEngine.getNonceReservationForJob(value.planned.job.jobId)?.state,
    ).toBe("ambiguous");
  });

  it("rejects a recovery account observation that does not bind the requested principal and tip", async () => {
    const value = await fixture();
    const executed = await executeAccepted(value);
    const base = reader({
      accountNonce: 8n,
      indexed: {
        status: "observed",
        httpStatus: 200,
        value: {
          txid: executed.attempt.precomputedTxid as `0x${string}`,
          transactionHex: "00",
          nonce: 7n,
          feeUstx: 1_000n,
          indexBlockHash: `0x${"cd".repeat(32)}`,
          blockHeight: 9_001n,
          isCanonical: true,
          resultRepr: "(ok true)",
        },
      },
    });
    const mismatchedReader: ManagerClaimAssistCoordinatorOptions["reader"] = {
      ...base,
      readAnchoredAccount: vi.fn(async () => ({
        status: "observed" as const,
        httpStatus: 200,
        value: {
          principal: getAddressFromPublicKey(privateKeyToPublic(`${"22".repeat(32)}01`), "testnet"),
          indexBlockHash: `0x${"ef".repeat(32)}` as const,
          balanceUstx: 0n,
          lockedUstx: 0n,
          unlockHeight: 0n,
          nonce: 8n,
        },
      })),
    };

    await expect(
      coordinator(value, { reader: mismatchedReader }).recover({
        jobId: value.planned.job.jobId,
        liveAnchor: recoveryAnchor(value),
        observedAt: recoveryAt,
      }),
    ).resolves.toMatchObject({
      status: "observation-unavailable",
      reason: "Account nonce observation does not bind the requested principal and anchor",
    });
    expect(value.store.transactionEngine.getAttempt(executed.attempt.attemptId)?.state).toBe(
      "submitted",
    );
  });

  it("repairs a partially persisted confirmation after a crash before the job transition", async () => {
    const value = await fixture();
    const executed = await executeAccepted(value);
    const live = reader({
      accountNonce: 8n,
      indexed: {
        status: "observed",
        httpStatus: 200,
        value: {
          txid: executed.attempt.precomputedTxid as `0x${string}`,
          transactionHex: "00",
          nonce: 7n,
          feeUstx: 1_000n,
          indexBlockHash: `0x${"cd".repeat(32)}`,
          blockHeight: 9_001n,
          isCanonical: true,
          resultRepr: "(ok true)",
        },
      },
    });
    const repository = repositoryOverride(value.store.transactionEngine, {
      transitionLogicalJob: (input) => {
        if (input.nextState === "confirmed") throw new Error("crash before job confirmation");
        return value.store.transactionEngine.transitionLogicalJob(input);
      },
    });
    await expect(
      coordinator(value, { repository, reader: live }).recover({
        jobId: value.planned.job.jobId,
        liveAnchor: recoveryAnchor(value),
        observedAt: recoveryAt,
      }),
    ).rejects.toThrow("crash before");
    expect(value.store.transactionEngine.getAttempt(executed.attempt.attemptId)?.state).toBe(
      "confirmed",
    );

    const repeated = reader({
      accountNonce: 8n,
      indexed: {
        status: "observed",
        httpStatus: 200,
        value: {
          txid: executed.attempt.precomputedTxid as `0x${string}`,
          transactionHex: "00",
          nonce: 7n,
          feeUstx: 1_000n,
          indexBlockHash: `0x${"cd".repeat(32)}`,
          blockHeight: 9_001n,
          isCanonical: true,
          resultRepr: "(ok true)",
        },
      },
    });
    await expect(
      coordinator(value, { reader: repeated }).recover({
        jobId: value.planned.job.jobId,
        liveAnchor: recoveryAnchor(value),
        observedAt: recoveryAt,
      }),
    ).resolves.toMatchObject({ status: "confirmed" });
    expect(repeated.lookupIndexedTransaction).toHaveBeenCalledOnce();
    expect(value.store.transactionEngine.getLogicalJob(value.planned.job.jobId)?.state).toBe(
      "confirmed",
    );
    expect(
      value.store.transactionEngine.getNonceReservationForJob(value.planned.job.jobId)?.state,
    ).toBe("reserved");
  });

  it("persists a foreign-activity latch before terminal confirmation transitions", async () => {
    const value = await fixture();
    const executed = await executeAccepted(value);
    const live = reader({
      accountNonce: 9n,
      indexed: {
        status: "observed",
        httpStatus: 200,
        value: {
          txid: executed.attempt.precomputedTxid as `0x${string}`,
          transactionHex: "00",
          nonce: 7n,
          feeUstx: 1_000n,
          indexBlockHash: `0x${"cd".repeat(32)}`,
          blockHeight: 9_001n,
          isCanonical: true,
          resultRepr: "(ok true)",
        },
      },
    });
    const repository = repositoryOverride(value.store.transactionEngine, {
      transitionLogicalJob: (input) => {
        if (input.nextState === "blocked") throw new Error("crash before foreign stop");
        return value.store.transactionEngine.transitionLogicalJob(input);
      },
    });

    await expect(
      coordinator(value, { repository, reader: live }).recover({
        jobId: value.planned.job.jobId,
        liveAnchor: recoveryAnchor(value),
        observedAt: recoveryAt,
      }),
    ).rejects.toThrow("crash before foreign stop");
    expect(value.store.transactionEngine.getAttempt(executed.attempt.attemptId)?.state).toBe(
      "ambiguous",
    );
    expect(value.store.transactionEngine.getLogicalJob(value.planned.job.jobId)?.state).toBe(
      "ambiguous",
    );
    expect(
      value.store.transactionEngine.getNonceReservationForJob(value.planned.job.jobId),
    ).toMatchObject({ state: "ambiguous", foreignActivity: true, resolvedAt: null });

    const repeated = reader({ accountNonce: 9n });
    await expect(
      coordinator(value, { reader: repeated }).recover({
        jobId: value.planned.job.jobId,
        liveAnchor: recoveryAnchor(value),
        observedAt: recoveryAt,
      }),
    ).resolves.toMatchObject({ status: "foreign-activity" });
    expect(value.store.transactionEngine.getLogicalJob(value.planned.job.jobId)).toMatchObject({
      state: "blocked",
      blockReason: "foreign-gas-payer-nonce-activity",
    });
    expect(
      value.store.transactionEngine.getNonceReservationForJob(value.planned.job.jobId),
    ).toMatchObject({ state: "ambiguous", foreignActivity: true, resolvedAt: null });
  });

  it("retains the local attempt and nonce after one negative externally reconciled lookup", async () => {
    const value = await fixture();
    const crash = { broadcast: vi.fn(async () => Promise.reject(new Error("process crashed"))) };
    await expect(
      coordinator(value, { broadcaster: crash }).execute({
        jobId: value.planned.job.jobId,
        admission: admission(value),
      }),
    ).rejects.toThrow("process crashed");
    const nonceJob = value.store.transactionEngine.getLogicalJob(value.planned.job.jobId);
    if (!nonceJob) throw new Error("Crash fixture lost its job");
    value.store.transactionEngine.transitionLogicalJob({
      jobId: nonceJob.jobId,
      expectedState: "nonce_reserved",
      expectedStateVersion: nonceJob.stateVersion,
      nextState: "reconciled",
      changedAt: recoveryAt,
    });

    const result = await coordinator(value, { reader: reader() }).recover({
      jobId: value.planned.job.jobId,
      liveAnchor: value.planned.job.chainAnchor,
      observedAt: recoveryAt,
    });
    expect(result).toMatchObject({
      status: "externally-reconciled",
      nonceState: "unresolved",
      reason: "no-local-transaction",
    });
    expect(value.store.transactionEngine.listAttempts(value.planned.job.jobId)[0]?.state).toBe(
      "ambiguous",
    );
    expect(
      value.store.transactionEngine.getNonceReservationForJob(value.planned.job.jobId)?.state,
    ).toBe("ambiguous");
  });
});
