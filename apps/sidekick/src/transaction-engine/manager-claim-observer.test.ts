import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAddressFromPublicKey, privateKeyToPublic } from "@stacks/transactions";
import { engineApprovalReviewSchema } from "@stx-labs/signer-sidekick-api-contracts";
import {
  type CompatibilityAttestationPayload,
  compatibilityAttestationPayloadSha256,
  compatibilityAttestationSigningBytes,
  type SignedCompatibilityAttestation,
} from "@stx-labs/signer-sidekick-protocol/compatibility-attestation";
import { POX5_TESTNET_COMPATIBILITY } from "@stx-labs/signer-sidekick-protocol/known-network-compatibility";
import {
  MANAGER_CLAIM_REWARDS_ADAPTER_ID,
  MANAGER_CLAIM_REWARDS_FUNCTION_NAME,
} from "@stx-labs/signer-sidekick-protocol/manager-claim-rewards";
import { afterEach, describe, expect, it } from "vitest";
import { openSidekickStore, type SidekickStore } from "../storage/store.js";
import {
  type ManagerClaimObserveFacts,
  ObserveManagerClaimPlanner,
} from "./manager-claim-observer.js";
import { transactionEngineDocumentSha256 } from "./repository.js";

const initial = "2026-07-17T12:00:00.000Z";
const later = "2026-07-17T12:01:00.000Z";
const manager = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.signer-manager";
const publicKey = privateKeyToPublic(`${"11".repeat(32)}01`);
const gasPayer = getAddressFromPublicKey(publicKey, "testnet");
const attestationKeys = generateKeyPairSync("ed25519");
const openStores: SidekickStore[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const store of openStores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
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

async function memoryStore(): Promise<{ store: SidekickStore; digest: string }> {
  const opened = await openSidekickStore(":memory:", initial);
  openStores.push(opened.store);
  return { store: opened.store, digest: await acceptAttestation(opened.store) };
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
    noBondParticipation: { proven: true, evidenceSha256: "ef".repeat(32) },
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
    controls: { adapterEnabled: true, rewardsPaused: false },
    effect: { remaining: true, completionEvidenceSha256: null },
    authoritative: { complete: true, canonical: true, finalityDepth: 1 },
  };
}

