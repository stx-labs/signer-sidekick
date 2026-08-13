import type { BrowserWalletIntentAction } from "@stx-labs/signer-sidekick-api-contracts";

export const dashboardPages = [
  "overview",
  "health",
  "manager",
  "pool",
  "rewards",
  "operations",
  "settings",
] as const;

export type DashboardPage = (typeof dashboardPages)[number];

export const managerActionIds = [
  "register-self",
  "add-admin",
  "remove-admin",
  "update-fees",
  "withdraw-fees",
  "sweep-fee-refunds",
] as const satisfies readonly BrowserWalletIntentAction[];

export type ManagerActionId = (typeof managerActionIds)[number];

export interface DashboardRoute {
  page: DashboardPage;
  action: ManagerActionId | null;
  legacy: boolean;
}

function isDashboardPage(value: string): value is DashboardPage {
  return dashboardPages.some((page) => page === value);
}

export function isManagerActionId(value: string | null): value is ManagerActionId {
  return value !== null && managerActionIds.some((action) => action === value);
}

export function parseDashboardHash(hash: string): DashboardRoute {
  const [rawPage = "", rawQuery = ""] = hash.replace(/^#/, "").split("?", 2);
  const legacy = ["registration", "setup", "enrollment"].includes(rawPage);
  const page = legacy ? "manager" : isDashboardPage(rawPage) ? rawPage : "overview";
  const candidate = page === "manager" ? new URLSearchParams(rawQuery).get("action") : null;
  return {
    page,
    action: isManagerActionId(candidate) ? candidate : null,
    legacy,
  };
}

export function dashboardHash(page: DashboardPage, action?: ManagerActionId): string {
  return `#${page}${page === "manager" && action ? `?action=${action}` : ""}`;
}
