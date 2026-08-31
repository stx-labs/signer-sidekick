import type { DashboardSnapshot } from "@stx-labs/signer-sidekick-api-contracts";
import { describe, expect, it } from "vitest";
import { managerActionAvailability } from "./manager-action-availability.js";

type ManagerActionContext = Pick<DashboardSnapshot, "freshness" | "manager" | "preflight">;

function context(): ManagerActionContext {
  return {
    preflight: {
      checks: [
        { id: "node-network", status: "pass", message: "Node network matches" },
        { id: "node-sync", status: "pass", message: "Node is synchronized" },
        { id: "api-network", status: "pass", message: "API and node networks agree" },
      ],
      compatibility: {
        status: "matched",
        profileId: "testnet",
        profileRevision: 1,
        profileLabel: "Testnet",
        origin: "built-in",
        nodeBuildPreviouslyTested: true,
        reason: "Live network fingerprint matches Testnet",
      },
    },
    manager: {
      attachAllowed: true,
      automationEligible: false,
      automationEligibilityReason: "Profile is not production-approved",
      capabilities: {
        signerManagerTrait: { compatible: true, reason: "Exact trait signature" },
        observedFunctions: {
          public: ["validate-stake!", "update-admin"],
          readOnly: ["is-admin"],
        },
        sourceReview: { exactReviewed: true, reason: "Exact reviewed source" },
        eventVocabulary: {
          id: "reference-manager-v1",
          normalizationAvailable: true,
          adapter: {
            id: "reference-manager-print-events",
            revision: 1,
            reviewedSourceSha256: "ab".repeat(32),
          },
          reason: "Reviewed event vocabulary",
        },
        actions: [
          {
            id: "update-admin",
            interfaceAvailable: true,
            executionAvailable: true,
            missingFunctions: [],
            adapter: {
              id: "reference-manager-update-admin",
              revision: 1,
              reviewedSourceSha256: "ab".repeat(32),
            },
            reason: "Exact reviewed capability",
          },
        ],
      },
      source: {
        recognized: true,
        profileId: "reference-testnet-manager",
        sha256: "ab".repeat(32),
        match: "exact",
        tier: "reference-built-in",
        origin: "built-in",
      },
      provenance: {
        status: "built-in",
        upstreamProfileId: "reference-testnet-manager",
        reason: "Source matches the built-in reference manager",
      },
      reasons: ["Profile is not production-approved"],
    },
  } as unknown as ManagerActionContext;
}

describe("managerActionAvailability", () => {
  it("allows a technically compatible manager independently of Assist eligibility", () => {
    const value = context();

    expect(value.manager.automationEligible).toBe(false);
    expect(managerActionAvailability(value, "update-admin")).toEqual({
      available: true,
      reason: "Exact reviewed capability",
      warning: null,
    });
  });

  it("does not gate external actions on the network compatibility profile", () => {
    const value = context();
    value.preflight.compatibility.status = "inconsistent";
    value.preflight.compatibility.reason = "No matching compatibility profile";

    expect(managerActionAvailability(value, "update-admin")).toMatchObject({ available: true });
  });

  it("blocks action preparation from a last-good stale snapshot", () => {
    const value = context();
    value.freshness = {
      status: "stale",
      snapshotGeneratedAt: "2026-07-19T16:00:00.000Z",
      servedAt: "2026-07-19T16:01:00.000Z",
      reason: "refresh-failed",
    };

    expect(managerActionAvailability(value, "update-admin")).toEqual({
      available: false,
      reason:
        "Manager actions are paused because the displayed data is stale. Refresh to continue.",
      warning: null,
    });
  });

  it("blocks when the browser has aged an otherwise current snapshot", () => {
    expect(managerActionAvailability(context(), "update-admin", true)).toMatchObject({
      available: false,
    });
  });

  it.each([
    "node-network",
    "node-sync",
  ])("blocks when the %s routing check does not pass", (checkId) => {
    const value = context();
    const check = value.preflight.checks.find(({ id }) => id === checkId);
    if (!check) throw new Error(`Missing ${checkId} fixture`);
    check.status = "fail";
    check.message = `${checkId} mismatch`;

    expect(managerActionAvailability(value, "update-admin")).toEqual({
      available: false,
      reason: `${checkId} mismatch`,
      warning: null,
    });
  });

  it("does not block local manager actions when only the API routing check fails", () => {
    const value = context();
    const check = value.preflight.checks.find(({ id }) => id === "api-network");
    if (!check) throw new Error("Missing api-network fixture");
    check.status = "fail";

    expect(managerActionAvailability(value, "update-admin")).toMatchObject({ available: true });
  });

  it("reports the manager network or interface failure", () => {
    const value = context();
    value.manager.attachAllowed = false;
    value.manager.reasons = ["Manager interface is missing 2 required functions"];

    expect(managerActionAvailability(value, "update-admin")).toEqual({
      available: false,
      reason: "Manager interface is missing 2 required functions",
      warning: null,
    });
  });

  it("blocks execution when the source is not reviewed for the capability", () => {
    const custom = context();
    custom.manager.source.tier = "custom-observe";
    custom.manager.source.origin = "operator-installed";
    custom.manager.provenance.status = "not-applicable";
    const customCapability = custom.manager.capabilities.actions[0];
    if (!customCapability) throw new Error("Missing update-admin capability");
    customCapability.executionAvailable = false;
    customCapability.adapter = null;
    customCapability.reason = "Source is not reviewed for update-admin";
    expect(managerActionAvailability(custom, "update-admin")).toEqual({
      available: false,
      reason:
        "This manager exposes the required interface, but its deployed behavior does not match a reviewed adapter for this operation.",
      warning: null,
    });

    const unverified = context();
    unverified.manager.source.recognized = false;
    unverified.manager.source.tier = "unrecognized";
    unverified.manager.source.origin = null;
    unverified.manager.provenance.status = "failed";
    unverified.manager.provenance.reason = "Reference-render proof failed";
    const unverifiedCapability = unverified.manager.capabilities.actions[0];
    if (!unverifiedCapability) throw new Error("Missing update-admin capability");
    unverifiedCapability.executionAvailable = false;
    unverifiedCapability.adapter = null;
    unverifiedCapability.reason = "No reviewed exact source match";
    expect(managerActionAvailability(unverified, "update-admin")).toMatchObject({
      available: false,
      reason:
        "This manager exposes the required interface, but its deployed behavior does not match a reviewed adapter for this operation.",
    });
  });

  it("distinguishes a manager that does not provide the operation", () => {
    const value = context();
    const capability = value.manager.capabilities.actions[0];
    if (!capability) throw new Error("Missing update-admin capability");
    capability.interfaceAvailable = false;
    capability.executionAvailable = false;
    capability.adapter = null;
    capability.missingFunctions = ["update-admin", "is-admin"];

    expect(managerActionAvailability(value, "update-admin")).toMatchObject({
      available: false,
      reason:
        "This manager does not expose the functions Sidekick requires for this operation: update-admin, is-admin.",
    });
  });

  it("treats a verified reference render as trusted assurance", () => {
    const value = context();
    value.manager.source.tier = "reference-render";
    value.manager.source.origin = "operator-installed";
    value.manager.provenance.status = "verified";

    expect(managerActionAvailability(value, "update-admin")).toMatchObject({
      available: true,
      warning: null,
    });
  });
});
