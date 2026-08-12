import type { HealthSnapshot as ApiHealthSnapshot } from "@stx-labs/signer-sidekick-api-contracts";
import type { BurnBlockPage } from "./chain-clients.js";
import type { SidekickConfig } from "./config.js";

export type HealthSnapshot = ApiHealthSnapshot;
export type HealthFinding = HealthSnapshot["findings"][number];
export type HealthSourceState = HealthSnapshot["node"]["rpc"];
export type HealthSourceStatus = HealthSourceState["status"];
export type BurnBlockTiming = NonNullable<HealthSnapshot["burnBlockTiming"]>;

export interface SourceObservation {
  reachable: boolean;
  latencyMs: number | null;
  errorCode: string | null;
}

export interface NodeInfo {
  server_version?: string | undefined;
  network_id: number;
  burn_block_height: number;
  stacks_tip_height: number;
  is_fully_synced?: boolean | undefined;
}

export interface NodeHealth {
  difference_from_max_peer: number;
  max_stacks_height_of_neighbors: number;
  node_stacks_tip_height: number;
}

export interface HiroStatus {
  server_version?: string | undefined;
  status: string;
  chain_tip: {
    block_height: number;
    burn_block_height: number;
  };
}

export interface SignerInfo {
  signerPublicKey: string;
  network: string;
  stxAddress: string;
  version: string;
}

export interface NodeMetricValues {
  stacksTipHeight: number | null;
  burnBlockHeight: number | null;
  inboundPeers: number | null;
  outboundPeers: number | null;
  warningTotal: number | null;
  errorTotal: number | null;
}

export interface SignerMetricValues {
  nodeHeight: number | null;
  rewardCycle: number | null;
  stxBalanceUstx: number | null;
  proposalsTotal: number | null;
  acceptedTotal: number | null;
  rejectedTotal: number | null;
  conflictTotal: number | null;
  responseLatencyBuckets: Record<string, number>;
}

export interface HealthObservation {
  observedAt: string;
  nodeRpc: SourceObservation;
  nodeInfo: NodeInfo | null;
  nodeHealth: NodeHealth | null;
  nodeMetricsSource: SourceObservation | null;
  nodeMetrics: NodeMetricValues | null;
  hiroSource: SourceObservation | null;
  hiro: HiroStatus | null;
  signerInfoSource: SourceObservation | null;
  signerInfo: SignerInfo | null;
  signerHeartbeat: SourceObservation | null;
  signerMetricsSource: SourceObservation | null;
  signerMetrics: SignerMetricValues | null;
}

export type HealthSourceKey =
  | "nodeRpc"
  | "nodeMetricsSource"
  | "hiroSource"
  | "signerInfoSource"
  | "signerHeartbeat"
  | "signerMetricsSource";

export interface HealthMonitoringOptions {
  getConfig: () => SidekickConfig;
  getBurnBlocks?: () => Promise<BurnBlockPage>;
  now?: () => Date;
  pollIntervalMs?: number;
  historyWindowMs?: number;
}
