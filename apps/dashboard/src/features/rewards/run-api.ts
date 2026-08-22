import { ApiRequestError, apiJson, type ResponseSchema } from "../../api-client.js";

/**
 * Operator-run reward runs (plan §8.8, delivered by S3). The dashboard binds to the route shapes
 * the plan fixes — `POST /api/v1/rewards/runs` (draft), `POST …/runs/:id/approve` (Go),
 * `GET …/runs/:id` — with a permissive reader so the page ships ahead of the engine slice and
 * degrades to "runs are not available in this build" until the routes exist.
 */

export const rewardRunKinds = [
  "collect-and-distribute",
  "distribute",
  "collect",
  "calculate",
  "finish-bitcoin-payouts",
] as const;
export type RewardRunKind = (typeof rewardRunKinds)[number];

export interface RewardRunStep {
  kind: string;
  label: string;
  detail: string | null;
  transactions: number | null;
  amountSats: string | null;
  asset: "sBTC" | "BTC" | null;
  state: "planned" | "running" | "done" | "skipped" | "failed" | "halted" | null;
}

export interface RewardRun {
  runId: string;
  kind: string;
  cycle: number | null;
  distribution: 1 | 2 | null;
  state: string;
  steps: RewardRunStep[];
  transactions: number | null;
  transactionsDone: number | null;
  estimatedGasUstx: string | null;
  gasUsedUstx: string | null;
  approvalExpiresAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  haltReason: string | null;
  distributedSats: string | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function step(value: unknown): RewardRunStep | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const kind = text(record.kind);
  const label = text(record.label);
  if (kind === null || label === null) return null;
  const state = text(record.state);
  const asset = text(record.asset);
  return {
    kind,
    label,
    detail: text(record.detail),
    transactions: integer(record.transactions),
    amountSats: text(record.amountSats),
    asset: asset === "sBTC" || asset === "BTC" ? asset : null,
    state:
      state === "planned" ||
      state === "running" ||
      state === "done" ||
      state === "skipped" ||
      state === "failed" ||
      state === "halted"
        ? state
        : null,
  };
}

export const rewardRunSchema: ResponseSchema<RewardRun> = {
  safeParse(value: unknown) {
    if (!value || typeof value !== "object") {
      return { success: false, error: { message: "run is not an object" } };
    }
    const record = value as Record<string, unknown>;
    const runId = text(record.runId);
    const kind = text(record.kind);
    const state = text(record.state);
    if (!runId || !kind || !state) {
      return { success: false, error: { message: "run is missing runId, kind, or state" } };
    }
    const distribution = integer(record.distribution);
    const steps = Array.isArray(record.steps)
      ? record.steps.map(step).filter((entry): entry is RewardRunStep => entry !== null)
      : [];
    return {
      success: true,
      data: {
        runId,
        kind,
        cycle: integer(record.cycle),
        distribution: distribution === 1 || distribution === 2 ? distribution : null,
        state,
        steps,
        transactions: integer(record.transactions),
        transactionsDone: integer(record.transactionsDone),
        estimatedGasUstx: text(record.estimatedGasUstx),
        gasUsedUstx: text(record.gasUsedUstx),
        approvalExpiresAt: text(record.approvalExpiresAt),
        startedAt: text(record.startedAt),
        finishedAt: text(record.finishedAt),
        haltReason: text(record.haltReason),
        distributedSats: text(record.distributedSats),
      },
    };
  },
};

export class RewardRunsUnavailableError extends Error {
  constructor() {
    super("Reward runs are not available in this Sidekick build yet.");
    this.name = "RewardRunsUnavailableError";
  }
}

function unavailable(error: unknown): never {
  if (error instanceof ApiRequestError && (error.status === 404 || error.status === 501)) {
    throw new RewardRunsUnavailableError();
  }
  throw error;
}

export async function draftRewardRun(
  token: string,
  input: { kind: RewardRunKind; cycle: number | null; distribution: 1 | 2 | null },
): Promise<RewardRun> {
  return apiJson(token, "/api/v1/rewards/runs", rewardRunSchema, {
    method: "POST",
    body: JSON.stringify(input),
  }).catch(unavailable);
}

export async function approveRewardRun(token: string, runId: string): Promise<RewardRun> {
  return apiJson(
    token,
    `/api/v1/rewards/runs/${encodeURIComponent(runId)}/approve`,
    rewardRunSchema,
    { method: "POST" },
  ).catch(unavailable);
}

export async function loadRewardRun(
  token: string,
  runId: string,
  signal?: AbortSignal,
): Promise<RewardRun> {
  return apiJson(
    token,
    `/api/v1/rewards/runs/${encodeURIComponent(runId)}`,
    rewardRunSchema,
    signal ? { signal } : {},
  ).catch(unavailable);
}

export async function pauseRewardRun(token: string, runId: string): Promise<RewardRun> {
  return apiJson(
    token,
    `/api/v1/rewards/runs/${encodeURIComponent(runId)}/pause`,
    rewardRunSchema,
    { method: "POST" },
  ).catch(unavailable);
}

export async function cancelRewardRun(token: string, runId: string): Promise<RewardRun> {
  return apiJson(
    token,
    `/api/v1/rewards/runs/${encodeURIComponent(runId)}/cancel`,
    rewardRunSchema,
    { method: "POST" },
  ).catch(unavailable);
}
