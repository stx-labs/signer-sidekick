import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HealthFinding, HealthObservation } from "../health-monitoring-types.js";
import { openSidekickStore, type SidekickStore } from "./store.js";

const stores: SidekickStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function observation(observedAt: string, stacksTipHeight: number): HealthObservation {
  return {
    observedAt,
    nodeRpc: { reachable: true, latencyMs: 4, errorCode: null, checkedAt: observedAt },
    nodeInfo: {
      network_id: 1,
      burn_block_height: 960_000,
      stacks_tip_height: stacksTipHeight,
      is_fully_synced: true,
    },
    nodeHealth: {
      difference_from_max_peer: 0,
      max_stacks_height_of_neighbors: stacksTipHeight,
      node_stacks_tip_height: stacksTipHeight,
    },
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

function finding(at: string): HealthFinding {
  return {
    id: "node-behind-network",
    episodeId: null,
    severity: "critical",
    title: "Stacks node is behind its observed peers",
    detail: "The local node remained behind its most advanced peer.",
    source: "node",
    classification: "likely-local-node",
    confidence: "high",
    firstObservedAt: at,
    lastObservedAt: at,
    evidenceWindow: { startedAt: at, endedAt: at, sampleCount: 6, distinctSources: 1 },
    evidence: [
      {
        code: "node-peer-height-gap",
        source: "node-peers",
        status: "supporting",
        observedAt: at,
        value: "3",
        detail: "The peer-health endpoint reports a sustained gap.",
      },
    ],
  };
}

describe("HealthMonitoringRepository", () => {
  it("rejects malformed durable observation payloads before persistence", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-08-14T12:00:00.000Z");
    stores.push(store);
    expect(() =>
      store.healthMonitoring.recordObservation("config-a", {
        ...observation("2026-08-14T12:00:00.000Z", 100),
        nodeInfo: "not-node-info",
      } as unknown as HealthObservation),
    ).toThrow();
    expect(store.healthMonitoring.listObservations("config-a")).toEqual([]);
  });

  it("persists observations and rollups across restart while isolating configurations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sidekick-health-history-"));
    directories.push(directory);
    const path = join(directory, "sidekick.sqlite");
    const opened = await openSidekickStore(path, "2026-08-14T12:00:00.000Z");
    const first = opened.store;
    stores.push(first);

    first.healthMonitoring.recordObservation(
      "config-a",
      observation("2026-08-14T12:00:00.000Z", 100),
    );
    first.healthMonitoring.recordObservation(
      "config-a",
      observation("2026-08-14T12:00:05.000Z", 101),
    );
    first.healthMonitoring.recordObservation(
      "config-b",
      observation("2026-08-14T12:00:05.000Z", 900),
    );
    first.healthMonitoring.upsertRollup(
      "config-a",
      {
        windowStartedAt: "2026-08-14T12:00:00.000Z",
        windowEndedAt: "2026-08-14T12:00:05.000Z",
        sampleCount: 2,
        nodeRpcAvailabilityPercent: 100,
        signerAvailabilityPercent: null,
        nodeStacksHeightStart: 100,
        nodeStacksHeightEnd: 101,
        nodeAdvanceCount: 1,
        proposals: null,
        accepted: null,
        rejected: null,
        disagreements: null,
        responseP95Seconds: null,
      },
      "2026-08-14T12:00:05.000Z",
    );
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const reopened = await openSidekickStore(path, "2026-08-14T12:01:00.000Z");
    stores.push(reopened.store);
    expect(
      reopened.store.healthMonitoring
        .listObservations("config-a")
        .map(({ nodeInfo }) => nodeInfo?.stacks_tip_height),
    ).toEqual([100, 101]);
    expect(reopened.store.healthMonitoring.observationSummary("config-a")).toEqual({
      observationCount: 2,
      observedSince: "2026-08-14T12:00:00.000Z",
    });
    expect(reopened.store.healthMonitoring.listObservations("config-b")).toHaveLength(1);
    expect(reopened.store.healthMonitoring.listRecentRollups("config-a")).toMatchObject([
      { nodeAdvanceCount: 1, nodeStacksHeightEnd: 101 },
    ]);
  });

  it("keeps one durable episode through brief recurrence and opens a new one after five minutes", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-08-14T12:00:00.000Z");
    stores.push(store);
    const repository = store.healthMonitoring;
    const openedAt = "2026-08-14T12:00:00.000Z";
    const first = repository.reconcileFindingEpisodes("config-a", [finding(openedAt)], openedAt)[0];
    if (!first) throw new Error("expected first finding episode");

    const secondAt = "2026-08-14T12:00:05.000Z";
    const second = repository.reconcileFindingEpisodes(
      "config-a",
      [finding(secondAt)],
      secondAt,
    )[0];
    expect(second).toMatchObject({
      episodeId: first.episodeId,
      status: "active",
      occurrences: 2,
      firstObservedAt: openedAt,
      lastObservedAt: secondAt,
    });

    const resolvedAt = "2026-08-14T12:00:10.000Z";
    expect(repository.reconcileFindingEpisodes("config-a", [], resolvedAt)[0]).toMatchObject({
      episodeId: first.episodeId,
      status: "resolved",
      resolvedAt,
    });
    const reopenedAt = "2026-08-14T12:00:15.000Z";
    const episodes = repository.reconcileFindingEpisodes(
      "config-a",
      [finding(reopenedAt)],
      reopenedAt,
    );
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      episodeId: first.episodeId,
      status: "active",
      occurrences: 3,
    });

    repository.reconcileFindingEpisodes("config-a", [], "2026-08-14T12:00:20.000Z");
    const later = repository.reconcileFindingEpisodes(
      "config-a",
      [finding("2026-08-14T12:06:00.000Z")],
      "2026-08-14T12:06:00.000Z",
    );
    expect(later).toHaveLength(2);
    expect(later[0]).toMatchObject({ status: "active", occurrences: 1 });
    expect(later[0]?.episodeId).not.toBe(first.episodeId);
    expect(repository.listFindingEpisodes("config-b")).toEqual([]);
  });

  it("prunes raw evidence after 72 hours and rollups after 90 days", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-08-14T12:00:00.000Z");
    stores.push(store);
    store.healthMonitoring.recordObservation(
      "config-a",
      observation("2026-05-01T00:00:00.000Z", 1),
    );
    store.healthMonitoring.recordObservation(
      "config-a",
      observation("2026-08-14T11:59:55.000Z", 2),
    );
    store.healthMonitoring.upsertRollup(
      "config-a",
      {
        windowStartedAt: "2026-05-01T00:00:00.000Z",
        windowEndedAt: "2026-05-01T00:05:00.000Z",
        sampleCount: 1,
        nodeRpcAvailabilityPercent: 100,
        signerAvailabilityPercent: null,
        nodeStacksHeightStart: 1,
        nodeStacksHeightEnd: 1,
        nodeAdvanceCount: 0,
        proposals: null,
        accepted: null,
        rejected: null,
        disagreements: null,
        responseP95Seconds: null,
      },
      "2026-05-01T00:05:00.000Z",
    );

    expect(store.healthMonitoring.prune("2026-08-14T12:00:00.000Z")).toEqual({
      observations: 1,
      rollups: 1,
    });
    expect(store.healthMonitoring.listObservations("config-a")).toHaveLength(1);
    expect(store.healthMonitoring.listRecentRollups("config-a")).toEqual([]);
  });
});
