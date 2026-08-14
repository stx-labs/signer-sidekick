import type {
  ActivityCoverage,
  ActivityGroupSummary,
  ActivityResponse,
  ConnectionAssessment,
  DashboardSnapshot,
  HealthSnapshot,
  OperatorDeadline,
  OverviewAttentionItem,
  OverviewDomain,
  OverviewEvidence,
  OverviewPage,
} from "@stx-labs/signer-sidekick-api-contracts";

interface ObserverGapStatus {
  status: "healthy" | "degraded" | "not-started" | "unknown";
  nodeStacksHeight: number | null;
  observerStacksHeight: number | null;
  observerSilenceSeconds: number | null;
}

export interface OverviewProjectionInput {
  snapshot: DashboardSnapshot;
  health: HealthSnapshot | null;
  connection: ConnectionAssessment | null;
  activity?: ActivityResponse | null;
  activitySource?: {
    status: "current" | "unavailable";
    observedAt: string;
    reason: string | null;
  };
  observerGap?: ObserverGapStatus | null;
  now?: Date;
}

export interface OverviewAttentionCandidate {
  item: OverviewAttentionItem;
  conditionKey: string;
  suppressedBy?: readonly string[];
  suppresses?: readonly string[];
  operationScope?: string | null;
  authority?: "domain" | "activity";
}

interface AttentionOrderContext {
  now: Date;
  burnBlockHeight: number | null;
  rewardCycleId: number | null;
  phase: "reward" | "prepare" | null;
}

const tierRank = new Map([
  ["urgent", 0],
  ["action-required", 1],
  ["needs-attention", 2],
] as const);

function compareNullableInstants(left: string | null, right: string | null): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return Date.parse(left) - Date.parse(right);
}

function deadlineRank(deadline: OperatorDeadline | null, context: AttentionOrderContext): number {
  if (!deadline) return 2;
  if (deadline.kind === "time") return Date.parse(deadline.at) <= context.now.getTime() ? 0 : 1;
  if (deadline.kind === "burn-block") {
    if (context.burnBlockHeight === null) return 1;
    return deadline.burnBlockHeight <= context.burnBlockHeight ? 0 : 1;
  }
  if (context.rewardCycleId === null) return 1;
  const overdue =
    context.rewardCycleId > deadline.rewardCycleId ||
    (context.rewardCycleId === deadline.rewardCycleId &&
      (deadline.phase === "cycle-start" || context.phase === "prepare"));
  return overdue ? 0 : 1;
}

export function sortOverviewAttention(
  items: readonly OverviewAttentionItem[],
  context: AttentionOrderContext,
): OverviewAttentionItem[] {
  return [...items].sort((left, right) => {
    const tierDifference = (tierRank.get(left.tier) ?? 99) - (tierRank.get(right.tier) ?? 99);
    if (tierDifference !== 0) return tierDifference;
    const deadlineDifference =
      deadlineRank(left.deadline, context) - deadlineRank(right.deadline, context);
    if (deadlineDifference !== 0) return deadlineDifference;
    const urgencyDifference = compareNullableInstants(left.urgencyAt, right.urgencyAt);
    if (urgencyDifference !== 0) return urgencyDifference;
    const openedDifference = compareNullableInstants(left.openedAt, right.openedAt);
    if (openedDifference !== 0) return openedDifference;
    return left.attentionId.localeCompare(right.attentionId);
  });
}

export function correlateOverviewAttention(
  candidates: readonly OverviewAttentionCandidate[],
  context: AttentionOrderContext,
): OverviewAttentionItem[] {
  const byCondition = new Map<string, number[]>();
  candidates.forEach((candidate, index) => {
    const indices = byCondition.get(candidate.conditionKey) ?? [];
    indices.push(index);
    byCondition.set(candidate.conditionKey, indices);
  });
  const edges = candidates.map(() => new Set<number>());
  const remainingIncoming = candidates.map(() => 0);
  const addEdge = (from: number, to: number): void => {
    if (from === to || edges[from]?.has(to)) return;
    edges[from]?.add(to);
    remainingIncoming[to] = (remainingIncoming[to] ?? 0) + 1;
  };
  candidates.forEach((candidate, index) => {
    for (const condition of candidate.suppressedBy ?? []) {
      for (const suppressor of byCondition.get(condition) ?? []) addEdge(suppressor, index);
    }
    for (const condition of candidate.suppresses ?? []) {
      if (condition === "*") {
        candidates.forEach((_target, target) => {
          addEdge(index, target);
        });
      } else {
        for (const target of byCondition.get(condition) ?? []) addEdge(index, target);
      }
    }
  });
  const queue = remainingIncoming.flatMap((degree, index) => (degree === 0 ? [index] : []));
  const suppressed = new Set<number>();
  const resolved = new Set<number>();
  const removeSuppressedEdges = (source: number): void => {
    for (const target of edges[source] ?? []) {
      remainingIncoming[target] = Math.max(0, (remainingIncoming[target] ?? 0) - 1);
      if (remainingIncoming[target] === 0 && !resolved.has(target) && !suppressed.has(target)) {
        queue.push(target);
      }
    }
  };
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const suppressor = queue[cursor];
    if (suppressor === undefined || resolved.has(suppressor) || suppressed.has(suppressor))
      continue;
    resolved.add(suppressor);
    for (const target of edges[suppressor] ?? []) {
      if (resolved.has(target) || suppressed.has(target)) continue;
      suppressed.add(target);
      removeSuppressedEdges(target);
    }
  }
  // Cycles are intentionally unresolved and survive: ambiguity must not silently hide work.
  const unsuppressed = candidates.filter((_candidate, index) => !suppressed.has(index));
  const activityScopes = new Set(
    unsuppressed.flatMap((candidate) =>
      candidate.authority === "activity" && candidate.operationScope
        ? [candidate.operationScope]
        : [],
    ),
  );
  const selected: OverviewAttentionCandidate[] = [];
  const domainScopes = new Set<string>();
  for (const candidate of unsuppressed) {
    if (candidate.authority === "activity" || !candidate.operationScope) {
      selected.push(candidate);
      continue;
    }
    if (
      activityScopes.has(candidate.operationScope) ||
      domainScopes.has(candidate.operationScope)
    ) {
      continue;
    }
    domainScopes.add(candidate.operationScope);
    selected.push(candidate);
  }
  const byId = new Map<string, OverviewAttentionItem>();
  for (const { item } of selected) {
    if (!byId.has(item.attentionId)) byId.set(item.attentionId, item);
  }
  return sortOverviewAttention([...byId.values()], context);
}

