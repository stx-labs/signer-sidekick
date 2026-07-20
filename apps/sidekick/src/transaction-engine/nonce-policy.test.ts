import { describe, expect, it } from "vitest";
import {
  evaluateNonceOwnership,
  type LocalNonceAttempt,
  type NonceOwnershipInput,
  type UnresolvedNonceReservation,
} from "./nonce-policy.js";

const intentHash = "ab".repeat(32);
const originalTxid = `0x${"11".repeat(32)}` as const;
const original: LocalNonceAttempt = {
  attemptId: "attempt-1",
  precomputedTxid: originalTxid,
  feeUstx: 1_000n,
  state: "ambiguous",
};

function unresolved(
  attempts: readonly LocalNonceAttempt[] = [original],
): UnresolvedNonceReservation {
  return { reservationId: "reservation-1", nonce: 7n, intentHash, attempts };
}

function input(overrides: Partial<NonceOwnershipInput> = {}): NonceOwnershipInput {
  return {
    expectedAccountNonce: 7n,
    observedAccountNonce: 7n,
    unresolved: [],
    observedTransactions: [],
    proposal: {
      nonce: 7n,
      intentHash,
      feeUstx: 1_000n,
      maximumFeeUstx: 5_000n,
    },
    ...overrides,
  };
}

describe("evaluateNonceOwnership", () => {
  it("admits one initial reservation at the exclusively observed account nonce", () => {
    expect(evaluateNonceOwnership(input())).toEqual({
      allowed: true,
      action: "reserve-initial",
      nonce: 7n,
    });
  });

  it("never allocates while a local nonce remains unresolved", () => {
    expect(evaluateNonceOwnership(input({ unresolved: [unresolved()] }))).toMatchObject({
      allowed: false,
      action: "block",
      code: "unresolved-nonce",
    });
    expect(
      evaluateNonceOwnership(
        input({
          unresolved: [
            unresolved(),
            { ...unresolved(), reservationId: "reservation-2", nonce: 8n },
          ],
        }),
      ),
    ).toMatchObject({ allowed: false, code: "multiple-unresolved-nonces" });
  });

  it("enforces the approved fee cap and exact observed nonce", () => {
    expect(
      evaluateNonceOwnership(input({ proposal: { ...input().proposal, feeUstx: 5_001n } })),
    ).toMatchObject({ allowed: false, code: "fee-cap-exceeded" });
    expect(evaluateNonceOwnership(input({ observedAccountNonce: 8n }))).toMatchObject({
      allowed: false,
      code: "foreign-activity",
    });
  });

  it("stops on unknown observed transaction activity", () => {
    expect(
      evaluateNonceOwnership(
        input({
          unresolved: [unresolved()],
          observedTransactions: [{ nonce: 7n, txid: `0x${"ff".repeat(32)}`, state: "mempool" }],
        }),
      ),
    ).toMatchObject({ allowed: false, action: "block", code: "foreign-activity" });
  });

  it("recognizes the one local attempt landing and requires reconciliation", () => {
    expect(
      evaluateNonceOwnership(
        input({
          observedAccountNonce: 8n,
          unresolved: [unresolved()],
          observedTransactions: [{ nonce: 7n, txid: originalTxid, state: "confirmed" }],
        }),
      ),
    ).toEqual({
      allowed: false,
      action: "reconcile-local-attempt",
      landedAttemptId: original.attemptId,
      landedTxid: originalTxid,
    });
  });

  it("rejects malformed attempt state and inconsistent confirmation evidence", () => {
    expect(evaluateNonceOwnership(input({ unresolved: [unresolved([])] }))).toMatchObject({
      allowed: false,
      code: "invalid-input",
    });
    expect(
      evaluateNonceOwnership(
        input({
          unresolved: [unresolved()],
          observedTransactions: [{ nonce: 7n, txid: originalTxid, state: "confirmed" }],
        }),
      ),
    ).toMatchObject({ allowed: false, code: "observation-inconsistent" });
  });
});
