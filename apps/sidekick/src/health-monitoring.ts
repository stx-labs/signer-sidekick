import { z } from "zod";
import type { BurnBlockPage } from "./chain-clients.js";
import type { SidekickConfig } from "./config.js";
import { fetchHealthSource, HealthSourceError } from "./health-http.js";
import {
  type PrometheusSample,
  parsePrometheusText,
  samplesNamed,
  sampleValue,
} from "./prometheus-text.js";

const nodeInfoSchema = z.object({
  server_version: z.string().min(1).optional(),
  network_id: z.number().int(),
  burn_block_height: z.number().int().nonnegative(),
  stacks_tip_height: z.number().int().nonnegative(),
});

const hiroStatusSchema = z.object({
  server_version: z.string().optional(),
  status: z.string(),
  chain_tip: z.object({
    block_height: z.number().int().nonnegative(),
    burn_block_height: z.number().int().nonnegative(),
  }),
});

const signerInfoSchema = z.object({
  signerPublicKey: z.string().min(1),
  network: z.string().min(1),
  stxAddress: z.string().min(1),
  version: z.string().min(1),
});

export type HealthSourceStatus = "healthy" | "unavailable" | "not-configured";

export interface HealthSourceState {
  configured: boolean;
  status: HealthSourceStatus;
  checkedAt: string | null;
  lastSuccessAt: string | null;
  latencyMs: number | null;
  consecutiveFailures: number;
  errorCode: string | null;
}

interface SourceObservation {
  reachable: boolean;
  latencyMs: number | null;
  errorCode: string | null;
}

interface NodeMetricValues {
  stacksTipHeight: number | null;
  burnBlockHeight: number | null;
  inboundPeers: number | null;
  outboundPeers: number | null;
  warningTotal: number | null;
  errorTotal: number | null;
}

interface SignerMetricValues {
  nodeHeight: number | null;
  rewardCycle: number | null;
  stxBalanceUstx: number | null;
  proposalsTotal: number | null;
  acceptedTotal: number | null;
  rejectedTotal: number | null;
  conflictTotal: number | null;
  responseLatencyBuckets: Record<string, number>;
}

interface HealthObservation {
  observedAt: string;
  nodeRpc: SourceObservation;
  nodeInfo: z.infer<typeof nodeInfoSchema> | null;
  nodeMetricsSource: SourceObservation | null;
  nodeMetrics: NodeMetricValues | null;
  hiroSource: SourceObservation | null;
  hiro: z.infer<typeof hiroStatusSchema> | null;
  signerInfoSource: SourceObservation | null;
  signerInfo: z.infer<typeof signerInfoSchema> | null;
  signerHeartbeat: SourceObservation | null;
  signerMetricsSource: SourceObservation | null;
  signerMetrics: SignerMetricValues | null;
}

export interface HealthFinding {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  source: "node" | "signer";
}

export interface HealthSnapshot {
  generatedAt: string;
  overallStatus: "healthy" | "needs-attention" | "partial" | "unavailable";
  coverage: { available: number; total: number };
  findings: HealthFinding[];
  burnBlockTiming: BurnBlockTiming | null;
  node: {
    rpc: HealthSourceState;
    metrics: HealthSourceState;
    version: string | null;
    networkId: number | null;
    stacksTipHeight: number | null;
    burnBlockHeight: number | null;
    lastTipAdvanceAt: string | null;
    inboundPeers: number | null;
    outboundPeers: number | null;
    lastHour: { warnings: number | null; errors: number | null };
  };
  hiro: {
    source: HealthSourceState;
    stacksTipHeight: number | null;
    burnBlockHeight: number | null;
    localStacksDifference: number | null;
    localBurnDifference: number | null;
  };
  signer: {
    infoSource: HealthSourceState;
    heartbeat: HealthSourceState;
    metrics: HealthSourceState;
    version: string | null;
    network: string | null;
    publicKey: string | null;
    stxAddress: string | null;
    observedNodeHeight: number | null;
    nodeHeightDifference: number | null;
    rewardCycle: number | null;
    stxBalanceUstx: number | null;
    lastHour: {
      proposals: number | null;
      accepted: number | null;
      rejected: number | null;
      rejectionPercent: number | null;
      responseP95Seconds: number | null;
      disagreements: number | null;
      collectingBaseline: boolean;
    };
  };
}

