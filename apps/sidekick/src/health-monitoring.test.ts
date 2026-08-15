import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { SidekickConfig } from "./config.js";
import { calculateBurnBlockTiming, HealthMonitoringService } from "./health-monitoring.js";
import type { HealthOperatorContext } from "./health-monitoring-types.js";
import { openSidekickStore, type SidekickStore } from "./storage/store.js";

const servers: ReturnType<typeof createServer>[] = [];
const stores: SidekickStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("HealthMonitoringService", () => {
  it("uses a 24-hour burn-block sample and falls back to 12 hours", () => {
    const latestTime = 1_784_000_000;
    const blocks = Array.from({ length: 151 }, (_, index) => ({
      burn_block_height: 910_000 - index,
      burn_block_time: latestTime - index * 600,
    }));

    expect(calculateBurnBlockTiming({ results: blocks })).toEqual({
      averageSeconds: 600,
      windowHours: 24,
      sampleBlocks: 144,
      sampledAt: new Date(latestTime * 1_000).toISOString(),
    });
    expect(calculateBurnBlockTiming({ results: blocks.slice(0, 81) })).toMatchObject({
      averageSeconds: 600,
      windowHours: 12,
      sampleBlocks: 72,
    });
    expect(calculateBurnBlockTiming({ results: blocks.slice(0, 6) })).toBeNull();
  });

  it("combines live node, Hiro, and signer signals with reset-safe rolling values", async () => {
    let accepted = 10;
    let rejected = 2;
    let proposals = 12;
    let conflicts = 1;
    let heartbeatHealthy = true;
    let hiroTip = 200_001;
    const server = createServer((request, response) => {
      if (request.url === "/v2/info") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            server_version: "stacks-node 4.0.1 (62e03cc)",
            network_id: 1,
            burn_block_height: 910_000,
            stacks_tip_height: 200_000,
            is_fully_synced: true,
          }),
        );
        return;
      }
      if (request.url === "/v3/health") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            difference_from_max_peer: 0,
            max_stacks_height_of_neighbors: 200_000,
            node_stacks_tip_height: 200_000,
          }),
        );
        return;
      }
      if (request.url === "/extended") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            status: "ready",
            chain_tip: { block_height: hiroTip, burn_block_height: 910_000 },
          }),
        );
        return;
      }
      if (request.url === "/node-metrics") {
        response.end(`
stacks_node_stacks_tip_height 200000
stacks_node_burn_block_height 910000
stacks_node_neighbors_inbound 8
stacks_node_neighbors_outbound 12
stacks_node_warning_emitted_total 4
stacks_node_errors_emitted_total 1
`);
        return;
      }
      if (request.url === "/info") {
        response.end(
          JSON.stringify({
            signerPublicKey: `02${"11".repeat(32)}`,
            network: "mainnet",
            stxAddress: "SP000000000000000000002Q6VF78",
            version: "4.0.1.0.0",
          }),
        );
        return;
      }
      if (request.url === "/heartbeat") {
        response.statusCode = heartbeatHealthy ? 200 : 500;
        response.end(heartbeatHealthy ? "OK" : "Failed");
        return;
      }
      if (request.url === "/metrics") {
        response.end(`
stacks_signer_stacks_node_height 200000
stacks_signer_current_reward_cycle 140
stacks_signer_stx_balance 100000000
stacks_signer_block_proposals_received ${proposals}
stacks_signer_block_validation_responses{response_type="accepted"} ${accepted}
stacks_signer_block_validation_responses{response_type="rejected"} ${rejected}
stacks_signer_block_responses_sent{response_type="accepted"} ${accepted}
stacks_signer_block_responses_sent{response_type="rejected"} ${rejected}
stacks_signer_block_pre_commits_sent ${proposals}
stacks_signer_agreement_state_conflicts{conflict="miner_view"} ${conflicts}
stacks_signer_node_rpc_call_latencies_histogram_bucket{le="0.1"} ${accepted + rejected}
stacks_signer_node_rpc_call_latencies_histogram_bucket{le="+Inf"} ${accepted + rejected}
stacks_signer_block_validation_latencies_histogram_bucket{le="1"} ${accepted + rejected}
stacks_signer_block_validation_latencies_histogram_bucket{le="+Inf"} ${accepted + rejected}
stacks_signer_block_response_latencies_histogram_bucket{le="1"} ${accepted}
stacks_signer_block_response_latencies_histogram_bucket{le="60"} ${accepted + rejected}
stacks_signer_block_response_latencies_histogram_bucket{le="+Inf"} ${accepted + rejected}
stacks_signer_agreement_capitulation_latencies_histogram_bucket{le="5"} ${accepted + rejected}
stacks_signer_agreement_capitulation_latencies_histogram_bucket{le="+Inf"} ${accepted + rejected}
`);
        return;
      }
      response.statusCode = 404;
      response.end("missing");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const config: SidekickConfig = {
      network: "mainnet",
      nodeRpcUrl: baseUrl,
      apiUrl: "https://api.mainnet.hiro.so",
      apiKeyHeader: "x-api-key",
      maxApiBurnBlockLag: 12,
      forecastHorizonCycles: 6,
      stakerPageLimit: 200,
      eventPageLimit: 100,
      databasePath: ":memory:",
      nodeMetricsUrl: `${baseUrl}/node-metrics`,
      signerMonitoringUrl: baseUrl,
      hiroReferenceApiUrl: baseUrl,
    };
    let now = Date.parse("2026-07-17T12:00:00.000Z");
    const health = new HealthMonitoringService({
      getConfig: () => config,
      now: () => new Date(now),
    });

    const initial = await health.refresh();
    expect(initial.overallStatus).toBe("healthy");
    expect(initial.node).toMatchObject({
      inboundPeers: 8,
      outboundPeers: 12,
      isFullySynced: true,
      peerHeightDifference: 0,
    });
    expect(initial.hiro).toMatchObject({ localStacksDifference: -1, localBurnDifference: 0 });
    expect(initial.hiro.lastTipAdvanceAt).toBeNull();
    expect(initial.hiro.advancementStatus).toBe("collecting");
    expect(initial.signer).toMatchObject({
      version: "4.0.1.0.0",
      observedNodeHeight: 200_000,
      rewardCycle: 140,
    });
    expect(initial.signer.lastHour.collectingBaseline).toBe(true);

    accepted = 14;
    rejected = 3;
    proposals = 17;
    conflicts = 2;
    hiroTip += 1;
    now += 5 * 60 * 1_000;
    const progressed = await health.refresh();
    expect(progressed.hiro.lastTipAdvanceAt).toBe("2026-07-17T12:05:00.000Z");
    expect(progressed.hiro.advancementStatus).toBe("advancing");
    expect(progressed.signer.lastHour).toMatchObject({
      proposals: 5,
      accepted: 4,
      rejected: 1,
      disagreements: 1,
      collectingBaseline: false,
    });
    expect(progressed.signer.lastHour.rejectionPercent).toBe(20);
    expect(progressed.signer.lastHour.responseP95Seconds).toBe(60);
    expect(progressed.signer.last15Minutes).toMatchObject({
      validationAccepted: 4,
      validationRejected: 1,
      preCommits: 5,
      nodeRpcP95Seconds: 0.1,
      validationP95Seconds: 1,
      capitulationP95Seconds: 5,
      collectingBaseline: false,
    });

    accepted = 1;
    rejected = 0;
    proposals = 1;
    conflicts = 0;
    now += 30_000;
    const reset = await health.refresh();
    expect(reset.signer.lastHour.accepted).toBe(5);

    heartbeatHealthy = false;
    for (let index = 0; index < 3; index += 1) {
      now += 30_000;
      await health.refresh();
    }
    const failed = await health.current();
    expect(failed.findings).toContainEqual(
      expect.objectContaining({ id: "signer-node-heartbeat-failed", severity: "critical" }),
    );

    delete config.signerMonitoringUrl;
    now += 30_000;
    const changedSource = await health.refresh();
    expect(changedSource.findings).toEqual([]);
    expect(changedSource.overallStatus).toBe("partial");
    expect(changedSource.signer.lastHour.collectingBaseline).toBe(true);
  });

  it("requires a persistent local-node sync failure before producing a behind finding", async () => {
    let fullySynced = false;
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/v2/info") {
        response.end(
          JSON.stringify({
            network_id: 1,
            burn_block_height: 910_000,
            stacks_tip_height: 200_000,
            is_fully_synced: fullySynced,
          }),
        );
        return;
      }
      if (request.url === "/v3/health") {
        response.end(
          JSON.stringify({
            difference_from_max_peer: fullySynced ? 0 : 1,
            max_stacks_height_of_neighbors: 200_001,
            node_stacks_tip_height: 200_000,
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end("missing");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    let now = Date.parse("2026-07-17T12:00:00.000Z");
    const { store } = await openSidekickStore(":memory:", new Date(now).toISOString());
    stores.push(store);
    let operatorContext: HealthOperatorContext | null = {
      network: "mainnet",
      managerPrincipal: "SP000000000000000000002Q6VF78.signer-manager",
      currentRewardCycle: 141,
      registered: true,
      signerKeyHex: `02${"11".repeat(32)}`,
      signerKeyGrantValid: true,
      expectedCurrentParticipation: true,
      expectedNextParticipation: true,
    };
    const health = new HealthMonitoringService({
      getConfig: () => ({
        network: "mainnet",
        nodeRpcUrl: `http://127.0.0.1:${address.port}`,
        apiUrl: "https://api.mainnet.hiro.so",
        apiKeyHeader: "x-api-key",
        maxApiBurnBlockLag: 12,
        forecastHorizonCycles: 6,
        stakerPageLimit: 200,
        eventPageLimit: 100,
        databasePath: ":memory:",
      }),
      store,
      getOperatorContext: () => operatorContext,
      now: () => new Date(now),
    });

    for (let sample = 0; sample < 5; sample += 1) {
      expect((await health.refresh()).findings).toEqual([]);
      now += 5_000;
    }
    const active = await health.refresh();
    expect(active.findings).toContainEqual(
      expect.objectContaining({ id: "node-behind-network", source: "node" }),
    );
    const episodeId = active.findings.find(({ id }) => id === "node-behind-network")?.episodeId;
    expect(episodeId).toEqual(expect.any(String));

    // Background reconciliation temporarily clears the cached operator snapshot. This context
    // transition must not look like a deployment change or resolve a continuing incident.
    operatorContext = null;
    now += 5_000;
    const withoutCachedContext = await health.refresh();
    expect(
      withoutCachedContext.findings.find(({ id }) => id === "node-behind-network")?.episodeId,
    ).toBe(episodeId);
    expect(
      withoutCachedContext.history.recentEpisodes.find(({ episodeId: id }) => id === episodeId),
    ).toMatchObject({ status: "active", resolvedAt: null });

    fullySynced = true;
    now += 5_000;
    expect((await health.refresh()).findings).not.toContainEqual(
      expect.objectContaining({ id: "node-behind-network" }),
    );
  });

  it("degrades optional sources without blocking node health", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/v2/info") {
        response.end(
          JSON.stringify({
            network_id: 1,
            burn_block_height: 1,
            stacks_tip_height: 1,
          }),
        );
        return;
      }
      response.statusCode = 500;
      response.end("unavailable");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const config: SidekickConfig = {
      network: "devnet",
      nodeRpcUrl: `http://127.0.0.1:${address.port}`,
      apiUrl: "http://127.0.0.1:3999",
      apiKeyHeader: "x-api-key",
      maxApiBurnBlockLag: 12,
      forecastHorizonCycles: 6,
      stakerPageLimit: 200,
      eventPageLimit: 100,
      databasePath: ":memory:",
    };
    const health = new HealthMonitoringService({ getConfig: () => config });
    const snapshot = await health.refresh();
    expect(snapshot.overallStatus).toBe("partial");
    expect(snapshot.node.rpc.status).toBe("healthy");
    expect(snapshot.signer.infoSource.status).toBe("not-configured");
    expect(snapshot.findings).toEqual([]);
  });
});
