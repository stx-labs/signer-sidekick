import { describe, expect, it } from "vitest";
import type { SidekickConfig } from "./config.js";
import { buildHealthSnapshot } from "./health-monitoring-presentation.js";
import type {
  HealthObservation,
  HealthOperatorContext,
  SignerMetricValues,
} from "./health-monitoring-types.js";

const config: SidekickConfig = {
  network: "mainnet",
  nodeRpcUrl: "http://127.0.0.1:20443",
  apiUrl: "https://api.mainnet.hiro.so",
  apiKeyHeader: "x-api-key",
  maxApiBurnBlockLag: 12,
  forecastHorizonCycles: 6,
  stakerPageLimit: 200,
  eventPageLimit: 100,
  databasePath: ":memory:",
  hiroReferenceApiUrl: "https://reference.example.com",
};

const operator: HealthOperatorContext = {
  network: "mainnet",
  managerPrincipal: "SP000000000000000000002Q6VF78.signer-manager",
  currentRewardCycle: 141,
  registered: true,
  signerKeyHex: `02${"11".repeat(32)}`,
  signerKeyGrantValid: true,
  expectedCurrentParticipation: true,
  expectedNextParticipation: true,
};

function signerMetrics(overrides: Partial<SignerMetricValues> = {}): SignerMetricValues {
  return {
    nodeHeight: 101,
    rewardCycle: 141,
    stxBalanceUstx: 1_000_000,
    proposalsTotal: 0,
    validationAcceptedTotal: 0,
    validationRejectedTotal: 0,
    acceptedTotal: 0,
    rejectedTotal: 0,
    preCommitsTotal: 0,
    conflictTotal: 0,
    conflictTotals: {},
    stateChangeTotals: {},
    nodeRpcLatencyBuckets: {},
    validationLatencyBuckets: {},
    responseLatencyBuckets: {},
    capitulationLatencyBuckets: {},
    ...overrides,
  };
}

function observation(
  observedAt: string,
  options: {
    height?: number;
    referenceHeight?: number;
    peerAligned?: boolean;
    signerPublicKey?: string;
    signer?: SignerMetricValues | null;
  } = {},
): HealthObservation {
  const height = options.height ?? 101;
  const referenceHeight = options.referenceHeight ?? height;
  const source = { reachable: true, latencyMs: 2, errorCode: null, checkedAt: observedAt };
  const signerPublicKey = options.signerPublicKey;
  return {
    observedAt,
    nodeRpc: source,
    nodeInfo: {
      network_id: 1,
      burn_block_height: 960_000,
      stacks_tip_height: height,
      is_fully_synced: true,
    },
    nodeHealth:
      options.peerAligned === undefined
        ? null
        : {
            difference_from_max_peer: 0,
            max_stacks_height_of_neighbors: height,
            node_stacks_tip_height: height,
          },
    nodeMetricsSource: null,
    nodeMetrics: null,
    hiroSource: source,
    hiro: {
      status: "ready",
      chain_tip: { block_height: referenceHeight, burn_block_height: 960_000 },
    },
    configuredApiSource: null,
    configuredApi: null,
    signerInfoSource: signerPublicKey ? source : null,
    signerInfo: signerPublicKey
      ? {
          signerPublicKey,
          network: "mainnet",
          stxAddress: "SP000000000000000000002Q6VF78",
          version: "4.0.2.0.0",
        }
      : null,
    signerHeartbeat: signerPublicKey ? source : null,
    signerMetricsSource: options.signer ? source : null,
    signerMetrics: options.signer ?? null,
  };
}

