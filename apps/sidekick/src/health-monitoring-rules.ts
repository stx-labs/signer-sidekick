import type { HealthFinding } from "./health-monitoring-types.js";

/**
 * Shared evidence windows used by more than one rule or by the snapshot builder.
 *
 * These are product-calibration values, not Stacks protocol constants. Change them only alongside
 * positive, recovery, and false-positive tests plus an incident or live-calibration note in the
 * diagnosis-model documentation.
 */
export const HEALTH_WINDOWS = {
  recentSignerMs: 15 * 60_000,
  networkAdvancementMs: 90_000,
} as const;

/**
 * All tunable finding thresholds live here. Keeping them out of the evaluator makes a rule review
 * possible without reconstructing numbers from control flow, while the catalog below records why
 * each threshold exists and which false positive it is intended to prevent.
 */
export const HEALTH_RULE_THRESHOLDS = {
  localEndpointFailure: {
    minimumSamples: 3,
    minimumWindowMs: 10_000,
  },
  nodeBehindPeers: {
    lagBlocks: 3,
    minimumSamples: 6,
    minimumWindowMs: 25_000,
  },
  localNodeStall: {
    minimumWindowMs: 90_000,
  },
  networkStall: {
    minimumWindowMs: 180_000,
    minimumIndependentSignals: 2,
  },
  comparisonSourceLag: {
    lagBlocks: 3,
    minimumWindowMs: HEALTH_WINDOWS.networkAdvancementMs,
  },
  signerConfigurationMismatch: {
    minimumSamples: 3,
    minimumWindowMs: 10_000,
  },
  signerNodeViewLag: {
    lagBlocks: 3,
    minimumUpdates: 3,
    minimumWindowMs: 2 * 60_000,
    recoveryUpdates: 2,
  },
  proposalResponseGap: {
    windowMs: HEALTH_WINDOWS.recentSignerMs,
    settleMs: 30_000,
    minimumProposals: 5,
    minimumGap: 3,
    highConfidenceResponses: 20,
  },
  rejectionRate: {
    windowMs: HEALTH_WINDOWS.recentSignerMs,
    minimumResponses: 20,
    percent: 25,
  },
  validationLatency: {
    windowMs: HEALTH_WINDOWS.recentSignerMs,
    minimumAcceptedValidations: 20,
    p95Seconds: 5,
  },
  agreementConflicts: {
    windowMs: HEALTH_WINDOWS.recentSignerMs,
    minimumConflicts: 3,
  },
} as const;

type HealthRuleCategory =
  | "availability"
  | "local-chain"
  | "comparison"
  | "signer-configuration"
  | "signer-participation";

interface RuleDefinition<TThresholds extends object> {
  id: string;
  category: HealthRuleCategory;
  defaultSeverity: HealthFinding["severity"];
  thresholds: TThresholds;
  rationale: string;
  falsePositiveGuard: string;
}

function defineRule<const TThresholds extends object>(
  definition: RuleDefinition<TThresholds>,
): RuleDefinition<TThresholds> {
  return definition;
}

/**
 * The closed catalog of conditions allowed to open durable health-finding episodes.
 *
 * A collected metric is not automatically an alerting rule. In particular, end-to-end response
 * latency remains visible for troubleshooting but is deliberately absent here because its
 * header-timestamp-based measurement is not reliable enough for operator attribution.
 */
