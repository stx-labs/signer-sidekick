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
    const add = (
      key: string,
      time: string,
      from: string,
      where: string,
      values: SQLInputValue[] = [],
      orderKey = key,
    ) => {
      const conditions = [where];
      parameters.push(...values);
      if (options.cutoff !== null) {
        conditions.push(`${time} >= ?`);
        parameters.push(options.cutoff);
      }
      if (options.after !== null) {
        // The redundant <= bound lets SQLite seek by time even with mixed Activity kinds.
        conditions.push(`${time} <= ? AND (${time} < ? OR ${key} > ? COLLATE BINARY)`);
        parameters.push(
          options.after.occurredAt,
          options.after.occurredAt,
          options.after.activityId,
        );
      }
      selects.push(`SELECT * FROM (SELECT ${key} AS activityId, ${time} AS occurredAt
        FROM ${from} WHERE ${conditions.join(" AND ")}
        ORDER BY ${time} DESC, ${orderKey} COLLATE BINARY ASC LIMIT ?)`);
      parameters.push(options.limit);
    };
    if (options.type === "all" || options.type === "actions") {
      add(
        "'wallet-intent:' || intent_id",
        "created_at",
        "browser_wallet_intents",
        "state IN ('complete', 'expired', 'superseded')",
      );
      add(
        "'engine-job:' || job_id",
        "created_at",
        "transaction_jobs",
        "state IN ('reconciled', 'superseded')",
      );
      add(
        "'reward-run:' || run_id",
        "created_at",
        "transaction_runs",
        "status IN ('completed', 'cancelled', 'expired')",
      );
    }
    if ((options.type === "all" || options.type === "chain-events") && options.contracts.length) {
      const contracts = options.contracts.map(() => "?").join(",");
      // Pick the earliest relevant print (then event index), preserving MIN(time) grouping
      // without grouping all history. Ownership remains global, never page-local.
      add(
        "'chain-tx:' || event.chain_id || ':' || event.tx_id",
        "COALESCE(event.occurred_at, event.first_seen_at)",
        "chain_events AS event INDEXED BY activity_chain_time",
        `event.chain_id = ? AND event.contract_id IN (${contracts})
          AND NOT EXISTS (SELECT 1 FROM chain_events AS earlier
            WHERE earlier.chain_id = event.chain_id AND earlier.tx_id = event.tx_id
              AND earlier.contract_id IN (${contracts})
              AND (COALESCE(earlier.occurred_at, earlier.first_seen_at), earlier.event_index)
                < (COALESCE(event.occurred_at, event.first_seen_at), event.event_index))
          AND NOT EXISTS (SELECT 1 FROM browser_wallet_intents WHERE txid = event.tx_id)
          AND NOT EXISTS (SELECT 1 FROM transaction_run_children WHERE txid = event.tx_id)
          AND NOT EXISTS (SELECT 1 FROM transaction_attempts WHERE precomputed_txid = event.tx_id)`,
        [options.chainId, ...options.contracts, ...options.contracts],
        "event.tx_id",
      );
    }
    if (options.type === "all" || options.type === "configuration") {
      add("'settings:' || revision", "changed_at", "settings_audit", "1=1");
    }
    if (selects.length === 0) return [];
    return this.db
      .prepare(`SELECT activityId, occurredAt FROM (${selects.join(" UNION ALL ")})
      ORDER BY occurredAt DESC, activityId COLLATE BINARY ASC LIMIT ?`)
      .all(...parameters, options.limit) as unknown as ActivityKey[];
  }
}
