import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRewardLedger } from "../reward-ledger.js";
import { type ActivityKey, ActivityReadRepository } from "./activity-read-repository.js";
import { migrations } from "./migrations.js";
import { SidekickStore } from "./store.js";

const manager = "SP000000000000000000002Q6VF78.signer-manager";
const pox = "SP000000000000000000002Q6VF78.pox-5";
const staker = "SP000000000000000000002Q6VF78";
const now = "2026-09-15T12:00:00.000Z";
const hash = `0x${"11".repeat(32)}`;
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const databases: DatabaseSync[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
});
function fixture(path = ":memory:") {
  const db = new DatabaseSync(path);
  databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  for (const migration of migrations) db.exec(migration.sql);
  db.prepare(
    "INSERT INTO chain_sources VALUES ('api','api','mainnet','https://unused.invalid',?,?)",
  ).run(now, now);
  return { db, store: new SidekickStore(db) };
}
function seed(db: DatabaseSync, count: number) {
  const event = db.prepare(`INSERT INTO chain_events
    (chain_id,tx_id,event_index,block_height,block_hash,index_block_hash,canonical,microblock_canonical,
     contract_id,raw_payload_json,decoded_payload_json,source_id,first_seen_at,updated_at,occurred_at)
    VALUES (1,?,?,?,?,?,1,1,?,'{}',?,'api',?,?,?)`);
  const claim = db.prepare(`INSERT INTO manager_activity_events
    (chain_id,tx_id,event_index,manager_principal,block_height,canonical,kind,staker_principal,reward_cycle,amount_sats,updated_at)
    VALUES (1,?,0,?,?,1,'claim-staker-rewards',?,?,'95',?)`);
  db.exec("BEGIN");
  for (let n = 0; n < count; n++) {
    const cycle = String(Math.floor(n / 50) + 100);
    const at = new Date(Date.parse(now) - Math.floor((count - n) / 3) * 60_000).toISOString();
    event.run(tx(n), 0, n, hash, hash, manager, "{}", at, at, n % 2 ? at : null);
    event.run(
      tx(n),
      1,
      n,
      hash,
      hash,
      pox,
      JSON.stringify({
        transactionStatus: "success",
        event: {
          kind: "claim-staker-rewards-for-signer",
          signerManager: manager,
          stakerPrincipal: staker,
          bondIndex: null,
          rewardCycle: n === 0 ? null : cycle,
          rewardsClaimedSats: "100",
        },
      }),
      at,
      at,
      at,
    );
    claim.run(tx(n), manager, n, staker, cycle, at);
  }
  db.exec("COMMIT");
}

