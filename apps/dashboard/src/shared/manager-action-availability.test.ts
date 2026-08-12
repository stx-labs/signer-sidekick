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
        profileId: "pox5-testnet",
        profileRevision: 1,
        profileLabel: "PoX-5 Testnet",
        origin: "built-in",
        nodeBuildPreviouslyTested: true,
        reason: "Live network fingerprint matches PoX-5 Testnet",
      },
    },
    manager: {
      attachAllowed: true,
      automationEligible: false,
      automationEligibilityReason: "Profile is not production-approved",
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
    expect(managerActionAvailability(value)).toEqual({
      available: true,
      reason: "Manager actions are available.",
      warning: null,
    });
  });

  it("does not gate external actions on the network compatibility profile", () => {
    const value = context();
    value.preflight.compatibility.status = "inconsistent";
    value.preflight.compatibility.reason = "No matching compatibility profile";

    expect(managerActionAvailability(value)).toMatchObject({ available: true });
  });

  it("blocks action preparation from a last-good stale snapshot", () => {
    const value = context();
    value.freshness = {
      status: "stale",
      snapshotGeneratedAt: "2026-07-19T16:00:00.000Z",
      servedAt: "2026-07-19T16:01:00.000Z",
      reason: "refresh-failed",
    };

    expect(managerActionAvailability(value)).toEqual({
      available: false,
      reason:
        "Manager actions are paused because the displayed data is stale. Refresh to continue.",
      warning: null,
    });
  });

  it("blocks when the browser has aged an otherwise current snapshot", () => {
    expect(managerActionAvailability(context(), true)).toMatchObject({ available: false });
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

    expect(managerActionAvailability(value)).toEqual({
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

    expect(managerActionAvailability(value)).toMatchObject({ available: true });
  });

  it("reports the manager network or interface failure", () => {
    const value = context();
    value.manager.attachAllowed = false;
    value.manager.reasons = ["Manager interface is missing 2 required functions"];

    expect(managerActionAvailability(value)).toEqual({
      available: false,
      reason: "Manager interface is missing 2 required functions",
      warning: null,
    });
  });

  it("allows custom and unrecognized managers with a nonblocking warning", () => {
    const custom = context();
    custom.manager.source.tier = "custom-observe";
    custom.manager.source.origin = "operator-installed";
    custom.manager.provenance.status = "not-applicable";
    expect(managerActionAvailability(custom)).toMatchObject({
      available: true,
      warning: expect.stringContaining("wallet or manual signing"),
    });

    const unverified = context();
    unverified.manager.source.recognized = false;
    unverified.manager.source.tier = "unrecognized";
    unverified.manager.source.origin = null;
    unverified.manager.provenance.status = "failed";
    unverified.manager.provenance.reason = "Reference-render proof failed";
    expect(managerActionAvailability(unverified)).toMatchObject({
      available: true,
      warning: expect.stringContaining("Assist is unavailable"),
    });
  });

  it("treats a verified reference render as trusted assurance", () => {
    const value = context();
    value.manager.source.tier = "reference-render";
    value.manager.source.origin = "operator-installed";
    value.manager.provenance.status = "verified";

    expect(managerActionAvailability(value)).toMatchObject({
      available: true,
      warning: null,
    });
  });
});
