import { afterEach, describe, expect, it, vi } from "vitest";
import type { SidekickConfig } from "./config.js";
import { HealthMonitoringService } from "./health-monitoring.js";
import { collectHealthObservation } from "./health-monitoring-sources.js";
import type { HealthObservation, HealthOperatorContext } from "./health-monitoring-types.js";
import { openSidekickStore, type SidekickStore } from "./storage/store.js";

vi.mock("./health-monitoring-sources.js", async (original) => ({
  ...(await original<typeof import("./health-monitoring-sources.js")>()),
  collectHealthObservation: vi.fn(),
}));

const stores: SidekickStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.resetAllMocks();
});

function observation(observedAt: string): HealthObservation {
  return {
    observedAt,
    nodeRpc: { reachable: true, latencyMs: 1, errorCode: null, checkedAt: observedAt },
    nodeInfo: { network_id: 1, burn_block_height: 100, stacks_tip_height: 200 },
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
  };
}

describe("retained health reads", () => {
  it.each([
    "recordObservation",
    "upsertRollup",
    "reconcileFindingEpisodes",
  ] as const)("keeps coherent memory after %s fails, even if operator context changes before recovery", async (method) => {
    const { store } = await openSidekickStore(":memory:");
    stores.push(store);
    let now = new Date("2026-09-08T12:00:00Z");
    let height = 200;
    let context: HealthOperatorContext | null = null;
    vi.mocked(collectHealthObservation).mockImplementation(async (_config, at) => ({
      ...observation(at),
      nodeInfo: { network_id: 1, burn_block_height: 100, stacks_tip_height: height },
    }));
    const health = new HealthMonitoringService({
      getConfig: () =>
        ({
          network: "mainnet",
          apiUrl: "http://api.invalid",
          nodeRpcUrl: "http://node.invalid",
        }) as SidekickConfig,
      getOperatorContext: () => context,
      store,
      now: () => now,
    });
    const first = await health.refresh();
    now = new Date(now.getTime() + 5_000);
    height = 300;
    vi.spyOn(store.healthMonitoring, method).mockImplementationOnce(() => {
      throw new Error("storage failed");
    });
    await expect(health.refresh()).rejects.toThrow("storage failed");
    expect(await health.current()).toBe(first);
    context = {
      network: "mainnet",
      managerPrincipal: "SP000000000000000000002Q6VF78.signer-manager",
      currentRewardCycle: 141,
      registered: true,
      signerKeyHex: null,
      signerKeyGrantValid: true,
      expectedCurrentParticipation: true,
      expectedNextParticipation: true,
    };
    expect(health.storedSnapshot().node.stacksTipHeight).toBe(200);
    expect(health.storedSnapshot().generatedAt).toBe(first.generatedAt);
    // A valid raw sample may already be durable; failed publication rolls back
    // current-state memory, not independently persisted history.
    expect(health.storedSnapshot().history.observationCount).toBe(
      method === "recordObservation" ? 1 : 2,
    );
    now = new Date(now.getTime() + 5_000);
    const recovered = await health.refresh();
    expect(recovered.node.stacksTipHeight).toBe(300);
    expect(recovered.generatedAt).not.toBe(first.generatedAt);
    expect(await health.current()).toBe(recovered);
  });

  it("does not publish an old deployment's in-flight collection after settings change", async () => {
    let config = {
      network: "mainnet",
      apiUrl: "http://api.invalid",
      nodeRpcUrl: "http://node.invalid",
    } as SidekickConfig;
    let finish!: (value: HealthObservation) => void;
    vi.mocked(collectHealthObservation).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const health = new HealthMonitoringService({ getConfig: () => config });
    const pending = health.refresh();
    config = { ...config, nodeRpcUrl: "http://replacement.invalid" };
    finish(observation("2026-09-08T12:00:00Z"));
    const afterChange = await pending;
    expect(afterChange.node.stacksTipHeight).toBeNull();
    expect(health.storedSnapshot()).toBe(afterChange);
    vi.mocked(collectHealthObservation).mockImplementation(async (_config, at) => observation(at));
    expect((await health.refresh()).node.stacksTipHeight).toBe(200);
  });

  it("publishes once per collection, reuses it on reads/failure, and bounds maintenance", async () => {
    const { store } = await openSidekickStore(":memory:");
    stores.push(store);
    let now = new Date("2026-09-08T12:00:00Z");
    let config = {
      network: "mainnet",
      apiUrl: "http://api.invalid",
      nodeRpcUrl: "http://node.invalid",
    } as SidekickConfig;
    vi.mocked(collectHealthObservation).mockImplementation(async (_config, at) => observation(at));
    const summary = vi.spyOn(store.healthMonitoring, "observationSummary");
    const prune = vi.spyOn(store.healthMonitoring, "prune");
    const health = new HealthMonitoringService({ getConfig: () => config, store, now: () => now });
    const first = await health.refresh();
    expect(summary).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 20; index += 1) {
      expect(await health.current()).toBe(first);
      expect(health.storedSnapshot()).toBe(first);
    }
    expect(summary).toHaveBeenCalledTimes(1);
    expect(collectHealthObservation).toHaveBeenCalledTimes(1);
    now = new Date(now.getTime() + 5000);
    const second = await health.refresh();
    expect(summary).toHaveBeenCalledTimes(2);
    expect(second.generatedAt).not.toBe(first.generatedAt);
    expect(prune).toHaveBeenCalledTimes(1);
    vi.mocked(collectHealthObservation).mockRejectedValueOnce(new Error("offline"));
    await expect(health.refresh()).rejects.toThrow("offline");
    expect(await health.current()).toBe(second);
    config = { ...config, nodeRpcUrl: "http://replacement.invalid" };
    expect(health.storedSnapshot().generatedAt).not.toBe(second.generatedAt);
    expect(collectHealthObservation).toHaveBeenCalledTimes(3);
    now = new Date(now.getTime() + 300_000);
    await health.refresh();
    expect(prune).toHaveBeenCalledTimes(2);
  });
});
