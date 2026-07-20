import type { EngineJobDetail } from "@stx-labs/signer-sidekick-api-contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EngineJobReview } from "./engine-job-review.js";

const hash = (value: string) => value.repeat(64);

const job: EngineJobDetail = {
  schemaVersion: 1,
  jobId: "3ef4ee75-c4d9-4ee7-980d-4fdb2914ef28",
  mode: "assist",
  state: "awaiting_approval",
  stateVersion: 3,
  blockReason: null,
  supersededByJobId: null,
  review: {
    adapter: { id: "reference-manager-claim-rewards", revision: 1 },
    network: "pox-5-testnet",
    managerPrincipal: "ST000000000000000000002AMW42H.signer-manager",
    call: {
      contract: "ST000000000000000000002AMW42H.signer-manager",
      functionName: "claim-rewards",
      arguments: [{ name: "reward-cycle", clarityValue: "u95", displayValue: "95" }],
    },
    anchor: {
      stacksBlockHeight: 1_000,
      indexBlockHash: `0x${"1a".repeat(32)}`,
      burnBlockHeight: 900,
      rewardCycle: 95,
      rewardCycleLength: 2_100,
      prepareCycleLength: 100,
      cyclePosition: 1_050,
      phase: "reward",
      checkpoint: "second-half",
    },
    checkpoint: {
      rewardCycle: 95,
      calculationCheckpoint: "first-half",
      lastRewardComputeHeight: 1_000,
      rewardsPerToken: "125000",
    },
    expectedEffect: {
      recipient: {
        kind: "manager",
        principal: "ST000000000000000000002AMW42H.signer-manager",
      },
      asset: {
        assetId: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token::sbtc-token",
        symbol: "sBTC",
        maximumOutflow: "0",
        unit: "sats",
      },
      postconditions: ["Deny unexpected asset outflows"],
      reconciliationPredicate: "manager reward state records checkpoint 1000",
    },
    fee: {
      snapshot: { state: "missing", feeBips: null, source: "manager read-only" },
      estimatedFeeUstx: "1200",
      maximumFeeUstx: "5000",
      policyRevision: 1,
    },
    hashes: {
      intentSha256: hash("a"),
      policySha256: hash("b"),
      attestationSha256: hash("c"),
    },
    expectedPostState: "The manager stores the exact reward checkpoint and fee snapshot.",
  },
  approvalWindow: {
    eligible: true,
    expiresAt: "2026-07-17T12:10:00.000Z",
    reason: null,
  },
  approval: null,
  nonce: null,
  attempts: [],
  reconciliation: null,
  createdAt: "2026-07-17T12:00:00.000Z",
  updatedAt: "2026-07-17T12:00:00.000Z",
};

describe("EngineJobReview", () => {
  it("renders every exact approval field and the actionable decision", () => {
    const markup = renderToStaticMarkup(
      <EngineJobReview
        job={job}
        actionsEnabled
        action={null}
        onApprove={() => undefined}
        onInvalidate={() => undefined}
      />,
    );

    expect(markup).toContain("claim-rewards");
    expect(markup).toContain("reference-manager-claim-rewards");
    expect(markup).toContain("Last reward compute height");
    expect(markup).toContain("Index block hash");
    expect(markup).toContain("Maximum asset outflow");
    expect(markup).toContain("Maximum transaction fee");
    expect(markup).toContain(hash("a"));
    expect(markup).toContain(hash("b"));
    expect(markup).toContain(hash("c"));
    expect(markup).toContain("Approve transaction");
    expect(markup).not.toContain("private key");
    expect(markup).not.toContain("signed transaction");
  });

  it("removes the approval control when freshness is invalidated", () => {
    const markup = renderToStaticMarkup(
      <EngineJobReview
        job={job}
        actionsEnabled={false}
        action={null}
        onApprove={() => undefined}
        onInvalidate={() => undefined}
      />,
    );
    expect(markup).toContain("Action controls are disabled");
    expect(markup).not.toContain("Approve transaction");
  });
});
