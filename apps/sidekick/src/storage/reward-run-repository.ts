import type { DatabaseSync } from "node:sqlite";
import {
  type RewardRun,
  type RewardRunChild,
  type RewardRunChildStatus,
  type RewardRunOperation,
  type RewardRunRecipe,
  type RewardRunStatus,
  rewardRunRecipeSchema,
  rewardRunSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import type { RewardOperationPlan } from "@stx-labs/signer-sidekick-protocol/reward-operation-plan";
import { z } from "zod";

const runRowSchema = z.object({
  run_id: z.string().uuid(),
  status: z.enum([
    "draft",
    "awaiting-approval",
    "approved",
    "running",
    "paused",
    "completed",
    "halted",
    "cancelled",
    "expired",
  ]),
  wallet_principal: z.string(),
  recipe_sha256: z.string().length(64),
  recipe_json: z.string(),
  cursor: z.number().int().nonnegative(),
  gas_spent_ustx: z.string().regex(/^\d+$/),
  approval_expires_at: z.string(),
  runtime_expires_at: z.string().nullable(),
  approved_at: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  failure_reason: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const childRowSchema = z.object({
  child_index: z.number().int().nonnegative(),
  operation_kind: z.enum([
    "calculate-rewards",
    "claim-rewards",
    "claim-staker-rewards",
    "settle-accepted-withdrawal",
    "reclaim-failed-withdrawal",
  ]),
  account_key: z.string().nullable(),
  maximum_amount_sats: z.string().regex(/^\d+$/).nullable(),
  status: z.enum([
    "pending",
    "materialized",
    "broadcast",
    "confirmed",
    "externally-completed",
    "skipped",
    "halted",
  ]),
  materialized_amount_sats: z.string().regex(/^\d+$/).nullable(),
  plan_sha256: z.string().length(64).nullable(),
  txid: z
    .string()
    .regex(/^0x[0-9a-f]{64}$/)
    .nullable(),
  provenance: z.enum(["you", "another-caller", "policy-exception"]).nullable(),
  failure_reason: z.string().nullable(),
  updated_at: z.string(),
});

const attemptRowSchema = z.object({
  attempt_index: z.number().int().nonnegative(),
  precomputed_txid: z.string().regex(/^0x[0-9a-f]{64}$/),
  nonce: z.string().regex(/^\d+$/),
  fee_ustx: z.string().regex(/^\d+$/),
  state: z.enum(["signed", "accepted", "ambiguous", "rejected", "confirmed"]),
  broadcast_result_json: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const terminalRunStatuses = new Set<RewardRunStatus>(["completed", "cancelled", "expired"]);

function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export class RewardRunRepositoryError extends Error {
  constructor(
    readonly code:
      | "authorization-busy"
      | "run-not-found"
      | "state-conflict"
      | "recipe-conflict"
      | "child-not-found",
    message: string,
  ) {
    super(message);
    this.name = "RewardRunRepositoryError";
  }
}

export interface StoredRewardRunAttempt {
  attemptIndex: number;
  precomputedTxid: `0x${string}`;
  nonce: string;
  feeUstx: string;
  state: "signed" | "accepted" | "ambiguous" | "rejected" | "confirmed";
  broadcastResult: unknown | null;
  createdAt: string;
  updatedAt: string;
}

export class RewardRunRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(input: {
    runId: string;
    walletPrincipal: string;
    recipeSha256: string;
    recipe: RewardRunRecipe;
    approvalExpiresAt: string;
    children: ReadonlyArray<{
      operation: RewardRunOperation;
      adapterId: string;
      adapterRevision: number;
      accountKey?: string | null;
      maximumAmountSats?: string | null;
    }>;
    now: string;
  }): RewardRun {
    const recipe = rewardRunRecipeSchema.parse(input.recipe);
    return transaction(this.db, () => {
      try {
        this.db
          .prepare(
            `INSERT INTO gas_wallet_authorizations (
               wallet_principal, authorization_kind, authorization_id, acquired_at, updated_at
             ) VALUES (?, 'reward-run', ?, ?, ?)`,
          )
          .run(input.walletPrincipal, input.runId, input.now, input.now);
      } catch (error) {
        if (String(error).includes("UNIQUE constraint failed")) {
          throw new RewardRunRepositoryError(
            "authorization-busy",
            "The gas wallet already has an active run or sweep",
          );
        }
        throw error;
      }
      this.db
        .prepare(
          `INSERT INTO transaction_runs (
             run_id, status, authorization_schema_version, wallet_principal, manager_principal,
             network, reward_cycle, distribution, recipe_sha256, recipe_json, cursor,
             gas_spent_ustx, approval_expires_at, created_at, updated_at
           ) VALUES (?, 'awaiting-approval', 2, ?, ?, ?, ?, ?, ?, ?, 0, '0', ?, ?, ?)`,
        )
        .run(
          input.runId,
          input.walletPrincipal,
          recipe.managerPrincipal,
          recipe.network,
          recipe.cycle,
          recipe.distribution,
          input.recipeSha256,
          JSON.stringify(recipe),
          input.approvalExpiresAt,
          input.now,
          input.now,
        );
      const insertChild = this.db.prepare(
        `INSERT INTO transaction_run_children (
           run_id, child_index, operation_kind, adapter_id, adapter_revision, account_key,
           maximum_amount_sats, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      );
      input.children.forEach((child, index) => {
        insertChild.run(
          input.runId,
          index,
          child.operation,
          child.adapterId,
          child.adapterRevision,
          child.accountKey ?? null,
          child.maximumAmountSats ?? null,
          input.now,
          input.now,
        );
      });
      return this.require(input.runId);
    });
  }

  get(runId: string): RewardRun | null {
    const row = this.db
      .prepare(
        `SELECT run_id, status, wallet_principal, recipe_sha256, recipe_json, cursor,
          gas_spent_ustx, approval_expires_at, runtime_expires_at, approved_at, started_at,
          completed_at, failure_reason, created_at, updated_at
         FROM transaction_runs WHERE run_id = ?`,
      )
      .get(runId);
    if (row === undefined) return null;
    const parsed = runRowSchema.parse(row);
    const children = this.children(runId);
    const complete = children.filter((child) =>
      ["confirmed", "externally-completed", "skipped"].includes(child.status),
    ).length;
    return rewardRunSchema.parse({
      schemaVersion: 1,
      runId: parsed.run_id,
      status: parsed.status,
      walletPrincipal: parsed.wallet_principal,
      recipeSha256: parsed.recipe_sha256,
      recipe: JSON.parse(parsed.recipe_json),
      cursor: parsed.cursor,
      progress: {
        completed: complete,
        total: children.length,
        inFlight: children.filter((child) => child.status === "broadcast").length,
      },
      gasSpentUstx: parsed.gas_spent_ustx,
      approvalExpiresAt: parsed.approval_expires_at,
      runtimeExpiresAt: parsed.runtime_expires_at,
      approvedAt: parsed.approved_at,
      startedAt: parsed.started_at,
      completedAt: parsed.completed_at,
      failureReason: parsed.failure_reason,
      createdAt: parsed.created_at,
      updatedAt: parsed.updated_at,
      children,
    });
  }

  require(runId: string): RewardRun {
    const run = this.get(runId);
    if (!run) throw new RewardRunRepositoryError("run-not-found", "Reward run does not exist");
    return run;
  }

  active(walletPrincipal: string): RewardRun | null {
    const row = this.db
      .prepare(
        `SELECT authorization_id FROM gas_wallet_authorizations
         WHERE wallet_principal = ? AND authorization_kind = 'reward-run'`,
      )
      .get(walletPrincipal) as { authorization_id: string } | undefined;
    return row ? this.get(row.authorization_id) : null;
  }

  list(limit = 20): RewardRun[] {
    const bounded = Math.max(1, Math.min(200, Math.trunc(limit)));
    const rows = this.db
      .prepare("SELECT run_id FROM transaction_runs ORDER BY created_at DESC, run_id DESC LIMIT ?")
      .all(bounded) as Array<{ run_id: string }>;
    return rows.map(({ run_id }) => this.require(run_id));
  }

  transition(input: {
    runId: string;
    from: readonly RewardRunStatus[];
    to: RewardRunStatus;
    now: string;
    approvedAt?: string | null;
    startedAt?: string | null;
    runtimeExpiresAt?: string | null;
    completedAt?: string | null;
    failureReason?: string | null;
  }): RewardRun {
    return transaction(this.db, () => {
      const current = this.require(input.runId);
      if (!input.from.includes(current.status)) {
        throw new RewardRunRepositoryError(
          "state-conflict",
          `Reward run is ${current.status}, expected ${input.from.join(" or ")}`,
        );
      }
      const result = this.db
        .prepare(
          `UPDATE transaction_runs SET status = ?, updated_at = ?,
             approved_at = COALESCE(?, approved_at),
             started_at = COALESCE(?, started_at),
             runtime_expires_at = COALESCE(?, runtime_expires_at),
             completed_at = COALESCE(?, completed_at),
             failure_reason = ?
           WHERE run_id = ? AND status = ?`,
        )
        .run(
          input.to,
          input.now,
          input.approvedAt ?? null,
          input.startedAt ?? null,
          input.runtimeExpiresAt ?? null,
          input.completedAt ?? null,
          input.failureReason ?? null,
          input.runId,
          current.status,
        );
      if (result.changes !== 1) {
        throw new RewardRunRepositoryError("state-conflict", "Reward run changed concurrently");
      }
      if (terminalRunStatuses.has(input.to)) this.releaseAuthorization(input.runId);
      return this.require(input.runId);
    });
  }

  materializeChild(input: {
    runId: string;
    childIndex: number;
    plan: RewardOperationPlan;
    amountSats?: string | null;
    now: string;
  }): RewardRunChild {
    const child = this.requireChild(input.runId, input.childIndex);
    if (child.status !== "pending") {
      throw new RewardRunRepositoryError("state-conflict", "Run child is not pending");
    }
    if (
      child.maximumAmountSats !== null &&
      input.amountSats !== null &&
      input.amountSats !== undefined &&
      BigInt(input.amountSats) > BigInt(child.maximumAmountSats)
    ) {
      throw new RewardRunRepositoryError(
        "recipe-conflict",
        "Materialized payment exceeds its approved recipe bound",
      );
    }
    this.db
      .prepare(
        `UPDATE transaction_run_children SET status = 'materialized', plan_sha256 = ?,
           plan_json = ?, materialized_amount_sats = ?, updated_at = ?
         WHERE run_id = ? AND child_index = ? AND status = 'pending'`,
      )
      .run(
        input.plan.planSha256,
        JSON.stringify(input.plan),
        input.amountSats ?? null,
        input.now,
        input.runId,
        input.childIndex,
      );
    return this.requireChild(input.runId, input.childIndex);
  }

  childPlan(runId: string, childIndex: number): RewardOperationPlan | null {
    const row = this.db
      .prepare(
        "SELECT plan_json FROM transaction_run_children WHERE run_id = ? AND child_index = ?",
      )
      .get(runId, childIndex) as { plan_json: string | null } | undefined;
    if (!row) throw new RewardRunRepositoryError("child-not-found", "Run child does not exist");
    return row.plan_json === null ? null : (JSON.parse(row.plan_json) as RewardOperationPlan);
  }

  updateChild(input: {
    runId: string;
    childIndex: number;
    from: readonly RewardRunChildStatus[];
    to: RewardRunChildStatus;
    now: string;
    txid?: `0x${string}` | null;
    provenance?: "you" | "another-caller" | "policy-exception" | null;
    failureReason?: string | null;
  }): RewardRunChild {
    const current = this.requireChild(input.runId, input.childIndex);
    if (!input.from.includes(current.status)) {
      throw new RewardRunRepositoryError("state-conflict", "Run child changed concurrently");
    }
    const result = this.db
      .prepare(
        `UPDATE transaction_run_children SET status = ?, txid = COALESCE(?, txid),
           provenance = ?, failure_reason = ?, updated_at = ?
         WHERE run_id = ? AND child_index = ? AND status = ?`,
      )
      .run(
        input.to,
        input.txid ?? null,
        input.provenance ?? null,
        input.failureReason ?? null,
        input.now,
        input.runId,
        input.childIndex,
        current.status,
      );
    if (result.changes !== 1) {
      throw new RewardRunRepositoryError("state-conflict", "Run child changed concurrently");
    }
    return this.requireChild(input.runId, input.childIndex);
  }

  resetUnattemptedMaterializedChild(runId: string, childIndex: number, now: string): void {
    const attempt = this.db
      .prepare(
        `SELECT 1 AS present FROM transaction_run_attempts
         WHERE run_id = ? AND child_index = ? LIMIT 1`,
      )
      .get(runId, childIndex);
    if (attempt !== undefined) {
      throw new RewardRunRepositoryError(
        "state-conflict",
        "A materialized child with an attempt cannot be reset",
      );
    }
    const result = this.db
      .prepare(
        `UPDATE transaction_run_children SET status = 'pending', plan_sha256 = NULL,
           plan_json = NULL, materialized_amount_sats = NULL, updated_at = ?
         WHERE run_id = ? AND child_index = ? AND status = 'materialized'`,
      )
      .run(now, runId, childIndex);
    if (result.changes !== 1) {
      throw new RewardRunRepositoryError(
        "state-conflict",
        "Materialized child changed concurrently",
      );
    }
  }

  /** Explicit operator resume may rebuild a child the node deterministically rejected. */
  resetRejectedChild(runId: string, childIndex: number, now: string): void {
    const child = this.requireChild(runId, childIndex);
    const attempt = this.attempts(runId, childIndex).at(-1);
    if (child.status !== "halted" || attempt?.state !== "rejected") {
      throw new RewardRunRepositoryError(
        "state-conflict",
        "Only a deterministically rejected child can be explicitly retried",
      );
    }
    const result = this.db
      .prepare(
        `UPDATE transaction_run_children SET status = 'pending', plan_sha256 = NULL,
           plan_json = NULL, materialized_amount_sats = NULL, txid = NULL, provenance = NULL,
           failure_reason = NULL, updated_at = ?
         WHERE run_id = ? AND child_index = ? AND status = 'halted'`,
      )
      .run(now, runId, childIndex);
    if (result.changes !== 1) {
      throw new RewardRunRepositoryError("state-conflict", "Rejected child changed concurrently");
    }
  }

  advanceCursor(
    runId: string,
    expectedCursor: number,
    gasSpentUstx: string,
    now: string,
  ): RewardRun {
    const result = this.db
      .prepare(
        `UPDATE transaction_runs SET cursor = cursor + 1, gas_spent_ustx = ?, updated_at = ?
         WHERE run_id = ? AND cursor = ?`,
      )
      .run(gasSpentUstx, now, runId, expectedCursor);
    if (result.changes !== 1) {
      throw new RewardRunRepositoryError(
        "state-conflict",
        "Reward run cursor changed concurrently",
      );
    }
    return this.require(runId);
  }

  insertAttempt(input: {
    runId: string;
    childIndex: number;
    precomputedTxid: `0x${string}`;
    nonce: string;
    feeUstx: string;
    state: StoredRewardRunAttempt["state"];
    broadcastResult?: unknown | null;
    now: string;
  }): StoredRewardRunAttempt {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(attempt_index), -1) + 1 AS next_index
         FROM transaction_run_attempts WHERE run_id = ? AND child_index = ?`,
      )
      .get(input.runId, input.childIndex) as { next_index: number };
    this.db
      .prepare(
        `INSERT INTO transaction_run_attempts (
           run_id, child_index, attempt_index, precomputed_txid, nonce, fee_ustx, state,
           broadcast_result_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.childIndex,
        row.next_index,
        input.precomputedTxid,
        input.nonce,
        input.feeUstx,
        input.state,
        input.broadcastResult === null || input.broadcastResult === undefined
          ? null
          : JSON.stringify(input.broadcastResult),
        input.now,
        input.now,
      );
    return this.attempts(input.runId, input.childIndex).at(-1) as StoredRewardRunAttempt;
  }

  updateAttempt(input: {
    runId: string;
    childIndex: number;
    attemptIndex: number;
    state: StoredRewardRunAttempt["state"];
    broadcastResult?: unknown | null;
    now: string;
  }): void {
    this.db
      .prepare(
        `UPDATE transaction_run_attempts SET state = ?, broadcast_result_json = ?, updated_at = ?
         WHERE run_id = ? AND child_index = ? AND attempt_index = ?`,
      )
      .run(
        input.state,
        input.broadcastResult === null || input.broadcastResult === undefined
          ? null
          : JSON.stringify(input.broadcastResult),
        input.now,
        input.runId,
        input.childIndex,
        input.attemptIndex,
      );
  }

  attempts(runId: string, childIndex: number): StoredRewardRunAttempt[] {
    const rows = this.db
      .prepare(
        `SELECT attempt_index, precomputed_txid, nonce, fee_ustx, state,
          broadcast_result_json, created_at, updated_at
         FROM transaction_run_attempts WHERE run_id = ? AND child_index = ?
         ORDER BY attempt_index ASC`,
      )
      .all(runId, childIndex);
    return rows.map((row) => {
      const value = attemptRowSchema.parse(row);
      return {
        attemptIndex: value.attempt_index,
        precomputedTxid: value.precomputed_txid as `0x${string}`,
        nonce: value.nonce,
        feeUstx: value.fee_ustx,
        state: value.state,
        broadcastResult:
          value.broadcast_result_json === null ? null : JSON.parse(value.broadcast_result_json),
        createdAt: value.created_at,
        updatedAt: value.updated_at,
      };
    });
  }

  private children(runId: string): RewardRunChild[] {
    const rows = this.db
      .prepare(
        `SELECT child_index, operation_kind, account_key, maximum_amount_sats, status,
          materialized_amount_sats, plan_sha256, txid, provenance, failure_reason, updated_at
         FROM transaction_run_children WHERE run_id = ? ORDER BY child_index ASC`,
      )
      .all(runId);
    return rows.map((row) => this.toChild(childRowSchema.parse(row)));
  }

  private child(runId: string, childIndex: number): RewardRunChild | null {
    const row = this.db
      .prepare(
        `SELECT child_index, operation_kind, account_key, maximum_amount_sats, status,
          materialized_amount_sats, plan_sha256, txid, provenance, failure_reason, updated_at
         FROM transaction_run_children WHERE run_id = ? AND child_index = ?`,
      )
      .get(runId, childIndex);
    return row === undefined ? null : this.toChild(childRowSchema.parse(row));
  }

  private requireChild(runId: string, childIndex: number): RewardRunChild {
    const child = this.child(runId, childIndex);
    if (!child) throw new RewardRunRepositoryError("child-not-found", "Run child does not exist");
    return child;
  }

  private toChild(row: z.infer<typeof childRowSchema>): RewardRunChild {
    return {
      index: row.child_index,
      operation: row.operation_kind,
      accountKey: row.account_key,
      status: row.status,
      maximumAmountSats: row.maximum_amount_sats,
      materializedAmountSats: row.materialized_amount_sats,
      planSha256: row.plan_sha256,
      txid: row.txid as `0x${string}` | null,
      provenance: row.provenance,
      failureReason: row.failure_reason,
      updatedAt: row.updated_at,
    };
  }

  private releaseAuthorization(runId: string): void {
    this.db
      .prepare(
        `DELETE FROM gas_wallet_authorizations
         WHERE authorization_kind = 'reward-run' AND authorization_id = ?`,
      )
      .run(runId);
  }
}
