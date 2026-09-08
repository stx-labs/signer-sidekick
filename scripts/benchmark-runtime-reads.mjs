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

const count = Number(process.argv[2] ?? 20_000);
if (!Number.isSafeInteger(count) || count < 100 || count > 100_000) {
  throw new Error("row-count must be an integer from 100 to 100000");
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
  for (let index = 0; index < count; index += 1) {
    const id = index.toString(16).padStart(64, "0");
    const at = new Date(now.getTime() - (count - index) * 10_000).toISOString();
    event.run(`0x${id}`, index, hash, hash, manager, at, at, at);
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
    "observer-status": () => store.observerInbox.status(),
    "health-current": () => health.current(),
  };
  const results = {};
  for (const [name, read] of Object.entries(cases)) {
    await read(); // hydrate/JIT outside warm measurements
    const samples = [];
    for (let index = 0; index < 30; index += 1) {
      await new Promise(setImmediate);
      const started = performance.now();
      await read();
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    results[name] = { p50Ms: samples[14], p95Ms: samples[28], maxMs: samples[29] };
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        rows: count,
        healthObservations: 1440,
        samplesPerRead: 30,
        synthetic: true,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  store.close();
  await rm(directory, { recursive: true, force: true });
}
