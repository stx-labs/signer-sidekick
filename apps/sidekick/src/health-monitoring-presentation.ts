import type { HealthSnapshot } from "@stx-labs/signer-sidekick-api-contracts";
import type { SidekickConfig } from "./config.js";
import {
  counterIncrease,
  healthSourceState,
  histogramP95,
  histogramP95For,
  lastConfiguredApiTipAdvanceAt,
  lastHiroTipAdvanceAt,
  lastTipAdvanceAt,
} from "./health-monitoring-state.js";
import type {
  BurnBlockTiming,
  HealthFinding,
  HealthObservation,
  HealthOperatorContext,
  HealthSourceState,
} from "./health-monitoring-types.js";
import {
  HEALTH_RAW_RETENTION_HOURS,
  HEALTH_ROLLUP_INTERVAL_MINUTES,
  HEALTH_ROLLUP_RETENTION_DAYS,
  type HealthFindingEpisode,
  type HealthRollup,
} from "./storage/health-monitoring-repository.js";

const networkAdvancementEvidenceWindowMs = 90_000;
const localSourceFailureSamples = 3;
const localSourceFailureWindowMs = 10_000;
const nodeBehindSamples = 6;
const nodeBehindWindowMs = 25_000;
const nodeStallWindowMs = 90_000;
const networkStallWindowMs = 180_000;
const sourceLagBlocks = 3;
const signerHeightLagBlocks = 3;
const signerResponseGapMinimum = 3;
const signerResponseSampleMinimum = 5;
const signerRateSampleMinimum = 20;
const signerRejectionPercentThreshold = 25;
const signerResponseP95ThresholdSeconds = 5;
const agreementConflictThreshold = 3;

type FindingInput = Omit<HealthFinding, "episodeId">;

interface HealthHistoryInput {
  observedSince: string | null;
  observationCount: number;
  recentRollups: HealthRollup[];
  recentEpisodes: HealthFindingEpisode[];
}

function sameOrigin(left: string, right: string): boolean {
  return new URL(left).origin === new URL(right).origin;
}

function windowSince(
  observations: readonly HealthObservation[],
  durationMs: number,
): HealthObservation[] {
  const latest = observations.at(-1);
  if (!latest) return [];
  const cutoff = Date.parse(latest.observedAt) - durationMs;
  return observations.filter(({ observedAt }) => Date.parse(observedAt) >= cutoff);
}

function stagnationStartedAt(
  observations: readonly HealthObservation[],
  lastAdvanceAt: string | null,
  select: (observation: HealthObservation) => { checkedAt: string; height: number } | null,
): string | null {
  if (lastAdvanceAt !== null) return lastAdvanceAt;
  const checks = new Map<string, number>();
  for (const observation of observations) {
    const sample = select(observation);
    if (sample) checks.set(sample.checkedAt, sample.height);
  }
  if (checks.size < 2 || new Set(checks.values()).size > 1) return null;
  return checks.keys().next().value ?? null;
}

function consecutiveMatching(
  observations: readonly HealthObservation[],
  predicate: (observation: HealthObservation) => boolean,
): HealthObservation[] {
  const result: HealthObservation[] = [];
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const observation = observations[index];
    if (!observation || !predicate(observation)) break;
    result.unshift(observation);
  }
  return result;
}

function sustained(
  samples: readonly HealthObservation[],
  minimumSamples: number,
  minimumWindowMs: number,
): boolean {
  const first = samples.at(0);
  const last = samples.at(-1);
  return Boolean(
    first &&
      last &&
      samples.length >= minimumSamples &&
      Date.parse(last.observedAt) - Date.parse(first.observedAt) >= minimumWindowMs,
  );
}

function evidenceWindow(
  observations: readonly HealthObservation[],
  distinctSources: number,
): HealthFinding["evidenceWindow"] {
  const first = observations.at(0)?.observedAt ?? new Date(0).toISOString();
  const last = observations.at(-1)?.observedAt ?? first;
  return {
    startedAt: first,
    endedAt: last,
    sampleCount: observations.length,
    distinctSources,
  };
}

function finding(
  value: Omit<FindingInput, "firstObservedAt" | "lastObservedAt" | "evidenceWindow"> & {
    observations: readonly HealthObservation[];
  },
): FindingInput {
  const firstObservedAt = value.observations.at(0)?.observedAt ?? new Date(0).toISOString();
  const lastObservedAt = value.observations.at(-1)?.observedAt ?? firstObservedAt;
  const distinctSources = new Set(value.evidence.map(({ source }) => source)).size;
  const { observations: _observations, ...findingValue } = value;
  return {
    ...findingValue,
    firstObservedAt,
    lastObservedAt,
    evidenceWindow: evidenceWindow(value.observations, distinctSources),
  };
}

function histogramWindow(
  observations: readonly HealthObservation[],
  key:
    | "nodeRpcLatencyBuckets"
    | "validationLatencyBuckets"
    | "responseLatencyBuckets"
    | "capitulationLatencyBuckets",
): number | null {
  return histogramP95For(observations, (observation) => observation.signerMetrics?.[key] ?? {});
}

