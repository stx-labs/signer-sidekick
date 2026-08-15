import { z } from "zod";
import type { SidekickConfig } from "./config.js";
import { fetchHealthSource, HealthSourceError } from "./health-http.js";
import type {
  HealthObservation,
  HiroStatus,
  NodeHealth,
  NodeInfo,
  NodeMetricValues,
  SignerInfo,
  SignerMetricValues,
  SourceObservation,
} from "./health-monitoring-types.js";
import {
  type PrometheusSample,
  parsePrometheusText,
  samplesNamed,
  sampleValue,
} from "./prometheus-text.js";

const nodeInfoSchema: z.ZodType<NodeInfo> = z.object({
  server_version: z.string().min(1).optional(),
  network_id: z.number().int(),
  burn_block_height: z.number().int().nonnegative(),
  stacks_tip_height: z.number().int().nonnegative(),
  is_fully_synced: z.boolean().optional(),
});

const nodeHealthSchema: z.ZodType<NodeHealth> = z.object({
  difference_from_max_peer: z.number().int().nonnegative(),
  max_stacks_height_of_neighbors: z.number().int().nonnegative(),
  node_stacks_tip_height: z.number().int().nonnegative(),
});

const hiroStatusSchema: z.ZodType<HiroStatus> = z.object({
  server_version: z.string().optional(),
  status: z.string(),
  chain_tip: z.object({
    block_height: z.number().int().nonnegative(),
    burn_block_height: z.number().int().nonnegative(),
  }),
});

const signerInfoSchema: z.ZodType<SignerInfo> = z.object({
  signerPublicKey: z.string().min(1),
  network: z.string().min(1),
  stxAddress: z.string().min(1),
  version: z.string().min(1),
});

const hiroStatusPath = "/extended";