describe("history reads independent of lifetime row limits", () => {
  it("reaches an old cycle past 10k payments and 200 cycles, including a cycle-less gross print", async () => {
    const { db, store } = fixture();
    seed(db, 10_100);
    expect(
      store.listManagerClaimRecords(1, manager, 10_000).some((row) => row.rewardCycle === "100"),
    ).toBe(false);
    const claims = store.listManagerClaimRecords(1, manager, 10_001, { cycles: [100] });
    const prints = store.listPox5RewardPrints(1, pox, manager, { cycles: [100] });
    expect(claims).toHaveLength(50);
    expect(prints).toHaveLength(50);
    expect(prints[0]).toMatchObject({ txId: tx(0), rewardCycle: null, rewardsClaimedSats: "100" });
    const allCycles: number[] = [];
    let beforeCycle: number | null = null;
    do {
      const page = store.listRewardLedgerCycles(1, manager, pox, {
        beforeCycle,
        limit: 20,
        liveCycles: [303],
      });
      allCycles.push(...page.cycles);
      beforeCycle = page.nextBeforeCycle;
    } while (beforeCycle !== null);
    expect(allCycles).toHaveLength(203);
    expect(new Set(allCycles).size).toBe(203);
    expect(allCycles.at(-1)).toBe(100);
    expect(store.listRewardLedgerCycles(2, manager, pox).cycles).toEqual([]);
    expect(store.listManagerClaimRecords(1, manager, 10, { cycles: [] })).toEqual([]);
    expect(store.listPox5RewardPrints(1, pox, manager, { cycles: [] })).toEqual([]);
    const plans = db
      .prepare(`EXPLAIN QUERY PLAN SELECT tx_id FROM manager_activity_events
      WHERE chain_id=1 AND manager_principal=? AND canonical=1 AND kind='claim-staker-rewards' AND reward_cycle='100'`)
      .all(manager);
    expect(JSON.stringify(plans)).toContain("manager_claim_cycle");
    const ledger = await buildRewardLedger({
      store,
      chainId: 1,
      managerPrincipal: manager,
      pox5ContractId: pox,
      sourceId: null,
      ownedTxids: new Set(),
      now: new Date(now),
      query: { cycle: 100 },
      snapshot: {
        generatedAt: now,
        network: "mainnet",
        managerPrincipal: manager,
        manager: { capabilities: { eventVocabulary: { normalizationAvailable: true } } },
        historyRecovery: {
          monitoringStartedAt: now,
          managerHistory: { status: "complete" },
          currentMemberHistory: { status: "complete" },
        },
      },
    });
    expect(ledger.payments).toHaveLength(50);
    expect(ledger.evidenceWindow.truncated).toBe(false);
    expect(
      ledger.payments.every((payment) => payment.cycle === 100 && payment.operatorFeeSats === "5"),
    ).toBe(true);
  });

  it("reuses fee totals across routine writes, invalidates on evidence/reorg, and isolates identity", () => {
    const { db, store } = fixture();
    seed(db, 2);
    const prepare = vi.spyOn(db, "prepare");
    const totals = () => store.getManagerRewardFeeTotals(1, manager, pox);
    expect(totals()).toEqual({
      paymentCount: 2,
      earnedIndexedSats: "10",
      unmatchedPaymentCount: 0,
    });
    db.prepare("UPDATE chain_sources SET base_url=?").run("https://another.invalid");
    totals().paymentCount = 999; // callers cannot mutate the retained value
    expect(totals().paymentCount).toBe(2);
    expect(prepare.mock.calls.filter(([sql]) => sql.includes("WITH claims AS"))).toHaveLength(1);
    expect(store.getManagerRewardFeeTotals(2, manager, pox).paymentCount).toBe(0);
    expect(
      store.getManagerRewardFeeTotals(1, manager, `${staker}.other-pox`).unmatchedPaymentCount,
    ).toBe(2);
    store.markIndexBlockNonCanonical(1, hash, now);
    expect(totals()).toEqual({ paymentCount: 0, earnedIndexedSats: "0", unmatchedPaymentCount: 0 });
    store.putChainEvent({
      chainId: 1,
      txId: tx(0),
      eventIndex: 0,
      blockHeight: 0,
      blockHash: hash,
      indexBlockHash: hash,
      canonical: true,
      microblockCanonical: true,
      microblockHash: null,
      microblockSequence: null,
      contractId: manager,
      topic: "claim-staker-rewards",
      rawPayload: {},
      decodedSchemaVersion: 1,
      decodedPayload: {
        transactionStatus: "success",
        event: {
          kind: "claim-staker-rewards",
          stakerPrincipal: staker,
          rewardCycle: "100",
          bondIndex: null,
          amountSats: "95",
          l1Withdrawal: null,
        },
      },
      sourceId: "api",
      observedAt: now,
    });
    expect(totals()).toEqual({ paymentCount: 1, earnedIndexedSats: "0", unmatchedPaymentCount: 1 });
    store.markMissingCanonicalContractEvents(1, manager, 0, true, new Set(), now);
    expect(totals().paymentCount).toBe(0);
  });

  it("notices commits from another SQLite connection without trusting a stale aggregate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sidekick-fee-cache-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    const { store } = fixture(path);
    expect(store.getManagerRewardFeeTotals(1, manager, pox).paymentCount).toBe(0);
    const writer = new DatabaseSync(path);
    databases.push(writer);
    seed(writer, 3);
    expect(store.getManagerRewardFeeTotals(1, manager, pox)).toMatchObject({
      paymentCount: 3,
      earnedIndexedSats: "15",
    });
  });

  it("keeps a selected cycle's later Bitcoin settlement outside the cycle filter", () => {
    const { db, store } = fixture();
    seed(db, 3);
    db.prepare(
      "UPDATE manager_activity_events SET request_id='1', withdrawal_amount_sats='90', max_fee_sats='5' WHERE tx_id=?",
    ).run(tx(0));
    db.prepare(
      "UPDATE manager_activity_events SET kind='settle-accepted-withdrawal', reward_cycle=NULL, request_id='1' WHERE tx_id=?",
    ).run(tx(1));
    db.prepare(
      "UPDATE manager_activity_events SET reward_cycle='141', request_id='2', withdrawal_amount_sats='90', max_fee_sats='5' WHERE tx_id=?",
    ).run(tx(2));
    expect(store.listManagerWithdrawalRecords(1, manager, 100, { cycles: [100] })).toMatchObject([
      { requestId: "1", state: "settled", resolvedTxId: tx(1) },
    ]);
    expect(store.listManagerWithdrawalRecords(1, manager, 100, { cycles: [141] })).toMatchObject([
      { requestId: "2", state: "pending" },
    ]);
    db.prepare("UPDATE manager_activity_events SET canonical=0 WHERE tx_id=?").run(tx(1));
    expect(store.listManagerWithdrawalRecords(1, manager, 100, { cycles: [100] })[0]?.state).toBe(
      "pending",
    );
  });

  it("matches grouped Activity ordering across ties, null occurrence times, filtering and every cursor", () => {
    const { db } = fixture();
    seed(db, 90);
    // Different print timestamps and noncanonical prints retain the original MIN(time) semantics.
    db.prepare(
      "UPDATE chain_events SET occurred_at=?, canonical=0 WHERE tx_id=? AND event_index=1",
    ).run("2026-09-14T00:00:00.000Z", tx(89));
    const activity = new ActivityReadRepository(db);
    for (const contracts of [[manager], [pox], [manager, pox]]) {
      for (const cutoff of [null, "2026-09-15T11:45:00.000Z"]) {
        const expected = db
          .prepare(`SELECT 'chain-tx:' || chain_id || ':' || tx_id AS activityId,
          MIN(COALESCE(occurred_at,first_seen_at)) AS occurredAt FROM chain_events
          WHERE chain_id=1 AND contract_id IN (${contracts.map(() => "?").join(",")})
          GROUP BY chain_id,tx_id HAVING (? IS NULL OR occurredAt >= ?)
          ORDER BY occurredAt DESC,activityId COLLATE BINARY`)
          .all(...contracts, cutoff, cutoff);
        const received: ActivityKey[] = [];
        let after: ActivityKey | null = null;
        for (;;) {
          const page = activity.historyKeys({
            chainId: 1,
            contracts,
            cutoff,
            after,
            type: "chain-events",
            limit: 7,
          });
          if (!page.length) break;
          received.push(...page);
          after = page.at(-1) ?? null;
          expect(received.length).toBeLessThanOrEqual(90);
        }
        expect(received).toEqual(expected);
      }
    }
    expect(
      activity.historyKeys({
        chainId: 1,
        contracts: [],
        cutoff: null,
        after: null,
        type: "chain-events",
        limit: 7,
      }),
    ).toEqual([]);
  });
});