function healthAction<
  Section extends "findings" | "node" | "signer" | "network" | "sources" | null,
>(section: Section, label: string) {
  return { kind: "open-domain" as const, page: "health" as const, section, label };
}

function poolAction<Section extends "positions" | "forecast" | "roster" | null>(
  section: Section,
  label: string,
) {
  return { kind: "open-domain" as const, page: "pool" as const, section, label };
}

function rewardsAction<
  Section extends "outlook" | "calculation" | "claims" | "fees" | "withdrawals" | "history" | null,
>(section: Section, label: string) {
  return { kind: "open-domain" as const, page: "rewards" as const, section, label };
}

function openActivityAction<Section extends "active" | "history" | null>(
  section: Section,
  label: string,
) {
  return { kind: "open-domain" as const, page: "activity" as const, section, label };
}

function evidence(options: {
  status: OverviewEvidence["status"];
  observedAt: string | null;
  anchor?: DashboardSnapshot["chainAnchor"] | null;
  source: OverviewEvidence["source"];
  reason?: string | null;
}): OverviewEvidence {
  return {
    status: options.status,
    observedAt: options.observedAt,
    anchor: options.anchor ?? null,
    source: options.source,
    reason: options.reason ?? null,
  };
}

function activityEvidence(value: ActivityCoverage): OverviewEvidence {
  return evidence({
    status: value.status,
    observedAt: value.observedAt,
    anchor: value.anchor,
    source: value.source === "indexed-manager-history" ? "indexed-api" : "sidekick-store",
    reason: value.reason,
  });
}

function activityAttentionItem(activity: ActivityGroupSummary): OverviewAttentionItem {
  const ambiguous = activity.outcome === "ambiguous";
  return attentionItem({
    attentionId: activity.activityId,
    tier:
      activity.displayStatus === "action-required"
        ? "action-required"
        : ambiguous
          ? "urgent"
          : "needs-attention",
    domain: activity.domain,
    affectedDomains: [activity.domain],
    code: activity.code,
    title: activity.title,
    summary: activity.summary,
    impact: ambiguous
      ? "Do not submit a replacement until the transaction and nonce evidence is resolved."
      : activity.displayStatus === "action-required"
        ? "The operation will not advance until the required operator input is provided."
        : "The operation needs review before Sidekick can consider it resolved.",
    openedAt: activity.occurredAt,
    updatedAt: activity.updatedAt,
    deadline: activity.deadline,
    urgencyAt: activity.urgencyAt,
    evidence: activity.coverage.map(activityEvidence),
    relatedActivityId: activity.activityId,
    relatedFindingId: null,
    primaryAction:
      activity.primaryAction ?? openActivityAction("active", "Review active operation"),
    detailsAction: null,
  });
}

function activityOperationScope(activity: ActivityGroupSummary): string {
  return activity.operationScope ?? activity.activityId;
}

function snapshotEvidence(snapshot: DashboardSnapshot): OverviewEvidence {
  const delayed = snapshot.freshness?.status === "stale";
  return evidence({
    status: delayed ? "delayed" : "current",
    observedAt: snapshot.generatedAt,
    anchor: snapshot.chainAnchor,
    source: "local-node",
    reason: delayed
      ? `The cached operator snapshot is delayed (${snapshot.freshness?.reason ?? "refreshing"}).`
      : null,
  });
}

function sourceEvidence(
  source: HealthSnapshot["node"]["rpc"],
  observedAt: string,
  kind: OverviewEvidence["source"],
): OverviewEvidence {
  return evidence({
    status:
      source.status === "healthy"
        ? "current"
        : source.status === "not-configured"
          ? "not-configured"
          : "unavailable",
    observedAt: source.checkedAt ?? observedAt,
    source: kind,
    reason: source.errorCode,
  });
}

function estimateAt(observedAt: string, blocksRemaining: number | null, seconds: number | null) {
  if (blocksRemaining === null || seconds === null) return null;
  const base = Date.parse(observedAt);
  if (!Number.isFinite(base)) return null;
  return new Date(base + blocksRemaining * seconds * 1_000).toISOString();
}