describe("Signer Health v2 diagnosis", () => {
  it("requires two distinct comparison signals before suspecting a network-wide stall", () => {
    const startedAt = Date.parse("2026-08-14T12:00:00.000Z");
    const samples = Array.from({ length: 41 }, (_, index) =>
      observation(new Date(startedAt + index * 5_000).toISOString(), {
        height: index === 0 ? 100 : 101,
      }),
    );
    const oneReference = buildHealthSnapshot({
      observations: samples,
      config,
      burnBlockTiming: null,
      operator,
    });
    expect(oneReference.findings).not.toContainEqual(
      expect.objectContaining({ classification: "suspected-network-wide" }),
    );

    const transientPeerAlignment = buildHealthSnapshot({
      observations: samples.map((sample, index) => ({
        ...sample,
        nodeHealth:
          index === samples.length - 1
            ? {
                difference_from_max_peer: 0,
                max_stacks_height_of_neighbors: sample.nodeInfo?.stacks_tip_height ?? 0,
                node_stacks_tip_height: sample.nodeInfo?.stacks_tip_height ?? 0,
              }
            : null,
      })),
      config,
      burnBlockTiming: null,
      operator,
    });
    expect(transientPeerAlignment.findings).not.toContainEqual(
      expect.objectContaining({ classification: "suspected-network-wide" }),
    );

    const peersAndReference = buildHealthSnapshot({
      observations: samples.map((sample) => ({
        ...sample,
        nodeHealth: {
          difference_from_max_peer: 0,
          max_stacks_height_of_neighbors: sample.nodeInfo?.stacks_tip_height ?? 0,
          node_stacks_tip_height: sample.nodeInfo?.stacks_tip_height ?? 0,
        },
      })),
      config,
      burnBlockTiming: null,
      operator,
    });
    expect(peersAndReference.findings).toContainEqual(
      expect.objectContaining({
        id: "network-tip-stalled",
        classification: "suspected-network-wide",
        confidence: "medium",
      }),
    );
  });

  it("detects a corroborated stall when no source advances after monitoring starts", () => {
    const startedAt = Date.parse("2026-08-14T12:00:00.000Z");
    const snapshot = buildHealthSnapshot({
      observations: Array.from({ length: 37 }, (_, index) =>
        observation(new Date(startedAt + index * 5_000).toISOString(), {
          height: 101,
          peerAligned: true,
        }),
      ),
      config,
      burnBlockTiming: null,
      operator,
    });

    expect(snapshot.node.lastTipAdvanceAt).toBeNull();
    expect(snapshot.hiro.lastTipAdvanceAt).toBeNull();
    expect(snapshot.hiro.advancementStatus).toBe("insufficient-evidence");
    expect(snapshot.findings).toContainEqual(
      expect.objectContaining({
        id: "network-tip-stalled",
        classification: "suspected-network-wide",
      }),
    );
  });

  it("detects a comparison source that remains behind from the initial sample", () => {
    const startedAt = Date.parse("2026-08-14T12:00:00.000Z");
    const snapshot = buildHealthSnapshot({
      observations: Array.from({ length: 20 }, (_, index) =>
        observation(new Date(startedAt + index * 5_000).toISOString(), {
          height: 101 + index,
          referenceHeight: 100,
        }),
      ),
      config,
      burnBlockTiming: null,
      operator,
    });

    expect(snapshot.findings).toContainEqual(
      expect.objectContaining({
        id: "reference-api-behind-local-node",
        classification: "source-disagreement",
      }),
    );
  });

  it("correlates the monitored signer identity with the node-proved manager registration", () => {
    const startedAt = Date.parse("2026-08-14T12:00:00.000Z");
    const mismatchedKey = `03${"22".repeat(32)}`;
    const snapshot = buildHealthSnapshot({
      observations: Array.from({ length: 3 }, (_, index) =>
        observation(new Date(startedAt + index * 5_000).toISOString(), {
          signerPublicKey: mismatchedKey,
          signer: signerMetrics(),
        }),
      ),
      config: { ...config, signerMonitoringUrl: "http://127.0.0.1:9153" },
      burnBlockTiming: null,
      operator,
    });

    expect(snapshot.findings).toContainEqual(
      expect.objectContaining({
        id: "signer-identity-mismatch",
        classification: "likely-local-signer",
        confidence: "high",
      }),
    );
    expect(snapshot.signer.identityMatchesRegistration).toBe(false);
  });

  it("reports sustained loss of signer participation telemetry", () => {
    const startedAt = Date.parse("2026-08-14T12:00:00.000Z");
    const samples = Array.from({ length: 3 }, (_, index) => {
      const sample = observation(new Date(startedAt + index * 5_000).toISOString(), {
        signerPublicKey: operator.signerKeyHex ?? undefined,
      });
      return {
        ...sample,
        signerMetricsSource: {
          reachable: false,
          latencyMs: null,
          errorCode: "upstream-timeout",
          checkedAt: sample.observedAt,
        },
      };
    });
    const snapshot = buildHealthSnapshot({
      observations: samples,
      config: { ...config, signerMonitoringUrl: "http://127.0.0.1:9153" },
      burnBlockTiming: null,
      operator,
    });

    expect(snapshot.findings).toContainEqual(
      expect.objectContaining({
        id: "signer-metrics-unavailable",
        classification: "likely-local-signer",
      }),
    );
  });

  it("judges signer height lag only on signer updates and requires two healthy updates to resolve", () => {
    const startedAt = Date.parse("2026-08-14T12:00:00.000Z");
    const sampleAt = (seconds: number, nodeHeight: number, signerHeight: number) =>
      observation(new Date(startedAt + seconds * 1_000).toISOString(), {
        height: nodeHeight,
        signerPublicKey: operator.signerKeyHex ?? undefined,
        signer: signerMetrics({ nodeHeight: signerHeight }),
      });
    const lagging = [sampleAt(0, 110, 100), sampleAt(60, 112, 101), sampleAt(120, 114, 102)];
    const lagSnapshot = buildHealthSnapshot({
      observations: lagging,
      config: { ...config, signerMonitoringUrl: "http://127.0.0.1:9153" },
      burnBlockTiming: null,
      operator,
    });
    expect(lagSnapshot.findings.map(({ id }) => id)).toContain("signer-node-view-behind");

    const oneHealthy = buildHealthSnapshot({
      observations: [...lagging, sampleAt(180, 115, 114)],
      config: { ...config, signerMonitoringUrl: "http://127.0.0.1:9153" },
      burnBlockTiming: null,
      operator,
    });
    expect(oneHealthy.findings.map(({ id }) => id)).toContain("signer-node-view-behind");

    const twoHealthy = buildHealthSnapshot({
      observations: [...lagging, sampleAt(180, 115, 114), sampleAt(240, 116, 116)],
      config: { ...config, signerMonitoringUrl: "http://127.0.0.1:9153" },
      burnBlockTiming: null,
      operator,
    });
    expect(twoHealthy.findings.map(({ id }) => id)).not.toContain("signer-node-view-behind");

    const staticSigner = buildHealthSnapshot({
      observations: [
        sampleAt(0, 101, 101),
        sampleAt(60, 106, 101),
        sampleAt(120, 111, 101),
        sampleAt(180, 116, 101),
      ],
      config: { ...config, signerMonitoringUrl: "http://127.0.0.1:9153" },
      burnBlockTiming: null,
      operator,
    });
    expect(staticSigner.findings.map(({ id }) => id)).not.toContain("signer-node-view-behind");
  });

  it("retains elevated end-to-end response time without opening a health finding", () => {
    const startedAt = Date.parse("2026-08-14T12:00:00.000Z");
    const first = signerMetrics({
      proposalsTotal: 10,
      acceptedTotal: 10,
      responseLatencyBuckets: { "1": 0, "10": 10, "+Inf": 10 },
      validationLatencyBuckets: { "1": 10, "+Inf": 10 },
      nodeRpcLatencyBuckets: { "1": 10, "+Inf": 10 },
    });
    const last = signerMetrics({
      proposalsTotal: 30,
      acceptedTotal: 30,
      responseLatencyBuckets: { "1": 0, "10": 30, "+Inf": 30 },
      validationLatencyBuckets: { "1": 30, "+Inf": 30 },
      nodeRpcLatencyBuckets: { "1": 30, "+Inf": 30 },
    });
    const snapshot = buildHealthSnapshot({
      observations: [
        observation(new Date(startedAt).toISOString(), {
          signerPublicKey: operator.signerKeyHex ?? undefined,
          signer: first,
        }),
        observation(new Date(startedAt + 60_000).toISOString(), {
          signerPublicKey: operator.signerKeyHex ?? undefined,
          signer: last,
        }),
      ],
      config: { ...config, signerMonitoringUrl: "http://127.0.0.1:9153" },
      burnBlockTiming: null,
      operator,
    });
    expect(snapshot.signer.last15Minutes.responseP95Seconds).toBeGreaterThan(5);
    expect(snapshot.findings.map(({ id }) => id)).not.toContain("signer-response-latency-elevated");
    expect(snapshot.diagnosis.activeFindingIds).toEqual([]);
  });

  it("alerts on sustained node-reported validation latency", () => {
    const startedAt = Date.parse("2026-08-14T12:00:00.000Z");
    const first = signerMetrics({
      validationAcceptedTotal: 10,
      validationLatencyBuckets: { "1": 10, "10": 10, "+Inf": 10 },
      nodeRpcLatencyBuckets: { "1": 10, "+Inf": 10 },
    });
    const last = signerMetrics({
      validationAcceptedTotal: 30,
      validationLatencyBuckets: { "1": 10, "10": 30, "+Inf": 30 },
      nodeRpcLatencyBuckets: { "1": 30, "+Inf": 30 },
    });
    const snapshot = buildHealthSnapshot({
      observations: [
        observation(new Date(startedAt).toISOString(), {
          signerPublicKey: operator.signerKeyHex ?? undefined,
          signer: first,
        }),
        observation(new Date(startedAt + 60_000).toISOString(), {
          signerPublicKey: operator.signerKeyHex ?? undefined,
          signer: last,
        }),
      ],
      config: { ...config, signerMonitoringUrl: "http://127.0.0.1:9153" },
      burnBlockTiming: null,
      operator,
    });

    expect(snapshot.findings).toContainEqual(
      expect.objectContaining({
        id: "signer-validation-latency-elevated",
        severity: "warning",
        source: "node",
        classification: "likely-local-node",
        confidence: "medium",
      }),
    );
  });

  it("does not alert on validation latency before the minimum population", () => {
    const startedAt = Date.parse("2026-08-14T12:00:00.000Z");
    const snapshot = buildHealthSnapshot({
      observations: [
        observation(new Date(startedAt).toISOString(), {
          signerPublicKey: operator.signerKeyHex ?? undefined,
          signer: signerMetrics({
            validationAcceptedTotal: 0,
            validationLatencyBuckets: { "1": 0, "10": 0, "+Inf": 0 },
          }),
        }),
        observation(new Date(startedAt + 60_000).toISOString(), {
          signerPublicKey: operator.signerKeyHex ?? undefined,
          signer: signerMetrics({
            validationAcceptedTotal: 19,
            validationLatencyBuckets: { "1": 0, "10": 19, "+Inf": 19 },
          }),
        }),
      ],
      config: { ...config, signerMonitoringUrl: "http://127.0.0.1:9153" },
      burnBlockTiming: null,
      operator,
    });

    expect(snapshot.signer.last15Minutes.validationP95Seconds).toBeGreaterThan(5);
    expect(snapshot.findings.map(({ id }) => id)).not.toContain(
      "signer-validation-latency-elevated",
    );
  });

  it("detects response gaps, elevated rejection, validation latency, and agreement conflicts", () => {
    const startedAt = Date.parse("2026-08-14T12:00:00.000Z");
    // Proposals climb far faster than responses across samples that are all old enough to have been
    // answered, so the settled proposal/response gap is real rather than trailing-edge in-flight.
    const first = signerMetrics({
      proposalsTotal: 10,
      acceptedTotal: 8,
      rejectedTotal: 2,
      validationAcceptedTotal: 10,
      conflictTotal: 1,
      responseLatencyBuckets: { "1": 8, "10": 10, "+Inf": 10 },
      validationLatencyBuckets: { "1": 0, "10": 10, "+Inf": 10 },
    });
    const middle = signerMetrics({
      proposalsTotal: 60,
      acceptedTotal: 12,
      rejectedTotal: 4,
      validationAcceptedTotal: 60,
      conflictTotal: 3,
      responseLatencyBuckets: { "1": 9, "10": 15, "+Inf": 15 },
      validationLatencyBuckets: { "1": 5, "10": 60, "+Inf": 60 },
    });
    const last = signerMetrics({
      proposalsTotal: 110,
      acceptedTotal: 20,
      rejectedTotal: 12,
      validationAcceptedTotal: 110,
      conflictTotal: 5,
      responseLatencyBuckets: { "1": 10, "10": 30, "+Inf": 30 },
      validationLatencyBuckets: { "1": 10, "10": 110, "+Inf": 110 },
    });
    const snapshot = buildHealthSnapshot({
      observations: [
        observation(new Date(startedAt).toISOString(), {
          signerPublicKey: operator.signerKeyHex ?? undefined,
          signer: first,
        }),
        observation(new Date(startedAt + 60_000).toISOString(), {
          signerPublicKey: operator.signerKeyHex ?? undefined,
          signer: middle,
        }),
        observation(new Date(startedAt + 120_000).toISOString(), {
          signerPublicKey: operator.signerKeyHex ?? undefined,
          signer: last,
        }),
      ],
      config: { ...config, signerMonitoringUrl: "http://127.0.0.1:9153" },
      burnBlockTiming: null,
      operator,
    });

    expect(snapshot.findings.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        "signer-proposal-response-gap",
        "signer-rejection-rate-elevated",
        "signer-validation-latency-elevated",
        "signer-agreement-conflicts-elevated",
      ]),
    );
  });

  it("does not flag a proposal/response gap from proposals still within the settle window", () => {
    const startedAt = Date.parse("2026-08-14T12:00:00.000Z");
    // Proposals older than the 30s settle window are fully answered; a late burst of proposals all
    // arrived within the last 30s and simply has responses in flight. The raw window gap here is 15
    // (which the pre-settle rule would have flagged critical), but no proposal is old enough to be
    // considered unanswered, so the settled gap is 0 and the finding must not fire.
    const proposalsByOffsetSeconds: Array<[number, number]> = [
      [0, 10],
      [5, 10],
      [10, 12],
      [15, 14],
      [20, 16],
      [25, 18],
      [30, 20],
      [35, 25],
    ];
    const observations = proposalsByOffsetSeconds.map(([offsetSeconds, proposalsTotal]) =>
      observation(new Date(startedAt + offsetSeconds * 1_000).toISOString(), {
        signerPublicKey: operator.signerKeyHex ?? undefined,
        signer: signerMetrics({ proposalsTotal, acceptedTotal: 8, rejectedTotal: 2 }),
      }),
    );
    const snapshot = buildHealthSnapshot({
      observations,
      config: { ...config, signerMonitoringUrl: "http://127.0.0.1:9153" },
      burnBlockTiming: null,
      operator,
    });

    expect(snapshot.findings.map(({ id }) => id)).not.toContain("signer-proposal-response-gap");
  });

  it("interpolates response p95 within the bucket and survives a mid-window counter reset", () => {
    const startedAt = Date.parse("2026-08-14T12:00:00.000Z");
    // Cumulative histogram where ~95% of responses land at or below 5s. A restart drops every
    // bucket together mid-window; a per-bucket delta would fold the post-reset totals back in and
    // push the crossing bucket upward. The joint reset handling instead counts only the two
    // monotonic intervals, and interpolation keeps the result inside the [1s, 5s] bucket.
    const bucketsFor = (multiplier: number) => ({
      "1": 90 * multiplier,
      "5": 99 * multiplier,
      "10": 100 * multiplier,
      "+Inf": 100 * multiplier,
    });
    const snapshot = buildHealthSnapshot({
      observations: [
        observation(new Date(startedAt).toISOString(), {
          signerPublicKey: operator.signerKeyHex ?? undefined,
          signer: signerMetrics({ responseLatencyBuckets: bucketsFor(1) }),
        }),
        observation(new Date(startedAt + 5_000).toISOString(), {
          signerPublicKey: operator.signerKeyHex ?? undefined,
          signer: signerMetrics({ responseLatencyBuckets: bucketsFor(2) }),
        }),
        // Restart: counters reset far below the previous cumulative values.
        observation(new Date(startedAt + 10_000).toISOString(), {
          signerPublicKey: operator.signerKeyHex ?? undefined,
          signer: signerMetrics({
            responseLatencyBuckets: { "1": 9, "5": 10, "10": 10, "+Inf": 10 },
          }),
        }),
        observation(new Date(startedAt + 15_000).toISOString(), {
          signerPublicKey: operator.signerKeyHex ?? undefined,
          signer: signerMetrics({ responseLatencyBuckets: bucketsFor(1) }),
        }),
      ],
      config: { ...config, signerMonitoringUrl: "http://127.0.0.1:9153" },
      burnBlockTiming: null,
      operator,
    });

    const p95 = snapshot.signer.last15Minutes.responseP95Seconds;
    expect(p95).not.toBeNull();
    expect(p95).toBeGreaterThan(1);
    expect(p95).toBeLessThan(5);
    expect(p95).toBeCloseTo(3.24, 1);
  });

  it("excludes a partial histogram interval instead of inflating response p95", () => {
    const startedAt = Date.parse("2026-08-14T12:00:00.000Z");
    const bucketsFor = (multiplier: number) => ({
      "1": 90 * multiplier,
      "5": 99 * multiplier,
      "10": 100 * multiplier,
      "+Inf": 100 * multiplier,
    });
    const snapshot = buildHealthSnapshot({
      observations: [
        observation(new Date(startedAt).toISOString(), {
          signerPublicKey: operator.signerKeyHex ?? undefined,
          signer: signerMetrics({ responseLatencyBuckets: bucketsFor(1) }),
        }),
        observation(new Date(startedAt + 5_000).toISOString(), {
          signerPublicKey: operator.signerKeyHex ?? undefined,
          signer: signerMetrics({ responseLatencyBuckets: bucketsFor(2) }),
        }),
        observation(new Date(startedAt + 10_000).toISOString(), {
          signerPublicKey: operator.signerKeyHex ?? undefined,
          signer: signerMetrics({
            responseLatencyBuckets: { "1": 270, "10": 300, "+Inf": 300 },
          }),
        }),
        observation(new Date(startedAt + 15_000).toISOString(), {
          signerPublicKey: operator.signerKeyHex ?? undefined,
          signer: signerMetrics({ responseLatencyBuckets: bucketsFor(4) }),
        }),
        observation(new Date(startedAt + 20_000).toISOString(), {
          signerPublicKey: operator.signerKeyHex ?? undefined,
          signer: signerMetrics({ responseLatencyBuckets: bucketsFor(5) }),
        }),
      ],
      config: { ...config, signerMonitoringUrl: "http://127.0.0.1:9153" },
      burnBlockTiming: null,
      operator,
    });

    expect(snapshot.signer.last15Minutes.responseP95Seconds).toBeCloseTo(3.22, 1);
  });
});
