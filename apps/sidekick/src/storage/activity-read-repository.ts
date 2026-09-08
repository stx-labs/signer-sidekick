import type { DatabaseSync, SQLInputValue } from "node:sqlite";

export interface ActivityKey {
  activityId: string;
  occurredAt: string;
}

/** Read-only indexes over the existing authorities. No copied Activity state or repair loop. */
export class ActivityReadRepository {
  constructor(private readonly db: DatabaseSync) {}

  activeKeys(limit: number): ActivityKey[] {
    return this.db
      .prepare(`
      SELECT 'wallet-intent:' || intent_id AS activityId, created_at AS occurredAt
      FROM browser_wallet_intents
      WHERE state IN ('prepared', 'submitted', 'mempool', 'confirmed', 'failed', 'reobserve')
      UNION ALL
      SELECT 'engine-job:' || job_id, created_at FROM transaction_jobs
      WHERE state NOT IN ('reconciled', 'superseded')
      UNION ALL
      SELECT 'reward-run:' || run_id, created_at FROM transaction_runs
      WHERE status NOT IN ('completed', 'cancelled', 'expired')
      LIMIT ?`)
      .all(limit) as unknown as ActivityKey[];
  }

  historyKeys(options: {
    chainId: number;
    contracts: readonly string[];
    type: "all" | "actions" | "chain-events" | "configuration";
    cutoff: string | null;
    after: ActivityKey | null;
    limit: number;
  }): ActivityKey[] {
    const selects: string[] = [];
    const parameters: SQLInputValue[] = [];
    if (options.type === "all" || options.type === "actions") {
      selects.push(`SELECT 'wallet-intent:' || intent_id AS activityId, created_at AS occurredAt
        FROM browser_wallet_intents WHERE state IN ('complete', 'expired', 'superseded')`);
      selects.push(`SELECT 'engine-job:' || job_id, created_at FROM transaction_jobs
        WHERE state IN ('reconciled', 'superseded')`);
      selects.push(`SELECT 'reward-run:' || run_id, created_at FROM transaction_runs
        WHERE status IN ('completed', 'cancelled', 'expired')`);
    }
    if (options.type === "all" || options.type === "chain-events") {
      // Group BEFORE applying the page boundary so a transaction with multiple prints cannot
      // split into two activities. An operation owns its txid even when it is on another page.
      selects.push(`SELECT 'chain-tx:' || chain_id || ':' || tx_id AS activityId,
          MIN(COALESCE(occurred_at, first_seen_at)) AS occurredAt
        FROM chain_events AS event
        WHERE chain_id = ? AND contract_id IN (${options.contracts.map(() => "?").join(",")})
          AND NOT EXISTS (SELECT 1 FROM browser_wallet_intents WHERE txid = event.tx_id)
          AND NOT EXISTS (SELECT 1 FROM transaction_run_children WHERE txid = event.tx_id)
          AND NOT EXISTS (SELECT 1 FROM transaction_attempts WHERE precomputed_txid = event.tx_id)
        GROUP BY chain_id, tx_id`);
      parameters.push(options.chainId, ...options.contracts);
    }
    if (options.type === "all" || options.type === "configuration") {
      selects.push(
        "SELECT 'settings:' || revision AS activityId, changed_at AS occurredAt FROM settings_audit",
      );
    }
    const conditions: string[] = [];
    if (options.cutoff !== null) {
      conditions.push("occurredAt >= ?");
      parameters.push(options.cutoff);
    }
    if (options.after !== null) {
      conditions.push("(occurredAt < ? OR (occurredAt = ? AND activityId > ? COLLATE BINARY))");
      parameters.push(options.after.occurredAt, options.after.occurredAt, options.after.activityId);
    }
    return this.db
      .prepare(`SELECT activityId, occurredAt FROM (${selects.join(" UNION ALL ")})
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY occurredAt DESC, activityId COLLATE BINARY ASC LIMIT ?`)
      .all(...parameters, options.limit) as unknown as ActivityKey[];
  }
}
