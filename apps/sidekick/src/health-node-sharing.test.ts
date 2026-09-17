import { afterEach, describe, expect, it, vi } from "vitest";
import type { SidekickConfig } from "./config.js";
import { HealthMonitoringService } from "./health-monitoring.js";
import { collectHealthObservation } from "./health-monitoring-sources.js";
import type { HealthObservation } from "./health-monitoring-types.js";
import { ObserverGapMonitor } from "./observer-gap-monitor.js";
import type { ObserverInboxStatus } from "./storage/observer-inbox-repository.js";

vi.mock("./health-monitoring-sources.js", async (original) => ({
  ...(await original<typeof import("./health-monitoring-sources.js")>()),
  collectHealthObservation: vi.fn(),
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

function fixture(pollIntervalMs?: number) {
  let now = Date.parse("2026-09-14T12:00:00Z");
  const config = {
    network: "mainnet",
    nodeRpcUrl: "http://node.invalid",
    apiUrl: "http://api.invalid",
    apiKeyHeader: "x-api-key",
    maxApiBurnBlockLag: 12,
    forecastHorizonCycles: 6,
    stakerPageLimit: 200,
    eventPageLimit: 100,
    databasePath: ":memory:",
  } satisfies SidekickConfig;
  const observation = (): HealthObservation => ({
    observedAt: new Date(now).toISOString(),
    nodeRpc: {
      reachable: true,
      checkedAt: new Date(now).toISOString(),
      latencyMs: 1,
      errorCode: null,
    },
    nodeInfo: { network_id: 1, burn_block_height: 100, stacks_tip_height: 200 },
    nodeHealth: null,
    nodeHealthSource: null,
    nodeMetrics: null,
    nodeMetricsSource: null,
    hiro: null,
    hiroSource: null,
    configuredApi: null,
    configuredApiSource: null,
    signerInfo: null,
    signerInfoSource: null,
    signerHeartbeat: null,
    signerMetrics: null,
    signerMetricsSource: null,
  });
  vi.mocked(collectHealthObservation).mockImplementation(async () => observation());
  const health = new HealthMonitoringService({
    getConfig: () => config,
    now: () => new Date(now),
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
  });
  return {
    health,
    config,
    observation,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("advisory node sample reuse", () => {
  it("preserves the original sample age and rejects stale, future, changed-source and failed samples", async () => {
    const { health, config, observation, advance } = fixture();
    expect(health.recentNodeInfo()).toBeNull();
    await health.refresh();
    expect(health.recentNodeInfo()?.stacks_tip_height).toBe(200);
    advance(20_000);
    expect(health.recentNodeInfo()).not.toBeNull();
    advance(1);
    expect(health.recentNodeInfo()).toBeNull();
    advance(-20_002);
    expect(health.recentNodeInfo()).toBeNull();
    advance(1);
    config.nodeRpcUrl = "http://changed.invalid";
    expect(health.recentNodeInfo()).toBeNull();
    await health.refresh();
    expect(health.recentNodeInfo()).not.toBeNull();
    const failed = observation();
    failed.nodeInfo = null;
    failed.nodeRpc = { ...failed.nodeRpc, reachable: false, errorCode: "timeout" };
    vi.mocked(collectHealthObservation).mockResolvedValueOnce(failed);
    await health.refresh();
    expect(health.recentNodeInfo()).toBeNull();
    expect(collectHealthObservation).toHaveBeenCalledTimes(3);
  });

  it("collects 360 times/hour while avoiding 240 duplicate gap checks, then falls back when collection stops", async () => {
    vi.useFakeTimers();
    const { health, advance } = fixture();
    health.start();
    await vi.advanceTimersByTimeAsync(0);
    const fallback = vi.fn(async () => ({ stacks_tip_height: 201 }));
    const monitor = new ObserverGapMonitor({
      getNode: () => ({ getInfo: async () => health.recentNodeInfo() ?? (await fallback()) }),
      getInbox: () => ({ lastVerifiedStacksBlock: null }) as ObserverInboxStatus,
      logger: { warn: vi.fn() },
    });
    monitor.start();
    try {
      for (let second = 0; second < 3600; second += 5) {
        if (second > 0) advance(5000);
        await vi.advanceTimersByTimeAsync(second === 0 ? 0 : 5000);
      }
      expect(collectHealthObservation).toHaveBeenCalledTimes(360);
      expect(
        vi
          .mocked(collectHealthObservation)
          .mock.calls.filter(([, , options]) => options?.includeReferences),
      ).toHaveLength(120);
      expect(monitor.status().checksTotal).toBe(240);
      expect(fallback).not.toHaveBeenCalled();
      health.stop();
      advance(25_000);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(fallback).toHaveBeenCalledOnce();
      expect(monitor.status().nodeStacksHeight).toBe(201);
    } finally {
      health.stop();
      await monitor.stop();
    }
  });

  it("uses the configured collection cadence for advisory sample freshness", async () => {
    const { health, advance } = fixture(15_000);
    await health.refresh();
    advance(30_000);
    expect(health.recentNodeInfo()).not.toBeNull();
    advance(1);
    expect(health.recentNodeInfo()).toBeNull();
  });
});
