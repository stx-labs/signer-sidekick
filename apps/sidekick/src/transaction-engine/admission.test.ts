import { describe, expect, it } from "vitest";
import type { ChainAnchor } from "../chain-anchor.js";
import {
  type AdmissionBlockCode,
  evaluateTransactionAdmission,
  type TransactionAdmissionInput,
} from "./admission.js";

const anchor: ChainAnchor = {
  stacksBlockHeight: 12,
  indexBlockHash: `0x${"ab".repeat(32)}`,
  burnBlockHeight: 8,
  rewardCycle: 2,
  rewardCycleLength: 10,
  prepareCycleLength: 2,
  cyclePosition: 3,
  phase: "reward",
  checkpoint: "first-half",
};

function validInput(overrides: Partial<TransactionAdmissionInput> = {}): TransactionAdmissionInput {
  return {
    mode: "assist",
    intentHash: "intent-a",
    policyHash: "policy-a",
    attestation: { current: true, payloadSha256: "attestation-a" },
    expectedAttestationSha256: "attestation-a",
    liveFingerprintMatches: true,
    adapter: { id: "reference-manager-claim-rewards", revision: 1 },
    expectedAdapter: { id: "reference-manager-claim-rewards", revision: 1 },
    plannedAnchor: anchor,
    liveAnchor: anchor,
    anchorCanonical: true,
    anchorDescendant: true,
    prerequisitesComplete: true,
    fee: { stateMatches: true, transactionFeeUstx: 100n, maximumFeeUstx: 200n },
    approval: {
      intentHash: "intent-a",
      policyHash: "policy-a",
      expiresAt: "2026-07-18T00:00:00.000Z",
      invalidatedAt: null,
    },
    signer: { available: true, principal: "ST1GAS", expectedPrincipal: "ST1GAS" },
    nonce: { owned: true, unresolvedAttempt: false, foreignActivity: false },
    authoritativeBlockers: [],
    now: new Date("2026-07-17T12:00:00.000Z"),
    ...overrides,
  };
}

function codes(input: TransactionAdmissionInput): AdmissionBlockCode[] {
  return evaluateTransactionAdmission(input).blocks.map(({ code }) => code);
}

function validApproval(): NonNullable<TransactionAdmissionInput["approval"]> {
  const approval = validInput().approval;
  if (!approval) throw new Error("The valid fixture must include an approval");
  return approval;
}

describe("sealed transaction admission", () => {
  it("admits an exact Assist broadcast", () => {
    expect(evaluateTransactionAdmission(validInput())).toEqual({ admitted: true, blocks: [] });
  });

  it("rejects attestation, fingerprint, adapter, anchor, and prerequisite drift", () => {
    expect(codes(validInput({ attestation: null }))).toContain("attestation-missing");
    expect(codes(validInput({ attestation: { current: false, payloadSha256: "wrong" } }))).toEqual(
      expect.arrayContaining(["attestation-not-current", "attestation-mismatch"]),
    );
    expect(codes(validInput({ liveFingerprintMatches: false }))).toContain(
      "live-fingerprint-mismatch",
    );
    expect(codes(validInput({ adapter: null }))).toContain("adapter-unavailable");
    expect(
      codes(validInput({ adapter: { id: "reference-manager-claim-rewards", revision: 2 } })),
    ).toContain("adapter-revision-mismatch");
    expect(codes(validInput({ anchorCanonical: false }))).toContain("anchor-noncanonical");
    expect(
      codes(
        validInput({
          liveAnchor: { ...anchor, indexBlockHash: `0x${"cd".repeat(32)}` },
          anchorDescendant: false,
        }),
      ),
    ).toContain("anchor-mismatch");
    expect(codes(validInput({ prerequisitesComplete: false }))).toContain(
      "prerequisites-incomplete",
    );
  });

  it("rejects changed fee state, cap excess, and deterministic blockers", () => {
    expect(codes(validInput({ fee: { ...validInput().fee, stateMatches: false } }))).toContain(
      "fee-state-mismatch",
    );
    expect(codes(validInput({ fee: { ...validInput().fee, transactionFeeUstx: 201n } }))).toContain(
      "fee-cap-exceeded",
    );
    expect(
      codes(
        validInput({
          authoritativeBlockers: [{ code: "rewards-paused", message: "Rewards are paused" }],
        }),
      ),
    ).toContain("authoritative-blocker");
  });

  it("rejects Observe broadcast and stale Assist approval", () => {
    expect(codes(validInput({ mode: "observe" }))).toContain("observe-mode");
    expect(codes(validInput({ approval: null }))).toContain("approval-missing");
    expect(
      codes(
        validInput({
          approval: { ...validApproval(), intentHash: "old", invalidatedAt: null },
        }),
      ),
    ).toContain("approval-invalid");
    expect(
      codes(
        validInput({
          approval: {
            ...validApproval(),
            expiresAt: "2026-07-17T12:00:00.000Z",
          },
        }),
      ),
    ).toContain("approval-expired");
  });

  it("requires signer identity and exclusive nonce ownership", () => {
    expect(codes(validInput({ signer: null }))).toContain("signer-unavailable");
    expect(
      codes(
        validInput({
          signer: { available: true, principal: "ST1OTHER", expectedPrincipal: "ST1GAS" },
        }),
      ),
    ).toContain("signer-identity-mismatch");
    expect(codes(validInput({ nonce: null }))).toContain("nonce-not-owned");
    expect(
      codes(
        validInput({ nonce: { owned: false, unresolvedAttempt: true, foreignActivity: true } }),
      ),
    ).toEqual(
      expect.arrayContaining(["nonce-unresolved", "nonce-not-owned", "foreign-nonce-activity"]),
    );
  });
});