export interface BurnBlockTiming {
  averageSeconds: number;
  windowHours: 12 | 24;
  sampleBlocks: number;
  sampledAt: string;
}

export interface HealthMonitoringOptions {
  getConfig: () => SidekickConfig;
  getBurnBlocks?: () => Promise<BurnBlockPage>;
  now?: () => Date;
  pollIntervalMs?: number;
  historyWindowMs?: number;
}

const burnBlockTimingRefreshMs = 5 * 60 * 1_000;

export function calculateBurnBlockTiming(
  page: Pick<BurnBlockPage, "results">,
): BurnBlockTiming | null {
  const blocks = [...page.results]
    .filter(({ burn_block_time }) => burn_block_time > 0)
    .sort((left, right) => right.burn_block_height - left.burn_block_height)
    .filter(
      (block, index, values) =>
        index === 0 || block.burn_block_height !== values[index - 1]?.burn_block_height,
    );
  const latest = blocks[0];
  if (!latest) return null;

  for (const windowHours of [24, 12] as const) {
    const cutoff = latest.burn_block_time - windowHours * 60 * 60;
    const inWindow = blocks.filter(
      ({ burn_block_time }) =>
        burn_block_time >= cutoff && burn_block_time <= latest.burn_block_time,
    );
    const oldest = inWindow.at(-1);
    if (!oldest) continue;
    const sampleBlocks = latest.burn_block_height - oldest.burn_block_height;
    const elapsedSeconds = latest.burn_block_time - oldest.burn_block_time;
    if (sampleBlocks < 6 || elapsedSeconds < windowHours * 60 * 60 * 0.75) continue;
    const averageSeconds = Math.round(elapsedSeconds / sampleBlocks);
    if (averageSeconds <= 0) continue;
    return {
      averageSeconds,
      windowHours,
      sampleBlocks,
      sampledAt: new Date(latest.burn_block_time * 1_000).toISOString(),
    };
  }
  return null;
}

type SourceKey =
  | "nodeRpc"
  | "nodeMetricsSource"
  | "hiroSource"
  | "signerInfoSource"
  | "signerHeartbeat"
  | "signerMetricsSource";

function endpoint(base: string, path: string): string {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

function sourceFailure(error: unknown): SourceObservation {
  return {
    reachable: false,
    latencyMs: null,
    errorCode: error instanceof HealthSourceError ? error.code : "unexpected-content",
  };
}

async function readJson<T>(
  url: string,
  schema: z.ZodType<T>,
): Promise<{
  source: SourceObservation;
  value: T;
}> {
  const response = await fetchHealthSource(url);
  try {
    return {
      source: { reachable: true, latencyMs: response.latencyMs, errorCode: null },
      value: schema.parse(JSON.parse(response.body) as unknown),
    };
  } catch (error) {
    throw new HealthSourceError("unexpected-content", "Health endpoint returned invalid JSON", {
      cause: error,
    });
  }
}

async function readMetrics(url: string): Promise<{
  source: SourceObservation;
  samples: PrometheusSample[];
}> {
  const response = await fetchHealthSource(url);
  try {
    return {
      source: { reachable: true, latencyMs: response.latencyMs, errorCode: null },
      samples: parsePrometheusText(response.body),
    };
  } catch (error) {
    throw new HealthSourceError(
      "unexpected-content",
      "Health endpoint returned invalid Prometheus exposition",
      { cause: error },
    );
  }
}

function nodeMetricValues(samples: readonly PrometheusSample[]): NodeMetricValues {
  return {
    stacksTipHeight: sampleValue(samples, "stacks_node_stacks_tip_height"),
    burnBlockHeight: sampleValue(samples, "stacks_node_burn_block_height"),
    inboundPeers: sampleValue(samples, "stacks_node_neighbors_inbound"),
    outboundPeers: sampleValue(samples, "stacks_node_neighbors_outbound"),
    warningTotal: sampleValue(samples, "stacks_node_warning_emitted_total"),
    errorTotal: sampleValue(samples, "stacks_node_errors_emitted_total"),
  };
}

function signerMetricValues(samples: readonly PrometheusSample[]): SignerMetricValues {
  const conflictSamples = samplesNamed(samples, "stacks_signer_agreement_state_conflicts");
  const responseLatencyBuckets: Record<string, number> = {};
  for (const sample of samplesNamed(
    samples,
    "stacks_signer_block_response_latencies_histogram_bucket",
  )) {
    const upperBound = sample.labels.le;
    if (upperBound) responseLatencyBuckets[upperBound] = sample.value;
  }
  return {
    nodeHeight: sampleValue(samples, "stacks_signer_stacks_node_height"),
    rewardCycle: sampleValue(samples, "stacks_signer_current_reward_cycle"),
    stxBalanceUstx: sampleValue(samples, "stacks_signer_stx_balance"),
    proposalsTotal: sampleValue(samples, "stacks_signer_block_proposals_received"),
    acceptedTotal: sampleValue(samples, "stacks_signer_block_responses_sent", {
      response_type: "accepted",
    }),
    rejectedTotal: sampleValue(samples, "stacks_signer_block_responses_sent", {
      response_type: "rejected",
    }),
    conflictTotal:
      conflictSamples.length > 0
        ? conflictSamples.reduce((sum, sample) => sum + sample.value, 0)
        : null,
    responseLatencyBuckets,
  };
}

function countConsecutiveFailures(
  observations: readonly HealthObservation[],
  key: SourceKey,
): number {
  let failures = 0;
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const source = observations[index]?.[key];
    if (!source || source.reachable) break;
    failures += 1;
  }
  return failures;
}