function signerWindow(
  observations: readonly HealthObservation[],
): HealthSnapshot["signer"]["last15Minutes"] {
  const latest = observations.at(-1)?.observedAt ?? new Date(0).toISOString();
  const earliest = observations.at(0)?.observedAt ?? latest;
  const proposals = counterIncrease(
    observations,
    (sample) => sample.signerMetrics?.proposalsTotal ?? null,
  );
  const validationAccepted = counterIncrease(
    observations,
    (sample) => sample.signerMetrics?.validationAcceptedTotal ?? null,
  );
  const validationRejected = counterIncrease(
    observations,
    (sample) => sample.signerMetrics?.validationRejectedTotal ?? null,
  );
  const accepted = counterIncrease(
    observations,
    (sample) => sample.signerMetrics?.acceptedTotal ?? null,
  );
  const rejected = counterIncrease(
    observations,
    (sample) => sample.signerMetrics?.rejectedTotal ?? null,
  );
  const responses = accepted !== null && rejected !== null ? accepted + rejected : null;
  return {
    startedAt: earliest,
    endedAt: latest,
    sampleCount: observations.length,
    proposals,
    validationAccepted,
    validationRejected,
    accepted,
    rejected,
    responseGap:
      proposals !== null && responses !== null ? Math.max(0, proposals - responses) : null,
    rejectionPercent:
      responses !== null && responses > 0 && rejected !== null
        ? (rejected / responses) * 100
        : null,
    responseP95Seconds: histogramP95(observations),
    validationP95Seconds: histogramWindow(observations, "validationLatencyBuckets"),
    nodeRpcP95Seconds: histogramWindow(observations, "nodeRpcLatencyBuckets"),
    capitulationP95Seconds: histogramWindow(observations, "capitulationLatencyBuckets"),
    disagreements: counterIncrease(
      observations,
      (sample) => sample.signerMetrics?.conflictTotal ?? null,
    ),
    preCommits: counterIncrease(
      observations,
      (sample) => sample.signerMetrics?.preCommitsTotal ?? null,
    ),
    collectingBaseline: observations.length < 2,
  };
}

function sourceAdvanceStatus(
  lastAdvanceAt: string | null,
  stagnationStartedAt: string | null,
  latestObservedAt: string,
): "advancing" | "collecting" | "insufficient-evidence" {
  const evidenceStartedAt = lastAdvanceAt ?? stagnationStartedAt;
  if (evidenceStartedAt === null) return "collecting";
  const current =
    Date.parse(latestObservedAt) - Date.parse(evidenceStartedAt) <=
    networkAdvancementEvidenceWindowMs
      ? lastAdvanceAt === null
        ? "collecting"
        : "advancing"
      : "insufficient-evidence";
  return current;
}

