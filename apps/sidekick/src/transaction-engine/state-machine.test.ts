import { describe, expect, it } from "vitest";
import {
  allowedTransactionJobTransitions,
  assertTransactionJobTransition,
  canTransitionTransactionJob,
  InvalidTransactionJobTransitionError,
  transactionJobStates,
} from "./state-machine.js";

describe("transaction job state machine", () => {
  it("allows the complete nominal Assist path", () => {
    const path = [
      "prepared",
      "preflighted",
      "awaiting_approval",
      "nonce_reserved",
      "broadcast",
      "confirmed",
      "reconciled",
    ] as const;

    for (const [from, to] of path.slice(0, -1).map((from, index) => [from, path[index + 1]])) {
      if (!to) throw new Error("Nominal transaction path is incomplete");
      expect(canTransitionTransactionJob(from, to)).toBe(true);
    }
  });

  it("supports ambiguity recovery without advancing the nonce state", () => {
    expect(canTransitionTransactionJob("nonce_reserved", "ambiguous")).toBe(true);
    expect(canTransitionTransactionJob("broadcast", "ambiguous")).toBe(true);
    expect(allowedTransactionJobTransitions("ambiguous")).not.toContain("nonce_reserved");
    expect(allowedTransactionJobTransitions("ambiguous")).not.toContain("prepared");
    expect(canTransitionTransactionJob("ambiguous", "confirmed")).toBe(true);
  });

  it("can reobserve a noncanonical confirmation but not a reconciled job", () => {
    expect(canTransitionTransactionJob("confirmed", "noncanonical_reobserve")).toBe(true);
    expect(canTransitionTransactionJob("noncanonical_reobserve", "prepared")).toBe(true);
    expect(allowedTransactionJobTransitions("reconciled")).toEqual([]);
    expect(allowedTransactionJobTransitions("superseded")).toEqual([]);
  });

  it("allows external permissionless completion before a local broadcast", () => {
    for (const state of [
      "prepared",
      "preflighted",
      "awaiting_approval",
      "nonce_reserved",
      "broadcast",
      "blocked",
      "ambiguous",
      "noncanonical_reobserve",
    ] as const) {
      expect(canTransitionTransactionJob(state, "confirmed")).toBe(true);
    }
    expect(canTransitionTransactionJob("confirmed", "reconciled")).toBe(true);
  });

  it("rejects every transition not present in the allowlist", () => {
    for (const from of transactionJobStates) {
      for (const to of transactionJobStates) {
        if (allowedTransactionJobTransitions(from).includes(to)) continue;
        expect(() => assertTransactionJobTransition(from, to)).toThrow(
          InvalidTransactionJobTransitionError,
        );
      }
    }
  });
});
