import {
  type RewardRun,
  type RewardRunOperation,
  type RewardRunPreparation,
  type RewardRunPrepareRequest,
  rewardRunPreparationSchema,
  rewardRunSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { ApiRequestError, apiJson, type ResponseSchema } from "../../api-client.js";

/**
 * Operator-run reward runs (plan §8.8, engine slice S3). One sealed recipe per run: the operator
 * reviews the exact children and approves with the recipe digest; the server-owned loop does the
 * rest without a browser.
 */

export const rewardRunKinds = [
  "collect-and-distribute",
  "distribute",
  "collect",
  "calculate",
  "finish-bitcoin-payouts",
] as const;
export type RewardRunKind = (typeof rewardRunKinds)[number];

/** The primary-button vocabulary maps onto the recipe operations the server may include. */
export function operationsForKind(kind: RewardRunKind): RewardRunOperation[] {
  switch (kind) {
    case "collect-and-distribute":
      return ["claim-rewards", "claim-staker-rewards"];
    case "distribute":
      return ["claim-staker-rewards"];
    case "collect":
      return ["claim-rewards"];
    case "calculate":
      return ["calculate-rewards"];
    case "finish-bitcoin-payouts":
      return ["settle-accepted-withdrawal", "reclaim-failed-withdrawal"];
  }
}

/** Runs that still own the gas wallet: unapproved drafts, approved, running, paused, halted. */
export const ACTIVE_RUN_STATUSES: ReadonlySet<RewardRun["status"]> = new Set([
  "awaiting-approval",
  "approved",
  "running",
  "paused",
  "halted",
]);

/** Runs whose loop is or may be moving transactions (drives the Now card's progress line). */
export const IN_PROGRESS_RUN_STATUSES: ReadonlySet<RewardRun["status"]> = new Set([
  "approved",
  "running",
  "paused",
  "halted",
]);

export class RewardRunsUnavailableError extends Error {
  constructor() {
    super("Reward runs are not available in this Sidekick build.");
    this.name = "RewardRunsUnavailableError";
  }
}

function unavailable(error: unknown): never {
  if (error instanceof ApiRequestError && (error.status === 404 || error.status === 501)) {
    throw new RewardRunsUnavailableError();
  }
  throw error;
}

const runListSchema: ResponseSchema<RewardRun[]> = {
  safeParse(value: unknown) {
    if (!Array.isArray(value)) {
      return { success: false, error: { message: "run list is not an array" } };
    }
    const runs: RewardRun[] = [];
    for (const item of value) {
      const parsed = rewardRunSchema.safeParse(item);
      if (!parsed.success) return { success: false, error: { message: parsed.error.message } };
      runs.push(parsed.data);
    }
    return { success: true, data: runs };
  },
};

export async function listRewardRuns(
  token: string,
  limit = 10,
  signal?: AbortSignal,
): Promise<RewardRun[]> {
  return apiJson(
    token,
    `/api/v1/rewards/runs?limit=${limit}`,
    runListSchema,
    signal ? { signal } : {},
  ).catch(unavailable);
}

export async function prepareRewardRun(
  token: string,
  request: RewardRunPrepareRequest,
  signal?: AbortSignal,
): Promise<RewardRunPreparation> {
  return apiJson(token, "/api/v1/rewards/runs", rewardRunPreparationSchema, {
    method: "POST",
    body: JSON.stringify(request),
    ...(signal ? { signal } : {}),
  }).catch(unavailable);
}

export async function loadRewardRunPreparation(
  token: string,
  preparationId: string,
  signal?: AbortSignal,
): Promise<RewardRunPreparation> {
  return apiJson(
    token,
    `/api/v1/rewards/run-preparations/${encodeURIComponent(preparationId)}`,
    rewardRunPreparationSchema,
    signal ? { signal } : {},
  ).catch(unavailable);
}

export async function approveRewardRun(
  token: string,
  runId: string,
  recipeSha256: string,
): Promise<RewardRun> {
  return apiJson(
    token,
    `/api/v1/rewards/runs/${encodeURIComponent(runId)}/approve`,
    rewardRunSchema,
    {
      method: "POST",
      body: JSON.stringify({ recipeSha256 }),
    },
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

async function runAction(
  token: string,
  runId: string,
  action: "pause" | "resume" | "cancel",
): Promise<RewardRun> {
  return apiJson(
    token,
    `/api/v1/rewards/runs/${encodeURIComponent(runId)}/${action}`,
    rewardRunSchema,
    {
      method: "POST",
    },
  ).catch(unavailable);
}

export const pauseRewardRun = (token: string, runId: string) => runAction(token, runId, "pause");
export const resumeRewardRun = (token: string, runId: string) => runAction(token, runId, "resume");
export const cancelRewardRun = (token: string, runId: string) => runAction(token, runId, "cancel");

export function runOperationLabel(operation: RewardRunOperation): string {
  switch (operation) {
    case "calculate-rewards":
      return "Run the network calculation";
    case "claim-rewards":
      return "Collect into the manager";
    case "claim-staker-rewards":
      return "Distribute payments";
    case "settle-accepted-withdrawal":
      return "Retire settled Bitcoin payouts";
    case "reclaim-failed-withdrawal":
      return "Return rejected Bitcoin payouts as sBTC";
  }
}

export interface RunStepSummary {
  operation: RewardRunOperation;
  label: string;
  count: number;
  done: number;
  amountSats: string | null;
}

/** Groups a recipe's children by operation for review and progress. */
export function summarizeRunSteps(run: RewardRun): RunStepSummary[] {
  const steps = new Map<RewardRunOperation, RunStepSummary>();
  for (const operation of run.recipe.orderedOperations) {
    steps.set(operation, {
      operation,
      label: runOperationLabel(operation),
      count: 0,
      done: 0,
      amountSats: null,
    });
  }
  for (const child of run.recipe.children) {
    const step = steps.get(child.operation) ?? {
      operation: child.operation,
      label: runOperationLabel(child.operation),
      count: 0,
      done: 0,
      amountSats: null,
    };
    steps.set(child.operation, step);
    step.count += 1;
    if (child.maximumAmountSats !== null && child.operation !== "claim-rewards") {
      step.amountSats = (
        BigInt(step.amountSats ?? "0") + BigInt(child.maximumAmountSats)
      ).toString();
    } else if (child.operation === "claim-rewards" && child.maximumAmountSats !== null) {
      step.amountSats = child.maximumAmountSats;
    }
  }
  for (const child of run.children) {
    const step = steps.get(child.operation);
    if (step && ["confirmed", "externally-completed", "skipped"].includes(child.status))
      step.done += 1;
  }
  return [...steps.values()];
}