function sourceState(
  observations: readonly HealthObservation[],
  key: SourceKey,
  configured: boolean,
): HealthSourceState {
  if (!configured) {
    return {
      configured: false,
      status: "not-configured",
      checkedAt: null,
      lastSuccessAt: null,
      latencyMs: null,
      consecutiveFailures: 0,
      errorCode: null,
    };
  }
  const latest = observations.at(-1);
  const source = latest?.[key] ?? null;
  const lastSuccess = [...observations]
    .reverse()
    .find((observation) => observation[key]?.reachable);
  return {
    configured: true,
    status: source?.reachable ? "healthy" : "unavailable",
    checkedAt: latest?.observedAt ?? null,
    lastSuccessAt: lastSuccess?.observedAt ?? null,
    latencyMs: source?.latencyMs ?? null,
    consecutiveFailures: countConsecutiveFailures(observations, key),
    errorCode: source?.errorCode ?? null,
  };
}

function counterIncrease<T>(
  items: readonly T[],
  select: (item: T) => number | null,
): number | null {
  let previous: number | null = null;
  let increase = 0;
  let transitions = 0;
  for (const item of items) {
    const value = select(item);
    if (value === null) continue;
    if (previous !== null) {
      increase += value >= previous ? value - previous : value;
      transitions += 1;
    }
    previous = value;
  }
  return transitions > 0 ? increase : null;
}

function histogramP95(observations: readonly HealthObservation[]): number | null {
  const bounds = new Set<string>();
  for (const observation of observations) {
    for (const bound of Object.keys(observation.signerMetrics?.responseLatencyBuckets ?? {})) {
      bounds.add(bound);
    }
  }
  const deltas = [...bounds].map((bound) => ({
    bound,
    value: counterIncrease(
      observations,
      (observation) => observation.signerMetrics?.responseLatencyBuckets[bound] ?? null,
    ),
  }));
  const total = deltas.find(({ bound }) => bound === "+Inf")?.value ?? null;
  if (total === null || total < 1) return null;
  const target = total * 0.95;
  for (const bucket of deltas
    .filter(({ bound }) => bound !== "+Inf")
    .sort((left, right) => Number(left.bound) - Number(right.bound))) {
    if (bucket.value !== null && bucket.value >= target) return Number(bucket.bound);
  }
  return null;
}

function lastTipAdvanceAt(observations: readonly HealthObservation[]): string | null {
  let previous: HealthObservation | null = null;
  let lastAdvance: string | null = null;
  for (const observation of observations) {
    if (
      previous?.nodeInfo &&
      observation.nodeInfo &&
      (observation.nodeInfo.stacks_tip_height !== previous.nodeInfo.stacks_tip_height ||
        observation.nodeInfo.burn_block_height !== previous.nodeInfo.burn_block_height)
    ) {
      lastAdvance = observation.observedAt;
    }
    previous = observation;
  }
  return lastAdvance ?? observations.find(({ nodeInfo }) => nodeInfo)?.observedAt ?? null;
}

function recognizedNodeSignals(values: NodeMetricValues): number {
  return Object.values(values).filter((value) => value !== null).length;
}

