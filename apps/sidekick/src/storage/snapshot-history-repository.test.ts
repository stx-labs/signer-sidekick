import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrations } from "./migrations.js";
import { SnapshotHistoryRepository } from "./snapshot-history-repository.js";
import { SidekickStore } from "./store.js";

const now = "2026-09-15T12:00:00.000Z";
const cutoff = "2026-08-25T12:00:00.000Z";
const manager = "SP000000000000000000002Q6VF78.signer-manager";
const staker = "SP000000000000000000002Q6VF78";
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  for (const migration of migrations) db.exec(migration.sql);
  db.prepare(
    "INSERT INTO chain_sources VALUES ('api','api','mainnet','https://unused.invalid',?,?)",
  ).run(now, now);
  return { db, store: new SidekickStore(db) };
}
function anchor(n: number) {
  const cyclePosition = n % 2100;
  return {
    stacksBlockHeight: 10000 + n,
    burnBlockHeight: 500000 + n,
    indexBlockHash: `0x${n.toString(16).padStart(64, "0")}`,
    rewardCycle: 141 + Math.floor(n / 2100),
    rewardCycleLength: 2100,
    prepareCycleLength: 100,
    cyclePosition,
    phase: cyclePosition >= 2000 ? ("prepare" as const) : ("reward" as const),
    checkpoint: cyclePosition < 1050 ? ("first-half" as const) : ("second-half" as const),
  };
}
function position(
  db: DatabaseSync,
  n: number,
  options: {
    amount?: string;
    at?: string;
    legacy?: boolean;
    complete?: number;
    owner?: string;
  } = {},
) {
  const value = anchor(n);
  db.prepare(`INSERT INTO staker_position_observations (
    manager_principal, staker_principal, observed_burn_block_height, observed_stacks_tip_height,
    has_stx, has_btc, stx_node_verified, position_present, signer_principal, amount_ustx,
    first_reward_cycle, num_cycles, unlock_cycle, source_id, observed_at, chain_anchor_json,
    reconciliation_complete, observed_index_block_hash, position_detail_json
  ) VALUES (?,?,?, ?,1,0,1,1,?,?,'141','1','142','api',?,?,?,?,'{"active":true,"bond":null,"cycleMemberships":[]}')`).run(
    manager,
    options.owner ?? staker,
    value.burnBlockHeight,
    value.stacksBlockHeight,
    manager,
    options.amount ?? "100",
    options.at ?? new Date(Date.parse("2026-08-20T00:00:00Z") + n * 1000).toISOString(),
    options.legacy ? null : JSON.stringify(value),
    options.complete ?? 1,
    value.indexBlockHash,
  );
}
function retained(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT observed_stacks_tip_height - 10000 AS n FROM staker_position_observations ORDER BY observed_at",
    )
    .all()
    .map((row) => row.n);
}
function pool(store: SidekickStore, n: number, at?: string) {
  const value = anchor(n);
  store.putPoolCycleSnapshots({
    managerPrincipal: manager,
    chainAnchor: value,
    burnBlockHeight: value.burnBlockHeight,
    stacksTipHeight: value.stacksBlockHeight,
    observedAt: at ?? new Date(Date.parse("2026-08-20T00:00:00Z") + n * 1000).toISOString(),
    cycles: [
      {
        cycleId: 150,
        status: "ready",
        rosterAvailable: true,
        stakerCount: 100,
        enumeratedStxUstx: "1000",
        enumerationDeltaUstx: "0",
        pendingStxUstx: "1000",
        eligibleStxSharesUstx: "1000",
        totalDelegatedUstx: "1000",
        nonStxDelegatedUstx: "0",
        inSignerSet: true,
        thresholdUstx: String(n),
        thresholdMarginUstx: String(1000 - n),
        provenance: {
          classification: "projected",
          contractSource: "pox5-read-only",
          localRosterSource: "api-indexed-node-verified",
        },
      },
    ],
  });
}

