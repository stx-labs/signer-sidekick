import type { ManagerActionCapability } from "@stx-labs/signer-sidekick-api-contracts";
import { describe, expect, it } from "vitest";
import {
  managerCapabilityExplanation,
  managerCapabilityState,
  summarizeManagerCapabilities,
} from "./manager-capability-presentation.js";

function capability(overrides: Partial<ManagerActionCapability> = {}): ManagerActionCapability {
  return {
    id: "update-admin",
    interfaceAvailable: true,
    executionAvailable: true,
    missingFunctions: [],
    adapter: {
      id: "reference-manager-update-admin",
      revision: 1,
      reviewedSourceSha256: "ab".repeat(32),
    },
    reason: "Reviewed adapter matched",
    ...overrides,
  };
}

describe("manager capability presentation", () => {
  it.each([
    [capability(), "Available"],
    [capability({ executionAvailable: false, adapter: null }), "Observe only"],
    [
      capability({
        interfaceAvailable: false,
        executionAvailable: false,
        adapter: null,
        missingFunctions: ["is-admin"],
      }),
      "Not provided",
    ],
  ] as const)("classifies operation compatibility independently", (value, state) => {
    expect(managerCapabilityState(value)).toBe(state);
  });

  it("summarizes mixed capability states without relabeling the whole manager", () => {
    expect(
      summarizeManagerCapabilities([
        capability(),
        capability({ executionAvailable: false, adapter: null }),
        capability({
          interfaceAvailable: false,
          executionAvailable: false,
          adapter: null,
        }),
      ]),
    ).toEqual({
      state: "Partial",
      detail: "1 available · 1 observe only · 1 not provided",
      hasUnavailable: true,
    });
  });

  it("explains the difference between an unreviewed interface and a missing operation", () => {
    expect(
      managerCapabilityExplanation(capability({ executionAvailable: false, adapter: null })),
    ).toContain("does not match a reviewed adapter");
    expect(
      managerCapabilityExplanation(
        capability({
          interfaceAvailable: false,
          executionAvailable: false,
          adapter: null,
          missingFunctions: ["claim-rewards", "claim-staker-rewards"],
        }),
      ),
    ).toContain("claim-rewards, claim-staker-rewards");
  });
});