function evaluateHealthFindings(input: {
  observations: readonly HealthObservation[];
  config: SidekickConfig;
  operator: HealthOperatorContext | null;
  nodeRpc: HealthSourceState;
  signerInfo: HealthSourceState;
  signerHeartbeat: HealthSourceState;
  signerMetrics: HealthSourceState;
  hiro: HealthSourceState;
  configuredApi: HealthSourceState;
  nodeLastAdvanceAt: string | null;
  nodeStagnationStartedAt: string | null;
  hiroLastAdvanceAt: string | null;
  hiroStagnationStartedAt: string | null;
  configuredApiLastAdvanceAt: string | null;
  configuredApiStagnationStartedAt: string | null;
  signer15m: HealthSnapshot["signer"]["last15Minutes"];
}): FindingInput[] {
  const {
    observations,
    config,
    operator,
    nodeRpc,
    signerInfo,
    signerHeartbeat,
    signerMetrics,
    hiro,
    configuredApi,
    nodeLastAdvanceAt,
    nodeStagnationStartedAt,
    hiroLastAdvanceAt,
    hiroStagnationStartedAt,
    configuredApiLastAdvanceAt,
    configuredApiStagnationStartedAt,
    signer15m,
  } = input;
  const latest = observations.at(-1);
  if (!latest) return [];
  const findings: FindingInput[] = [];
  const latestAt = Date.parse(latest.observedAt);
  const recent15m = windowSince(observations, 15 * 60 * 1_000);

  const nodeFailures = consecutiveMatching(observations, ({ nodeRpc }) => !nodeRpc.reachable);
  if (
    nodeRpc.consecutiveFailures >= localSourceFailureSamples &&
    sustained(nodeFailures, localSourceFailureSamples, localSourceFailureWindowMs)
  ) {
    findings.push(
      finding({
        id: "node-rpc-unavailable",
        severity: "critical",
        title: "Stacks node is unavailable",
        detail:
          "Sidekick could not reach the configured node RPC for a sustained local evidence window.",
        source: "node",
        classification: "likely-local-node",
        confidence: "high",
        observations: nodeFailures,
        evidence: [
          {
            code: "node-rpc-consecutive-failures",
            source: "local-node",
            status: "supporting",
            observedAt: nodeRpc.checkedAt,
            value: String(nodeRpc.consecutiveFailures),
            detail: "The configured local RPC failed consecutive bounded checks.",
          },
        ],
      }),
    );
  }

  const signerInfoFailures = consecutiveMatching(
    observations,
    ({ signerInfoSource }) => signerInfoSource?.reachable === false,
  );
  if (
    signerInfo.consecutiveFailures >= localSourceFailureSamples &&
    sustained(signerInfoFailures, localSourceFailureSamples, localSourceFailureWindowMs)
  ) {
    findings.push(
      finding({
        id: "signer-monitoring-unavailable",
        severity: "critical",
        title: "Signer monitoring is unavailable",
        detail:
          "Sidekick could not reach the configured signer monitoring server for a sustained local evidence window.",
        source: "signer",
        classification: "likely-local-signer",
        confidence: "high",
        observations: signerInfoFailures,
        evidence: [
          {
            code: "signer-info-consecutive-failures",
            source: "signer-monitoring",
            status: "supporting",
            observedAt: signerInfo.checkedAt,
            value: String(signerInfo.consecutiveFailures),
            detail: "The signer information endpoint failed consecutive bounded checks.",
          },
        ],
      }),
    );
  }

  const heartbeatFailures = consecutiveMatching(
    observations,
    ({ signerHeartbeat }) => signerHeartbeat?.reachable === false,
  );
  if (
    signerHeartbeat.consecutiveFailures >= localSourceFailureSamples &&
    sustained(heartbeatFailures, localSourceFailureSamples, localSourceFailureWindowMs)
  ) {
    findings.push(
      finding({
        id: "signer-node-heartbeat-failed",
        severity: "critical",
        title: "Signer cannot reach its Stacks node",
        detail:
          "The signer heartbeat failed its node connection check throughout the evidence window.",
        source: "signer",
        classification: "likely-local-signer",
        confidence: "high",
        observations: heartbeatFailures,
        evidence: [
          {
            code: "signer-heartbeat-consecutive-failures",
            source: "signer-monitoring",
            status: "supporting",
            observedAt: signerHeartbeat.checkedAt,
            value: String(signerHeartbeat.consecutiveFailures),
            detail: "The signer's own heartbeat reports that its node connection is unhealthy.",
          },
        ],
      }),
    );
  }

  const signerMetricFailures = consecutiveMatching(
    observations,
    ({ signerMetricsSource }) => signerMetricsSource?.reachable === false,
  );
  if (
    signerMetrics.consecutiveFailures >= localSourceFailureSamples &&
    sustained(signerMetricFailures, localSourceFailureSamples, localSourceFailureWindowMs) &&
    !findings.some(({ id }) => id === "signer-monitoring-unavailable")
  ) {
    findings.push(
      finding({
        id: "signer-metrics-unavailable",
        severity: "warning",
        title: "Signer participation metrics are unavailable",
        detail:
          "The signer identity endpoint is reachable, but Sidekick cannot verify recent proposal, response, latency, or agreement activity.",
        source: "signer",
        classification: "likely-local-signer",
        confidence: "high",
        observations: signerMetricFailures,
        evidence: [
          {
            code: "signer-metrics-consecutive-failures",
            source: "signer-monitoring",
            status: "supporting",
            observedAt: signerMetrics.checkedAt,
            value: String(signerMetrics.consecutiveFailures),
            detail: "The configured signer metrics endpoint failed consecutive bounded checks.",
          },
        ],
      }),
    );
  }

  const behindSamples = consecutiveMatching(
    observations,
    (observation) =>
      observation.nodeInfo?.is_fully_synced === false ||
      (observation.nodeHealth?.difference_from_max_peer ?? 0) >= sourceLagBlocks,
  );
  if (sustained(behindSamples, nodeBehindSamples, nodeBehindWindowMs)) {
    findings.push(
      finding({
        id: "node-behind-network",
        severity: "critical",
        title: "Stacks node is behind its observed peers",
        detail:
          latest.nodeInfo?.is_fully_synced === false
            ? "The local node persistently reports that it is not fully synchronized."
            : `The local node remained ${latest.nodeHealth?.difference_from_max_peer ?? 0} Stacks blocks behind its most advanced peer.`,
        source: "node",
        classification: "likely-local-node",
        confidence: "high",
        observations: behindSamples,
        evidence: [
          {
            code: "node-peer-height-gap",
            source: "node-peers",
            status: "supporting",
            observedAt: latest.observedAt,
            value: String(latest.nodeHealth?.difference_from_max_peer ?? 0),
            detail: "The node's peer-health endpoint reports a sustained canonical height gap.",
          },
        ],
      }),
    );
  }

  const nodeStallAge =
    nodeStagnationStartedAt === null ? null : latestAt - Date.parse(nodeStagnationStartedAt);
  const hiroAdvancing =
    hiro.status === "healthy" &&
    hiroLastAdvanceAt !== null &&
    latestAt - Date.parse(hiroLastAdvanceAt) <= networkAdvancementEvidenceWindowMs;
  const configuredApiAdvancing =
    configuredApi.status === "healthy" &&
    configuredApiLastAdvanceAt !== null &&
    latestAt - Date.parse(configuredApiLastAdvanceAt) <= networkAdvancementEvidenceWindowMs;
  const peersAhead = (latest.nodeHealth?.difference_from_max_peer ?? 0) > 0;
  if (
    nodeStallAge !== null &&
    nodeStallAge >= nodeStallWindowMs &&
    (peersAhead || hiroAdvancing || configuredApiAdvancing) &&
    !findings.some(({ id }) => id === "node-rpc-unavailable" || id === "node-behind-network")
  ) {
    const corroborating =
      Number(peersAhead) + Number(hiroAdvancing) + Number(configuredApiAdvancing);
    findings.push(
      finding({
        id: "node-tip-stalled-locally",
        severity: "critical",
        title: "Local Stacks tip stopped advancing",
        detail:
          "The local node stopped advancing while at least one independent source observed newer chain progress.",
        source: "node",
        classification: "likely-local-node",
        confidence: corroborating >= 2 ? "high" : "medium",
        observations: windowSince(observations, nodeStallWindowMs),
        evidence: [
          {
            code: "local-tip-stall",
            source: "local-node",
            status: "supporting",
            observedAt: nodeStagnationStartedAt,
            value: `${Math.round(nodeStallAge / 1_000)}s`,
            detail: "No local Stacks or Bitcoin tip advance was observed inside the stall window.",
          },
          ...(peersAhead
            ? [
                {
                  code: "peer-tip-ahead",
                  source: "node-peers" as const,
                  status: "supporting" as const,
                  observedAt: latest.observedAt,
                  value: String(latest.nodeHealth?.difference_from_max_peer ?? 0),
                  detail: "The local node reports a connected peer at a newer Stacks height.",
                },
              ]
            : []),
          ...(hiroAdvancing
            ? [
                {
                  code: "reference-api-advancing",
                  source: "reference-api" as const,
                  status: "supporting" as const,
                  observedAt: hiroLastAdvanceAt,
                  value: latest.hiro ? String(latest.hiro.chain_tip.block_height) : null,
                  detail: "The independent reference API advanced during the local stall.",
                },
              ]
            : []),
          ...(configuredApiAdvancing
            ? [
                {
                  code: "configured-api-advancing",
                  source: "configured-api" as const,
                  status: "supporting" as const,
                  observedAt: configuredApiLastAdvanceAt,
                  value: latest.configuredApi
                    ? String(latest.configuredApi.chain_tip.block_height)
                    : null,
                  detail: "The separately configured API advanced during the local stall.",
                },
              ]
            : []),
        ],
      }),
    );
  }

  const peerViewAlignedSamples = consecutiveMatching(
    observations,
    (observation) =>
      observation.nodeHealth !== null &&
      observation.nodeHealth.difference_from_max_peer === 0 &&
      observation.nodeHealth.max_stacks_height_of_neighbors ===
        observation.nodeHealth.node_stacks_tip_height,
  );
  const peerViewAligned = sustained(peerViewAlignedSamples, 2, networkStallWindowMs);
  const peerViewAlignedStartedAt = peerViewAlignedSamples.at(0)?.observedAt ?? null;
  const hiroStalled =
    hiro.status === "healthy" &&
    hiroStagnationStartedAt !== null &&
    latestAt - Date.parse(hiroStagnationStartedAt) >= networkStallWindowMs;
  const configuredApiStalled =
    configuredApi.status === "healthy" &&
    configuredApiStagnationStartedAt !== null &&
    latestAt - Date.parse(configuredApiStagnationStartedAt) >= networkStallWindowMs;
  const networkCorroboration =
    Number(peerViewAligned) + Number(hiroStalled) + Number(configuredApiStalled);
  if (
    nodeStallAge !== null &&
    nodeStallAge >= networkStallWindowMs &&
    networkCorroboration >= 2 &&
    !findings.some(({ classification }) => classification === "likely-local-node")
  ) {
    findings.push(
      finding({
        id: "network-tip-stalled",
        severity: "warning",
        title: "Stacks network may be stalled",
        detail:
          "The local node and at least two distinct comparison signals show no recent Stacks tip advancement.",
        source: "network",
        classification: "suspected-network-wide",
        confidence: networkCorroboration >= 3 ? "high" : "medium",
        observations: windowSince(observations, networkStallWindowMs),
        evidence: [
          {
            code: "local-tip-stall",
            source: "local-node",
            status: "supporting",
            observedAt: nodeStagnationStartedAt,
            value: `${Math.round(nodeStallAge / 1_000)}s`,
            detail: "The local node did not advance during the network evidence window.",
          },
          ...(peerViewAligned
            ? [
                {
                  code: "peer-view-aligned-stall",
                  source: "node-peers" as const,
                  status: "supporting" as const,
                  observedAt: peerViewAlignedStartedAt,
                  value: String(latest.nodeHealth?.node_stacks_tip_height ?? "unknown"),
                  detail:
                    "The node's connected-peer view reports no peer ahead of the stalled tip.",
                },
              ]
            : []),
          ...(hiroStalled
            ? [
                {
                  code: "reference-api-stall",
                  source: "reference-api" as const,
                  status: "supporting" as const,
                  observedAt: hiroStagnationStartedAt,
                  value: latest.hiro ? String(latest.hiro.chain_tip.block_height) : null,
                  detail: "The independent reference API also shows no recent advance.",
                },
              ]
            : []),
          ...(configuredApiStalled
            ? [
                {
                  code: "configured-api-stall",
                  source: "configured-api" as const,
                  status: "supporting" as const,
                  observedAt: configuredApiStagnationStartedAt,
                  value: latest.configuredApi
                    ? String(latest.configuredApi.chain_tip.block_height)
                    : null,
                  detail: "The separately configured API also shows no recent advance.",
                },
              ]
            : []),
        ],
      }),
    );
  }

  const sourceLag = [
    {
      id: "reference-api",
      source: hiro,
      value: latest.hiro,
      stagnationStartedAt: hiroStagnationStartedAt,
      evidenceSource: "reference-api" as const,
    },
    {
      id: "configured-api",
      source: configuredApi,
      value: latest.configuredApi,
      stagnationStartedAt: configuredApiStagnationStartedAt,
      evidenceSource: "configured-api" as const,
    },
  ].find(
    ({ source, value, stagnationStartedAt }) =>
      source.status === "healthy" &&
      value &&
      latest.nodeInfo &&
      latest.nodeInfo.stacks_tip_height - value.chain_tip.block_height >= sourceLagBlocks &&
      stagnationStartedAt !== null &&
      latestAt - Date.parse(stagnationStartedAt) >= networkAdvancementEvidenceWindowMs,
  );
  if (sourceLag && nodeStallAge !== null && nodeStallAge < networkAdvancementEvidenceWindowMs) {
    findings.push(
      finding({
        id: `${sourceLag.id}-behind-local-node`,
        severity: "warning",
        title: "A comparison source is behind the local node",
        detail:
          "The local node is advancing, but a configured comparison source remains several Stacks blocks behind.",
        source: "source",
        classification: "source-disagreement",
        confidence: "high",
        observations: windowSince(observations, networkAdvancementEvidenceWindowMs),
        evidence: [
          {
            code: "local-node-advancing",
            source: "local-node",
            status: "contradicting",
            observedAt: nodeLastAdvanceAt,
            value: String(latest.nodeInfo?.stacks_tip_height ?? "unknown"),
            detail: "The authoritative local node advanced inside the evidence window.",
          },
          {
            code: "comparison-source-lag",
            source: sourceLag.evidenceSource,
            status: "supporting",
            observedAt: sourceLag.source.checkedAt,
            value: String(
              (latest.nodeInfo?.stacks_tip_height ?? 0) -
                (sourceLag.value?.chain_tip.block_height ?? 0),
            ),
            detail:
              "The comparison source remains behind and is not used as a current-state authority.",
          },
        ],
      }),
    );
  }

  if (config.signerMonitoringUrl) {
    const identityMismatchSamples = consecutiveMatching(
      observations,
      ({ signerInfo }) =>
        Boolean(operator?.signerKeyHex && signerInfo?.signerPublicKey) &&
        signerInfo?.signerPublicKey.toLowerCase() !== operator?.signerKeyHex?.toLowerCase(),
    );
    if (sustained(identityMismatchSamples, 3, localSourceFailureWindowMs)) {
      findings.push(
        finding({
          id: "signer-identity-mismatch",
          severity: "critical",
          title: "Signer identity does not match its on-chain registration",
          detail:
            "The signer monitoring public key differs from the signer key registered for this manager.",
          source: "signer",
          classification: "likely-local-signer",
          confidence: "high",
          observations: identityMismatchSamples,
          evidence: [
            {
              code: "monitored-signer-key",
              source: "signer-monitoring",
              status: "supporting",
              observedAt: latest.signerInfoSource?.checkedAt ?? latest.observedAt,
              value: latest.signerInfo?.signerPublicKey ?? null,
              detail: "Signer monitoring reports this runtime public key.",
            },
            {
              code: "registered-signer-key",
              source: "on-chain",
              status: "contradicting",
              observedAt: latest.observedAt,
              value: operator?.signerKeyHex ?? null,
              detail: "The manager registration currently authorizes a different signer key.",
            },
          ],
        }),
      );
    }

    const networkMismatchSamples = consecutiveMatching(
      observations,
      ({ signerInfo }) =>
        Boolean(signerInfo?.network) && signerInfo?.network.toLowerCase() !== config.network,
    );
    if (sustained(networkMismatchSamples, 3, localSourceFailureWindowMs)) {
      findings.push(
        finding({
          id: "signer-network-mismatch",
          severity: "critical",
          title: "Signer is monitoring the wrong network",
          detail: `The signer reports ${latest.signerInfo?.network ?? "an unknown network"}, while Sidekick is connected to ${config.network}.`,
          source: "signer",
          classification: "likely-local-signer",
          confidence: "high",
          observations: networkMismatchSamples,
          evidence: [
            {
              code: "signer-network",
              source: "signer-monitoring",
              status: "supporting",
              observedAt: latest.signerInfoSource?.checkedAt ?? latest.observedAt,
              value: latest.signerInfo?.network ?? null,
              detail: "The signer monitoring endpoint reports a different network.",
            },
            {
              code: "configured-network",
              source: "local-node",
              status: "contradicting",
              observedAt: latest.nodeRpc.checkedAt,
              value: config.network,
              detail: "Sidekick's connected local node is configured for this network.",
            },
          ],
        }),
      );
    }

    const cycleMismatchSamples = consecutiveMatching(
      observations,
      ({ signerMetrics }) =>
        operator !== null &&
        signerMetrics?.rewardCycle !== null &&
        signerMetrics?.rewardCycle !== operator.currentRewardCycle,
    );
    if (sustained(cycleMismatchSamples, 3, localSourceFailureWindowMs)) {
      findings.push(
        finding({
          id: "signer-reward-cycle-mismatch",
          severity: "warning",
          title: "Signer reward cycle is out of sync",
          detail:
            "The signer monitoring cycle does not match the current cycle proved by the local node.",
          source: "signer",
          classification: "likely-local-signer",
          confidence: "high",
          observations: cycleMismatchSamples,
          evidence: [
            {
              code: "signer-reward-cycle",
              source: "signer-monitoring",
              status: "supporting",
              observedAt: latest.signerMetricsSource?.checkedAt ?? latest.observedAt,
              value: latest.signerMetrics?.rewardCycle?.toString() ?? null,
              detail: "Signer monitoring reports this reward cycle.",
            },
            {
              code: "node-reward-cycle",
              source: "on-chain",
              status: "contradicting",
              observedAt: latest.observedAt,
              value: operator?.currentRewardCycle.toString() ?? null,
              detail: "The connected local node proves this current reward cycle.",
            },
          ],
        }),
      );
    }

    const signerLagSamples = consecutiveMatching(
      observations,
      (observation) =>
        observation.signerMetrics?.nodeHeight !== null &&
        observation.signerMetrics?.nodeHeight !== undefined &&
        observation.nodeInfo !== null &&
        observation.nodeInfo.stacks_tip_height - observation.signerMetrics.nodeHeight >=
          signerHeightLagBlocks,
    );
    if (sustained(signerLagSamples, nodeBehindSamples, nodeBehindWindowMs)) {
      findings.push(
        finding({
          id: "signer-node-view-behind",
          severity: "critical",
          title: "Signer is behind the local Stacks node",
          detail:
            "The signer persistently reports a Stacks node height several blocks behind Sidekick's local-node view.",
          source: "signer",
          classification: "likely-local-signer",
          confidence: "high",
          observations: signerLagSamples,
          evidence: [
            {
              code: "signer-node-height-gap",
              source: "signer-monitoring",
              status: "supporting",
              observedAt: latest.signerMetricsSource?.checkedAt ?? latest.observedAt,
              value: String(
                (latest.nodeInfo?.stacks_tip_height ?? 0) - (latest.signerMetrics?.nodeHeight ?? 0),
              ),
              detail: "Signer monitoring remains behind the authoritative local node height.",
            },
          ],
        }),
      );
    }
  }

  if (
    signer15m.proposals !== null &&
    signer15m.proposals >= signerResponseSampleMinimum &&
    signer15m.responseGap !== null &&
    signer15m.responseGap >= signerResponseGapMinimum
  ) {
    findings.push(
      finding({
        id: "signer-proposal-response-gap",
        severity: "critical",
        title: "Signer is not responding to every proposal",
        detail: `${signer15m.responseGap} recently received proposal${signer15m.responseGap === 1 ? " has" : "s have"} no recorded signer response.`,
        source: "signer",
        classification: "likely-local-signer",
        confidence: signer15m.proposals >= signerRateSampleMinimum ? "high" : "medium",
        observations: recent15m,
        evidence: [
          {
            code: "proposal-response-gap",
            source: "signer-monitoring",
            status: "supporting",
            observedAt: latest.signerMetricsSource?.checkedAt ?? latest.observedAt,
            value: String(signer15m.responseGap),
            detail:
              "The proposal counter advanced more than the accepted and rejected response counters.",
          },
        ],
      }),
    );
  }

  if (
    signer15m.accepted !== null &&
    signer15m.rejected !== null &&
    signer15m.accepted + signer15m.rejected >= signerRateSampleMinimum &&
    (signer15m.rejectionPercent ?? 0) >= signerRejectionPercentThreshold
  ) {
    findings.push(
      finding({
        id: "signer-rejection-rate-elevated",
        severity: "warning",
        title: "Signer rejection rate is elevated",
        detail: `${signer15m.rejectionPercent?.toFixed(1)}% of recent signer responses rejected the proposed block. Review signer, node-validation, and network evidence together.`,
        source: "signer",
        classification: "source-disagreement",
        confidence: "medium",
        observations: recent15m,
        evidence: [
          {
            code: "signer-rejection-rate",
            source: "signer-monitoring",
            status: "supporting",
            observedAt: latest.signerMetricsSource?.checkedAt ?? latest.observedAt,
            value: `${signer15m.rejectionPercent?.toFixed(1)}%`,
            detail:
              "Rejections can reflect miner proposals, node validation, or signer policy; this is not attributed to one component without corroboration.",
          },
        ],
      }),
    );
  }

  if (
    signer15m.accepted !== null &&
    signer15m.rejected !== null &&
    signer15m.accepted + signer15m.rejected >= signerRateSampleMinimum &&
    (signer15m.responseP95Seconds ?? 0) > signerResponseP95ThresholdSeconds
  ) {
    findings.push(
      finding({
        id: "signer-response-latency-elevated",
        severity: "warning",
        title: "Signer responses are slower than the target block cadence",
        detail: `The recent signer response p95 is ${signer15m.responseP95Seconds}s, above the five-second Stacks block target.`,
        source: "signer",
        classification: "likely-local-signer",
        confidence: "medium",
        observations: recent15m,
        evidence: [
          {
            code: "signer-response-p95",
            source: "signer-monitoring",
            status: "supporting",
            observedAt: latest.signerMetricsSource?.checkedAt ?? latest.observedAt,
            value: `${signer15m.responseP95Seconds}s`,
            detail:
              "The official signer histogram measures end-to-end time from block timestamp to response broadcast.",
          },
        ],
      }),
    );
  }

  if ((signer15m.disagreements ?? 0) >= agreementConflictThreshold) {
    findings.push(
      finding({
        id: "signer-agreement-conflicts-elevated",
        severity: "warning",
        title: "Signer agreement conflicts are elevated",
        detail: `${signer15m.disagreements} signer agreement conflicts were observed in the recent evidence window.`,
        source: "network",
        classification: "source-disagreement",
        confidence: "medium",
        observations: recent15m,
        evidence: [
          {
            code: "signer-agreement-conflicts",
            source: "signer-monitoring",
            status: "supporting",
            observedAt: latest.signerMetricsSource?.checkedAt ?? latest.observedAt,
            value: String(signer15m.disagreements),
            detail:
              "The signer reports disagreement about burn blocks, Stacks blocks, or miner view; the local metric alone cannot assign network-wide cause.",
          },
        ],
      }),
    );
  }

  return findings;
}

