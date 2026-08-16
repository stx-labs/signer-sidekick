import type { HealthSnapshot } from "@stx-labs/signer-sidekick-api-contracts";
import type { SidekickConfig } from "./config.js";
import {
  HEALTH_RULE_THRESHOLDS,
  HEALTH_RULES,
  HEALTH_WINDOWS,
  type HealthRuleDefinition,
} from "./health-monitoring-rules.js";
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

type FindingInput = Omit<HealthFinding, "episodeId">;

// Latency measurements are interpolated within histogram buckets, so render them to a single
// decimal (e.g. "4.8s") rather than exposing raw floating-point noise. Returns null passthrough so
// callers can keep a not-measured value distinct from a real zero.
function formatSeconds(value: number | null): string | null {
  return value === null ? null : `${value.toFixed(1)}s`;
}

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

function signerHeightUpdates(observations: readonly HealthObservation[]): HealthObservation[] {
  const updates: HealthObservation[] = [];
  let previousHeight: number | null = null;
  for (const observation of observations) {
    const height = observation.signerMetrics?.nodeHeight ?? null;
    if (height === null || height === previousHeight) continue;
    updates.push(observation);
    previousHeight = height;
  }
  return updates;
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
  value: Omit<
    FindingInput,
    "id" | "severity" | "firstObservedAt" | "lastObservedAt" | "evidenceWindow"
  > & {
    rule: HealthRuleDefinition;
    observations: readonly HealthObservation[];
  },
): FindingInput {
  const firstObservedAt = value.observations.at(0)?.observedAt ?? new Date(0).toISOString();
  const lastObservedAt = value.observations.at(-1)?.observedAt ?? firstObservedAt;
  const distinctSources = new Set(value.evidence.map(({ source }) => source)).size;
  const { observations: _observations, rule, ...findingValue } = value;
  return {
    id: rule.id,
    severity: rule.defaultSeverity,
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
  // This is a conservative lower bound: compare proposals old enough to have been answered with all
  // responses in the window. Aggregate counters cannot correlate a response to a specific proposal,
  // but allowing every response to account for an older proposal prevents normal in-flight work from
  // creating a false gap.
  // A just-received proposal legitimately has no response yet. The settle window belongs to the
  // proposal/response-gap rule catalog so the calculation and operator-facing rule cannot drift.
  const settleCutoff = Date.parse(latest) - HEALTH_RULE_THRESHOLDS.proposalResponseGap.settleMs;
  const settledProposals = counterIncrease(
    observations.filter((observation) => Date.parse(observation.observedAt) <= settleCutoff),
    (sample) => sample.signerMetrics?.proposalsTotal ?? null,
  );
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
      settledProposals !== null && responses !== null
        ? Math.max(0, settledProposals - responses)
        : null,
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
    HEALTH_WINDOWS.networkAdvancementMs
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
  const recent15m = windowSince(observations, HEALTH_WINDOWS.recentSignerMs);
  const {
    localEndpointFailure,
    nodeBehindPeers,
    localNodeStall,
    networkStall,
    comparisonSourceLag,
    signerConfigurationMismatch,
    signerNodeViewLag,
    proposalResponseGap,
    rejectionRate,
    validationLatency,
    agreementConflicts,
  } = HEALTH_RULE_THRESHOLDS;

  // Availability rules: these answer whether Sidekick still has the local first-person evidence
  // needed for diagnosis. Repeated failures are required so one timeout never opens an incident.

  const nodeFailures = consecutiveMatching(observations, ({ nodeRpc }) => !nodeRpc.reachable);
  if (
    nodeRpc.consecutiveFailures >= localEndpointFailure.minimumSamples &&
    sustained(
      nodeFailures,
      localEndpointFailure.minimumSamples,
      localEndpointFailure.minimumWindowMs,
    )
  ) {
    findings.push(
      finding({
        rule: HEALTH_RULES.nodeRpcUnavailable,
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
    signerInfo.consecutiveFailures >= localEndpointFailure.minimumSamples &&
    sustained(
      signerInfoFailures,
      localEndpointFailure.minimumSamples,
      localEndpointFailure.minimumWindowMs,
    )
  ) {
    findings.push(
      finding({
        rule: HEALTH_RULES.signerMonitoringUnavailable,
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
    signerHeartbeat.consecutiveFailures >= localEndpointFailure.minimumSamples &&
    sustained(
      heartbeatFailures,
      localEndpointFailure.minimumSamples,
      localEndpointFailure.minimumWindowMs,
    )
  ) {
    findings.push(
      finding({
        rule: HEALTH_RULES.signerNodeHeartbeatFailed,
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
    signerMetrics.consecutiveFailures >= localEndpointFailure.minimumSamples &&
    sustained(
      signerMetricFailures,
      localEndpointFailure.minimumSamples,
      localEndpointFailure.minimumWindowMs,
    ) &&
    !findings.some(({ id }) => id === HEALTH_RULES.signerMonitoringUnavailable.id)
  ) {
    findings.push(
      finding({
        rule: HEALTH_RULES.signerMetricsUnavailable,
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

  // Local-chain rules: local node and peer evidence is authoritative. Public APIs may corroborate
  // a stall but can never make an advancing local node unhealthy.
  const behindSamples = consecutiveMatching(
    observations,
    (observation) =>
      observation.nodeInfo?.is_fully_synced === false ||
      (observation.nodeHealth?.difference_from_max_peer ?? 0) >= nodeBehindPeers.lagBlocks,
  );
  if (sustained(behindSamples, nodeBehindPeers.minimumSamples, nodeBehindPeers.minimumWindowMs)) {
    findings.push(
      finding({
        rule: HEALTH_RULES.nodeBehindNetwork,
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
    latestAt - Date.parse(hiroLastAdvanceAt) <= HEALTH_WINDOWS.networkAdvancementMs;
  const configuredApiAdvancing =
    configuredApi.status === "healthy" &&
    configuredApiLastAdvanceAt !== null &&
    latestAt - Date.parse(configuredApiLastAdvanceAt) <= HEALTH_WINDOWS.networkAdvancementMs;
  const peersAhead = (latest.nodeHealth?.difference_from_max_peer ?? 0) > 0;
  if (
    nodeStallAge !== null &&
    nodeStallAge >= localNodeStall.minimumWindowMs &&
    (peersAhead || hiroAdvancing || configuredApiAdvancing) &&
    !findings.some(
      ({ id }) =>
        id === HEALTH_RULES.nodeRpcUnavailable.id || id === HEALTH_RULES.nodeBehindNetwork.id,
    )
  ) {
    const corroborating =
      Number(peersAhead) + Number(hiroAdvancing) + Number(configuredApiAdvancing);
    findings.push(
      finding({
        rule: HEALTH_RULES.nodeTipStalledLocally,
        title: "Local Stacks tip stopped advancing",
        detail:
          "The local node stopped advancing while at least one independent source observed newer chain progress.",
        source: "node",
        classification: "likely-local-node",
        confidence: corroborating >= 2 ? "high" : "medium",
        observations: windowSince(observations, localNodeStall.minimumWindowMs),
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
  const peerViewAligned = sustained(peerViewAlignedSamples, 2, networkStall.minimumWindowMs);
  const peerViewAlignedStartedAt = peerViewAlignedSamples.at(0)?.observedAt ?? null;
  const hiroStalled =
    hiro.status === "healthy" &&
    hiroStagnationStartedAt !== null &&
    latestAt - Date.parse(hiroStagnationStartedAt) >= networkStall.minimumWindowMs;
  const configuredApiStalled =
    configuredApi.status === "healthy" &&
    configuredApiStagnationStartedAt !== null &&
    latestAt - Date.parse(configuredApiStagnationStartedAt) >= networkStall.minimumWindowMs;
  const networkCorroboration =
    Number(peerViewAligned) + Number(hiroStalled) + Number(configuredApiStalled);
  if (
    nodeStallAge !== null &&
    nodeStallAge >= networkStall.minimumWindowMs &&
    networkCorroboration >= networkStall.minimumIndependentSignals &&
    !findings.some(({ classification }) => classification === "likely-local-node")
  ) {
    findings.push(
      finding({
        rule: HEALTH_RULES.networkTipStalled,
        title: "Stacks network may be stalled",
        detail:
          "The local node and at least two distinct comparison signals show no recent Stacks tip advancement.",
        source: "network",
        classification: "suspected-network-wide",
        confidence: networkCorroboration >= 3 ? "high" : "medium",
        observations: windowSince(observations, networkStall.minimumWindowMs),
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
      rule: HEALTH_RULES.referenceApiBehindLocalNode,
      source: hiro,
      value: latest.hiro,
      stagnationStartedAt: hiroStagnationStartedAt,
      evidenceSource: "reference-api" as const,
    },
    {
      rule: HEALTH_RULES.configuredApiBehindLocalNode,
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
      latest.nodeInfo.stacks_tip_height - value.chain_tip.block_height >=
        comparisonSourceLag.lagBlocks &&
      stagnationStartedAt !== null &&
      latestAt - Date.parse(stagnationStartedAt) >= comparisonSourceLag.minimumWindowMs,
  );
  if (sourceLag && nodeStallAge !== null && nodeStallAge < HEALTH_WINDOWS.networkAdvancementMs) {
    findings.push(
      finding({
        rule: sourceLag.rule,
        title: "A comparison source is behind the local node",
        detail:
          "The local node is advancing, but a configured comparison source remains several Stacks blocks behind.",
        source: "source",
        classification: "source-disagreement",
        confidence: "high",
        observations: windowSince(observations, comparisonSourceLag.minimumWindowMs),
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

  // Signer-configuration rules compare the running process with node-proved operator context. The
  // public API is intentionally absent from these identity and participation decisions.
  if (config.signerMonitoringUrl) {
    const identityMismatchSamples = consecutiveMatching(
      observations,
      ({ signerInfo }) =>
        Boolean(operator?.signerKeyHex && signerInfo?.signerPublicKey) &&
        signerInfo?.signerPublicKey.toLowerCase() !== operator?.signerKeyHex?.toLowerCase(),
    );
    if (
      sustained(
        identityMismatchSamples,
        signerConfigurationMismatch.minimumSamples,
        signerConfigurationMismatch.minimumWindowMs,
      )
    ) {
      findings.push(
        finding({
          rule: HEALTH_RULES.signerIdentityMismatch,
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
    if (
      sustained(
        networkMismatchSamples,
        signerConfigurationMismatch.minimumSamples,
        signerConfigurationMismatch.minimumWindowMs,
      )
    ) {
      findings.push(
        finding({
          rule: HEALTH_RULES.signerNetworkMismatch,
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
    if (
      sustained(
        cycleMismatchSamples,
        signerConfigurationMismatch.minimumSamples,
        signerConfigurationMismatch.minimumWindowMs,
      )
    ) {
      findings.push(
        finding({
          rule: HEALTH_RULES.signerRewardCycleMismatch,
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

    const heightUpdates = signerHeightUpdates(observations);
    let healthyUpdateCount = 0;
    for (let index = heightUpdates.length - 1; index >= 0; index -= 1) {
      const observation = heightUpdates[index];
      if (
        !observation?.nodeInfo ||
        observation.signerMetrics?.nodeHeight === null ||
        observation.signerMetrics?.nodeHeight === undefined ||
        observation.nodeInfo.stacks_tip_height - observation.signerMetrics.nodeHeight >=
          signerNodeViewLag.lagBlocks
      ) {
        break;
      }
      healthyUpdateCount += 1;
    }
    const lagEvaluationUpdates =
      healthyUpdateCount >= signerNodeViewLag.recoveryUpdates
        ? []
        : heightUpdates.slice(0, heightUpdates.length - healthyUpdateCount);
    const signerLagSamples = consecutiveMatching(
      lagEvaluationUpdates,
      (observation) =>
        observation.signerMetrics?.nodeHeight !== null &&
        observation.signerMetrics?.nodeHeight !== undefined &&
        observation.nodeInfo !== null &&
        observation.nodeInfo.stacks_tip_height - observation.signerMetrics.nodeHeight >=
          signerNodeViewLag.lagBlocks,
    );
    if (
      sustained(
        signerLagSamples,
        signerNodeViewLag.minimumUpdates,
        signerNodeViewLag.minimumWindowMs,
      )
    ) {
      const findingSamples = [
        ...signerLagSamples,
        ...heightUpdates.slice(heightUpdates.length - healthyUpdateCount),
      ];
      findings.push(
        finding({
          rule: HEALTH_RULES.signerNodeViewBehind,
          title: "Signer is behind the local Stacks node",
          detail:
            "The signer persistently reports a Stacks node height several blocks behind Sidekick's local-node view.",
          source: "signer",
          classification: "likely-local-signer",
          confidence: "high",
          observations: findingSamples,
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

  // Participation rules use first-person signer counters. End-to-end response latency is retained
  // in the snapshot for troubleshooting but deliberately does not open a finding: Stacks Signer
  // derives it from the block header wall-clock timestamp, which is not a trustworthy local alert
  // boundary. Successful validation latency is eligible because the Stacks node reports that
  // duration directly.
  //
  // signer15m.responseGap is a conservative lower bound after the settle window, so it will not
  // read normal in-flight responses as a gap.
  if (
    signer15m.proposals !== null &&
    signer15m.proposals >= proposalResponseGap.minimumProposals &&
    signer15m.responseGap !== null &&
    signer15m.responseGap >= proposalResponseGap.minimumGap
  ) {
    findings.push(
      finding({
        rule: HEALTH_RULES.signerProposalResponseGap,
        title: "Signer is not responding to every proposal",
        detail: `At least ${signer15m.responseGap} proposal${signer15m.responseGap === 1 ? " is" : "s are"} not accounted for by the response counters after a ${Math.round(proposalResponseGap.settleMs / 1_000)}-second settling window.`,
        source: "signer",
        classification: "likely-local-signer",
        confidence:
          signer15m.proposals >= proposalResponseGap.highConfidenceResponses ? "high" : "medium",
        observations: recent15m,
        evidence: [
          {
            code: "proposal-response-gap",
            source: "signer-monitoring",
            status: "supporting",
            observedAt: latest.signerMetricsSource?.checkedAt ?? latest.observedAt,
            value: String(signer15m.responseGap),
            detail:
              "The settled proposal count advanced more than all accepted and rejected response counters in the same observation window.",
          },
        ],
      }),
    );
  }

  if (
    signer15m.accepted !== null &&
    signer15m.rejected !== null &&
    signer15m.accepted + signer15m.rejected >= rejectionRate.minimumResponses &&
    (signer15m.rejectionPercent ?? 0) >= rejectionRate.percent
  ) {
    findings.push(
      finding({
        rule: HEALTH_RULES.signerRejectionRateElevated,
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
    signer15m.validationAccepted !== null &&
    signer15m.validationAccepted >= validationLatency.minimumAcceptedValidations &&
    (signer15m.validationP95Seconds ?? 0) > validationLatency.p95Seconds
  ) {
    const nodeRpcSlow = (signer15m.nodeRpcP95Seconds ?? 0) > validationLatency.p95Seconds;
    findings.push(
      finding({
        rule: HEALTH_RULES.signerValidationLatencyElevated,
        title: "Local node block validation is slow",
        detail: `The local Stacks node reported a recent successful-validation p95 of ${formatSeconds(signer15m.validationP95Seconds)} across ${signer15m.validationAccepted} validations.`,
        source: "node",
        classification: "likely-local-node",
        confidence: nodeRpcSlow ? "high" : "medium",
        observations: recent15m,
        evidence: [
          {
            code: "signer-validation-p95",
            source: "signer-monitoring",
            status: "supporting",
            observedAt: latest.signerMetricsSource?.checkedAt ?? latest.observedAt,
            value: formatSeconds(signer15m.validationP95Seconds),
            detail:
              "The signer records validation_time_ms reported by the local Stacks node for successful block validation responses.",
          },
          {
            code: "signer-node-rpc-p95",
            source: "signer-monitoring",
            status: nodeRpcSlow ? "supporting" : "contradicting",
            observedAt: latest.signerMetricsSource?.checkedAt ?? latest.observedAt,
            value: formatSeconds(signer15m.nodeRpcP95Seconds),
            detail: nodeRpcSlow
              ? "General signer-to-node RPC latency is also elevated, strengthening the local-node diagnosis."
              : "General signer-to-node RPC latency is not elevated; the finding is limited to node-reported block validation.",
          },
        ],
      }),
    );
  }

  if ((signer15m.disagreements ?? 0) >= agreementConflicts.minimumConflicts) {
    findings.push(
      finding({
        rule: HEALTH_RULES.signerAgreementConflictsElevated,
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
    validationP95Seconds: signer.validationP95Seconds,
  };
}

function diagnosis(
  findings: readonly HealthFinding[],
  observations: readonly HealthObservation[],
  partial: boolean,
): HealthSnapshot["diagnosis"] {
  const latest = observations.at(-1);
  const window = evidenceWindow(
    windowSince(observations, 15 * 60 * 1_000),
    new Set(findings.flatMap(({ evidence }) => evidence.map(({ source }) => source))).size,
  );
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
    const actionable = findings.some(({ severity }) => severity !== "info");
    return {
      status: actionable ? "needs-attention" : "monitoring",
      classification: current,
      confidence: strongest?.confidence ?? "low",
      title: strongest?.title ?? "Signer health finding",
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
      title: "Local node check is not yet conclusive",
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
      title: partial ? "Some health evidence is incomplete" : "Collecting signer-health evidence",
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
    title: "Signer is operating as expected",
    summary: "The signer and local node are connected and aligned.",
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
    nodeRpc.consecutiveFailures >= HEALTH_RULE_THRESHOLDS.localEndpointFailure.minimumSamples
      ? "unavailable"
      : findings.some(({ severity }) => severity !== "info")
        ? "needs-attention"
        : findings.length > 0
          ? "monitoring"
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
        validationP95Seconds: signer1h.validationP95Seconds,
        disagreements: signer1h.disagreements,
        collectingBaseline: signer1h.collectingBaseline,
      },
    },
  };
}