function endpoint(base: string, path: string): string {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

function sourceFailure(error: unknown, checkedAt: string): SourceObservation {
  return {
    reachable: false,
    latencyMs: null,
    errorCode: error instanceof HealthSourceError ? error.code : "unexpected-content",
    checkedAt,
  };
}

async function readJson<T>(
  url: string,
  schema: z.ZodType<T>,
  checkedAt: string,
): Promise<{
  source: SourceObservation;
  value: T;
}> {
  const response = await fetchHealthSource(url);
  try {
    return {
      source: { reachable: true, latencyMs: response.latencyMs, errorCode: null, checkedAt },
      value: schema.parse(JSON.parse(response.body) as unknown),
    };
  } catch (error) {
    throw new HealthSourceError("unexpected-content", "Health endpoint returned invalid JSON", {
      cause: error,
    });
  }
}

async function readMetrics(
  url: string,
  checkedAt: string,
): Promise<{
  source: SourceObservation;
  samples: PrometheusSample[];
}> {
  const response = await fetchHealthSource(url);
  try {
    return {
      source: { reachable: true, latencyMs: response.latencyMs, errorCode: null, checkedAt },
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
  const histogramBuckets = (metricName: string): Record<string, number> => {
    const result: Record<string, number> = {};
    for (const sample of samplesNamed(samples, metricName)) {
      const upperBound = sample.labels.le;
      if (upperBound) result[upperBound] = (result[upperBound] ?? 0) + sample.value;
    }
    return result;
  };
  const labeledTotals = (metricName: string, label: string): Record<string, number> => {
    const result: Record<string, number> = {};
    for (const sample of samplesNamed(samples, metricName)) {
      const value = sample.labels[label];
      if (value) result[value] = (result[value] ?? 0) + sample.value;
    }
    return result;
  };
  const conflictTotals = labeledTotals("stacks_signer_agreement_state_conflicts", "conflict");
  return {
    nodeHeight: sampleValue(samples, "stacks_signer_stacks_node_height"),
    rewardCycle: sampleValue(samples, "stacks_signer_current_reward_cycle"),
    stxBalanceUstx: sampleValue(samples, "stacks_signer_stx_balance"),
    proposalsTotal: sampleValue(samples, "stacks_signer_block_proposals_received"),
    validationAcceptedTotal: sampleValue(samples, "stacks_signer_block_validation_responses", {
      response_type: "accepted",
    }),
    validationRejectedTotal: sampleValue(samples, "stacks_signer_block_validation_responses", {
      response_type: "rejected",
    }),
    acceptedTotal: sampleValue(samples, "stacks_signer_block_responses_sent", {
      response_type: "accepted",
    }),
    rejectedTotal: sampleValue(samples, "stacks_signer_block_responses_sent", {
      response_type: "rejected",
    }),
    preCommitsTotal: sampleValue(samples, "stacks_signer_block_pre_commits_sent"),
    conflictTotal:
      conflictSamples.length > 0
        ? conflictSamples.reduce((sum, sample) => sum + sample.value, 0)
        : null,
    conflictTotals,
    stateChangeTotals: labeledTotals("stacks_signer_agreement_state_change_reasons", "reason"),
    nodeRpcLatencyBuckets: histogramBuckets(
      "stacks_signer_node_rpc_call_latencies_histogram_bucket",
    ),
    validationLatencyBuckets: histogramBuckets(
      "stacks_signer_block_validation_latencies_histogram_bucket",
    ),
    responseLatencyBuckets: histogramBuckets(
      "stacks_signer_block_response_latencies_histogram_bucket",
    ),
    capitulationLatencyBuckets: histogramBuckets(
      "stacks_signer_agreement_capitulation_latencies_histogram_bucket",
    ),
  };
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
    values.validationAcceptedTotal !== null || values.validationRejectedTotal !== null ? 1 : null,
    values.acceptedTotal !== null || values.rejectedTotal !== null ? 1 : null,
    values.preCommitsTotal,
    Object.keys(values.nodeRpcLatencyBuckets).length > 0 ? 1 : null,
    Object.keys(values.validationLatencyBuckets).length > 0 ? 1 : null,
    Object.keys(values.responseLatencyBuckets).length > 0 ? 1 : null,
    Object.keys(values.capitulationLatencyBuckets).length > 0 ? 1 : null,
    values.conflictTotal,
  ].filter((value) => value !== null).length;
}

export function healthConfigurationFingerprint(config: SidekickConfig): string {
  return JSON.stringify([
    config.network,
    config.nodeRpcUrl,
    config.nodeMetricsUrl ?? null,
    config.signerMonitoringUrl ?? null,
    config.hiroReferenceApiUrl ?? null,
    config.apiUrl,
  ]);
}

export async function testHealthSource(
  kind: "node-metrics" | "signer-monitoring" | "hiro-reference",
  url: string,
): Promise<{ status: "connected"; signals: number }> {
  const checkedAt = new Date().toISOString();
  if (kind === "node-metrics") {
    const result = await readMetrics(url, checkedAt);
    return {
      status: "connected",
      signals: recognizedNodeSignals(nodeMetricValues(result.samples)),
    };
  }
  if (kind === "hiro-reference") {
    await readJson(endpoint(url, hiroStatusPath), hiroStatusSchema, checkedAt);
    return { status: "connected", signals: 2 };
  }
  const [, , metrics] = await Promise.all([
    readJson(endpoint(url, "/info"), signerInfoSchema, checkedAt),
    fetchHealthSource(endpoint(url, "/heartbeat")),
    readMetrics(endpoint(url, "/metrics"), checkedAt),
  ]);
  return {
    status: "connected",
    signals: 5 + recognizedSignerSignals(signerMetricValues(metrics.samples)),
  };
}

export async function collectHealthObservation(
  config: SidekickConfig,
  observedAt: string,
  options: { includeReferences?: boolean; previous?: HealthObservation | null } = {},
): Promise<HealthObservation> {
  const includeReferences = options.includeReferences ?? true;
  const configuredApiDistinct =
    !config.hiroReferenceApiUrl ||
    new URL(config.apiUrl).origin !== new URL(config.hiroReferenceApiUrl).origin;
  const [
    nodeRpc,
    nodeHealth,
    nodeMetrics,
    hiro,
    configuredApi,
    signerInfo,
    signerHeartbeat,
    signerMetrics,
  ] = await Promise.all([
    readJson(endpoint(config.nodeRpcUrl, "/v2/info"), nodeInfoSchema, observedAt).catch(
      (error) => ({
        source: sourceFailure(error, observedAt),
        value: null,
      }),
    ),
    readJson(endpoint(config.nodeRpcUrl, "/v3/health"), nodeHealthSchema, observedAt).catch(() => ({
      source: null,
      value: null,
    })),
    config.nodeMetricsUrl
      ? readMetrics(config.nodeMetricsUrl, observedAt).catch((error) => ({
          source: sourceFailure(error, observedAt),
          samples: null,
        }))
      : null,
    config.hiroReferenceApiUrl && includeReferences
      ? readJson(
          endpoint(config.hiroReferenceApiUrl, hiroStatusPath),
          hiroStatusSchema,
          observedAt,
        ).catch((error) => ({ source: sourceFailure(error, observedAt), value: null }))
      : options.previous?.hiroSource
        ? { source: options.previous.hiroSource, value: options.previous.hiro }
        : null,
    configuredApiDistinct && includeReferences
      ? readJson(endpoint(config.apiUrl, hiroStatusPath), hiroStatusSchema, observedAt).catch(
          (error) => ({ source: sourceFailure(error, observedAt), value: null }),
        )
      : configuredApiDistinct && options.previous?.configuredApiSource
        ? {
            source: options.previous.configuredApiSource,
            value: options.previous.configuredApi,
          }
        : null,
    config.signerMonitoringUrl
      ? readJson(endpoint(config.signerMonitoringUrl, "/info"), signerInfoSchema, observedAt).catch(
          (error) => ({
            source: sourceFailure(error, observedAt),
            value: null,
          }),
        )
      : null,
    config.signerMonitoringUrl
      ? fetchHealthSource(endpoint(config.signerMonitoringUrl, "/heartbeat"))
          .then((response) => ({
            reachable: response.body.trim() === "OK",
            latencyMs: response.latencyMs,
            errorCode: response.body.trim() === "OK" ? null : "unexpected-content",
            checkedAt: observedAt,
          }))
          .catch((error) => sourceFailure(error, observedAt))
      : null,
    config.signerMonitoringUrl
      ? readMetrics(endpoint(config.signerMonitoringUrl, "/metrics"), observedAt).catch(
          (error) => ({
            source: sourceFailure(error, observedAt),
            samples: null,
          }),
        )
      : null,
  ]);

  return {
    observedAt,
    nodeRpc: nodeRpc.source,
    nodeInfo: nodeRpc.value,
    nodeHealth: nodeHealth.value,
    nodeMetricsSource: nodeMetrics?.source ?? null,
    nodeMetrics: nodeMetrics?.samples ? nodeMetricValues(nodeMetrics.samples) : null,
    hiroSource: hiro?.source ?? null,
    hiro: hiro?.value ?? null,
    configuredApiSource: configuredApi?.source ?? null,
    configuredApi: configuredApi?.value ?? null,
    signerInfoSource: signerInfo?.source ?? null,
    signerInfo: signerInfo?.value ?? null,
    signerHeartbeat,
    signerMetricsSource: signerMetrics?.source ?? null,
    signerMetrics: signerMetrics?.samples ? signerMetricValues(signerMetrics.samples) : null,
  };
}