export function buildHealthRollup(observations: readonly HealthObservation[]): HealthRollup | null {
  const first = observations.at(0);
  const last = observations.at(-1);
  if (!first || !last) return null;
  const signerConfigured = observations.some(({ signerInfoSource }) => signerInfoSource !== null);
  let nodeAdvanceCount = 0;
  let previousHeight: number | null = null;
  for (const observation of observations) {
    const height = observation.nodeInfo?.stacks_tip_height ?? null;
    if (height !== null && previousHeight !== null && height > previousHeight)
      nodeAdvanceCount += 1;
    if (height !== null) previousHeight = height;
  }
  const signer = signerWindow(observations);
  return {
    windowStartedAt: first.observedAt,
    windowEndedAt: last.observedAt,
    sampleCount: observations.length,
    nodeRpcAvailabilityPercent:
      (observations.filter(({ nodeRpc }) => nodeRpc.reachable).length / observations.length) * 100,
    signerAvailabilityPercent: signerConfigured
      ? (observations.filter(({ signerInfoSource }) => signerInfoSource?.reachable === true)
          .length /
          observations.length) *
        100
      : null,
    nodeStacksHeightStart: first.nodeInfo?.stacks_tip_height ?? null,
    nodeStacksHeightEnd: last.nodeInfo?.stacks_tip_height ?? null,
    nodeAdvanceCount,
    proposals: signer.proposals,
    accepted: signer.accepted,
    rejected: signer.rejected,
    disagreements: signer.disagreements,
    responseP95Seconds: signer.responseP95Seconds,
  };
}

