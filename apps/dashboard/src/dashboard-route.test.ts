import { describe, expect, it } from "vitest";
import {
  actionHash,
  activityHash,
  dashboardHash,
  domainHash,
  managerActionIds,
  parseDashboardHash,
  settingsHash,
} from "./dashboard-route.js";

const noOperation = {
  domainSection: null,
  operation: null,
  operationContext: { kind: "none" },
  settingsSection: null,
} as const;

describe("dashboard routes", () => {
  it("ignores unknown and removed pages without interpreting old action parameters", () => {
    expect(parseDashboardHash("#unknown?action=remove-admin")).toMatchObject({
      page: "overview",
    });
    expect(parseDashboardHash("#manager?action=arbitrary-call")).toMatchObject({
      page: "overview",
    });
  });

  it.each([
    "registration",
    "setup",
    "enrollment",
    "manager",
    "operations",
  ])("maps removed %s routes to Overview", (page) => {
    expect(parseDashboardHash(`#${page}`)).toEqual({
      page: "overview",
      activityId: null,
      activitySearch: "",
      ...noOperation,
    });
  });

  it("builds only frozen page and typed Settings-section links", () => {
    expect(dashboardHash("rewards")).toBe("#rewards");
    expect(settingsHash("capabilities")).toBe("#settings?section=capabilities");
    expect(parseDashboardHash(settingsHash("observer"))).toMatchObject({
      page: "settings",
      settingsSection: "observer",
    });
    expect(parseDashboardHash("#settings?section=unknown")).toMatchObject({
      page: "settings",
      settingsSection: null,
    });
  });

  it("round-trips only page-specific domain sections", () => {
    expect(domainHash("rewards", "fees")).toBe("#rewards?section=fees");
    expect(parseDashboardHash(domainHash("rewards", "fees"))).toMatchObject({
      page: "rewards",
      domainSection: "fees",
    });
    expect(parseDashboardHash("#rewards?section=roster")).toMatchObject({
      page: "rewards",
      domainSection: null,
    });
  });

  it.each(
    managerActionIds,
  )("routes the %s operation through the shared Settings workspace", (action) => {
    expect(parseDashboardHash(actionHash(action))).toMatchObject({
      page: "settings",
      operation: action,
      operationContext: { kind: "none" },
      settingsSection: null,
    });
  });

  it("parses Activity filters and encoded durable detail identifiers", () => {
    const detail = activityHash(`chain-tx:1:0x${"ab".repeat(32)}`, "status=resolved&time=all");
    expect(parseDashboardHash(detail)).toMatchObject({
      page: "activity",
      activityId: `chain-tx:1:0x${"ab".repeat(32)}`,
      activitySearch: "status=resolved&time=all",
      ...noOperation,
    });
    expect(activityHash(null, "domain=rewards")).toBe("#activity?domain=rewards");
  });

  it("round-trips closed contextual action routes without arbitrary URLs", () => {
    const engine = actionHash("claim-rewards", {
      kind: "engine-job",
      jobId: "3ef4ee75-c4d9-4ee7-980d-4fdb2914ef28",
    });
    expect(parseDashboardHash(engine)).toMatchObject({
      page: "rewards",
      settingsSection: null,
      operation: "claim-rewards",
      operationContext: {
        kind: "engine-job",
        jobId: "3ef4ee75-c4d9-4ee7-980d-4fdb2914ef28",
      },
    });

    const staker = actionHash("claim-staker-rewards", {
      kind: "staker-reward",
      stakerPrincipal: "SP000000000000000000002Q6VF78",
      rewardCycle: "141",
      bondIndex: null,
    });
    expect(parseDashboardHash(staker)).toMatchObject({
      page: "rewards",
      settingsSection: null,
      operation: "claim-staker-rewards",
      operationContext: {
        kind: "staker-reward",
        stakerPrincipal: "SP000000000000000000002Q6VF78",
        rewardCycle: "141",
        bondIndex: null,
      },
    });
    expect(parseDashboardHash("#action/deploy-manager")).toMatchObject({
      page: "overview",
      operation: null,
    });
    expect(parseDashboardHash("#action/claim-rewards?context=engine-job&jobId=bad")).toMatchObject({
      operation: "claim-rewards",
      operationContext: { kind: "none" },
    });
  });
});