describe("21-day snapshot detail retention", () => {
  it("does not alter financial chain evidence while deleting redundant snapshots", () => {
    const { db, store } = fixture();
    const txid = `0x${"22".repeat(32)}`;
    db.prepare(`INSERT INTO chain_events (chain_id,tx_id,event_index,block_height,block_hash,index_block_hash,
      canonical,microblock_canonical,contract_id,raw_payload_json,source_id,first_seen_at,updated_at)
      VALUES (1,?,0,1,?,?,1,1,?,'{"financial":"retained"}','api',?,?)`).run(
      txid,
      txid,
      txid,
      manager,
      now,
      now,
    );
    const evidence = db.prepare("SELECT * FROM chain_events").all();
    for (let n = 1; n <= 5; n++) position(db, n);
    expect(store.snapshotHistory.compact(now).removed).toBe(3);
    expect(db.prepare("SELECT * FROM chain_events").all()).toEqual(evidence);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("keeps the exact cutoff, latest state and both sides of a position change", () => {
    const { db, store } = fixture();
    for (let n = 1; n <= 9; n++)
      position(db, n, { amount: n < 5 ? "100" : "200", ...(n >= 8 ? { at: cutoff } : {}) });
    expect(store.snapshotHistory.compact(now)).toEqual({ examined: 7, removed: 4 });
    expect(retained(db)).toEqual([1, 4, 5, 8, 9]);
    expect(store.snapshotHistory.compact(now)).toEqual({ examined: 0, removed: 0 });
  });

  it("keeps sample pairs bracketing half-cycle and cycle boundaries, without inventing exact boundary samples", () => {
    const { db, store } = fixture();
    for (const n of [1040, 1042, 1047, 1055, 1056, 2099, 2102, 2105, 2108]) position(db, n);
    store.snapshotHistory.compact(now);
    expect(retained(db)).toEqual([1040, 1047, 1055, 2099, 2102, 2108]);
  });

  it("compacts numeric forecasts by observation period, not their future target cycle", () => {
    const { db, store } = fixture();
    for (const n of [1040, 1042, 1047, 1055, 1056, 1057]) pool(store, n);
    expect(store.snapshotHistory.compact(now)).toEqual({ examined: 6, removed: 2 });
    expect(
      db
        .prepare(
          "SELECT observed_stacks_tip_height - 10000 AS n FROM pool_cycle_snapshots ORDER BY observed_at",
        )
        .all(),
    ).toEqual([1040, 1047, 1055, 1057].map((n) => ({ n })));
  });

  it("preserves unclassifiable legacy and incomplete observations", () => {
    const { db, store } = fixture();
    for (let n = 1; n <= 8; n++) position(db, n, { legacy: n <= 4, complete: n >= 5 ? 0 : 1 });
    expect(store.snapshotHistory.compact(now)).toEqual({ examined: 8, removed: 0 });
    expect(store.snapshotHistory.compact(now)).toEqual({ examined: 0, removed: 0 });
  });

  it("preserves rewinds and source changes", () => {
    const { db, store } = fixture();
    for (const [index, n] of [10, 11, 9, 12, 13].entries())
      position(db, n, {
        at: new Date(Date.parse("2026-08-20T00:00:00Z") + index * 1000).toISOString(),
      });
    db.prepare(
      "INSERT INTO chain_sources VALUES ('another','api','mainnet','https://another.invalid',?,?)",
    ).run(now, now);
    db.exec(
      "UPDATE staker_position_observations SET source_id='another' WHERE observed_stacks_tip_height=10012",
    );
    expect(store.snapshotHistory.compact(now)).toEqual({ examined: 5, removed: 0 });
  });

  it("keeps bond and per-cycle membership changes even when the aggregate STX amount is unchanged", () => {
    const { db, store } = fixture();
    for (let n = 1; n <= 9; n++) position(db, n);
    db.prepare(
      "UPDATE staker_position_observations SET position_detail_json=? WHERE observed_stacks_tip_height BETWEEN 10004 AND 10006",
    ).run(
      JSON.stringify({
        active: true,
        bond: { amountSats: "5000" },
        cycleMemberships: [{ rewardCycle: "141", amountUstx: "90" }],
      }),
    );
    store.snapshotHistory.compact(now);
    expect(retained(db)).toEqual([1, 3, 4, 6, 7, 9]);
  });

  it("resumes bounded batches from durable flags after repository restart", () => {
    const { db, store } = fixture();
    for (let n = 1; n <= 15; n++) position(db, n);
    expect(store.snapshotHistory.compact(now, 4).examined).toBe(4);
    const restarted = new SnapshotHistoryRepository(db);
    expect(restarted.compact(now, 4).examined).toBe(4);
    while (restarted.compact(now, 4).examined) {
      /* bounded catch-up */
    }
    expect(retained(db)).toEqual([1, 15]);
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM staker_position_observations WHERE history_compacted=0 AND observed_at < ? ORDER BY observed_at LIMIT 250",
      )
      .all(cutoff);
    expect(JSON.stringify(plan)).toContain("position_detail_due");
  });

  it("rolls back the whole batch if deletion fails and paces maintenance separately", () => {
    const { db, store } = fixture();
    for (let n = 1; n <= 5; n++) position(db, n);
    db.exec(
      "CREATE TRIGGER prevent_fixture_delete BEFORE DELETE ON staker_position_observations BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
    );
    expect(() => store.snapshotHistory.maintain(now)).toThrow("fixture failure");
    expect(
      db
        .prepare("SELECT count(*) AS n FROM staker_position_observations WHERE history_compacted=1")
        .get(),
    ).toEqual({ n: 0 });
    expect(retained(db)).toEqual([1, 2, 3, 4, 5]);
    db.exec("DROP TRIGGER prevent_fixture_delete");
    expect(store.snapshotHistory.maintain(now)).toEqual({ examined: 0, removed: 0 });
    expect(store.snapshotHistory.maintain("2026-09-15T12:05:00.000Z").removed).toBe(3);
  });

  it("does not rewrite an identical pool sample or lose a changed same-anchor value", () => {
    const { db, store } = fixture();
    pool(store, 10);
    const before = db.prepare("SELECT total_changes() AS n").get();
    pool(store, 10, now);
    expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    expect(db.prepare("SELECT observed_at FROM pool_cycle_snapshots").get()?.observed_at).not.toBe(
      now,
    );
    db.exec("UPDATE pool_cycle_snapshots SET threshold_ustx='999', history_compacted=1");
    pool(store, 10, now);
    expect(
      db
        .prepare("SELECT threshold_ustx, history_compacted, observed_at FROM pool_cycle_snapshots")
        .get(),
    ).toEqual({ threshold_ustx: "10", history_compacted: 0, observed_at: now });
  });
});