function formatUstx(value: string): string {
  const amount = BigInt(value);
  const sign = amount < 0n ? "-" : "";
  const absolute = amount < 0n ? -amount : amount;
  const whole = absolute / 1_000_000n;
  const fraction = (absolute % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${sign}${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""} STX`;
}

function nextCalculation(snapshot: DashboardSnapshot, averageBurnSeconds: number | null) {
  const anchor = snapshot.chainAnchor;
  const localEvidence = snapshotEvidence(snapshot);
  if (!anchor) {
    return {
      status: "unavailable" as const,
      burnBlockHeight: null,
      blocksRemaining: null,
      estimatedAt: null,
      evidence: [localEvidence],
    };
  }
  const observedNext =
    snapshot.rewardOutlook?.calculation.next ?? snapshot.rewards?.calculation.next ?? null;
  const cycleStart = anchor.burnBlockHeight - anchor.cyclePosition;
  const checkpointOffset =
    anchor.checkpoint === "first-half"
      ? anchor.rewardCycleLength / 2 - 1
      : anchor.rewardCycleLength - 1;
  if (!observedNext && (!Number.isInteger(checkpointOffset) || cycleStart < 0)) {
    return {
      status: "unavailable" as const,
      burnBlockHeight: null,
      blocksRemaining: null,
      estimatedAt: null,
      evidence: [
        evidence({
          ...localEvidence,
          status: "unavailable",
          reason: "The current PoX-5 cycle does not expose a valid calculation checkpoint.",
        }),
      ],
    };
  }
  // `calculate-rewards` becomes callable on the burn block after the distribution checkpoint.
  // Prefer the already-derived PoX-5 outlook so Overview and Rewards cannot disagree about that
  // boundary. The anchor fallback preserves timing visibility when the reward read is unavailable.
  const burnBlockHeight = observedNext?.eligibleBurnHeight ?? cycleStart + checkpointOffset + 1;
  // The stable anchor/outlook defines the protocol moment. Count down from the same current local
  // node tip shown beside it so ordinary reference-indexer lag cannot skew the displayed timing.
  const blocksRemaining = Math.max(0, burnBlockHeight - snapshot.preflight.node.burnBlockHeight);
  return {
    status: blocksRemaining === 0 ? ("due" as const) : ("scheduled" as const),
    burnBlockHeight,
    blocksRemaining,
    estimatedAt: estimateAt(snapshot.generatedAt, blocksRemaining, averageBurnSeconds),
    evidence: [localEvidence],
  };
}

function nextPrepare(snapshot: DashboardSnapshot, averageBurnSeconds: number | null) {
  const burnBlockHeight = snapshot.preflight.cycle.preparePhaseStartBurnHeight;
  const blocksRemaining = snapshot.preflight.cycle.blocksUntilPreparePhase;
  return {
    status:
      burnBlockHeight === null || blocksRemaining === null
        ? ("unavailable" as const)
        : blocksRemaining === 0
          ? ("due" as const)
          : ("scheduled" as const),
    burnBlockHeight,
    blocksRemaining,
    estimatedAt: estimateAt(snapshot.generatedAt, blocksRemaining, averageBurnSeconds),
    evidence: [snapshotEvidence(snapshot)],
  };
}

function prepareDeadlineForCycle(
  snapshot: DashboardSnapshot,
  cycleId: number,
  averageBurnSeconds: number | null,
): OperatorDeadline | null {
  const nextCycleId = snapshot.preflight.cycle.nextId;
  const nextPrepareHeight = snapshot.preflight.cycle.preparePhaseStartBurnHeight;
  if (nextCycleId === null || nextPrepareHeight === null || cycleId < nextCycleId) return null;
  const cycleOffset = cycleId - nextCycleId;
  const rewardCycleLength = snapshot.chainAnchor?.rewardCycleLength ?? null;
  if (cycleOffset > 0 && rewardCycleLength === null) return null;
  const burnBlockHeight = nextPrepareHeight + cycleOffset * (rewardCycleLength ?? 0);
  const blocksRemaining = Math.max(0, burnBlockHeight - snapshot.preflight.node.burnBlockHeight);
  return {
    kind: "burn-block",
    burnBlockHeight,
    estimatedAt: estimateAt(snapshot.generatedAt, blocksRemaining, averageBurnSeconds),
  };
}

function currentForecastCycle(snapshot: DashboardSnapshot) {
  return snapshot.forecast?.cycles.find(
    ({ cycleId }) => cycleId === snapshot.preflight.cycle.currentId,
  );
}

function indexedProjectionDelayed(snapshot: DashboardSnapshot): boolean {
  return (
    snapshot.freshness?.status === "stale" ||
    snapshot.preflight.api.position === "behind" ||
    (snapshot.preflight.api.stacksTipLag ?? 0) > 0 ||
    snapshot.preflight.api.burnBlockLag > 0
  );
}

function nextForecastCycle(snapshot: DashboardSnapshot) {
  const nextId = snapshot.preflight.cycle.nextId;
  return nextId === null
    ? undefined
    : snapshot.forecast?.cycles.find(({ cycleId }) => cycleId === nextId);
}

function poolSummary(snapshot: DashboardSnapshot): OverviewPage["pool"] {
  const current = currentForecastCycle(snapshot);
  const next = nextForecastCycle(snapshot);
  const projectionDelayed = indexedProjectionDelayed(snapshot);
  const ingestion = snapshot.forecast?.ingestion ?? null;
  const projectionEvidence = evidence({
    status: !ingestion ? "unavailable" : projectionDelayed ? "delayed" : "current",
    observedAt: ingestion?.completedAt ?? null,
    source: "indexed-api",
    reason: ingestion
      ? projectionDelayed
        ? "The indexed pool projection is behind the current local node position."
        : null
      : "No completed indexed roster projection is available.",
  });
  const rosterComplete = ingestion !== null;
  const activeRoster = snapshot.roster.filter(({ active }) => active);
  const participants = rosterComplete
    ? {
        stxOnly: activeRoster.filter(({ hasStx, bond }) => hasStx && bond === null).length,
        bitcoinBond: activeRoster.filter(({ bond }) => bond !== null).length,
      }
    : null;
  const materialCycle = snapshot.forecast?.cycles
    .filter(({ cycleId }) => cycleId > snapshot.preflight.cycle.currentId)
    .sort((left, right) => left.cycleId - right.cycleId)
    .find(({ changesFromPrevious }) => {
      if (!changesFromPrevious) return false;
      return (
        changesFromPrevious.joiningStakers > 0 ||
        changesFromPrevious.leavingStakers > 0 ||
        changesFromPrevious.changedAmountStakers > 0
      );
    });
  const changes = materialCycle?.changesFromPrevious;
  const previous = materialCycle
    ? snapshot.forecast?.cycles.find(({ cycleId }) => cycleId === materialCycle.cycleId - 1)
    : undefined;
  const amountDelta =
    materialCycle && previous
      ? (
          BigInt(materialCycle.contract.pendingStxUstx) - BigInt(previous.contract.pendingStxUstx)
        ).toString()
      : null;
  const changeKind = changes
    ? changes.joiningStakers > 0
      ? "join"
      : changes.leavingStakers > 0
        ? "exit"
        : "amount-change"
    : null;
  const participantCount = changes
    ? changeKind === "join"
      ? changes.joiningStakers
      : changeKind === "exit"
        ? changes.leavingStakers
        : changes.changedAmountStakers
    : 0;
  return {
    status: !snapshot.forecast
      ? "unavailable"
      : !rosterComplete
        ? "insufficient-evidence"
        : snapshot.forecast.status === "attention"
          ? "needs-attention"
          : "ready",
    current: current
      ? {
          rewardCycleId: current.cycleId,
          amountUstx: current.contract.pendingStxUstx,
          inSignerSet: current.contract.inSignerSet,
        }
      : null,
    next: next
      ? {
          rewardCycleId: next.cycleId,
          amountUstx: next.contract.pendingStxUstx,
          inSignerSet: next.contract.inSignerSet,
        }
      : null,
    nextThresholdMarginUstx: next?.threshold.marginUstx ?? null,
    participants,
    nextChange:
      materialCycle && changeKind
        ? {
            kind: changeKind,
            rewardCycleId: materialCycle.cycleId,
            participantCount,
            amountDeltaUstx: amountDelta,
          }
        : null,
    evidence: [snapshotEvidence(snapshot), projectionEvidence],
    detailsAction: poolAction("forecast", "Open pool forecast"),
  };
}

function rewardsSummary(snapshot: DashboardSnapshot): OverviewPage["rewards"] {
  const rewards = snapshot.rewards;
  const outlook = snapshot.rewardOutlook ?? null;
  const available = outlook !== null || rewards !== null;
  const rewardEvidence = evidence({
    status: !available
      ? "unavailable"
      : snapshot.freshness?.status === "stale"
        ? "delayed"
        : "current",
    observedAt: snapshot.generatedAt,
    source: "local-node",
    reason: available
      ? snapshot.freshness?.status === "stale"
        ? "The local rewards projection is delayed."
        : null
      : "No PoX-5 reward outlook is available.",
  });
  return {
    status: available
      ? rewards?.status === "attention"
        ? "needs-attention"
        : "ready"
      : "unavailable",
    rewardCycleId:
      outlook?.calculation.targetRewardCycle ?? rewards?.calculation.targetRewardCycle ?? null,
    globalAccruedSats:
      outlook?.accrued.globalSats ?? rewards?.global.globalAccruedRewardsSats ?? null,
    estimatedPoolRewardSats:
      outlook?.forecast?.poolSats.point ?? outlook?.poolEstimate?.grossSats ?? null,
    operatorFeeSats: null,
    // The current-share result is contract-exact for its anchor but remains an estimate of the
    // future checkpoint because accrual, shares, or the active bond set can still change.
    confidence: outlook?.forecast || outlook?.poolEstimate ? "estimated" : "unavailable",
    calculationState: outlook?.calculation.state ?? rewards?.calculation.state ?? null,
    actionableClaims: rewards?.totals.actionableClaims ?? null,
    evidence: [rewardEvidence],
    detailsAction: rewardsAction("outlook", "Open rewards"),
  };
}

function networkSummary(health: HealthSnapshot | null): OverviewPage["network"] {
  if (!health) {
    return {
      status: "unavailable",
      reference: null,
      stacksTipHeight: null,
      burnBlockHeight: null,
      lastObservedAt: null,
      detail: "Network reference evidence is not available.",
      evidence: [
        evidence({ status: "unavailable", observedAt: null, source: "network-reference" }),
      ],
      detailsAction: healthAction("network", "Review network evidence"),
    };
  }
  const source = health.hiro.source;
  const observed = sourceEvidence(source, health.generatedAt, "network-reference");
  const configured = source.status !== "not-configured";
  const available = source.status === "healthy";
  const lastAdvanceAt = health.hiro.lastTipAdvanceAt;
  const advancing = available && health.hiro.advancementStatus === "advancing";
  return {
    status: !configured
      ? "insufficient-evidence"
      : !available
        ? "unavailable"
        : advancing
          ? "advancing"
          : "insufficient-evidence",
    reference: configured ? "configured network reference" : null,
    stacksTipHeight: health.hiro.stacksTipHeight,
    burnBlockHeight: health.hiro.burnBlockHeight,
    lastObservedAt: lastAdvanceAt ?? source.lastSuccessAt,
    detail: !configured
      ? "No optional independent network reference is configured."
      : !available
        ? "The configured network reference is currently unavailable."
        : advancing
          ? "The independently observed network tip is advancing."
          : "The network reference is reachable, but recent advancement is not proved inside the evidence window.",
    evidence: [observed],
    detailsAction: healthAction("network", "Review network evidence"),
  };
}

function nodeSummary(
  snapshot: DashboardSnapshot,
  health: HealthSnapshot | null,
): OverviewPage["node"] {
  if (!health) {
    return {
      status: "insufficient-evidence",
      stacksTipHeight: snapshot.preflight.node.stacksTipHeight,
      burnBlockHeight: snapshot.preflight.node.burnBlockHeight,
      peerHeightDifference: snapshot.preflight.node.peerHeightDifference ?? null,
      lastAdvancedAt: null,
      detail: "The local snapshot is available, but longitudinal node health is not.",
      evidence: [snapshotEvidence(snapshot)],
      detailsAction: healthAction("node", "Review node health"),
    };
  }
  const unavailable = health.node.rpc.status === "unavailable";
  const behind = health.findings.some(({ id }) => id === "node-behind-network");
  const aligned = !unavailable && !behind && health.node.rpc.status === "healthy";
  return {
    status: unavailable
      ? "unavailable"
      : behind
        ? "behind"
        : aligned
          ? "aligned"
          : "insufficient-evidence",
    stacksTipHeight: health.node.stacksTipHeight,
    burnBlockHeight: health.node.burnBlockHeight,
    peerHeightDifference: health.node.peerHeightDifference ?? null,
    lastAdvancedAt: health.node.lastTipAdvanceAt,
    detail: unavailable
      ? "The configured local node RPC is unavailable."
      : behind
        ? "The local node reports that it is behind its observed peers."
        : aligned
          ? "The local node is reachable and aligned with its observed peers."
          : "Sidekick is still collecting enough evidence to determine node alignment.",
    evidence: [sourceEvidence(health.node.rpc, health.generatedAt, "local-node")],
    detailsAction: healthAction("node", "Review node health"),
  };
}

function signerSummary(health: HealthSnapshot | null): OverviewPage["signer"] {
  if (!health) {
    return {
      status: "unavailable",
      rewardCycleId: null,
      nodeHeightDifference: null,
      proposalsLastHour: null,
      acceptedLastHour: null,
      rejectedLastHour: null,
      responseP95Seconds: null,
      detail: "Signer monitoring evidence is not available.",
      evidence: [evidence({ status: "unavailable", observedAt: null, source: "signer" })],
      detailsAction: healthAction("signer", "Review signer health"),
    };
  }
  const source = health.signer.infoSource;
  const notConfigured = source.status === "not-configured";
  const unavailable =
    source.status === "unavailable" ||
    health.signer.heartbeat.status === "unavailable" ||
    health.signer.metrics.status === "unavailable";
  const signerFinding = health.findings.some(
    ({ source: findingSource }) => findingSource === "signer",
  );
  const collecting = health.signer.lastHour.collectingBaseline;
  return {
    status: notConfigured
      ? "not-configured"
      : unavailable
        ? "unavailable"
        : signerFinding
          ? "needs-attention"
          : collecting
            ? "collecting"
            : "healthy",
    rewardCycleId: health.signer.rewardCycle,
    nodeHeightDifference: health.signer.nodeHeightDifference,
    proposalsLastHour: health.signer.lastHour.proposals,
    acceptedLastHour: health.signer.lastHour.accepted,
    rejectedLastHour: health.signer.lastHour.rejected,
    responseP95Seconds: health.signer.lastHour.responseP95Seconds,
    detail: notConfigured
      ? "Signer monitoring is not configured."
      : unavailable
        ? "The configured signer monitoring source is unavailable."
        : signerFinding
          ? "Signer monitoring reports a condition that needs attention."
          : collecting
            ? "Signer monitoring is healthy and collecting a participation baseline."
            : "Signer monitoring is healthy and aligned with the local node.",
    evidence: [
      sourceEvidence(source, health.generatedAt, "signer"),
      sourceEvidence(health.signer.heartbeat, health.generatedAt, "signer"),
      sourceEvidence(health.signer.metrics, health.generatedAt, "signer"),
    ],
    detailsAction: healthAction("signer", "Review signer health"),
  };
}

function attentionItem(
  value: Omit<OverviewAttentionItem, "schemaVersion" | "openedAt" | "urgencyAt" | "deadline"> &
    Partial<Pick<OverviewAttentionItem, "openedAt" | "urgencyAt" | "deadline">>,
): OverviewAttentionItem {
  return {
    schemaVersion: 1,
    openedAt: value.openedAt ?? null,
    urgencyAt: value.urgencyAt ?? null,
    deadline: value.deadline ?? null,
    ...value,
  };
}

function buildAttentionCandidates(input: OverviewProjectionInput): OverviewAttentionCandidate[] {
  const { snapshot, health, connection, activity, activitySource, observerGap } = input;
  const candidates: OverviewAttentionCandidate[] = [];
  const updatedAt = snapshot.generatedAt;
  const localEvidence = snapshotEvidence(snapshot);
  const snapshotCurrent = snapshot.freshness?.status !== "stale";

  if (connection?.status === "blocked" || connection?.status === "unavailable") {
    const identityMismatch = connection.outcomeCode === "deployment-identity-mismatch";
    candidates.push({
      conditionKey: identityMismatch ? "connection:safe-mode" : "connection:unavailable",
      suppressedBy: identityMismatch ? [] : ["node:node-rpc-unavailable"],
      suppresses: identityMismatch ? ["*"] : ["snapshot:delayed"],
      item: attentionItem({
        attentionId: identityMismatch ? "connection:deployment-identity" : "connection:unavailable",
        tier: identityMismatch ? "urgent" : "needs-attention",
        domain: "connection",
        affectedDomains: ["connection", "manager", "pool", "rewards", "signer"],
        code: connection.outcomeCode ?? "connection-unavailable",
        title: identityMismatch
          ? "Deployment identity does not match"
          : "Connection needs attention",
        summary:
          connection.deploymentIdentity.reason ??
          connection.checks.find(({ status }) => status !== "pass")?.message ??
          "Sidekick could not verify the configured deployment.",
        impact: identityMismatch
          ? "Money-moving operations are blocked until the stored and configured deployment identities agree."
          : "Some current-state and operation evidence is unavailable.",
        updatedAt: connection.checkedAt,
        evidence: [
          evidence({
            status: connection.stale
              ? "delayed"
              : connection.status === "unavailable"
                ? "unavailable"
                : "current",
            observedAt: connection.checkedAt,
            source: "local-node",
            reason: connection.outcomeCode,
          }),
        ],
        relatedActivityId: null,
        relatedFindingId: null,
        primaryAction: { kind: "recheck", target: "connection", label: "Recheck connection" },
        detailsAction: { kind: "open-settings", section: "attachment", label: "Review attachment" },
      }),
    });
  }

  const currentInSignerSet = currentForecastCycle(snapshot)?.contract.inSignerSet === true;
  const nextInSignerSet = nextForecastCycle(snapshot)?.contract.inSignerSet === true;
  const expectedParticipation = currentInSignerSet || nextInSignerSet;
  if (
    snapshot.registration?.registered === false ||
    snapshot.registration?.signerKeyGrantValid === false
  ) {
    const missingRegistration = snapshot.registration.registered === false;
    const registrationCapability = snapshot.manager.capabilities.actions.find(
      ({ id }) => id === "register-self",
    );
    const repairAvailable =
      registrationCapability?.executionAvailable === true && expectedParticipation;
    const canRepair = repairAvailable && snapshotCurrent;
    const profileIssueBlocksRepair =
      snapshot.manager.installedProfiles.issues.length > 0 &&
      registrationCapability?.executionAvailable !== true;
    candidates.push({
      conditionKey: missingRegistration ? "signer:registration-missing" : "signer:grant-invalid",
      suppresses: missingRegistration ? ["signer:grant-invalid"] : [],
      operationScope: "register-self",
      item: attentionItem({
        attentionId: missingRegistration ? "signer:registration-missing" : "signer:grant-invalid",
        tier: currentInSignerSet ? "urgent" : canRepair ? "action-required" : "needs-attention",
        domain: "signer",
        affectedDomains: ["signer", "manager"],
        code: missingRegistration ? "registration-missing" : "grant-invalid",
        title: missingRegistration
          ? "Signer registration is missing"
          : "Signer authorization is invalid",
        summary: profileIssueBlocksRepair
          ? `${snapshot.registration.reason} An installed manager profile issue removed the reviewed repair capability.`
          : snapshot.registration.reason,
        impact: currentInSignerSet
          ? "The signer is expected to participate in the current cycle but is not correctly authorized."
          : "The signer cannot participate under this manager until authorization is repaired.",
        updatedAt,
        evidence: [localEvidence],
        relatedActivityId: null,
        relatedFindingId: null,
        primaryAction: canRepair
          ? {
              kind: "launch-operation",
              operation: "register-self",
              context: { kind: "none" },
              label: "Repair signer authorization",
            }
          : repairAvailable
            ? { kind: "recheck", target: "node", label: "Refresh signer authorization" }
            : { kind: "open-settings", section: "capabilities", label: "Review signer capability" },
        detailsAction: healthAction("signer", "Review signer evidence"),
      }),
    });
  }

  if (health) {
    const nodeUnavailable = health.findings.some(({ id }) => id === "node-rpc-unavailable");
    for (const finding of health.findings) {
      const domain: OverviewDomain = finding.source === "node" ? "node" : "signer";
      const conditionKey = `${finding.source}:${finding.id}`;
      candidates.push({
        conditionKey,
        suppressedBy:
          finding.id === "signer-node-heartbeat-failed" && nodeUnavailable
            ? ["node:node-rpc-unavailable"]
            : [],
        suppresses:
          finding.id === "node-rpc-unavailable"
            ? [
                "snapshot:delayed",
                "node:node-behind-network",
                "signer:signer-node-heartbeat-failed",
              ]
            : [],
        item: attentionItem({
          attentionId: `health:${finding.id}`,
          tier:
            currentInSignerSet && finding.severity === "critical" ? "urgent" : "needs-attention",
          domain,
          affectedDomains:
            finding.source === "node" ? ["node", "signer", "pool", "rewards"] : ["signer"],
          code: finding.id,
          title: finding.title,
          summary: finding.detail,
          impact:
            finding.source === "node"
              ? "Local signer participation and current-state operations may be affected."
              : "Signer participation evidence or signing activity may be affected.",
          updatedAt: health.generatedAt,
          evidence: [
            sourceEvidence(
              finding.source === "node" ? health.node.rpc : health.signer.infoSource,
              health.generatedAt,
              finding.source === "node" ? "local-node" : "signer",
            ),
          ],
          relatedActivityId: null,
          relatedFindingId: finding.id,
          primaryAction: healthAction(
            finding.source === "node" ? "node" : "signer",
            "Review health evidence",
          ),
          detailsAction: null,
        }),
      });
    }
    if (health.signer.infoSource.status === "not-configured") {
      candidates.push({
        conditionKey: "signer:monitoring-not-configured",
        item: attentionItem({
          attentionId: "signer:monitoring-not-configured",
          tier: "needs-attention",
          domain: "signer",
          affectedDomains: ["signer"],
          code: "monitoring-not-configured",
          title: "Signer monitoring is not configured",
          summary:
            "Sidekick cannot inspect runtime signer identity, heartbeat, or recent participation.",
          impact:
            "Sidekick cannot distinguish several local signer failures from missing telemetry.",
          updatedAt: health.generatedAt,
          evidence: [sourceEvidence(health.signer.infoSource, health.generatedAt, "signer")],
          relatedActivityId: null,
          relatedFindingId: null,
          primaryAction: {
            kind: "open-settings",
            section: "sources",
            label: "Configure signer monitoring",
          },
          detailsAction: healthAction("sources", "Review monitoring coverage"),
        }),
      });
    }
  }

  const enrollmentClosed =
    snapshot.preflight.cycle.isPreparePhase === true ||
    (snapshot.preflight.cycle.blocksUntilPreparePhase !== null &&
      snapshot.preflight.cycle.blocksUntilPreparePhase <= 1);
  const nextId = snapshot.preflight.cycle.nextId;
  const actionableCycleId = nextId === null ? null : nextId + (enrollmentClosed ? 1 : 0);
  const actionableCycle = snapshot.forecast?.cycles.find(
    ({ cycleId }) => cycleId === actionableCycleId,
  );
  const actionableCycleDeadline =
    actionableCycle === undefined
      ? null
      : prepareDeadlineForCycle(
          snapshot,
          actionableCycle.cycleId,
          health?.burnBlockTiming?.averageSeconds ?? null,
        );
  const rosterUnavailableBlocksThresholdAction =
    actionableCycle?.threshold.meetsThreshold === false &&
    actionableCycle.local.rosterAvailable === false;
  if (actionableCycle && rosterUnavailableBlocksThresholdAction) {
    candidates.push({
      conditionKey: "pool:roster-unavailable",
      item: attentionItem({
        attentionId: `pool:roster-unavailable:${actionableCycle.cycleId}`,
        tier: "needs-attention",
        domain: "pool",
        affectedDomains: ["pool", "signer"],
        code: "actionable-roster-unavailable",
        title: `Pool positions for cycle ${actionableCycle.cycleId} are unavailable`,
        summary:
          "The contract is below threshold, but Sidekick does not have the verified participant roster needed to explain the corrective position change.",
        impact:
          "Sidekick cannot safely turn the threshold deficit into a participant-specific action until indexed roster evidence recovers.",
        updatedAt,
        deadline: actionableCycleDeadline,
        evidence: [
          evidence({
            status: "unavailable",
            observedAt: snapshot.forecast?.ingestion?.completedAt ?? snapshot.generatedAt,
            source: "indexed-api",
            reason: "No node-verified indexed roster is available at the projection anchor.",
          }),
        ],
        relatedActivityId: null,
        relatedFindingId: null,
        primaryAction: { kind: "recheck", target: "api", label: "Recheck pool roster" },
        detailsAction: poolAction("roster", "Review roster coverage"),
      }),
    });
  }
  if (actionableCycle && !actionableCycle.threshold.meetsThreshold) {
    candidates.push({
      conditionKey: "pool:next-cycle-threshold",
      suppressedBy: ["pool:roster-unavailable", "connection:safe-mode"],
      item: attentionItem({
        attentionId: `pool:threshold:${actionableCycle.cycleId}`,
        tier: "action-required",
        domain: "pool",
        affectedDomains: ["pool", "signer"],
        code: "next-cycle-below-threshold",
        title: `Reward cycle ${actionableCycle.cycleId} is below threshold`,
        summary: `The current projection is ${formatUstx(actionableCycle.threshold.marginUstx)} relative to the signer-set threshold.`,
        impact:
          "The manager will not enter that signer set unless its position changes before the window closes.",
        updatedAt,
        deadline: actionableCycleDeadline,
        evidence: [
          evidence({
            status: snapshot.freshness?.status === "stale" ? "delayed" : "current",
            observedAt: snapshot.generatedAt,
            source: "indexed-api",
            reason:
              snapshot.freshness?.status === "stale" ? "The pool projection is delayed." : null,
          }),
        ],
        relatedActivityId: null,
        relatedFindingId: null,
        primaryAction: poolAction("forecast", "Review next cycle"),
        detailsAction: null,
      }),
    });
  }

  const fixedCycle = nextForecastCycle(snapshot);
  if (
    enrollmentClosed &&
    currentInSignerSet &&
    fixedCycle !== undefined &&
    fixedCycle.contract.inSignerSet === false
  ) {
    candidates.push({
      conditionKey: "pool:fixed-cycle-exclusion",
      item: attentionItem({
        attentionId: `pool:fixed-cycle-exclusion:${fixedCycle.cycleId}`,
        tier: "needs-attention",
        domain: "pool",
        affectedDomains: ["pool", "signer"],
        code: "fixed-cycle-exclusion",
        title: `Reward cycle ${fixedCycle.cycleId} is already fixed below threshold`,
        summary: `The enrollment window for cycle ${fixedCycle.cycleId} is closed. The next changeable cycle is ${actionableCycleId ?? "not yet available"}.`,
        impact:
          "The signer is expected in the current set but will not participate in that fixed cycle.",
        updatedAt,
        evidence: [localEvidence],
        relatedActivityId: null,
        relatedFindingId: null,
        primaryAction: poolAction("forecast", "Review the next actionable cycle"),
        detailsAction: null,
      }),
    });
  }

  const calculation = snapshot.rewardOutlook?.calculation ?? snapshot.rewards?.calculation;
  const calculationGrace = calculation?.next?.grace ?? null;
  if (calculation?.state === "pending" && calculationGrace?.state === "action-required") {
    const canAct = snapshotCurrent;
    candidates.push({
      conditionKey: "rewards:calculation-due",
      operationScope: `calculate-rewards:${calculation.targetRewardCycle ?? "unknown"}:${calculation.targetCheckpoint ?? "unknown"}`,
      item: attentionItem({
        attentionId: `rewards:calculation-due:${calculation.targetRewardCycle ?? "unknown"}:${calculation.targetCheckpoint ?? "unknown"}`,
        tier: canAct ? "action-required" : "needs-attention",
        domain: "rewards",
        affectedDomains: ["rewards"],
        code: "reward-calculation-due",
        title: "PoX-5 reward calculation is due",
        summary: canAct
          ? `The calculation remains pending after ${calculationGrace.elapsedMinutes} minutes and ${calculationGrace.canonicalStacksBlocks} canonical Stacks blocks.`
          : "The calculation grace period passed, but current action witnesses are unavailable.",
        impact: "Manager and staker rewards cannot become claimable until calculation completes.",
        updatedAt,
        deadline: {
          kind: "burn-block",
          burnBlockHeight:
            calculation.next?.calculationBurnHeight ?? snapshot.preflight.node.burnBlockHeight,
          estimatedAt: null,
        },
        evidence: [localEvidence],
        relatedActivityId: null,
        relatedFindingId: null,
        primaryAction: canAct
          ? rewardsAction("calculation", "Review reward calculation")
          : { kind: "recheck", target: "node", label: "Refresh reward calculation state" },
        detailsAction: null,
      }),
    });
  }

  const actionableClaims = snapshot.rewards?.totals.actionableClaims ?? 0;
  if (actionableClaims > 0 && calculation?.state === "completed") {
    const claimCapability = snapshot.manager.capabilities.actions.find(
      ({ id }) => id === "reference-reward-claims",
    );
    const canClaim = claimCapability?.executionAvailable === true && snapshotCurrent;
    const profileIssueBlocksClaim =
      snapshot.manager.installedProfiles.issues.length > 0 &&
      claimCapability?.executionAvailable !== true;
    const rewardCycle = snapshot.rewards?.rewardCycle ?? "unknown";
    candidates.push({
      conditionKey: "rewards:claims-due",
      operationScope: `claim-staker-rewards:${rewardCycle}`,
      item: attentionItem({
        attentionId: `rewards:claims-due:${rewardCycle}`,
        tier: canClaim ? "action-required" : "needs-attention",
        domain: "rewards",
        affectedDomains: ["rewards"],
        code: "reward-claims-due",
        title: `${actionableClaims} staker reward settlement${actionableClaims === 1 ? " is" : "s are"} due`,
        summary: profileIssueBlocksClaim
          ? "An installed manager profile issue removed the reviewed claim capability."
          : canClaim
            ? "Current reward and capability evidence supports discovering and reviewing the exact per-staker settlement calls."
            : "Staker settlements are due, but the required current evidence or reviewed manager capability is unavailable.",
        impact: "The accrued rewards remain unclaimed until the operator reviews this work.",
        updatedAt,
        evidence: [localEvidence],
        relatedActivityId: null,
        relatedFindingId: null,
        primaryAction: canClaim
          ? rewardsAction("claims", "Review staker settlements")
          : snapshotCurrent
            ? {
                kind: "open-settings",
                section: "capabilities",
                label: "Review claim capability",
              }
            : { kind: "recheck", target: "node", label: "Refresh reward claim evidence" },
        detailsAction: rewardsAction("claims", "Review reward claims"),
      }),
    });
  }

  if (snapshot.freshness?.status === "stale") {
    candidates.push({
      conditionKey: "snapshot:delayed",
      item: attentionItem({
        attentionId: "sidekick:current-state-delayed",
        tier: "needs-attention",
        domain: "sidekick",
        affectedDomains: ["manager", "pool", "rewards"],
        code: "current-state-delayed",
        title: "Current operator state is delayed",
        summary: `Sidekick is serving its last successful snapshot while refresh is ${snapshot.freshness.reason ?? "in progress"}.`,
        impact:
          "Actions that require current witnesses remain unavailable until their sources recover.",
        updatedAt: snapshot.freshness.servedAt,
        evidence: [localEvidence],
        relatedActivityId: null,
        relatedFindingId: null,
        primaryAction: { kind: "recheck", target: "node", label: "Refresh current state" },
        detailsAction: healthAction("sources", "Review source health"),
      }),
    });
  }

  if (observerGap?.status === "degraded" && snapshot.freshness?.status === "stale") {
    candidates.push({
      conditionKey: "observer:projection-delayed",
      suppresses: ["snapshot:delayed"],
      operationScope: "current-state-refresh",
      item: attentionItem({
        attentionId: "sidekick:observer-projection-delayed",
        tier: "needs-attention",
        domain: "sidekick",
        affectedDomains: ["pool", "rewards"],
        code: "observer-projection-delayed",
        title: "Event-driven projections are delayed",
        summary: `The observer is ${observerGap.observerSilenceSeconds ?? "an unknown number of"} seconds behind and polling has not kept current state inside its freshness budget.`,
        impact: "Pool or rewards changes may not yet appear in Sidekick.",
        updatedAt,
        evidence: [
          evidence({
            status: "delayed",
            observedAt: snapshot.generatedAt,
            source: "sidekick-store",
            reason: "Verified observer callbacks and polling fallback are behind.",
          }),
        ],
        relatedActivityId: null,
        relatedFindingId: null,
        primaryAction: {
          kind: "open-settings",
          section: "observer",
          label: "Review observer status",
        },
        detailsAction: null,
      }),
    });
  }

  if (activitySource?.status === "unavailable") {
    candidates.push({
      conditionKey: "activity:unavailable",
      item: attentionItem({
        attentionId: "sidekick:activity-unavailable",
        tier: "needs-attention",
        domain: "sidekick",
        affectedDomains: ["rewards", "manager"],
        code: "activity-source-unavailable",
        title: "Active operation state is unavailable",
        summary: activitySource.reason ?? "Sidekick could not read its durable operation state.",
        impact: "An operation that needs review or intervention may not appear on Overview.",
        updatedAt: activitySource.observedAt,
        evidence: [
          evidence({
            status: "unavailable",
            observedAt: activitySource.observedAt,
            source: "sidekick-store",
            reason: activitySource.reason,
          }),
        ],
        relatedActivityId: null,
        relatedFindingId: null,
        primaryAction: { kind: "recheck", target: "activity", label: "Recheck active operations" },
        detailsAction: openActivityAction("active", "Open Activity"),
      }),
    });
  }

  for (const active of activity?.active ?? []) {
    if (active.displayStatus === "needs-attention" || active.displayStatus === "action-required") {
      candidates.push({
        conditionKey: `activity:${active.activityId}`,
        operationScope: activityOperationScope(active),
        authority: "activity",
        item: activityAttentionItem(active),
      });
    }
  }

  return candidates;
}

function inProgressItems(input: OverviewProjectionInput): OverviewPage["inProgress"] {
  return (input.activity?.active ?? [])
    .filter(({ displayStatus }) => displayStatus === "in-progress")
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, 3)
    .map((activity) => {
      return {
        schemaVersion: 1 as const,
        activityId: activity.activityId,
        domain: activity.domain,
        title: activity.title,
        stage: activity.stage.replaceAll("-", " "),
        updatedAt: activity.updatedAt,
        evidence: activity.coverage.map(activityEvidence),
        primaryAction: {
          kind: "resume-activity" as const,
          activityId: activity.activityId,
          label: "View operation",
        },
      };
    });
}

export function projectOverview(input: OverviewProjectionInput): OverviewPage {
  const { snapshot, health } = input;
  const now = input.now ?? new Date();
  const localEvidence = snapshotEvidence(snapshot);
  const averageBurnSeconds = health?.burnBlockTiming?.averageSeconds ?? null;
  const cycleId = snapshot.preflight.cycle.currentId;
  const phase =
    snapshot.chainAnchor?.phase ??
    (snapshot.preflight.cycle.isPreparePhase === true
      ? "prepare"
      : snapshot.preflight.cycle.isPreparePhase === false
        ? "reward"
        : null);
  const attentionContext = {
    now,
    burnBlockHeight: snapshot.preflight.node.burnBlockHeight,
    rewardCycleId: cycleId,
    phase,
  };
  const attention = correlateOverviewAttention(buildAttentionCandidates(input), attentionContext);
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    monitoring: {
      network: snapshot.network,
      managerPrincipal: snapshot.managerPrincipal,
    },
    cycle: {
      status: "current",
      rewardCycleId: cycleId,
      phase,
      burnBlockHeight: snapshot.preflight.node.burnBlockHeight,
      stacksTipHeight: snapshot.preflight.node.stacksTipHeight,
      nextRewardCalculation: nextCalculation(snapshot, averageBurnSeconds),
      nextPreparePhase: nextPrepare(snapshot, averageBurnSeconds),
      evidence: [localEvidence],
    },
    network: networkSummary(health),
    node: nodeSummary(snapshot, health),
    signer: signerSummary(health),
    attention,
    inProgress: inProgressItems(input),
    pool: poolSummary(snapshot),
    rewards: rewardsSummary(snapshot),
  };
}
