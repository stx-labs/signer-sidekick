import { type EngineJobState, engineJobStateSchema } from "@stx-labs/signer-sidekick-api-contracts";
import { describe, expect, it } from "vitest";
import { engineJobBadgeState } from "./job-state.js";

const cases = [
  ["reconciled", "success"],
  ["blocked", "error"],
  ["ambiguous", "error"],
  ["noncanonical_reobserve", "error"],
  ["awaiting_approval", "caution"],
  ["prepared", "info"],
  ["preflighted", "info"],
  ["nonce_reserved", "info"],
  ["broadcast", "info"],
  ["confirmed", "info"],
  ["superseded", "info"],
] satisfies Array<[EngineJobState, ReturnType<typeof engineJobBadgeState>]>;

describe("engine job state presentation", () => {
  it.each(cases)("maps %s to %s", (state, badge) => {
    expect(engineJobBadgeState(state)).toBe(badge);
  });

  it("covers every API job state", () => {
    expect(cases.map(([state]) => state).sort()).toEqual([...engineJobStateSchema.options].sort());
  });
});