export const HEALTH_RULES = {
  nodeRpcUnavailable: defineRule({
    id: "node-rpc-unavailable",
    category: "availability",
    defaultSeverity: "critical",
    thresholds: HEALTH_RULE_THRESHOLDS.localEndpointFailure,
    rationale: "Sidekick cannot assess or safely operate against a node it cannot reach.",
    falsePositiveGuard: "Require repeated failures spanning time rather than one failed request.",
  }),
  signerMonitoringUnavailable: defineRule({
    id: "signer-monitoring-unavailable",
    category: "availability",
    defaultSeverity: "critical",
    thresholds: HEALTH_RULE_THRESHOLDS.localEndpointFailure,
    rationale:
      "Loss of signer identity and heartbeat evidence removes first-person health coverage.",
    falsePositiveGuard: "Require repeated failures spanning time rather than one failed request.",
  }),
  signerNodeHeartbeatFailed: defineRule({
    id: "signer-node-heartbeat-failed",
    category: "availability",
    defaultSeverity: "critical",
    thresholds: HEALTH_RULE_THRESHOLDS.localEndpointFailure,
    rationale:
      "The signer itself reports that it cannot reach the node required for participation.",
    falsePositiveGuard: "Require a sustained sequence of failed heartbeat checks.",
  }),
  signerMetricsUnavailable: defineRule({
    id: "signer-metrics-unavailable",
    category: "availability",
    defaultSeverity: "warning",
    thresholds: HEALTH_RULE_THRESHOLDS.localEndpointFailure,
    rationale:
      "The signer is reachable, but participation and performance evidence is unavailable.",
    falsePositiveGuard:
      "Suppress this secondary finding when all signer monitoring is unavailable.",
  }),
  nodeBehindNetwork: defineRule({
    id: "node-behind-network",
    category: "local-chain",
    defaultSeverity: "critical",
    thresholds: HEALTH_RULE_THRESHOLDS.nodeBehindPeers,
    rationale: "The node's own peer view can directly show that its canonical tip is behind.",
    falsePositiveGuard: "Require a multi-block gap across multiple samples and a minimum duration.",
  }),
  nodeTipStalledLocally: defineRule({
    id: "node-tip-stalled-locally",
    category: "local-chain",
    defaultSeverity: "critical",
    thresholds: HEALTH_RULE_THRESHOLDS.localNodeStall,
    rationale: "A local tip that stops while another source advances needs operator investigation.",
    falsePositiveGuard: "Require independent evidence of newer chain progress during the stall.",
  }),
  networkTipStalled: defineRule({
    id: "network-tip-stalled",
    category: "comparison",
    defaultSeverity: "warning",
    thresholds: HEALTH_RULE_THRESHOLDS.networkStall,
    rationale:
      "Corroborated non-progression can keep an operator from misdiagnosing a local fault.",
    falsePositiveGuard: "Require the local stall plus at least two distinct peer or API signals.",
  }),
  referenceApiBehindLocalNode: defineRule({
    id: "reference-api-behind-local-node",
    category: "comparison",
    defaultSeverity: "warning",
    thresholds: HEALTH_RULE_THRESHOLDS.comparisonSourceLag,
    rationale:
      "A stale reference should be disclosed without making a healthy local node unhealthy.",
    falsePositiveGuard:
      "Only fire while the local node is advancing and the lag remains sustained.",
  }),
  configuredApiBehindLocalNode: defineRule({
    id: "configured-api-behind-local-node",
    category: "comparison",
    defaultSeverity: "warning",
    thresholds: HEALTH_RULE_THRESHOLDS.comparisonSourceLag,
    rationale: "A stale indexed source should not override node-proved current state.",
    falsePositiveGuard:
      "Only fire while the local node is advancing and the lag remains sustained.",
  }),
  signerIdentityMismatch: defineRule({
    id: "signer-identity-mismatch",
    category: "signer-configuration",
    defaultSeverity: "critical",
    thresholds: HEALTH_RULE_THRESHOLDS.signerConfigurationMismatch,
    rationale: "The running signer key must match the key registered for this manager.",
    falsePositiveGuard: "Compare against node-proved registration and require sustained mismatch.",
  }),
  signerNetworkMismatch: defineRule({
    id: "signer-network-mismatch",
    category: "signer-configuration",
    defaultSeverity: "critical",
    thresholds: HEALTH_RULE_THRESHOLDS.signerConfigurationMismatch,
    rationale: "A signer attached to another network cannot participate for this deployment.",
    falsePositiveGuard: "Require repeated mismatch against the configured local-node network.",
  }),
  signerRewardCycleMismatch: defineRule({
    id: "signer-reward-cycle-mismatch",
    category: "signer-configuration",
    defaultSeverity: "warning",
    thresholds: HEALTH_RULE_THRESHOLDS.signerConfigurationMismatch,
    rationale: "A stale signer reward-cycle view may prevent expected participation.",
    falsePositiveGuard:
      "Require repeated mismatch against the local node's anchored operator state.",
  }),
  signerNodeViewBehind: defineRule({
    id: "signer-node-view-behind",
    category: "signer-participation",
    defaultSeverity: "critical",
    thresholds: HEALTH_RULE_THRESHOLDS.signerNodeViewLag,
    rationale: "A signer that persistently observes an old node tip can miss or reject proposals.",
    falsePositiveGuard:
      "Evaluate signer updates, not polls, and require two healthy updates to recover.",
  }),
  signerProposalResponseGap: defineRule({
    id: "signer-proposal-response-gap",
    category: "signer-participation",
    defaultSeverity: "critical",
    thresholds: HEALTH_RULE_THRESHOLDS.proposalResponseGap,
    rationale: "First-person counters can show proposals that the signer did not answer.",
    falsePositiveGuard:
      "Use a conservative lower bound and exclude proposals still inside the settle window.",
  }),
  signerRejectionRateElevated: defineRule({
    id: "signer-rejection-rate-elevated",
    category: "signer-participation",
    defaultSeverity: "warning",
    thresholds: HEALTH_RULE_THRESHOLDS.rejectionRate,
    rationale:
      "Sustained rejection can indicate bad proposals, node validation, or signer policy issues.",
    falsePositiveGuard: "Require a minimum response population and preserve ambiguous attribution.",
  }),
  signerValidationLatencyElevated: defineRule({
    id: "signer-validation-latency-elevated",
    category: "local-chain",
    defaultSeverity: "warning",
    thresholds: HEALTH_RULE_THRESHOLDS.validationLatency,
    rationale: "The Stacks node directly reports how long successful block validation took.",
    falsePositiveGuard:
      "Require at least 20 successful validations so one complex block cannot alert.",
  }),
  signerAgreementConflictsElevated: defineRule({
    id: "signer-agreement-conflicts-elevated",
    category: "signer-participation",
    defaultSeverity: "warning",
    thresholds: HEALTH_RULE_THRESHOLDS.agreementConflicts,
    rationale:
      "Repeated agreement conflicts can reveal signer, miner-view, or network disagreement.",
    falsePositiveGuard:
      "Require multiple conflicts and do not attribute the metric to one component.",
  }),
} as const;

export type HealthRuleDefinition = (typeof HEALTH_RULES)[keyof typeof HEALTH_RULES];

export const HEALTH_RULE_CATALOG: readonly HealthRuleDefinition[] = Object.freeze(
  Object.values(HEALTH_RULES),
);
