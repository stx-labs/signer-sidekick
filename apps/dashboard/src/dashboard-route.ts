import {
  type BrowserWalletIntentAction,
  type ContextualAction,
  contextualActionSchema,
  type OperatorOperationCode,
  operatorOperationCodeSchema,
} from "@stx-labs/signer-sidekick-api-contracts";

export const dashboardPages = [
  "overview",
  "health",
  "pool",
  "rewards",
  "activity",
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
export type ActionContext = Extract<ContextualAction, { kind: "launch-operation" }>["context"];
export const settingsSections = [
  "attachment",
  "sources",
  "capabilities",
  "observer",
  "auth",
  "support",
] as const;
export type SettingsSection = (typeof settingsSections)[number];

export interface DashboardRoute {
  page: DashboardPage;
  activityId: string | null;
  activitySearch: string;
  operation: OperatorOperationCode | null;
  operationContext: ActionContext;
  settingsSection: SettingsSection | null;
}

function isDashboardPage(value: string): value is DashboardPage {
  return dashboardPages.some((page) => page === value);
}

export function isManagerActionId(value: string | null): value is ManagerActionId {
  return value !== null && managerActionIds.some((action) => action === value);
}

function actionPage(operation: OperatorOperationCode): DashboardPage {
  return isManagerActionId(operation) ? "settings" : "rewards";
}

function isSettingsSection(value: string | null): value is SettingsSection {
  return value !== null && settingsSections.some((section) => section === value);
}

function parseActionContext(
  operation: OperatorOperationCode,
  query: URLSearchParams,
): ActionContext {
  const kind = query.get("context");
  const context: ActionContext =
    kind === "engine-job"
      ? { kind, jobId: query.get("jobId") ?? "" }
      : kind === "staker-reward"
        ? {
            kind,
            stakerPrincipal: query.get("stakerPrincipal") ?? "",
            rewardCycle: query.get("rewardCycle") ?? "",
            bondIndex: query.get("bondIndex"),
          }
        : { kind: "none" };
  const parsed = contextualActionSchema.safeParse({
    kind: "launch-operation",
    operation,
    context,
    label: "Open operation",
  });
  return parsed.success && parsed.data.kind === "launch-operation"
    ? parsed.data.context
    : { kind: "none" };
}

export function parseDashboardHash(hash: string): DashboardRoute {
  const [rawPath = "", rawQuery = ""] = hash.replace(/^#/, "").split("?", 2);
  const [rawPage = ""] = rawPath.split("/", 1);
  if (rawPage === "action" && rawPath.startsWith("action/")) {
    let candidate = "";
    try {
      candidate = decodeURIComponent(rawPath.slice("action/".length));
    } catch {
      candidate = "";
    }
    const operation = operatorOperationCodeSchema.safeParse(candidate);
    if (operation.success) {
      const query = new URLSearchParams(rawQuery);
      return {
        page: actionPage(operation.data),
        activityId: null,
        activitySearch: "",
        operation: operation.data,
        operationContext: parseActionContext(operation.data, query),
        settingsSection: null,
      };
    }
  }
  const page = isDashboardPage(rawPage) ? rawPage : "overview";
  let activityId: string | null = null;
  if (page === "activity" && rawPath.startsWith("activity/")) {
    try {
      activityId = decodeURIComponent(rawPath.slice("activity/".length)) || null;
    } catch {
      return {
        page: "overview",
        activityId: null,
        activitySearch: "",
        operation: null,
        operationContext: { kind: "none" },
        settingsSection: null,
      };
    }
  }
  return {
    page,
    activityId,
    activitySearch: page === "activity" ? rawQuery : "",
    operation: null,
    operationContext: { kind: "none" },
    settingsSection:
      page === "settings"
        ? (() => {
            const candidate = new URLSearchParams(rawQuery).get("section");
            return isSettingsSection(candidate) ? candidate : null;
          })()
        : null,
  };
}

export function dashboardHash(page: DashboardPage): string {
  return `#${page}`;
}

export function settingsHash(section: SettingsSection | null = null): string {
  return `#settings${section ? `?section=${section}` : ""}`;
}

export function activityHash(activityId: string | null = null, search = ""): string {
  const query = search.replace(/^\?/, "");
  return `#activity${activityId ? `/${encodeURIComponent(activityId)}` : ""}${query ? `?${query}` : ""}`;
}

export function actionHash(
  operation: OperatorOperationCode,
  context: ActionContext = { kind: "none" },
): string {
  const query = new URLSearchParams();
  if (context.kind === "engine-job") {
    query.set("context", context.kind);
    query.set("jobId", context.jobId);
  } else if (context.kind === "staker-reward") {
    query.set("context", context.kind);
    query.set("stakerPrincipal", context.stakerPrincipal);
    query.set("rewardCycle", context.rewardCycle);
    if (context.bondIndex !== null) query.set("bondIndex", context.bondIndex);
  }
  const search = query.toString();
  return `#action/${encodeURIComponent(operation)}${search ? `?${search}` : ""}`;
}
