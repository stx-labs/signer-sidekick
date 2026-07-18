import { z } from "zod";
import type { SidekickConfig } from "./config.js";
import { fetchHealthSource, HealthSourceError } from "./health-http.js";
import type {
  HealthObservation,
  HiroStatus,
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

export function healthConfigurationFingerprint(config: SidekickConfig): string {
  return JSON.stringify([
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
  if (kind === "node-metrics") {
    const result = await readMetrics(url);
    return {
      status: "connected",
      signals: recognizedNodeSignals(nodeMetricValues(result.samples)),
    };
  }
  if (kind === "hiro-reference") {
    await readJson(endpoint(url, hiroStatusPath), hiroStatusSchema);
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

export async function collectHealthObservation(
  config: SidekickConfig,
  observedAt: string,
): Promise<HealthObservation> {
  const [nodeRpc, nodeMetrics, hiro, signerInfo, signerHeartbeat, signerMetrics] =
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
        ? readJson(endpoint(config.hiroReferenceApiUrl, hiroStatusPath), hiroStatusSchema).catch(
            (error) => ({ source: sourceFailure(error), value: null }),
          )
        : null,
      config.signerMonitoringUrl
        ? readJson(endpoint(config.signerMonitoringUrl, "/info"), signerInfoSchema).catch(
            (error) => ({
              source: sourceFailure(error),
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
            }))
            .catch(sourceFailure)
        : null,
      config.signerMonitoringUrl
        ? readMetrics(endpoint(config.signerMonitoringUrl, "/metrics")).catch((error) => ({
            source: sourceFailure(error),
            samples: null,
          }))
        : null,
    ]);

  return {
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
  };
}
