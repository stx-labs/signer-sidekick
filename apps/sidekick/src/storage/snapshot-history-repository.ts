import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { chainAnchorSchema } from "../chain-anchor.js";

export const SNAPSHOT_DETAIL_RETENTION_DAYS = 21;
const maintenanceIntervalMs = 5 * 60_000;
const batchSize = 250;

const histories = [
  {
    table: "staker_position_observations",
    identity: ["manager_principal", "staker_principal"],
    // Values, availability, and provenance matter; sample timestamps/heights do not.
    changes: [
      "has_stx",
      "has_btc",
      "stx_node_verified",
      "position_present",
      "signer_principal",
      "amount_ustx",
      "first_reward_cycle",
      "num_cycles",
      "unlock_cycle",
      "unlock_burn_height",
      "source_id",
      "verification_source_id",
      "reconciliation_complete",
      "position_detail_json",
    ],
  },
  {
    table: "pool_cycle_snapshots",
    identity: ["manager_principal", "reward_cycle"],
    // Detailed numeric forecasts expire; checkpoint estimates and quality transitions remain.
    changes: [
      "status",
      "roster_available",
      "value_classification",
      "contract_source",
      "local_roster_source",
    ],
  },
] as const;
type History = (typeof histories)[number];
type Row = Record<string, SQLInputValue>;
const order = ["observed_at", "observed_burn_block_height", "observed_stacks_tip_height"];

function anchor(row: Row, history: History) {
  if (typeof row.chain_anchor_json !== "string") return null;
  if (
    history.table === "staker_position_observations" &&
    (row.reconciliation_complete !== 1 || typeof row.position_detail_json !== "string")
  )
    return null;
  if (history.table === "pool_cycle_snapshots" && row.roster_available !== 1) return null;
  try {
    const parsed = chainAnchorSchema.safeParse(JSON.parse(row.chain_anchor_json));
    if (!parsed.success) return null;
    const value = parsed.data;
    if (
      value.burnBlockHeight !== row.observed_burn_block_height ||
      value.stacksBlockHeight !== row.observed_stacks_tip_height
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

function redundant(
  history: History,
  previous: Row | undefined,
  current: Row,
  next: Row | undefined,
) {
  if (!previous || !next) return false; // first/latest state is always retained
  const a = anchor(previous, history);
  const b = anchor(current, history);
  const c = anchor(next, history);
  if (!a || !b || !c) return false;
  // Preserve observations on both sides of real half-cycle boundaries, outages, and rewinds.
  if (
    a.rewardCycle !== b.rewardCycle ||
    b.rewardCycle !== c.rewardCycle ||
    a.checkpoint !== b.checkpoint ||
    b.checkpoint !== c.checkpoint ||
    a.rewardCycleLength !== b.rewardCycleLength ||
    b.rewardCycleLength !== c.rewardCycleLength ||
    a.prepareCycleLength !== b.prepareCycleLength ||
    b.prepareCycleLength !== c.prepareCycleLength ||
    a.stacksBlockHeight >= b.stacksBlockHeight ||
    b.stacksBlockHeight >= c.stacksBlockHeight ||
    a.burnBlockHeight > b.burnBlockHeight ||
    b.burnBlockHeight > c.burnBlockHeight ||
    a.burnBlockHeight - a.cyclePosition !== b.burnBlockHeight - b.cyclePosition ||
    b.burnBlockHeight - b.cyclePosition !== c.burnBlockHeight - c.cyclePosition
  )
    return false;
  return history.changes.every(
    (key) => previous[key] === current[key] && current[key] === next[key],
  );
}

/** Disposable snapshot detail only. Never touches payments, transaction evidence, or callbacks. */
export class SnapshotHistoryRepository {
  private nextMaintenanceAt = 0;
  constructor(private readonly db: DatabaseSync) {}

  maintain(observedAt: string): { examined: number; removed: number } {
    const now = Date.parse(z.iso.datetime().parse(observedAt));
    if (now < this.nextMaintenanceAt) return { examined: 0, removed: 0 };
    try {
      return this.compact(observedAt);
    } finally {
      this.nextMaintenanceAt = now + maintenanceIntervalMs;
    }
  }

  /** One durable, bounded batch per table; retained rows leave the maintenance index as well. */
  compact(observedAt: string, limit = batchSize): { examined: number; removed: number } {
    const now = Date.parse(z.iso.datetime().parse(observedAt));
    const cutoff = new Date(now - SNAPSHOT_DETAIL_RETENTION_DAYS * 86_400_000).toISOString();
    const count = z.number().int().min(1).max(1_000).parse(limit);
    let examined = 0;
    let removed = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const history of histories) {
        const identityWhere = history.identity.map((key) => `${key} = ?`).join(" AND ");
        const keyWhere = [...history.identity, ...order.slice(1)]
          .map((key) => `${key} = ?`)
          .join(" AND ");
        const neighbors = (direction: "<" | ">") =>
          this.db.prepare(`SELECT * FROM ${history.table}
          WHERE ${identityWhere} AND (${order.join(",")}) ${direction} (?, ?, ?)
          ORDER BY ${order.map((key) => `${key} ${direction === "<" ? "DESC" : "ASC"}`).join(",")}
          LIMIT 1`);
        const previous = neighbors("<");
        const next = neighbors(">");
        const keep = this.db.prepare(
          `UPDATE ${history.table} SET history_compacted = 1 WHERE ${keyWhere}`,
        );
        const drop = this.db.prepare(`DELETE FROM ${history.table} WHERE ${keyWhere}`);
        const candidates = this.db
          .prepare(`SELECT * FROM ${history.table}
          WHERE history_compacted = 0 AND observed_at < ? ORDER BY observed_at LIMIT ?`)
          .all(cutoff, count) as Row[];
        for (const row of candidates) {
          const neighborKey = [...history.identity, ...order].map((key) => row[key] ?? null);
          const before = previous.get(...neighborKey) as Row | undefined;
          const after = next.get(...neighborKey) as Row | undefined;
          const key = [...history.identity, ...order.slice(1)].map((field) => row[field] ?? null);
          if (redundant(history, before, row, after)) {
            removed += Number(drop.run(...key).changes);
          } else keep.run(...key);
          examined += 1;
        }
      }
      this.db.exec("COMMIT");
      return { examined, removed };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