function diagnosis(
  findings: readonly HealthFinding[],
  observations: readonly HealthObservation[],
  partial: boolean,
): HealthSnapshot["diagnosis"] {
  const latest = observations.at(-1);
  const window = evidenceWindow(windowSince(observations, 15 * 60 * 1_000), 0);
  const priority = [
    "likely-local-node",
    "likely-local-signer",
    "suspected-network-wide",
    "source-disagreement",
    "insufficient-evidence",
  ] as const;
  const current = priority.find((classification) =>
    findings.some((finding) => finding.classification === classification),
  );
  if (findings.length > 0 && current) {
    const strongest = findings.find(({ classification }) => classification === current);
    return {
      status: "needs-attention",
      classification: current,
      confidence: strongest?.confidence ?? "low",
      summary:
        findings.length === 1
          ? (strongest?.detail ?? "Signer health needs attention.")
          : `${findings.length} evidence-backed health findings need attention; the strongest current classification is ${current.replaceAll("-", " ")}.`,
      evidenceWindow: window,
      activeFindingIds: findings.map(({ id }) => id),
    };
  }
  if (!latest?.nodeRpc.reachable) {
    return {
      status: "collecting",
      classification: "insufficient-evidence",
      confidence: "low",
      summary:
        "The latest node check failed, but the sustained failure window is not yet complete.",
      evidenceWindow: window,
      activeFindingIds: [],
    };
  }
  if (observations.length < 3 || partial) {
    return {
      status: "collecting",
      classification: "insufficient-evidence",
      confidence: observations.length < 3 ? "low" : "medium",
      summary: partial
        ? "Core local health is available; optional signer or comparison evidence is incomplete."
        : "Sidekick is collecting the initial signer-health evidence window.",
      evidenceWindow: window,
      activeFindingIds: [],
    };
  }
  return {
    status: "healthy",
    classification: "healthy",
    confidence: "high",
    summary:
      "The configured local node and signer are reachable, aligned, and have no sustained actionable finding.",
    evidenceWindow: window,
    activeFindingIds: [],
  };
}

