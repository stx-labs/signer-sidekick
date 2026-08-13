import { describe, expect, it } from "vitest";
import { dashboardHash, parseDashboardHash } from "./dashboard-route.js";

describe("dashboard routes", () => {
  it.each([
    "register-self",
    "add-admin",
    "remove-admin",
    "update-fees",
    "withdraw-fees",
    "sweep-fee-refunds",
  ] as const)("parses the Manager %s action link", (action) => {
    expect(parseDashboardHash(`#manager?action=${action}`)).toEqual({
      page: "manager",
      action,
      legacy: false,
    });
  });

  it("ignores unknown pages and action names", () => {
    expect(parseDashboardHash("#unknown?action=remove-admin")).toMatchObject({
      page: "overview",
      action: null,
    });
    expect(parseDashboardHash("#manager?action=arbitrary-call")).toMatchObject({
      page: "manager",
      action: null,
    });
  });

  it("maps the legacy Registration route to Manager", () => {
    expect(parseDashboardHash("#registration")).toEqual({
      page: "manager",
      action: null,
      legacy: true,
    });
  });

  it.each(["setup", "enrollment"])("maps removed %s routes to Manager", (page) => {
    expect(parseDashboardHash(`#${page}`)).toEqual({
      page: "manager",
      action: null,
      legacy: true,
    });
  });

  it("builds only typed Manager action links", () => {
    expect(dashboardHash("manager", "withdraw-fees")).toBe("#manager?action=withdraw-fees");
    expect(dashboardHash("rewards")).toBe("#rewards");
  });
});
