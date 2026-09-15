// Run after pnpm build: node scripts/benchmark-history-reads.mjs [checkout]
// Isolated synthetic databases; no network or production files. Keep fixtures for inspection.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

// An optional checkout path allows the same driver to measure the signed baseline.
const root = resolve(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
const { openSidekickStore } = await import(
  pathToFileURL(join(root, "apps/sidekick/dist/storage/store.js"))
);
const { ActivityReadRepository } = await import(
  pathToFileURL(join(root, "apps/sidekick/dist/storage/activity-read-repository.js"))
);

const dir = await mkdtemp(join(tmpdir(), "sidekick-scale-fixtures-"));
const manager = "SP000000000000000000002Q6VF78.signer-manager";
const pox = "SP000000000000000000002Q6VF78.pox-5";
const staker = "SP000000000000000000002Q6VF78";
const hash = `0x${"11".repeat(32)}`;
const now = "2026-09-15T12:00:00.000Z";
const results = [];
function measure(fn) {
  fn();
  const samples = Array.from({ length: 7 }, () => {
    const start = performance.now();
    fn();
    return performance.now() - start;
  }).sort((a, b) => a - b);
  return { medianMs: +samples[3].toFixed(2), maxMs: +samples[6].toFixed(2) };
}
for (const count of [1000, 10000, 50000, 100000]) {
  const path = join(dir, `${count}.sqlite`);
  const { store } = await openSidekickStore(path, now);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON; BEGIN");
  db.prepare(
    "INSERT INTO chain_sources VALUES ('bench','api','mainnet','https://unused.invalid',?,?)",
  ).run(now, now);
  const event = db.prepare(`INSERT INTO chain_events (
    chain_id,tx_id,event_index,block_height,block_hash,index_block_hash,
    canonical,microblock_canonical,contract_id,raw_payload_json,decoded_payload_json,
    source_id,first_seen_at,updated_at,occurred_at
  ) VALUES (1,?,?,?,?,?,1,1,?,'{}',?,'bench',?,?,?)`);
  const claim = db.prepare(`INSERT INTO manager_activity_events (
    chain_id,tx_id,event_index,manager_principal,block_height,canonical,kind,
    staker_principal,reward_cycle,bond_index,amount_sats,updated_at
  ) VALUES (1,?,0,?,?,1,'claim-staker-rewards',?,?,NULL,'95',?)`);
  for (let index = 0; index < count; index++) {
    const tx = `0x${index.toString(16).padStart(64, "0")}`;
    const at = new Date(Date.parse(now) - (count - index) * 60000).toISOString();
    const cycle = String(Math.floor(index / 1000) + 141);
    const decoded = JSON.stringify({
      transactionStatus: "success",
      event: {
        kind: "claim-staker-rewards-for-signer",
        signerManager: manager,
        stakerPrincipal: staker,
        bondIndex: null,
        rewardCycle: cycle,
        rewardsClaimedSats: "100",
      },
    });
    event.run(tx, 0, index, hash, hash, manager, "{}", at, at, at);
    event.run(tx, 1, index, hash, hash, pox, decoded, at, at, at);
    claim.run(tx, manager, index, staker, cycle, at);
  }
  db.exec("COMMIT; ANALYZE");
  const activity = new ActivityReadRepository(db);
  const options = {
    chainId: 1,
    contracts: [manager, pox],
    type: "chain-events",
    cutoff: null,
    after: null,
    limit: 50,
  };
  const page = activity.historyKeys(options);
  const coldStartedAt = performance.now();
  const totals = store.getManagerRewardFeeTotals(1, manager, pox);
  const coldFeeAggregateMs = +(performance.now() - coldStartedAt).toFixed(2);
  assert.equal(totals.paymentCount, count);
  assert.equal(totals.earnedIndexedSats, String(count * 5));
  assert.equal(totals.unmatchedPaymentCount, 0);
  assert.equal(page.length, 50);
  const oldestCycleRowsInDisplayWindow = store
    .listManagerClaimRecords(1, manager, 10000)
    .filter((row) => row.rewardCycle === "141").length;
  assert.equal(oldestCycleRowsInDisplayWindow, count <= 10000 ? 1000 : 0);
  const row = {
    payments: count,
    chainEvents: count * 2,
    coldFeeAggregateMs,
    activity50: measure(() => activity.historyKeys(options)),
    activity200: measure(() => activity.historyKeys({ ...options, limit: 200 })),
    activity50Next: measure(() => activity.historyKeys({ ...options, after: page.at(-1) })),
    warmLifetimeFeeAggregate: measure(() => store.getManagerRewardFeeTotals(1, manager, pox)),
    ...(store.listRewardLedgerCycles
      ? {
          cyclePage: measure(() => store.listRewardLedgerCycles(1, manager, pox)),
          selectedOldCycle: measure(() =>
            store.listManagerClaimRecords(1, manager, 10001, { cycles: [141] }),
          ),
          selectedOldPox: measure(() =>
            store.listPox5RewardPrints(1, pox, manager, { cycles: [141] }),
          ),
        }
      : {}),
    latest10kClaims: measure(() => store.listManagerClaimRecords(1, manager, 10000)),
    latest10kPox: measure(() => store.listPox5RewardPrints(1, pox, manager, { limit: 10000 })),
    oldestCycleRowsInDisplayWindow,
  };
  if (store.snapshotHistory && count === 100000) {
    const insert = db.prepare(`INSERT INTO staker_position_observations (
      manager_principal,staker_principal,observed_burn_block_height,observed_stacks_tip_height,
      has_stx,has_btc,stx_node_verified,position_present,source_id,observed_at,chain_anchor_json,
      reconciliation_complete,position_detail_json)
      VALUES (?,?,?,?,0,0,1,0,'bench',?,?,1,'{"active":false,"bond":null,"cycleMemberships":[]}')`);
    db.exec("BEGIN");
    for (let sample = 0; sample < 50; sample++) {
      const anchor = {
        stacksBlockHeight: 1000 + sample,
        burnBlockHeight: 500000 + sample,
        indexBlockHash: hash,
        rewardCycle: 141,
        rewardCycleLength: 2100,
        prepareCycleLength: 100,
        cyclePosition: sample,
        phase: "reward",
        checkpoint: "first-half",
      };
      for (let participant = 0; participant < 100; participant++) {
        insert.run(
          manager,
          `synthetic-staker-${participant}`,
          anchor.burnBlockHeight,
          anchor.stacksBlockHeight,
          new Date(Date.parse("2026-08-01T00:00:00Z") + sample * 60000).toISOString(),
          JSON.stringify(anchor),
        );
      }
    }
    db.exec("COMMIT");
    const start = performance.now();
    const batch = store.snapshotHistory.compact(now);
    assert.equal(batch.examined, 250);
    row.retentionBatch = {
      ...batch,
      milliseconds: +(performance.now() - start).toFixed(2),
      retainedInput: 5000,
      stakers: 100,
    };
    assert.equal(db.prepare("SELECT count(*) AS n FROM manager_activity_events").get().n, count);
  }
  results.push(row);
  console.log(JSON.stringify(row));
  db.close();
  store.close();
}
console.log(JSON.stringify({ node: process.version, fixtureDirectory: dir, results }));
