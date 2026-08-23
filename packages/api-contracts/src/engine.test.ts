import { describe, expect, it } from "vitest";
import {
  engineDisableAdapterRequestSchema,
  engineForceObserveRequestSchema,
  engineJobDetailSchema,
  engineJobPageSchema,
  engineStatusSchema,
  operationReadinessSchema,
} from "./engine.js";

const jobId = "3ef4ee75-c4d9-4ee7-980d-4fdb2914ef28";
const approvalId = "7f8ff935-9cb4-4677-a167-17257625bd14";
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);
const hashD = "d".repeat(64);
const indexBlockHash = `0x${"1a".repeat(32)}`;
const now = "2026-07-17T12:00:00.000Z";
const expiresAt = "2026-07-17T12:10:00.000Z";

const anchor = {
  stacksBlockHeight: 1_000,
  indexBlockHash,
  burnBlockHeight: 900,
  rewardCycle: 95,
  rewardCycleLength: 2_100,
  prepareCycleLength: 100,
  cyclePosition: 1_050,
  phase: "reward" as const,
  checkpoint: "second-half" as const,
};

const review = {
  adapter: { id: "reference-manager-claim-rewards", revision: 1 },
  network: "pox-5-testnet",
  managerPrincipal: "ST000000000000000000002AMW42H.signer-manager",
  call: {
    contract: "ST000000000000000000002AMW42H.signer-manager",
    functionName: "claim-rewards",
    arguments: [
      { name: "reward-cycle", clarityValue: "u95", displayValue: "95" },
      { name: "staker", clarityValue: "'ST1STAKER", displayValue: "ST1STAKER" },
    ],
  },
  anchor,
  checkpoint: {
    rewardCycle: 95,
    calculationCheckpoint: "first-half" as const,
    lastRewardComputeHeight: 1_000,
    rewardsPerToken: "125000",
  },
  expectedEffect: {
    recipient: {
      kind: "manager" as const,
      principal: "ST000000000000000000002AMW42H.signer-manager",
    },
    asset: {
      assetId: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token::sbtc-token",
      symbol: "sBTC",
      maximumOutflow: "0",
      unit: "sats",
    },
    postconditions: ["Deny all asset outflows except the exact reviewed manager effect"],
    reconciliationPredicate: "manager reward state records checkpoint 1000",
  },
  fee: {
    snapshot: { state: "missing" as const, feeBips: null, source: "manager read-only" },
    estimatedFeeUstx: "1200",
    maximumFeeUstx: "5000",
    policyRevision: 1,
  },
  hashes: {
    intentSha256: hashA,
    policySha256: hashB,
    attestationSha256: hashC,
  },
  expectedPostState: "The manager stores the exact reward checkpoint and fee snapshot.",
};

const approval = {
  approvalId,
  jobId,
  review,
  approvalSha256: hashD,
  actor: "operator-session",
  createdAt: now,
  expiresAt,
  invalidatedAt: null,
  invalidationReason: null,
  version: 0,
};

const job = {
  schemaVersion: 1 as const,
  jobId,
  mode: "assist" as const,
  state: "awaiting_approval" as const,
  stateVersion: 3,
  blockReason: null,
  supersededByJobId: null,
  review,
  approvalWindow: { eligible: true, expiresAt, reason: null },
  approval: null,
  nonce: null,
  attempts: [],
  reconciliation: null,
  createdAt: now,
  updatedAt: now,
};

const status = {
  schemaVersion: 1 as const,
  mode: "assist" as const,
  forcedObserve: { active: false, reason: null, actor: null, forcedAt: null },
  adapters: [
    {
      adapter: review.adapter,
      label: "Reference manager claim rewards",
      mode: "assist" as const,
      enabled: true,
      availability: "available" as const,
      blockReason: null,
    },
  ],
  jobs: { active: 1, awaitingApproval: 1, ambiguous: 0 },
  generatedAt: now,
};

describe("transaction engine v1 API contracts", () => {
  it("accepts the strict status, paginated job, and detail views", () => {
    expect(engineStatusSchema.parse(status)).toEqual(status);
    expect(
      engineJobPageSchema.parse({
        schemaVersion: 1,
        items: [
          {
            jobId,
            mode: "assist",
            state: "awaiting_approval",
            blockReason: null,
            adapter: review.adapter,
            network: review.network,
            managerPrincipal: review.managerPrincipal,
            contract: review.call.contract,
            functionName: review.call.functionName,
            rewardCycle: review.checkpoint.rewardCycle,
            approvalState: "awaiting",
            updatedAt: now,
          },
        ],
        nextCursor: null,
        total: 1,
      }).items,
    ).toHaveLength(1);
    expect(engineJobDetailSchema.parse(job).review).toEqual(review);
    expect(engineJobDetailSchema.parse({ ...job, approval }).approval?.actor).toBe(
      "operator-session",
    );
    expect(
      operationReadinessSchema.parse({
        schemaVersion: 1,
        status: "blocked",
        generatedAt: now,
        checks: [
          { id: "control-plane", status: "ready", detail: "Chain checks pass." },
          { id: "setup", status: "ready", detail: "Manager setup is ready." },
          { id: "engine", status: "blocked", detail: "Chain tips disagree." },
        ],
      }).status,
    ).toBe("blocked");
    expect(
      operationReadinessSchema.parse({
        schemaVersion: 2,
        status: "ready",
        generatedAt: now,
        checks: [
          { id: "control-plane", status: "ready", detail: "Chain checks pass." },
          { id: "manager", status: "ready", detail: "Manager attached." },
          { id: "signer", status: "ready", detail: "Signer registered." },
          { id: "engine", status: "ready", detail: "Engine ready." },
        ],
      }).schemaVersion,
    ).toBe(2);
  });

  it("rejects private keys, signed transaction bytes, and undeclared nested material", () => {
    expect(
      engineJobDetailSchema.safeParse({ ...job, gasPayerPrivateKey: "not-allowed" }).success,
    ).toBe(false);
    expect(
      engineJobDetailSchema.safeParse({
        ...job,
        review: { ...review, signedTransactionBytes: "0xdeadbeef" },
      }).success,
    ).toBe(false);
    expect(
      engineJobDetailSchema.safeParse({
        ...job,
        attempts: [
          {
            attemptNumber: 1,
            state: "signed",
            nonce: "7",
            feeUstx: "1200",
            txid: null,
            submittedAt: null,
            confirmation: null,
            signedTransaction: "0xdeadbeef",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps emergency controls narrow and strict", () => {
    expect(
      engineForceObserveRequestSchema.safeParse({
        decision: "force-observe",
        reason: "Emergency stop",
        resumeAt: now,
      }).success,
    ).toBe(false);
    expect(
      engineDisableAdapterRequestSchema.parse({
        decision: "disable",
        reason: "Disable this reviewed adapter",
      }).decision,
    ).toBe("disable");
  });
});