export function buildHealthSnapshot({
  observations,
  config,
  burnBlockTiming,
  operator,
  history,
}: {
  observations: readonly HealthObservation[];
  config: SidekickConfig;
  burnBlockTiming: BurnBlockTiming | null;
  operator?: HealthOperatorContext | null;
  history?: HealthHistoryInput;
}): HealthSnapshot {
  const latest = observations.at(-1);
  const latestAt = latest?.observedAt ?? new Date().toISOString();
  const last15Minutes = windowSince(observations, 15 * 60 * 1_000);
  const lastHour = windowSince(observations, 60 * 60 * 1_000);
  const nodeRpc = healthSourceState(observations, "nodeRpc", true);
  const nodeMetricsState = healthSourceState(
    observations,
    "nodeMetricsSource",
    Boolean(config.nodeMetricsUrl),
  );
  const hiroState = healthSourceState(
    observations,
    "hiroSource",
    Boolean(config.hiroReferenceApiUrl),
  );
  const configuredApiDistinct =
    !config.hiroReferenceApiUrl || !sameOrigin(config.apiUrl, config.hiroReferenceApiUrl);
  const configuredApiState = healthSourceState(
    observations,
    "configuredApiSource",
    configuredApiDistinct,
  );
  const signerInfoState = healthSourceState(
    observations,
    "signerInfoSource",
    Boolean(config.signerMonitoringUrl),
  );
  const signerHeartbeatState = healthSourceState(
    observations,
    "signerHeartbeat",
    Boolean(config.signerMonitoringUrl),
  );
  const signerMetricsState = healthSourceState(
    observations,
    "signerMetricsSource",
    Boolean(config.signerMonitoringUrl),
  );
  const nodeValues = latest?.nodeMetrics ?? null;
  const signerValues = latest?.signerMetrics ?? null;
  const nodeInfo = latest?.nodeInfo ?? null;
  const nodeHealth = latest?.nodeHealth ?? null;
  const hiro = latest?.hiro ?? null;
  const configuredApi = latest?.configuredApi ?? null;
  const hiroLastTipAdvanceAt = lastHiroTipAdvanceAt(observations);
  const configuredApiLastTipAdvanceAt = lastConfiguredApiTipAdvanceAt(observations);
  const nodeLastTipAdvanceAt = lastTipAdvanceAt(observations);
  const nodeStagnationStartedAt = stagnationStartedAt(
    observations,
    nodeLastTipAdvanceAt,
    (observation) =>
      observation.nodeInfo
        ? {
            checkedAt: observation.nodeRpc.checkedAt,
            height: observation.nodeInfo.stacks_tip_height,
          }
        : null,
  );
  const hiroStagnationStartedAt = stagnationStartedAt(
    observations,
    hiroLastTipAdvanceAt,
    (observation) =>
      observation.hiro && observation.hiroSource
        ? {
            checkedAt: observation.hiroSource.checkedAt,
            height: observation.hiro.chain_tip.block_height,
          }
        : null,
  );
  const configuredApiStagnationStartedAt = stagnationStartedAt(
    observations,
    configuredApiLastTipAdvanceAt,
    (observation) =>
      observation.configuredApi && observation.configuredApiSource
        ? {
            checkedAt: observation.configuredApiSource.checkedAt,
            height: observation.configuredApi.chain_tip.block_height,
          }
        : null,
  );
  const signer15m = signerWindow(last15Minutes);
  const signer1h = signerWindow(lastHour);
  const provisionalFindings = evaluateHealthFindings({
    observations,
    config,
    operator: operator ?? null,
    nodeRpc,
    signerInfo: signerInfoState,
    signerHeartbeat: signerHeartbeatState,
    signerMetrics: signerMetricsState,
    hiro: hiroState,
    configuredApi: configuredApiState,
    nodeLastAdvanceAt: nodeLastTipAdvanceAt,
    nodeStagnationStartedAt,
    hiroLastAdvanceAt: hiroLastTipAdvanceAt,
    hiroStagnationStartedAt,
    configuredApiLastAdvanceAt: configuredApiLastTipAdvanceAt,
    configuredApiStagnationStartedAt,
    signer15m,
  });
  const episodeByFinding = new Map(
    (history?.recentEpisodes ?? [])
      .filter(({ status }) => status === "active")
      .map((episode) => [episode.id, episode]),
  );
  const findings: HealthFinding[] = provisionalFindings.map((value) => {
    const episode = episodeByFinding.get(value.id);
    return {
      ...value,
      episodeId: episode?.episodeId ?? null,
      firstObservedAt: episode?.firstObservedAt ?? value.firstObservedAt,
      lastObservedAt: episode?.lastObservedAt ?? value.lastObservedAt,
    };
  });
  const signerInfo = latest?.signerInfo ?? null;
  const coverageSignals = [
    nodeRpc.status === "healthy",
    nodeInfo?.server_version ?? null,
    nodeInfo?.stacks_tip_height ?? null,
    nodeInfo?.burn_block_height ?? null,
    nodeInfo?.is_fully_synced ?? null,
    nodeHealth?.difference_from_max_peer ?? null,
    nodeValues?.inboundPeers ?? null,
    nodeValues?.outboundPeers ?? null,
    nodeValues?.warningTotal ?? null,
    nodeValues?.errorTotal ?? null,
    hiro?.chain_tip.block_height ?? null,
    configuredApi?.chain_tip.block_height ?? null,
    signerInfo?.version ?? null,
    signerInfo?.network ?? null,
    signerInfo?.signerPublicKey ?? null,
    signerHeartbeatState.status === "healthy",
    signerValues?.nodeHeight ?? null,
    signerValues?.rewardCycle ?? null,
    signerValues?.proposalsTotal ?? null,
    signerValues?.validationAcceptedTotal !== null || signerValues?.validationRejectedTotal !== null
      ? true
      : null,
    signerValues?.acceptedTotal !== null || signerValues?.rejectedTotal !== null ? true : null,
    Object.keys(signerValues?.responseLatencyBuckets ?? {}).length > 0 ? true : null,
    signerValues?.conflictTotal ?? null,
  ];
  const available = coverageSignals.filter(
    (value) => value !== null && value !== undefined && value !== false,
  ).length;
  const configuredFailure = [
    nodeMetricsState,
    hiroState,
    configuredApiState,
    signerInfoState,
    signerHeartbeatState,
    signerMetricsState,
  ].some((source) => source.configured && source.status === "unavailable");
  const partial = !config.nodeMetricsUrl || !config.signerMonitoringUrl || configuredFailure;
  const overallStatus =
    nodeRpc.consecutiveFailures >= localSourceFailureSamples
      ? "unavailable"
      : findings.length > 0
        ? "needs-attention"
        : partial
          ? "partial"
          : "healthy";
  const fallbackRollup = buildHealthRollup(last15Minutes);
  const recentRollups = history?.recentRollups ?? (fallbackRollup ? [fallbackRollup] : []);
  const observationSummary = history ?? {
    observedSince: observations.at(0)?.observedAt ?? null,
    observationCount: observations.length,
    recentRollups,
    recentEpisodes: [],
  };

  return {
    schemaVersion: 2,
    generatedAt: latestAt,
    overallStatus,
    coverage: { available, total: coverageSignals.length },
    diagnosis: diagnosis(findings, observations, partial),
    findings,
    history: {
      sampleIntervalSeconds: 5,
      rawRetentionHours: HEALTH_RAW_RETENTION_HOURS,
      rollupIntervalMinutes: HEALTH_ROLLUP_INTERVAL_MINUTES,
      rollupRetentionDays: HEALTH_ROLLUP_RETENTION_DAYS,
      observedSince: observationSummary.observedSince,
      observationCount: observationSummary.observationCount,
      recentRollups: observationSummary.recentRollups.slice(0, 288),
      recentEpisodes: observationSummary.recentEpisodes.slice(0, 50),
    },
    operator: operator ?? null,
    burnBlockTiming,
    node: {
      rpc: nodeRpc,
      metrics: nodeMetricsState,
      version: nodeInfo?.server_version ?? null,
      networkId: nodeInfo?.network_id ?? null,
      stacksTipHeight: nodeInfo?.stacks_tip_height ?? nodeValues?.stacksTipHeight ?? null,
      burnBlockHeight: nodeInfo?.burn_block_height ?? nodeValues?.burnBlockHeight ?? null,
      isFullySynced: nodeInfo?.is_fully_synced ?? null,
      peerHeightDifference: nodeHealth?.difference_from_max_peer ?? null,
      lastTipAdvanceAt: nodeLastTipAdvanceAt,
      inboundPeers: nodeValues?.inboundPeers ?? null,
      outboundPeers: nodeValues?.outboundPeers ?? null,
      lastHour: {
        warnings: counterIncrease(lastHour, (sample) => sample.nodeMetrics?.warningTotal ?? null),
        errors: counterIncrease(lastHour, (sample) => sample.nodeMetrics?.errorTotal ?? null),
      },
    },
    hiro: {
      source: hiroState,
      stacksTipHeight: hiro?.chain_tip.block_height ?? null,
      burnBlockHeight: hiro?.chain_tip.burn_block_height ?? null,
      localStacksDifference:
        nodeInfo && hiro ? nodeInfo.stacks_tip_height - hiro.chain_tip.block_height : null,
      localBurnDifference:
        nodeInfo && hiro ? nodeInfo.burn_block_height - hiro.chain_tip.burn_block_height : null,
      lastTipAdvanceAt: hiroLastTipAdvanceAt,
      advancementStatus: sourceAdvanceStatus(
        hiroLastTipAdvanceAt,
        hiroStagnationStartedAt,
        latestAt,
      ),
    },
    configuredApi: {
      distinctFromReference: configuredApiDistinct,
      source: configuredApiState,
      stacksTipHeight: configuredApi?.chain_tip.block_height ?? null,
      burnBlockHeight: configuredApi?.chain_tip.burn_block_height ?? null,
      localStacksDifference:
        nodeInfo && configuredApi
          ? nodeInfo.stacks_tip_height - configuredApi.chain_tip.block_height
          : null,
      localBurnDifference:
        nodeInfo && configuredApi
          ? nodeInfo.burn_block_height - configuredApi.chain_tip.burn_block_height
          : null,
      lastTipAdvanceAt: configuredApiLastTipAdvanceAt,
      advancementStatus: sourceAdvanceStatus(
        configuredApiLastTipAdvanceAt,
        configuredApiStagnationStartedAt,
        latestAt,
      ),
    },
    signer: {
      infoSource: signerInfoState,
      heartbeat: signerHeartbeatState,
      metrics: signerMetricsState,
      version: signerInfo?.version ?? null,
      network: signerInfo?.network ?? null,
      publicKey: signerInfo?.signerPublicKey ?? null,
      stxAddress: signerInfo?.stxAddress ?? null,
      observedNodeHeight: signerValues?.nodeHeight ?? null,
      nodeHeightDifference:
        signerValues?.nodeHeight !== null && signerValues?.nodeHeight !== undefined && nodeInfo
          ? signerValues.nodeHeight - nodeInfo.stacks_tip_height
          : null,
      rewardCycle: signerValues?.rewardCycle ?? null,
      stxBalanceUstx: signerValues?.stxBalanceUstx ?? null,
      identityMatchesRegistration:
        operator?.signerKeyHex && signerInfo?.signerPublicKey
          ? operator.signerKeyHex.toLowerCase() === signerInfo.signerPublicKey.toLowerCase()
          : null,
      networkMatchesConfiguration: signerInfo?.network
        ? signerInfo.network.toLowerCase() === config.network
        : null,
      rewardCycleMatchesNode:
        signerValues?.rewardCycle !== null &&
        signerValues?.rewardCycle !== undefined &&
        operator !== null &&
        operator !== undefined
          ? signerValues.rewardCycle === operator.currentRewardCycle
          : null,
      last15Minutes: signer15m,
      lastHour: {
        proposals: signer1h.proposals,
        accepted: signer1h.accepted,
        rejected: signer1h.rejected,
        rejectionPercent: signer1h.rejectionPercent,
        responseP95Seconds: signer1h.responseP95Seconds,
        disagreements: signer1h.disagreements,
        collectingBaseline: signer1h.collectingBaseline,
      },
    },
  };
}
