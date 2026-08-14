import type {
  ActivityDisplayStatus,
  ActivityDomain,
  ActivityGroupSummary,
  ActivityStage,
  ActivityTimelineEntry,
  OperatorDeadline,
} from "@stx-labs/signer-sidekick-api-contracts";

export const activityStatusFilters = [
  "all",
  "action-required",
  "needs-attention",
  "in-progress",
  "resolved",
] as const;
export const activityTypeFilters = ["all", "actions", "chain-events", "configuration"] as const;
export const activityDomainFilters = [
  "all",
  "manager",
  "pool",
  "rewards",
  "node",
  "signer",
  "network",
  "sidekick",
] as const;
export const activityTimeFilters = ["24h", "7d", "30d", "all"] as const;

export type ActivityStatusFilter = (typeof activityStatusFilters)[number];
export type ActivityTypeFilter = (typeof activityTypeFilters)[number];
export type ActivityDomainFilter = (typeof activityDomainFilters)[number];
export type ActivityTimeFilter = (typeof activityTimeFilters)[number];

export interface ActivityFilters {
  status: ActivityStatusFilter;
  type: ActivityTypeFilter;
  domain: ActivityDomainFilter;
  time: ActivityTimeFilter;
  search: string;
}

function closedValue<Value extends string>(
  value: string | null,
  values: readonly Value[],
  fallback: Value,
): Value {
  return value !== null && values.some((candidate) => candidate === value)
    ? (value as Value)
    : fallback;
}

export function parseActivityFilters(search: string): ActivityFilters {
  const params = new URLSearchParams(search.replace(/^\?/, ""));
  return {
    status: closedValue(params.get("status"), activityStatusFilters, "all"),
    type: closedValue(params.get("type"), activityTypeFilters, "all"),
    domain: closedValue(params.get("domain"), activityDomainFilters, "all"),
    time: closedValue(params.get("time"), activityTimeFilters, "30d"),
    search: (params.get("search") ?? "").slice(0, 500),
  };
}

export function activityFilterSearch(filters: ActivityFilters): string {
  const params = new URLSearchParams();
  if (filters.status !== "all") params.set("status", filters.status);
  if (filters.type !== "all") params.set("type", filters.type);
  if (filters.domain !== "all") params.set("domain", filters.domain);
  if (filters.time !== "30d") params.set("time", filters.time);
  if (filters.search.trim()) params.set("search", filters.search.trim());
  return params.toString();
}

export function activityStatusLabel(status: ActivityDisplayStatus): string {
  return status.replaceAll("-", " ");
}

export function activityStageLabel(stage: ActivityStage): string {
  return stage.replaceAll("-", " ");
}

export function activityStatusBadge(
  status: ActivityDisplayStatus,
): "success" | "caution" | "error" | "info" | "neutral" | "accent" {
  switch (status) {
    case "complete":
      return "success";
    case "action-required":
      return "accent";
    case "in-progress":
      return "info";
    case "needs-attention":
      return "error";
    case "superseded":
    case "observed":
      return "neutral";
  }
}

export function activityDomainLabel(domain: ActivityDomain): string {
  return domain === "sidekick" ? "Sidekick" : `${domain[0]?.toUpperCase()}${domain.slice(1)}`;
}

export function activityKindLabel(kind: ActivityGroupSummary["kind"]): string {
  switch (kind) {
    case "operation":
      return "Action";
    case "chain-event":
      return "Chain event";
    case "configuration-change":
      return "Configuration";
    case "finding-change":
      return "Finding";
  }
}

export function activityDeadlineLabel(deadline: OperatorDeadline | null): string | null {
  if (deadline === null) return null;
  switch (deadline.kind) {
    case "burn-block":
      return `Bitcoin block ${deadline.burnBlockHeight.toLocaleString("en-US")}`;
    case "reward-cycle":
      return `Cycle ${deadline.rewardCycleId.toLocaleString("en-US")} ${deadline.phase.replaceAll("-", " ")}`;
    case "time":
      return new Date(deadline.at).toLocaleString();
  }
}

export function activityTimestamp(value: string): string {
  return new Date(value).toLocaleString();
}

export interface ActivityHistoryGroup {
  label: string;
  items: ActivityGroupSummary[];
}

function localDayStart(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

export function groupActivityHistory(
  items: readonly ActivityGroupSummary[],
  now = new Date(),
): ActivityHistoryGroup[] {
  const today = localDayStart(now);
  const yesterday = today - 24 * 60 * 60 * 1_000;
  const groups = new Map<string, ActivityGroupSummary[]>();
  for (const item of items) {
    const date = new Date(item.updatedAt);
    const day = localDayStart(date);
    const label =
      day === today
        ? "Today"
        : day === yesterday
          ? "Yesterday"
          : date.toLocaleDateString(undefined, {
              year: "numeric",
              month: "long",
              day: "numeric",
            });
    const values = groups.get(label) ?? [];
    values.push(item);
    groups.set(label, values);
  }
  return [...groups.entries()].map(([label, values]) => ({ label, items: values }));
}

export function activityTimelineState(entry: ActivityTimelineEntry): "ok" | "now" | "bad" | "" {
  if (entry.canonical === false || entry.code.includes("abort") || entry.code.includes("failed")) {
    return "bad";
  }
  if (entry.finalized === true || entry.code.includes("verified")) return "ok";
  return entry.canonical === true ? "now" : "";
}