function recognizedSignerSignals(values: SignerMetricValues): number {
  return [
    values.nodeHeight,
    values.rewardCycle,
    values.stxBalanceUstx,
    values.proposalsTotal,
    values.acceptedTotal !== null || values.rejectedTotal !== null ? 1 : null,
    Object.keys(values.responseLatencyBuckets).length > 0 ? 1 : null,
    values.conflictTotal,
  ].filter((value) => value !== null).length;
}

export class HealthMonitoringService {
  private observations: HealthObservation[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<HealthSnapshot> | null = null;
  private burnBlockTiming: BurnBlockTiming | null = null;
  private burnBlockTimingAttemptedAt = 0;
  private configFingerprint: string | null = null;

  constructor(private readonly options: HealthMonitoringOptions) {}

  start(): void {
    if (this.interval) return;
    void this.refresh();
    this.interval = setInterval(() => void this.refresh(), this.options.pollIntervalMs ?? 30_000);
    this.interval.unref?.();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  async current(): Promise<HealthSnapshot> {
    return this.observations.length > 0 ? this.buildSnapshot() : this.refresh();
  }

  async refresh(): Promise<HealthSnapshot> {
    this.refreshing ??= this.collect()
      .then(() => this.buildSnapshot())
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  async testSource(
    kind: "node-metrics" | "signer-monitoring" | "hiro-reference",
    url: string,
  ): Promise<{ status: "connected"; signals: number }> {
    if (kind === "node-metrics") {
      const result = await readMetrics(url);
      return {
        status: "connected",
        signals: recognizedNodeSignals(nodeMetricValues(result.samples)),
      };
    }
    if (kind === "hiro-reference") {
      await readJson(endpoint(url, "/extended/v1/status"), hiroStatusSchema);
      return { status: "connected", signals: 2 };
    }
    const [, , metrics] = await Promise.all([
      readJson(endpoint(url, "/info"), signerInfoSchema),
      fetchHealthSource(endpoint(url, "/heartbeat")),
      readMetrics(endpoint(url, "/metrics")),
    ]);
    return {
      status: "connected",
      signals: 5 + recognizedSignerSignals(signerMetricValues(metrics.samples)),
    };
  }

  private async collect(): Promise<void> {
    const config = this.options.getConfig();
    const configFingerprint = JSON.stringify([
      config.nodeRpcUrl,
      config.nodeMetricsUrl ?? null,
      config.signerMonitoringUrl ?? null,
      config.hiroReferenceApiUrl ?? null,
      config.apiUrl,
    ]);
    if (this.configFingerprint !== null && this.configFingerprint !== configFingerprint) {
      this.observations = [];
      this.burnBlockTiming = null;
      this.burnBlockTimingAttemptedAt = 0;
    }
    this.configFingerprint = configFingerprint;
    const observedAt = (this.options.now ?? (() => new Date()))().toISOString();
    const observedAtMs = Date.parse(observedAt);
    const shouldRefreshBurnTiming =
      Boolean(this.options.getBurnBlocks) &&
      observedAtMs - this.burnBlockTimingAttemptedAt >= burnBlockTimingRefreshMs;
    if (shouldRefreshBurnTiming) this.burnBlockTimingAttemptedAt = observedAtMs;
    const [nodeRpc, nodeMetrics, hiro, signerInfo, signerHeartbeat, signerMetrics, burnBlocks] =
      await Promise.all([
        readJson(endpoint(config.nodeRpcUrl, "/v2/info"), nodeInfoSchema).catch((error) => ({
          source: sourceFailure(error),
          value: null,
        })),
        config.nodeMetricsUrl
          ? readMetrics(config.nodeMetricsUrl).catch((error) => ({
              source: sourceFailure(error),
              samples: null,
            }))
          : null,
        config.hiroReferenceApiUrl
          ? readJson(
              endpoint(config.hiroReferenceApiUrl, "/extended/v1/status"),
              hiroStatusSchema,
            ).catch((error) => ({ source: sourceFailure(error), value: null }))
          : null,
        config.signerMonitoringUrl
          ? readJson(endpoint(config.signerMonitoringUrl, "/info"), signerInfoSchema).catch(
              (error) => ({ source: sourceFailure(error), value: null }),
            )
          : null,
        config.signerMonitoringUrl
          ? fetchHealthSource(endpoint(config.signerMonitoringUrl, "/heartbeat"))
              .then((response) => ({
                reachable: response.body.trim() === "OK",
                latencyMs: response.latencyMs,
                errorCode: response.body.trim() === "OK" ? null : "unexpected-content",
              }))
              .catch(sourceFailure)
          : null,
        config.signerMonitoringUrl
          ? readMetrics(endpoint(config.signerMonitoringUrl, "/metrics")).catch((error) => ({
              source: sourceFailure(error),
              samples: null,
            }))
          : null,
        shouldRefreshBurnTiming
          ? this.options.getBurnBlocks?.().catch(() => null)
          : Promise.resolve(undefined),
      ]);

    if (burnBlocks) this.burnBlockTiming = calculateBurnBlockTiming(burnBlocks);

    this.observations.push({
      observedAt,
      nodeRpc: nodeRpc.source,
      nodeInfo: nodeRpc.value,
      nodeMetricsSource: nodeMetrics?.source ?? null,
      nodeMetrics: nodeMetrics?.samples ? nodeMetricValues(nodeMetrics.samples) : null,
      hiroSource: hiro?.source ?? null,
      hiro: hiro?.value ?? null,
      signerInfoSource: signerInfo?.source ?? null,
      signerInfo: signerInfo?.value ?? null,
      signerHeartbeat,
      signerMetricsSource: signerMetrics?.source ?? null,
      signerMetrics: signerMetrics?.samples ? signerMetricValues(signerMetrics.samples) : null,
    });
    const cutoff = Date.parse(observedAt) - (this.options.historyWindowMs ?? 2 * 60 * 60 * 1_000);
    this.observations = this.observations.filter(
      (observation) => Date.parse(observation.observedAt) >= cutoff,
    );
  }

  private buildSnapshot(): HealthSnapshot {
    const config = this.options.getConfig();
    const latest = this.observations.at(-1);
    const oneHourCutoff =
      Date.parse(latest?.observedAt ?? new Date().toISOString()) - 60 * 60 * 1_000;
    const lastHour = this.observations.filter(
      (observation) => Date.parse(observation.observedAt) >= oneHourCutoff,
    );
    const nodeRpc = sourceState(this.observations, "nodeRpc", true);
    const nodeMetricsState = sourceState(
      this.observations,
      "nodeMetricsSource",
      Boolean(config.nodeMetricsUrl),
    );
    const hiroState = sourceState(
      this.observations,
      "hiroSource",
      Boolean(config.hiroReferenceApiUrl),
    );
    const signerInfoState = sourceState(
      this.observations,
      "signerInfoSource",
      Boolean(config.signerMonitoringUrl),
    );
    const signerHeartbeatState = sourceState(
      this.observations,
      "signerHeartbeat",
      Boolean(config.signerMonitoringUrl),
    );
    const signerMetricsState = sourceState(
      this.observations,
      "signerMetricsSource",
      Boolean(config.signerMonitoringUrl),
    );
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
    if (signerInfoState.consecutiveFailures >= 3) {
      findings.push({
        id: "signer-monitoring-unavailable",
        severity: "critical",
        title: "Signer monitoring is unavailable",
        detail:
          "Sidekick could not reach the configured signer monitoring server for three checks.",
        source: "signer",
      });
    }
    if (signerHeartbeatState.consecutiveFailures >= 3) {
      findings.push({
        id: "signer-node-heartbeat-failed",
        severity: "critical",
        title: "Signer cannot reach its Stacks node",
        detail: "The signer heartbeat failed its node connection check three consecutive times.",
        source: "signer",
      });
    }

    const nodeValues = latest?.nodeMetrics ?? null;
    const signerValues = latest?.signerMetrics ?? null;
    const nodeInfo = latest?.nodeInfo ?? null;
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
      burnBlockTiming: this.burnBlockTiming,
      node: {
        rpc: nodeRpc,
        metrics: nodeMetricsState,
        version: nodeInfo?.server_version ?? null,
        networkId: nodeInfo?.network_id ?? null,
        stacksTipHeight: nodeInfo?.stacks_tip_height ?? nodeValues?.stacksTipHeight ?? null,
        burnBlockHeight: nodeInfo?.burn_block_height ?? nodeValues?.burnBlockHeight ?? null,
        lastTipAdvanceAt: lastTipAdvanceAt(this.observations),
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
}
