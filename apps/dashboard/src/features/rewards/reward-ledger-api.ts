import {
  type RewardLedger,
  type RewardLedgerDistribution,
  rewardLedgerSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { apiDownload, apiJson } from "../../api-client.js";

export interface RewardLedgerQuery {
  cycle?: number | null;
  distribution?: 1 | 2 | null;
  staker?: string | null;
  scope?: "selection" | "all";
}

export function rewardLedgerSearch(query: RewardLedgerQuery): string {
  const search = new URLSearchParams();
  if (query.cycle !== null && query.cycle !== undefined) search.set("cycle", String(query.cycle));
  if (query.distribution !== null && query.distribution !== undefined) {
    search.set("distribution", String(query.distribution));
  }
  if (query.staker) search.set("staker", query.staker);
  if (query.scope === "all") search.set("scope", "all");
  const text = search.toString();
  return text ? `?${text}` : "";
}

/** Reads the read-only reward ledger (plan S1): cycles, the selected distribution's payments, fees. */
export async function loadRewardLedger(
  token: string,
  query: RewardLedgerQuery = {},
  signal?: AbortSignal,
): Promise<RewardLedger> {
  return apiJson(
    token,
    `/api/v1/rewards/ledger${rewardLedgerSearch(query)}`,
    rewardLedgerSchema,
    signal ? { signal } : {},
  );
}

export type RewardLedgerExportName = "distributions" | "payments" | "fees";
export type RewardLedgerExportFormat = "csv" | "json";

export function rewardLedgerExportUrl(
  name: RewardLedgerExportName,
  format: RewardLedgerExportFormat,
  query: RewardLedgerQuery,
): string {
  return `/api/v1/rewards/ledger/${name}.${format}${rewardLedgerSearch(query)}`;
}

export async function downloadRewardLedgerExport(
  token: string,
  name: RewardLedgerExportName,
  format: RewardLedgerExportFormat,
  query: RewardLedgerQuery,
): Promise<void> {
  await apiDownload(token, rewardLedgerExportUrl(name, format, query), {
    expectedContentTypes:
      format === "csv" ? ["text/csv"] : ["application/json", "application/json; charset=utf-8"],
    fallbackFilename: `signer-sidekick-reward-${name}.${format}`,
  });
}

/** The distribution the page is looking at: the live one by default, or the queried one. */
export function selectedDistribution(ledger: RewardLedger): RewardLedgerDistribution | null {
  const cycle =
    ledger.query.cycle === null
      ? ledger.cycles.find((entry) => entry.cycle === ledger.current.cycle)
      : ledger.cycles.find((entry) => entry.cycle === ledger.query.cycle);
  if (!cycle) return null;
  const wanted = ledger.query.distribution ?? ledger.current.distribution ?? null;
  return (
    cycle.distributions.find((distribution) => distribution.distribution === wanted) ??
    cycle.distributions.at(-1) ??
    null
  );
}
