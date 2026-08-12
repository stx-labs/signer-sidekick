import type { SidekickConfig } from "./config.js";
import {
  counterIncrease,
  healthSourceState,
  histogramP95,
  lastTipAdvanceAt,
} from "./health-monitoring-state.js";
import type {
  BurnBlockTiming,
  HealthFinding,
  HealthObservation,
  HealthSnapshot,
  HealthSourceState,
} from "./health-monitoring-types.js";

function evaluateHealthFindings(
  nodeRpc: HealthSourceState,
  signerInfo: HealthSourceState,
  signerHeartbeat: HealthSourceState,
  nodeInfo: HealthObservation["nodeInfo"],
  nodeHealth: HealthObservation["nodeHealth"],
): HealthFinding[] {
  const findings: HealthFinding[] = [];
  if (nodeRpc.consecutiveFailures >= 3) {
    findings.push({
      id: "node-rpc-unavailable",
      severity: "critical",
      title: "Stacks node is unavailable",
      detail: "Sidekick could not reach the configured node RPC for three consecutive checks.",
      source: "node",
    });
  }
  if (signerInfo.consecutiveFailures >= 3) {
    findings.push({
      id: "signer-monitoring-unavailable",
      severity: "critical",
      title: "Signer monitoring is unavailable",
      detail: "Sidekick could not reach the configured signer monitoring server for three checks.",
      source: "signer",
    });
  }
  if (signerHeartbeat.consecutiveFailures >= 3) {
    findings.push({
      id: "signer-node-heartbeat-failed",
      severity: "critical",
      title: "Signer cannot reach its Stacks node",
      detail: "The signer heartbeat failed its node connection check three consecutive times.",
      source: "signer",
    });
  }
  if (nodeInfo?.is_fully_synced === false || (nodeHealth?.difference_from_max_peer ?? 0) > 0) {
    findings.push({
      id: "node-behind-network",
      severity: "critical",
      title: "Stacks node is behind the network",
      detail:
        nodeInfo?.is_fully_synced === false
          ? "The local node reports that it is not fully synchronized."
          : `The local node is ${nodeHealth?.difference_from_max_peer ?? 0} Stacks blocks behind its observed peers.`,
      source: "node",
    });
  }
  return findings;
}

export function buildHealthSnapshot({
  observations,
  config,
  burnBlockTiming,
}: {
  observations: readonly HealthObservation[];
  config: SidekickConfig;
  burnBlockTiming: BurnBlockTiming | null;
}): HealthSnapshot {
  const latest = observations.at(-1);
  const oneHourCutoff =
    Date.parse(latest?.observedAt ?? new Date().toISOString()) - 60 * 60 * 1_000;
  const lastHour = observations.filter(
    (observation) => Date.parse(observation.observedAt) >= oneHourCutoff,
  );
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
  const findings = evaluateHealthFindings(
    nodeRpc,
    signerInfoState,
    signerHeartbeatState,
    nodeInfo,
    nodeHealth,
  );
  const hiro = latest?.hiro ?? null;
  const signerInfo = latest?.signerInfo ?? null;
  const proposals = counterIncrease(
    lastHour,
    (sample) => sample.signerMetrics?.proposalsTotal ?? null,
  );
  const accepted = counterIncrease(
    lastHour,
    (sample) => sample.signerMetrics?.acceptedTotal ?? null,
  );
  const rejected = counterIncrease(
    lastHour,
    (sample) => sample.signerMetrics?.rejectedTotal ?? null,
  );
  const responses = accepted !== null && rejected !== null ? accepted + rejected : null;

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
    hiro?.chain_tip.burn_block_height ?? null,
    signerInfo?.version ?? null,
    signerInfo?.network ?? null,
    signerInfo?.signerPublicKey ?? null,
    signerInfo?.stxAddress ?? null,
    signerHeartbeatState.status === "healthy",
    signerValues?.nodeHeight ?? null,
    signerValues?.rewardCycle ?? null,
    signerValues?.stxBalanceUstx ?? null,
    signerValues?.proposalsTotal ?? null,
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
    signerInfoState,
    signerHeartbeatState,
    signerMetricsState,
  ].some((source) => source.configured && source.status === "unavailable");
  const partial = !config.nodeMetricsUrl || !config.signerMonitoringUrl;
  const overallStatus =
    nodeRpc.consecutiveFailures >= 3
      ? "unavailable"
      : findings.length > 0 || configuredFailure
        ? "needs-attention"
        : partial
          ? "partial"
          : "healthy";

  return {
    generatedAt: latest?.observedAt ?? new Date().toISOString(),
    overallStatus,
    coverage: { available, total: coverageSignals.length },
    findings,
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
      lastTipAdvanceAt: lastTipAdvanceAt(observations),
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
      lastHour: {
        proposals,
        accepted,
        rejected,
        rejectionPercent:
          responses !== null && responses > 0 && rejected !== null
            ? (rejected / responses) * 100
            : null,
        responseP95Seconds: histogramP95(lastHour),
        disagreements: counterIncrease(
          lastHour,
          (sample) => sample.signerMetrics?.conflictTotal ?? null,
        ),
        collectingBaseline: lastHour.length < 2,
      },
    },
  };
}
