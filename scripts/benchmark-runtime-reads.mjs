// Synthetic retained-read benchmark, not a production/API or browser-vitals measurement.
// Run after pnpm build: node scripts/benchmark-runtime-reads.mjs [row-count]
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { ActivityProjectionService } from "../apps/sidekick/dist/activity-projection.js";
import { HealthMonitoringService } from "../apps/sidekick/dist/health-monitoring.js";
import { healthConfigurationFingerprint } from "../apps/sidekick/dist/health-monitoring-sources.js";
import { openSidekickStore } from "../apps/sidekick/dist/storage/store.js";
import {
  buildRewardRunRecipe,
  RewardRunService,
} from "../apps/sidekick/dist/transaction-engine/reward-run-service.js";

const count = Number(process.argv[2] ?? 20_000);
if (!Number.isSafeInteger(count) || count < 100 || count > 500_000) {
  throw new Error("row-count must be an integer from 100 to 500000");
}
const directory = await mkdtemp(join(tmpdir(), "sidekick-read-bench-"));
const databasePath = join(directory, "fixture.sqlite");
const now = new Date("2026-09-08T12:00:00.000Z");
const manager = "SP000000000000000000002Q6VF78.signer-manager";
const hash = `0x${"22".repeat(32)}`;
const config = {
  network: "mainnet",
  nodeRpcUrl: "http://unused.invalid",
  apiUrl: "https://unused.invalid",
  apiKeyHeader: "x-api-key",
  maxApiBurnBlockLag: 12,
  forecastHorizonCycles: 6,
  stakerPageLimit: 200,
  eventPageLimit: 100,
  databasePath,
};
const { store } = await openSidekickStore(databasePath, now.toISOString());
const wallet = "SP000000000000000000002Q6VF78";
function insertRun(index, children, active = false) {
  const runId = `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const facts = {
    walletPrincipal: wallet,
    managerPrincipal: manager,
    pox5Contract: `${wallet}.pox-5`,
    sbtcTokenContract: `${wallet}.sbtc-token`,
    sbtcRegistryContract: `${wallet}.sbtc-registry`,
    network: "mainnet",
    chainId: 1,
    cycle: 141,
    distribution: 1,
    preparedAnchor: { stacksBlockHeight: 9000, burnBlockHeight: 4100, indexBlockHash: hash },
    managerSourceFingerprint: "12".repeat(32),
    pox5SourceFingerprint: "34".repeat(32),
    calculateRequired: false,
    collectRequired: false,
    maximumCollectSats: null,
    eligibleAccountCount: children,
    eligibleWithdrawalCounts: { accepted: 0, rejected: 0 },
    withdrawals: [],
    accounts: Array.from({ length: children }, (_, bondIndex) => ({
      stakerPrincipal: wallet,
      rewardCycle: 141,
      bondIndex: String(bondIndex),
      maximumGrossSats: "1000",
      payoutRoute: "direct-sbtc",
    })),
  };
  const recipe = buildRewardRunRecipe({
    runId,
    facts,
    request: { cycle: 141, distribution: 1, operations: ["claim-staker-rewards"] },
    feeCapUstx: 500n,
    maximumTransactions: children,
  });
  store.rewardRuns.insert({
    runId,
    walletPrincipal: wallet,
    recipeSha256: "ab".repeat(32),
    recipe,
    children: recipe.children,
    approvalExpiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    now: now.toISOString(),
  });
  if (active) {
    for (let childIndex = 0; childIndex < children; childIndex += 1) {
      store.rewardRuns.updateChild({
        runId,
        childIndex,
        from: ["pending"],
        to: "confirmed",
        txid: `0x${childIndex.toString(16).padStart(64, "0")}`,
        provenance: "you",
        now: now.toISOString(),
      });
    }
    store.rewardRuns.transition({
      runId,
      from: ["awaiting-approval"],
      to: "paused",
      approvedAt: now.toISOString(),
      startedAt: now.toISOString(),
      runtimeExpiresAt: new Date(now.getTime() + 6 * 60 * 60_000).toISOString(),
      now: now.toISOString(),
    });
  } else
    store.rewardRuns.transition({
      runId,
      from: ["awaiting-approval"],
      to: "cancelled",
      now: now.toISOString(),
      completedAt: now.toISOString(),
    });
}
const unexpected = () => {
  throw new Error("Benchmark must never sign, broadcast, or access a chain");
};
const maintenance = new RewardRunService({
  repository: store.rewardRuns,
  signer: { gasWalletSignerReady: () => false },
  driver: { materialize: unexpected, broadcast: unexpected, reconcile: unexpected },
  facts: unexpected,
  refusalChecks: unexpected,
  now: () => now,
});
const originalPrepare = DatabaseSync.prototype.prepare;
let statements = 0;
try {
  // SQL setup avoids timing the real ingestion pipeline. Reads use production services.
  const db = new DatabaseSync(databasePath);
  db.exec("BEGIN");
  db.prepare("INSERT INTO chain_sources VALUES ('bench', 'api', 'mainnet', ?, ?, ?)").run(
    config.apiUrl,
    now.toISOString(),
    now.toISOString(),
  );
  const event = db.prepare(`INSERT INTO chain_events (
    chain_id, tx_id, event_index, block_height, block_hash, index_block_hash,
    canonical, microblock_canonical, contract_id, raw_payload_json, source_id,
    first_seen_at, updated_at, occurred_at
  ) VALUES (1, ?, 0, ?, ?, ?, 1, 1, ?, '{}', 'bench', ?, ?, ?)`);
  const delivery = db.prepare(`INSERT INTO observer_deliveries (
    delivery_id, endpoint_kind, content_sha256, raw_payload_json, payload_bytes,
    state, claimed_block_height, claimed_block_hash, claimed_index_block_hash,
    first_received_at, last_received_at, last_processing_at, next_attempt_at,
    completed_at, updated_at, processing_attempts, payload_pruned
  ) VALUES (?, 'new-block', ?, '{}', 0, 'node-verified', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`);
  const audit =
    db.prepare(`INSERT INTO settings_audit (audit_id, revision, changed_fields_json, changed_at)
    VALUES (?, ?, '["pool.displayName"]', ?)`);
  for (let index = 0; index < count; index += 1) {
    const id = index.toString(16).padStart(64, "0");
    const at = new Date(now.getTime() - (count - index) * 10_000).toISOString();
    event.run(`0x${id}`, index, hash, hash, manager, at, at, at);
    audit.run(`audit-${index}`, index + 1, at);
    delivery.run(
      `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
      id,
      index,
      hash,
      `0x${id}`,
      at,
      at,
      at,
      at,
      at,
      at,
    );
  }
  db.exec("COMMIT");
  db.close();
  for (let index = 0; index < 200; index += 1) insertRun(index, 50);
  const fingerprint = healthConfigurationFingerprint(config);
  for (let index = 0; index < 1_440; index += 1) {
    const at = new Date(now.getTime() - (1_440 - index) * 5_000).toISOString();
    store.healthMonitoring.recordObservation(fingerprint, {
      observedAt: at,
      nodeRpc: { reachable: true, latencyMs: 1, errorCode: null, checkedAt: at },
      nodeInfo: { network_id: 1, burn_block_height: 900000, stacks_tip_height: index },
      nodeHealth: null,
      nodeHealthSource: null,
      nodeMetricsSource: null,
      nodeMetrics: null,
      hiroSource: null,
      hiro: null,
      configuredApiSource: null,
      configuredApi: null,
      signerInfoSource: null,
      signerInfo: null,
      signerHeartbeat: null,
      signerMetricsSource: null,
      signerMetrics: null,
    });
  }
  const activity = new ActivityProjectionService({
    store,
    chainId: 1,
    managerPrincipal: manager,
    sourceId: () => "bench",
    now: () => now,
  });
  const health = new HealthMonitoringService({ getConfig: () => config, store, now: () => now });
  const query = {
    status: "all",
    type: "all",
    domain: "all",
    time: "all",
    search: null,
    cursor: null,
    limit: 50,
  };
  const cases = {
    "overview-active": () =>
      activity.active ? activity.active() : activity.page({ ...query, limit: 1 }),
    "activity-first-page": () => activity.page(query),
    "activity-settings-page": () => activity.page({ ...query, type: "configuration" }),
    "maintenance-terminal-history": () => maintenance.recover(),
    "observer-status": () => store.observerInbox.status(),
    "observer-operational": () => store.observerInbox.operationalStatus(),
    "observer-status-after-empty-claim": () => {
      store.observerInbox.claimNextDelivery(now.toISOString());
      return store.observerInbox.status();
    },
    "observer-status-after-empty-recovery": () => {
      store.observerInbox.recoverDeliveries(now.toISOString());
      return store.observerInbox.status();
    },
    "observer-status-after-empty-prune": () => {
      store.observerInbox.prunePayloads(now.toISOString());
      return store.observerInbox.status();
    },
    "observer-status-after-delivery": () => {
      store.observerInbox.acceptDelivery({
        endpointKind: "attachments",
        contentSha256: "ff".repeat(32),
        rawPayloadJson: "{}",
        payloadBytes: 2,
        state: "expired",
        stateReason: "benchmark",
        claimedBlockHeight: null,
        claimedBlockHash: null,
        claimedIndexBlockHash: null,
        claimedBurnBlockHeight: null,
        claimedBurnBlockHash: null,
        receivedAt: now.toISOString(),
      });
      return store.observerInbox.status();
    },
    "health-current": () => health.current(),
  };
  let deliverySequence = count;
  // Include writes, not just the following GET: a faster read must not hide expensive ingestion.
  cases["observer-active-delivery-lifecycle"] = () => {
    const height = ++deliverySequence;
    const accepted = store.observerInbox.acceptDelivery({
      endpointKind: "new-block",
      contentSha256: height.toString(16).padStart(64, "0"),
      rawPayloadJson: "{}",
      payloadBytes: 2,
      state: "observer-claimed",
      stateReason: null,
      claimedBlockHeight: height,
      claimedBlockHash: hash,
      claimedIndexBlockHash: `0x${height.toString(16).padStart(64, "0")}`,
      claimedBurnBlockHeight: null,
      claimedBurnBlockHash: null,
      receivedAt: now.toISOString(),
    });
    store.observerInbox.status();
    store.observerInbox.claimNextDelivery(now.toISOString());
    store.observerInbox.status();
    store.observerInbox.finishDelivery({
      deliveryId: accepted.deliveryId,
      state: "node-verified",
      reason: "benchmark",
      completedAt: now.toISOString(),
    });
    return store.observerInbox.status();
  };
  DatabaseSync.prototype.prepare = function (...args) {
    statements += 1;
    return originalPrepare.apply(this, args);
  };
  const results = {};
  async function measure(name, read) {
    await read(); // hydrate/JIT outside warm measurements
    const samples = [];
    const eventLoopDelays = [];
    const startStatements = statements;
    for (let index = 0; index < 30; index += 1) {
      await new Promise(setImmediate);
      const started = performance.now();
      const yielded = new Promise((resolve) =>
        setImmediate(() => {
          eventLoopDelays.push(performance.now() - started);
          resolve();
        }),
      );
      await read();
      samples.push(performance.now() - started);
      await yielded;
    }
    samples.sort((a, b) => a - b);
    eventLoopDelays.sort((a, b) => a - b);
    results[name] = {
      p50Ms: samples[14],
      p95Ms: samples[28],
      maxMs: samples[29],
      eventLoopDelayP95Ms: eventLoopDelays[28],
      preparedStatementsPerRead: (statements - startStatements) / 30,
    };
  }
  for (const [name, read] of Object.entries(cases)) await measure(name, read);
  insertRun(200, 100, true);
  await measure("activity-100-child-run", () => activity.active());
  await measure("maintenance-100-child-paused-run", () => maintenance.recover());
  console.log(
    JSON.stringify(
      {
        node: process.version,
        rows: count,
        healthObservations: 1440,
        settingsRows: count,
        terminalRuns: 200,
        terminalChildrenPerRun: 50,
        activeRunChildren: 100,
        samplesPerRead: 30,
        synthetic: true,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  DatabaseSync.prototype.prepare = originalPrepare;
  await maintenance.stop();
  store.close();
  await rm(directory, { recursive: true, force: true });
}
