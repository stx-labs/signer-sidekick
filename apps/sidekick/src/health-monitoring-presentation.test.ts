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

  it("detects response gaps, elevated rejection, latency, and agreement conflicts", () => {
    const startedAt = Date.parse("2026-08-14T12:00:00.000Z");
    const first = signerMetrics({
      proposalsTotal: 10,
      acceptedTotal: 8,
      rejectedTotal: 2,
      conflictTotal: 1,
      responseLatencyBuckets: { "1": 8, "10": 10, "+Inf": 10 },
    });
    const last = signerMetrics({
      proposalsTotal: 35,
      acceptedTotal: 18,
      rejectedTotal: 12,
      conflictTotal: 5,
      responseLatencyBuckets: { "1": 10, "10": 30, "+Inf": 30 },
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

    expect(snapshot.findings.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        "signer-proposal-response-gap",
        "signer-rejection-rate-elevated",
        "signer-response-latency-elevated",
        "signer-agreement-conflicts-elevated",
      ]),
    );
  });
});
