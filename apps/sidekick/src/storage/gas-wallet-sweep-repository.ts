import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { type GasWalletSweepPlan, gasWalletSweepPlanSchema } from "../gas-wallet-sweep.js";

export type StoredGasWalletSweepStatus =
  | "planned"
  | "broadcast"
  | "confirmed"
  | "failed"
  | "cancelled"
  | "expired";

export interface StoredGasWalletSweep {
  sweepId: string;
  status: StoredGasWalletSweepStatus;
  walletPrincipal: string;
  recipient: string;
  amountUstx: string;
  feeUstx: string;
  nonce: string;
  balanceUstx: string;
  planSha256: string;
  txid: `0x${string}` | null;
  broadcastAmbiguous: boolean;
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
  broadcastAt: string | null;
  resolvedAt: string | null;
  blockHeight: number | null;
  failureReason: string | null;
  updatedAt: string;
}

const rowSchema = z
  .object({
    sweep_id: z.string().uuid(),
    status: z.enum(["planned", "broadcast", "confirmed", "failed", "cancelled", "expired"]),
    wallet_principal: z.string().min(1),
    recipient: z.string().min(1),
    amount_ustx: z.string(),
    fee_ustx: z.string(),
    nonce: z.string(),
    balance_ustx: z.string(),
    plan_sha256: z.string().length(64),
    txid: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/)
      .nullable(),
    broadcast_ambiguous: z.union([z.literal(0), z.literal(1)]),
    created_at: z.string(),
    expires_at: z.string(),
    approved_at: z.string().nullable(),
    broadcast_at: z.string().nullable(),
    resolved_at: z.string().nullable(),
    block_height: z.number().int().nullable(),
    failure_reason: z.string().nullable(),
    updated_at: z.string(),
  })
  .strict();

function toRecord(row: z.infer<typeof rowSchema>): StoredGasWalletSweep {
  return {
    sweepId: row.sweep_id,
    status: row.status,
    walletPrincipal: row.wallet_principal,
    recipient: row.recipient,
    amountUstx: row.amount_ustx,
    feeUstx: row.fee_ustx,
    nonce: row.nonce,
    balanceUstx: row.balance_ustx,
    planSha256: row.plan_sha256,
    txid: row.txid as `0x${string}` | null,
    broadcastAmbiguous: row.broadcast_ambiguous === 1,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    approvedAt: row.approved_at,
    broadcastAt: row.broadcast_at,
    resolvedAt: row.resolved_at,
    blockHeight: row.block_height,
    failureReason: row.failure_reason,
    updatedAt: row.updated_at,
  };
}

const columns = `sweep_id, status, wallet_principal, recipient, amount_ustx, fee_ustx, nonce, balance_ustx,
  plan_sha256, txid, broadcast_ambiguous, created_at, expires_at, approved_at, broadcast_at,
  resolved_at, block_height, failure_reason, updated_at`;

export interface GasWalletSweepPatch {
  status?: StoredGasWalletSweepStatus;
  txid?: `0x${string}` | null;
  broadcastAmbiguous?: boolean;
  approvedAt?: string | null;
  broadcastAt?: string | null;
  resolvedAt?: string | null;
  blockHeight?: number | null;
  failureReason?: string | null;
}

export class GasWalletSweepRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(input: {
    sweepId: string;
    walletPrincipal: string;
    plan: GasWalletSweepPlan;
    createdAt: string;
  }): StoredGasWalletSweep {
    const plan = gasWalletSweepPlanSchema.parse(input.plan);
    this.db
      .prepare(
        `INSERT INTO gas_wallet_sweeps (
           sweep_id, status, wallet_principal, recipient, amount_ustx, fee_ustx, nonce, balance_ustx,
           plan_sha256, plan_json, txid, broadcast_ambiguous, created_at, expires_at, approved_at,
           broadcast_at, resolved_at, block_height, failure_reason, updated_at
         ) VALUES (?, 'planned', ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, ?)`,
      )
      .run(
        input.sweepId,
        input.walletPrincipal,
        plan.material.recipient,
        plan.material.amountUstx,
        plan.material.feeUstx,
        plan.material.nonce,
        plan.material.balanceUstx,
        plan.planSha256,
        JSON.stringify(plan),
        input.createdAt,
        plan.material.expiresAt,
        input.createdAt,
      );
    const stored = this.get(input.sweepId);
    if (!stored) throw new Error("Gas wallet sweep did not persist");
    return stored;
  }

  get(sweepId: string): StoredGasWalletSweep | null {
    const row = this.db
      .prepare(`SELECT ${columns} FROM gas_wallet_sweeps WHERE sweep_id = ?`)
      .get(sweepId);
    return row === undefined ? null : toRecord(rowSchema.parse(row));
  }

  getPlan(sweepId: string): GasWalletSweepPlan | null {
    const row = this.db
      .prepare("SELECT plan_json FROM gas_wallet_sweeps WHERE sweep_id = ?")
      .get(sweepId) as { plan_json: string } | undefined;
    if (row === undefined) return null;
    return gasWalletSweepPlanSchema.parse(JSON.parse(row.plan_json));
  }

  update(sweepId: string, patch: GasWalletSweepPatch, updatedAt: string): StoredGasWalletSweep {
    const sets: string[] = ["updated_at = ?"];
    const values: Array<string | number | null> = [updatedAt];
    const add = (column: string, value: string | number | null) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.status !== undefined) add("status", patch.status);
    if (patch.txid !== undefined) add("txid", patch.txid);
    if (patch.broadcastAmbiguous !== undefined) {
      add("broadcast_ambiguous", patch.broadcastAmbiguous ? 1 : 0);
    }
    if (patch.approvedAt !== undefined) add("approved_at", patch.approvedAt);
    if (patch.broadcastAt !== undefined) add("broadcast_at", patch.broadcastAt);
    if (patch.resolvedAt !== undefined) add("resolved_at", patch.resolvedAt);
    if (patch.blockHeight !== undefined) add("block_height", patch.blockHeight);
    if (patch.failureReason !== undefined) add("failure_reason", patch.failureReason);
    values.push(sweepId);
    this.db
      .prepare(`UPDATE gas_wallet_sweeps SET ${sets.join(", ")} WHERE sweep_id = ?`)
      .run(...values);
    const stored = this.get(sweepId);
    if (!stored) throw new Error("Gas wallet sweep does not exist");
    return stored;
  }

  list(limit = 20): StoredGasWalletSweep[] {
    const bounded = Math.max(1, Math.min(200, Math.trunc(limit)));
    const rows = this.db
      .prepare(
        `SELECT ${columns} FROM gas_wallet_sweeps ORDER BY created_at DESC, sweep_id DESC LIMIT ?`,
      )
      .all(bounded);
    return rows.map((row) => toRecord(rowSchema.parse(row)));
  }

  /** The single sweep that is planned or broadcast, if any. */
  active(): StoredGasWalletSweep | null {
    const row = this.db
      .prepare(
        `SELECT ${columns} FROM gas_wallet_sweeps WHERE status IN ('planned', 'broadcast')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get();
    return row === undefined ? null : toRecord(rowSchema.parse(row));
  }
}