describe("Observe-only reference-manager claim planner", () => {
  it("builds the fixed vector and a lossless strict approval review without authority", async () => {
    const { store, digest } = await memoryStore();
    const planner = new ObserveManagerClaimPlanner(store.transactionEngine);
    const input = facts(digest);

    const first = await planner.observe(input);
    const duplicate = await planner.observe(input);

    expect(first).toMatchObject({
      status: "planned",
      created: true,
      job: { state: "preflighted", adapterId: MANAGER_CLAIM_REWARDS_ADAPTER_ID },
      plan: {
        material: {
          call: { contract: manager, functionName: MANAGER_CLAIM_REWARDS_FUNCTION_NAME },
          expectedEffect: { amount: "1234", postConditionMode: "deny" },
          transaction: { nonce: "7", fee: "1000" },
        },
      },
      records: {
        policy: {
          mode: "observe",
          nonceReservationAllowed: false,
          signingAllowed: false,
          broadcastAllowed: false,
        },
      },
    });
    expect(duplicate).toMatchObject({
      status: "planned",
      created: false,
      job: { jobId: first.job.jobId, state: "preflighted" },
    });
    expect(store.transactionEngine.listReconciliationObservations(first.job.jobId)).toHaveLength(1);
    expect(first.records.intent.review).not.toHaveProperty("hashes");

    const review = engineApprovalReviewSchema.parse({
      ...first.records.intent.review,
      hashes: {
        intentSha256: first.job.intentSha256,
        policySha256: first.job.policySha256,
        attestationSha256: digest,
      },
    });
    expect(review).toMatchObject({
      managerPrincipal: manager,
      call: {
        functionName: "claim-rewards",
        arguments: [
          { name: "bond-periods", displayValue: "[]" },
          { name: "reward-cycle", clarityValue: "u5" },
        ],
      },
      checkpoint: {
        rewardCycle: 5,
        calculationCheckpoint: "first-half",
        lastRewardComputeHeight: 4_099,
      },
      expectedEffect: {
        recipient: { kind: "manager", principal: manager },
        asset: { symbol: "sBTC", maximumOutflow: "1234", unit: "sats" },
      },
      fee: { estimatedFeeUstx: "1000", maximumFeeUstx: "2000" },
    });
  });

  it("supersedes unbroadcast Observe work with an approval-bound Assist policy", async () => {
    const { store, digest } = await memoryStore();
    const planner = new ObserveManagerClaimPlanner(store.transactionEngine);
    const observed = await planner.observe(facts(digest));

    const assisted = await planner.observe({
      ...facts(digest),
      observedAt: "2026-07-17T18:01:00.000Z",
      controls: { mode: "assist", adapterEnabled: true, rewardsPaused: false },
    });

    expect(assisted).toMatchObject({
      status: "planned",
      created: true,
      supersededJobId: observed.job.jobId,
      job: { state: "preflighted" },
      records: {
        policy: {
          mode: "assist",
          approvalRequired: true,
          nonceReservationAllowed: true,
          signingAllowed: true,
          broadcastAllowed: true,
        },
      },
    });
    expect(store.transactionEngine.getLogicalJob(observed.job.jobId)).toMatchObject({
      state: "superseded",
      supersededByJobId: assisted.job.jobId,
    });
  });

  it("resumes the same durable job after restart and never reserves or signs a nonce", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sidekick-manager-claim-observe-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "sidekick.sqlite");
    const opened = await openSidekickStore(path, initial);
    const digest = await acceptAttestation(opened.store);
    const first = await new ObserveManagerClaimPlanner(opened.store.transactionEngine).observe(
      facts(digest),
    );
    opened.store.close();

    const restarted = await openSidekickStore(path, later);
    openStores.push(restarted.store);
    const resumed = await new ObserveManagerClaimPlanner(restarted.store.transactionEngine).observe(
      { ...facts(digest), observedAt: later },
    );
    expect(resumed).toMatchObject({
      created: false,
      job: { jobId: first.job.jobId, state: "preflighted" },
    });
    restarted.store.close();
    openStores.splice(openStores.indexOf(restarted.store), 1);

    const raw = new DatabaseSync(path, { readOnly: true });
    expect(raw.prepare("SELECT count(*) AS count FROM transaction_jobs").get()).toEqual({
      count: 1,
    });
    expect(raw.prepare("SELECT count(*) AS count FROM gas_payer_nonce_reservations").get()).toEqual(
      {
        count: 0,
      },
    );
    expect(raw.prepare("SELECT count(*) AS count FROM transaction_attempts").get()).toEqual({
      count: 0,
    });
    raw.close();
  });

  it("atomically supersedes changed anchored facts and invalidates stale approval", async () => {
    const { store, digest } = await memoryStore();
    const planner = new ObserveManagerClaimPlanner(store.transactionEngine);
    const first = await planner.observe(facts(digest));
    const awaiting = store.transactionEngine.transitionLogicalJob({
      jobId: first.job.jobId,
      expectedState: "preflighted",
      expectedStateVersion: first.job.stateVersion,
      nextState: "awaiting_approval",
      changedAt: initial,
    });
    const approval = {
      ...first.records.intent.review,
      hashes: {
        intentSha256: first.job.intentSha256,
        policySha256: first.job.policySha256,
        attestationSha256: digest,
      },
    };
    store.transactionEngine.createApproval({
      jobId: awaiting.jobId,
      expectedJobStateVersion: awaiting.stateVersion,
      intentSha256: awaiting.intentSha256,
      policySha256: awaiting.policySha256,
      approval,
      approvalSha256: transactionEngineDocumentSha256(approval),
      actor: "operator:test",
      createdAt: initial,
      expiresAt: "2026-07-17T13:00:00.000Z",
    });

    const changed = structuredClone(facts(digest));
    changed.observedAt = later;
    changed.chainAnchor.stacksBlockHeight += 1;
    changed.chainAnchor.burnBlockHeight += 1;
    changed.chainAnchor.cyclePosition += 1;
    changed.chainAnchor.indexBlockHash = `0x${"bc".repeat(32)}`;
    const replacement = await planner.observe(changed);

    expect(replacement).toMatchObject({
      status: "planned",
      created: true,
      supersededJobId: first.job.jobId,
      job: { state: "preflighted" },
    });
    expect(store.transactionEngine.getLogicalJob(first.job.jobId)).toMatchObject({
      state: "superseded",
      supersessionReason: "authoritative-manager-claim-facts-changed",
      supersededByJobId: replacement.job.jobId,
    });
    expect(store.transactionEngine.getActiveApproval(first.job.jobId)).toBeNull();
    expect(
      store.transactionEngine.getActiveLogicalJobForScope(replacement.job.operationScopeKey)?.jobId,
    ).toBe(replacement.job.jobId);
  });

  it("durably blocks valid authoritative facts that fail adapter policy", async () => {
    const { store, digest } = await memoryStore();
    const input = facts(digest);
    input.manager.observedSourceSha256 = "34".repeat(32);
    input.controls.rewardsPaused = true;
    input.gasPayer.estimatedFeeUstx = 3_000n;

    const result = await new ObserveManagerClaimPlanner(store.transactionEngine).observe(input);

    expect(result).toMatchObject({
      status: "blocked",
      job: {
        state: "blocked",
        blockReason: "manager-source-mismatch,rewards-paused,fee-cap-exceeded",
      },
      blocks: [
        { code: "manager-source-mismatch" },
        { code: "rewards-paused" },
        { code: "fee-cap-exceeded" },
      ],
    });
    expect(store.transactionEngine.listReconciliationObservations(result.job.jobId)).toMatchObject([
      { outcome: "blocked", effectRemaining: true },
    ]);
  });

  it("reconciles an external caller winning the race without creating another job", async () => {
    const { store, digest } = await memoryStore();
    const planner = new ObserveManagerClaimPlanner(store.transactionEngine);
    const planned = await planner.observe(facts(digest));
    const completed = structuredClone(facts(digest));
    completed.observedAt = later;
    completed.chainAnchor.stacksBlockHeight += 1;
    completed.chainAnchor.burnBlockHeight += 1;
    completed.chainAnchor.cyclePosition += 1;
    completed.chainAnchor.indexBlockHash = `0x${"cd".repeat(32)}`;
    completed.feeSnapshot.state = "present";
    completed.observedSignerEarnedSats = 0n;
    completed.effect = {
      remaining: false,
      completionEvidenceSha256: "56".repeat(32),
    };

    const reconciled = await planner.observe(completed);
    const duplicate = await planner.observe(completed);

    expect(reconciled).toMatchObject({
      status: "reconciled",
      created: false,
      job: { jobId: planned.job.jobId, state: "reconciled" },
      plan: null,
    });
    expect(duplicate.job.jobId).toBe(planned.job.jobId);
    expect(
      store.transactionEngine.getLatestLogicalJobForScope(planned.job.operationScopeKey),
    ).toMatchObject({
      jobId: planned.job.jobId,
      state: "reconciled",
    });
    expect(store.transactionEngine.listReconciliationObservations(planned.job.jobId)).toMatchObject(
      [
        { outcome: "pending", effectRemaining: true },
        { outcome: "external_success", effectRemaining: false },
      ],
    );
  });

  it("does not fabricate a retrospective job for completion with no matching local work", async () => {
    const { store, digest } = await memoryStore();
    const completed = facts(digest);
    completed.feeSnapshot.state = "present";
    completed.observedSignerEarnedSats = 0n;
    completed.effect = {
      remaining: false,
      completionEvidenceSha256: "56".repeat(32),
    };

    await expect(
      new ObserveManagerClaimPlanner(store.transactionEngine).observe(completed),
    ).rejects.toThrow("no matching durable logical job");
    expect(store.transactionEngine.logicalJobStats().total).toBe(0);
  });
});
