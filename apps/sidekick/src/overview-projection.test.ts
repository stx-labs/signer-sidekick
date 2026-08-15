import {
  type ActivityGroupSummary,
  type ActivityResponse,
  type ConnectionAssessment,
  type DashboardSnapshot,
  type HealthSnapshot,
  type OverviewAttentionItem,
  overviewPageSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { describe, expect, it } from "vitest";
import {
  correlateOverviewAttention,
  type OverviewAttentionCandidate,
  projectOverview,
  sortOverviewAttention,
} from "./overview-projection.js";

const generatedAt = "2026-08-14T12:00:00.000Z";
const managerPrincipal = "SP000000000000000000002Q6VF78.signer-manager";
const chainAnchor = {
  stacksBlockHeight: 8_750_000,
  indexBlockHash: `0x${"11".repeat(32)}`,
  burnBlockHeight: 962_300,
  rewardCycle: 141,
  rewardCycleLength: 2_100,
  prepareCycleLength: 100,
  cyclePosition: 1_000,
  phase: "reward" as const,
  checkpoint: "first-half" as const,
};

function forecastCycle(cycleId: number, inSignerSet: boolean, marginUstx: string) {
  return {
    cycleId,
    status: inSignerSet ? ("ready" as const) : ("attention" as const),
    provenance: {
      classification: cycleId === 141 ? ("authoritative" as const) : ("projected" as const),
      contractSource: "pox5-read-only" as const,
      localRosterSource: "api-indexed-node-verified" as const,
    },
    local: { stakerCount: 2, enumeratedStxUstx: "4000000000000", rosterAvailable: true },
    contract: { pendingStxUstx: "4000000000000", inSignerSet },
    threshold: { marginUstx, meetsThreshold: inSignerSet },
    changesFromPrevious: null,
  };
}

function snapshot(overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  const base = {
    schemaVersion: 1 as const,
    generatedAt,
    chainAnchor,
    network: "mainnet",
    managerPrincipal,
    setup: {
      status: "ready" as const,
      enrollmentWindow: {
        status: "open" as const,
        targetCycleId: 142,
        preparePhaseStartBurnHeight: 963_300,
        blocksUntilPreparePhase: 1_000,
      },
      eligibility: { current: null, next: null },
      checks: [],
    },
    preflight: {
      status: "pass" as const,
      node: {
        serverVersion: "stacks-node 4.0.1",
        version: "4.0.1",
        commit: null,
        networkId: 1,
        burnBlockHeight: 962_300,
        stacksTipHeight: 8_750_000,
        isFullySynced: true,
        peerHeightDifference: 0,
      },
      api: {
        available: true,
        networkCompatible: true,
        status: "ready",
        serverVersion: "stacks-blockchain-api",
        burnBlockHeight: 962_298,
        stacksTipHeight: 8_749_998,
        burnBlockLag: 2,
        stacksTipLag: 2,
        position: "behind" as const,
        error: null,
      },
      pox: {
        activationState: "active" as const,
        blocksUntilActivation: 0,
        rewardCycleId: 141,
        pox5Available: true,
        pox5ContractId: "SP000000000000000000002Q6VF78.pox-5",
      },
      cycle: {
        currentId: 141,
        nextId: 142,
        preparePhaseStartBurnHeight: 963_300,
        blocksUntilPreparePhase: 1_000,
        rewardPhaseStartBurnHeight: 963_400,
        blocksUntilRewardPhase: 1_100,
        isPreparePhase: false,
      },
      compatibility: {
        status: "matched" as const,
        profileId: "mainnet",
        profileRevision: 1,
        profileLabel: "Mainnet",
        origin: "built-in" as const,
        nodeBuildPreviouslyTested: true,
        reason: "matched",
      },
      checks: [],
    },
    manager: {
      attachAllowed: true,
      publishHeight: 8_000_000,
      automationEligible: true,
      automationEligibilityReason: "reviewed",
      source: {
        profileId: "reference",
        tier: "reference-built-in" as const,
        origin: "built-in" as const,
        recognized: true,
        sha256: "11".repeat(32),
        match: "exact",
      },
      provenance: {
        status: "built-in" as const,
        upstreamProfileId: "reference",
        reason: "reviewed",
      },
      reasons: [],
      installedProfiles: { directory: null, loaded: 0, issues: [] },
      capabilities: {
        signerManagerTrait: { compatible: true, reason: "matched" },
        observedFunctions: { public: ["register-self"], readOnly: [] },
        sourceReview: { exactReviewed: true, reason: "reviewed" },
        eventVocabulary: {
          id: "reference-manager-v1" as const,
          normalizationAvailable: true,
          adapter: null,
          reason: "reviewed",
        },
        actions: [
          {
            id: "register-self" as const,
            interfaceAvailable: true,
            executionAvailable: true,
            missingFunctions: [],
            adapter: null,
            reason: "available",
          },
        ],
      },
    },
    registration: {
      registered: true,
      signerKeyHex: `02${"22".repeat(32)}`,
      signerKeyGrantValid: true,
      reason: "registered",
    },
    forecast: {
      status: "ready" as const,
      ingestion: { activeDiscoveredStakers: 2, completedAt: generatedAt },
      cycles: [forecastCycle(141, true, "100000000"), forecastCycle(142, true, "100000000")],
    },
    rewards: {
      status: "ready" as const,
      rewardCycle: 141,
      global: {
        lastRewardComputeBurnHeight: "962299",
        lastComputedRewardCycle: "141",
        globalAccruedRewardsSats: "2500",
        signerEarnedBeforeManagerClaimSats: "1000",
        signerEarnedAcrossBucketsSats: "1500",
      },
      calculation: {
        state: "completed" as const,
        targetRewardCycle: 141,
        targetCheckpoint: "first-half" as const,
        expectedLastRewardComputeBurnHeight: 962_299,
        observedLastRewardComputeBurnHeight: "962299",
        next: {
          state: "scheduled" as const,
          targetRewardCycle: 141,
          targetCheckpoint: "first-half" as const,
          calculationBurnHeight: 962_349,
          eligibleBurnHeight: 962_350,
          blocksRemaining: 50,
        },
      },
      buckets: [],
      manager: {
        configuredFeeBips: "500",
        feeSnapshotBips: "500",
        earnedFeesSats: "75",
        withdrawalLiabilitySats: "0",
        unclaimedStakerRewardsSats: "1425",
      },
      totals: {
        stakers: 2,
        grossSats: "1500",
        earnedSats: "1425",
        feeSats: "75",
        actionableClaims: 0,
        l1ClaimsWaitingForFeeThreshold: 0,
      },
      stakers: [],
    },
    activity: {
      eventCount: 0,
      latestBlockHeight: null,
      claimTotal: 0,
      withdrawalTotal: 0,
      pendingWithdrawalTotal: 0,
      admins: { status: "current" as const, principals: [], updatesObserved: 0 },
      claims: [],
      withdrawals: [],
    },
    roster: [
      {
        stakerPrincipal: "SP1",
        active: true,
        hasStx: true,
        stxNodeVerified: true,
        bond: null,
        position: {
          amountUstx: "2000000000000",
          firstRewardCycle: "141",
          numCycles: "4",
          unlockCycle: "145",
          unlockBurnHeight: "970000",
          active: true,
        },
      },
      {
        stakerPrincipal: "SP2",
        active: true,
        hasStx: true,
        stxNodeVerified: true,
        bond: { bondIndex: "1", amountUstx: "2000000000000", amountSats: "1000", isL1Lock: true },
        position: {
          amountUstx: "2000000000000",
          firstRewardCycle: "141",
          numCycles: "4",
          unlockCycle: "145",
          unlockBurnHeight: "970000",
          active: true,
        },
      },
    ],
    alerts: [],
    freshness: {
      status: "current" as const,
      snapshotGeneratedAt: generatedAt,
      servedAt: generatedAt,
      reason: null,
    },
  } satisfies DashboardSnapshot;
  return { ...base, ...overrides };
}

function source(status: "healthy" | "unavailable" | "not-configured" = "healthy") {
  return {
    configured: status !== "not-configured",
    status,
    checkedAt: generatedAt,
    lastSuccessAt: status === "healthy" ? generatedAt : null,
    latencyMs: status === "healthy" ? 4 : null,
    consecutiveFailures: status === "unavailable" ? 3 : 0,
    errorCode: status === "unavailable" ? "unreachable" : null,
  };
}

function healthFinding(
  overrides: Pick<
    HealthSnapshot["findings"][number],
    "id" | "severity" | "title" | "detail" | "source"
  > &
    Partial<HealthSnapshot["findings"][number]>,
): HealthSnapshot["findings"][number] {
  return {
    episodeId: "10000000-0000-4000-8000-000000000001",
    classification:
      overrides.source === "node"
        ? "likely-local-node"
        : overrides.source === "signer"
          ? "likely-local-signer"
          : "source-disagreement",
    confidence: "high",
    firstObservedAt: generatedAt,
    lastObservedAt: generatedAt,
    evidenceWindow: {
      startedAt: generatedAt,
      endedAt: generatedAt,
      sampleCount: 3,
      distinctSources: 1,
    },
    evidence: [
      {
        code: overrides.id,
        source:
          overrides.source === "node"
            ? "local-node"
            : overrides.source === "signer"
              ? "signer-monitoring"
              : "reference-api",
        status: "supporting",
        observedAt: generatedAt,
        value: null,
        detail: overrides.detail,
      },
    ],
    ...overrides,
  };
}

function health(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
  const base = {
    schemaVersion: 2 as const,
    generatedAt,
    overallStatus: "healthy" as const,
    coverage: { available: 20, total: 20 },
    diagnosis: {
      status: "healthy" as const,
      classification: "healthy" as const,
      confidence: "high" as const,
      summary: "No active health finding is supported.",
      evidenceWindow: {
        startedAt: generatedAt,
        endedAt: generatedAt,
        sampleCount: 1,
        distinctSources: 1,
      },
      activeFindingIds: [],
    },
    history: {
      sampleIntervalSeconds: 5 as const,
      rawRetentionHours: 72 as const,
      rollupIntervalMinutes: 5 as const,
      rollupRetentionDays: 90 as const,
      observedSince: generatedAt,
      observationCount: 1,
      recentRollups: [],
      recentEpisodes: [],
    },
    operator: {
      network: "mainnet",
      managerPrincipal,
      currentRewardCycle: 141,
      registered: true,
      signerKeyHex: `02${"22".repeat(32)}`,
      signerKeyGrantValid: true,
      expectedCurrentParticipation: true,
      expectedNextParticipation: true,
    },
    burnBlockTiming: {
      averageSeconds: 600,
      windowHours: 12 as const,
      sampleBlocks: 72,
      sampledAt: generatedAt,
    },
    findings: [],
    node: {
      rpc: source(),
      metrics: source(),
      version: "4.0.1",
      networkId: 1,
      stacksTipHeight: 8_750_000,
      burnBlockHeight: 962_300,
      isFullySynced: true,
      peerHeightDifference: 0,
      lastTipAdvanceAt: generatedAt,
      inboundPeers: 12,
      outboundPeers: 18,
      lastHour: { warnings: 0, errors: 0 },
    },
    hiro: {
      source: source(),
      stacksTipHeight: 8_749_998,
      burnBlockHeight: 962_298,
      localStacksDifference: 2,
      localBurnDifference: 2,
      lastTipAdvanceAt: generatedAt,
      advancementStatus: "advancing" as const,
    },
    configuredApi: {
      distinctFromReference: false,
      source: source("not-configured"),
      stacksTipHeight: null,
      burnBlockHeight: null,
      localStacksDifference: null,
      localBurnDifference: null,
      lastTipAdvanceAt: null,
      advancementStatus: "insufficient-evidence" as const,
    },
    signer: {
      infoSource: source(),
      heartbeat: source(),
      metrics: source(),
      version: "4.0.1",
      network: "mainnet",
      publicKey: `02${"22".repeat(32)}`,
      stxAddress: "SP000000000000000000002Q6VF78",
      observedNodeHeight: 8_750_000,
      nodeHeightDifference: 0,
      rewardCycle: 141,
      stxBalanceUstx: 1_000_000,
      identityMatchesRegistration: true,
      networkMatchesConfiguration: true,
      rewardCycleMatchesNode: true,
      last15Minutes: {
        startedAt: generatedAt,
        endedAt: generatedAt,
        sampleCount: 1,
        proposals: 12,
        validationAccepted: 12,
        validationRejected: 0,
        accepted: 12,
        rejected: 0,
        responseGap: 0,
        rejectionPercent: 0,
        responseP95Seconds: 0.8,
        validationP95Seconds: 0.8,
        nodeRpcP95Seconds: 0.1,
        capitulationP95Seconds: null,
        disagreements: 0,
        preCommits: 12,
        collectingBaseline: false,
      },
      lastHour: {
        proposals: 12,
        accepted: 12,
        rejected: 0,
        rejectionPercent: 0,
        responseP95Seconds: 0.8,
        disagreements: 0,
        collectingBaseline: false,
      },
    },
  } satisfies HealthSnapshot;
  return { ...base, ...overrides };
}

function activityGroup(
  code: string,
  displayStatus: ActivityGroupSummary["displayStatus"],
  outcome: ActivityGroupSummary["outcome"],
  activityId = "engine-job:00000000-0000-4000-8000-000000000001",
): ActivityGroupSummary {
  return {
    schemaVersion: 1,
    activityId,
    kind: "operation",
    domain: "rewards",
    code,
    title: "Claim rewards",
    summary: "The reward claim is waiting for approval.",
    stage: "review-ready",
    operationScope:
      code === "claim-staker-rewards"
        ? "claim-staker-rewards:141"
        : code === "register-self"
          ? "register-self"
          : "claim-rewards:141",
    displayStatus,
    outcome,
    occurredAt: generatedAt,
    updatedAt: generatedAt,
    deadline: null,
    urgencyAt: null,
    actorPrincipal: null,
    txids: [],
    anchor: null,
    supersedesActivityId: null,
    supersededByActivityId: null,
    primaryAction: { kind: "resume-activity", activityId, label: "Resume operation" },
    coverage: [
      {
        source: "transaction-engine",
        status: "current",
        observedAt: generatedAt,
        anchor: null,
        reason: null,
      },
    ],
  };
}

function activity(active: ActivityGroupSummary[]): ActivityResponse {
  return {
    schemaVersion: 1,
    generatedAt,
    active,
    items: [],
    nextCursor: null,
    coverage: active[0]?.coverage ?? [
      {
        source: "transaction-engine",
        status: "current",
        observedAt: generatedAt,
        anchor: null,
        reason: null,
      },
    ],
  };
}

function connection(overrides: Partial<ConnectionAssessment> = {}): ConnectionAssessment {
  return {
    schemaVersion: 1,
    status: "unavailable",
    outcomeCode: "node-unreachable",
    checkedAt: generatedAt,
    stale: false,
    configured: {
      network: "mainnet",
      networkId: 1,
      nodeRpcUrl: "http://node",
      managerPrincipal,
    },
    observed: null,
    lastSuccessful: null,
    deploymentIdentity: { status: "unbound", stored: null, reason: "Node is unavailable" },
    checks: [
      { id: "node-network", status: "unavailable", message: "Node is unavailable" },
      { id: "pox5", status: "unavailable", message: "PoX-5 is unavailable" },
      { id: "principal-network", status: "pass", message: "Principal matches" },
      { id: "manager-trait", status: "unavailable", message: "Manager is unavailable" },
      { id: "deployment-identity", status: "unavailable", message: "Identity is unavailable" },
    ],
    ...overrides,
  };
}

function overview(overrides: Partial<Parameters<typeof projectOverview>[0]> = {}) {
  return projectOverview({
    snapshot: snapshot(),
    health: health(),
    connection: null,
    now: new Date(generatedAt),
    ...overrides,
  });
}

function changedSnapshot(change: (value: DashboardSnapshot) => void): DashboardSnapshot {
  const value = structuredClone(snapshot());
  change(value);
  return value;
}

function attention(
  id: string,
  tier: OverviewAttentionItem["tier"],
  options: Partial<OverviewAttentionItem> = {},
): OverviewAttentionItem {
  return {
    schemaVersion: 1,
    attentionId: id,
    tier,
    domain: "sidekick",
    affectedDomains: ["sidekick"],
    code: id,
    title: id,
    summary: id,
    impact: id,
    openedAt: null,
    updatedAt: generatedAt,
    deadline: null,
    urgencyAt: null,
    evidence: [
      {
        status: "current",
        observedAt: generatedAt,
        anchor: null,
        source: "sidekick-store",
        reason: null,
      },
    ],
    relatedActivityId: null,
    relatedFindingId: null,
    primaryAction: { kind: "recheck", target: "connection", label: "Recheck" },
    detailsAction: null,
    ...options,
  };
}

describe("Overview projection", () => {
  it("keeps node-first facts current when the indexed/reference API is behind", () => {
    const result = projectOverview({
      snapshot: snapshot(),
      health: health(),
      connection: null,
      now: new Date(generatedAt),
    });

    expect(() => overviewPageSchema.parse(result)).not.toThrow();
    expect(result.cycle).toMatchObject({
      status: "current",
      rewardCycleId: 141,
      burnBlockHeight: 962_300,
      stacksTipHeight: 8_750_000,
    });
    expect(result.network.status).toBe("advancing");
    expect(result.node.status).toBe("aligned");
    expect(result.signer.status).toBe("healthy");
    expect(result.attention).toEqual([]);
    expect(result.pool.participants).toEqual({ stxOnly: 1, bitcoinBond: 1 });
    expect(result.pool.evidence).toMatchObject([
      { source: "local-node", status: "current" },
      { source: "indexed-api", status: "delayed" },
    ]);
    expect(result.rewards.evidence[0]).toMatchObject({ source: "local-node", status: "current" });
    expect(result.cycle.nextRewardCalculation).toMatchObject({
      status: "scheduled",
      burnBlockHeight: 962_350,
      blocksRemaining: 50,
    });
  });

  it("counts down an anchored reward checkpoint from the displayed local-node burn height", () => {
    const value = snapshot();
    value.preflight.node.burnBlockHeight = 962_301;

    expect(
      projectOverview({ snapshot: value, health: health(), connection: null }).cycle
        .nextRewardCalculation,
    ).toMatchObject({ burnBlockHeight: 962_350, blocksRemaining: 49 });
  });

  it("marks reward calculation due only once the eligible burn block arrives", () => {
    const checkpoint = snapshot();
    checkpoint.preflight.node.burnBlockHeight = 962_349;
    expect(
      projectOverview({ snapshot: checkpoint, health: health(), connection: null }).cycle
        .nextRewardCalculation,
    ).toMatchObject({ status: "scheduled", burnBlockHeight: 962_350, blocksRemaining: 1 });

    const eligible = snapshot();
    eligible.preflight.node.burnBlockHeight = 962_350;
    expect(
      projectOverview({ snapshot: eligible, health: health(), connection: null }).cycle
        .nextRewardCalculation,
    ).toMatchObject({ status: "due", burnBlockHeight: 962_350, blocksRemaining: 0 });
  });

  it("keeps exact PoX-5 outlook available when manager settlement actions are unsupported", () => {
    const value = snapshot();
    if (!value.rewards) throw new Error("Test fixture must include rewards");
    const outlook: NonNullable<DashboardSnapshot["rewardOutlook"]> = {
      pox5ContractId: "SP000000000000000000002Q6VF78.pox-5",
      observedAt: generatedAt,
      chainAnchor,
      accrued: { globalSats: "2500", source: "pox5-get-new-rewards" },
      poolEstimate: {
        kind: "if-calculated-now",
        targetRewardCycle: 141,
        targetCheckpoint: "first-half",
        calculationBurnHeight: 962_349,
        grossSats: "500",
        stxSats: "450",
        bondSats: "50",
        inputs: {
          globalStxSharesUstx: "100000000000",
          managerStxSharesUstx: "20000000000",
          activeBonds: [],
        },
        assumptions: [
          "current-global-accrual",
          "current-cycle-shares",
          "current-active-bond-set",
          "contract-integer-rounding",
        ],
      },
      poolEstimateUnavailableReason: null,
      forecast: {
        kind: "checkpoint-run-rate",
        targetRewardCycle: 141,
        targetCheckpoint: "first-half",
        calculationBurnHeight: 962_349,
        globalSats: { low: "2600", point: "3000", high: "3400" },
        poolSats: { low: "520", point: "600", high: "680" },
        sample: {
          observations: 6,
          firstObservedBurnHeight: 962_277,
          lastObservedBurnHeight: 962_301,
          sampleBlocks: 24,
          elapsedBlocks: 52,
          remainingBlocks: 48,
        },
        confidence: "developing",
        assumptions: [
          "zero-accrual-after-last-calculation",
          "linear-global-accrual-run-rate",
          "current-cycle-shares",
          "current-active-bond-set",
          "unchanged-reserve-before-calculation",
          "contract-integer-rounding",
        ],
      },
      forecastUnavailableReason: null,
      operatorFeeForecast: null,
      operatorFeeForecastUnavailableReason: "reviewed-fee-capability-unavailable",
      calibration: {
        modelRevision: 1,
        status: "collecting",
        eligibleRealizations: 0,
        rewardCycles: 0,
        nonzeroOutcomes: 0,
        rangeHits: 0,
        medianPointErrorBips: null,
        medianRangeWidthBips: null,
        requirements: {
          realizations: 6,
          rewardCycles: 3,
          nonzeroOutcomes: 4,
          rangeHits: 5,
          maxMedianPointErrorBips: "1500",
          maxMedianRangeWidthBips: "5000",
          evaluationLeadBlocks: 144,
          evaluationToleranceBlocks: 12,
        },
      },
      calculation: value.rewards.calculation,
    };
    const valueWithOutlook: DashboardSnapshot = { ...value, rewards: null, rewardOutlook: outlook };
    const result = projectOverview({
      snapshot: valueWithOutlook,
      health: health(),
      connection: null,
      now: new Date(generatedAt),
    });

    expect(result.rewards).toMatchObject({
      status: "ready",
      globalAccruedSats: "2500",
      estimatedPoolRewardSats: "600",
      estimateKind: "checkpoint-forecast",
      confidence: "developing",
      operatorFeeSats: null,
      operatorFeeUnavailableReason: "reviewed-fee-capability-unavailable",
      calculationState: "completed",
      actionableClaims: null,
    });

    outlook.operatorFeeForecast = {
      kind: "reference-manager-exact",
      sats: { low: "24", point: "28", high: "32" },
      inputs: {
        stakers: 2,
        buckets: [{ bondIndex: null, feeBips: "500", source: "cycle-snapshot" }],
      },
      assumptions: ["per-staker-per-bucket-integer-rounding"],
    };
    outlook.operatorFeeForecastUnavailableReason = null;
    expect(
      projectOverview({ snapshot: valueWithOutlook, health: health(), connection: null }).rewards,
    ).toMatchObject({
      operatorFeeSats: "28",
      operatorFeeUnavailableReason: null,
    });

    outlook.forecast = null;
    outlook.forecastUnavailableReason = "insufficient-samples";
    outlook.operatorFeeForecast = null;
    outlook.operatorFeeForecastUnavailableReason = "reviewed-fee-capability-unavailable";

    expect(
      projectOverview({ snapshot: valueWithOutlook, health: health(), connection: null }).rewards,
    ).toMatchObject({
      estimatedPoolRewardSats: "500",
      estimateKind: "if-calculated-now",
      confidence: "contract-exact",
      operatorFeeSats: null,
      operatorFeeUnavailableReason: "reviewed-fee-capability-unavailable",
    });

    outlook.operatorFeeEstimate = {
      kind: "reference-manager-exact",
      sats: "25",
      inputs: {
        stakers: 2,
        buckets: [{ bondIndex: null, feeBips: "500", source: "cycle-snapshot" }],
      },
      assumptions: ["per-staker-per-bucket-integer-rounding"],
    };
    outlook.operatorFeeEstimateUnavailableReason = null;
    const currentEstimate = projectOverview({
      snapshot: valueWithOutlook,
      health: health(),
      connection: null,
    });
    expect(currentEstimate.rewards).toMatchObject({
      estimatedPoolRewardSats: "500",
      estimateKind: "if-calculated-now",
      confidence: "contract-exact",
      operatorFeeSats: "25",
      operatorFeeUnavailableReason: null,
    });
    expect(() => overviewPageSchema.parse(currentEstimate)).not.toThrow();
  });

  it("suppresses derived safe-mode noise but retains ambiguity and Activity coverage warnings", () => {
    const belowThreshold = forecastCycle(142, false, "-100000000");
    const unhealthy = health({
      findings: [
        healthFinding({
          id: "node-rpc-unavailable",
          severity: "critical",
          title: "Node unavailable",
          detail: "Three failures",
          source: "node",
        }),
      ],
    });
    const result = projectOverview({
      snapshot: snapshot({
        registration: {
          registered: false,
          signerKeyHex: null,
          signerKeyGrantValid: false,
          reason: "missing",
        },
        forecast: {
          status: "attention",
          ingestion: { activeDiscoveredStakers: 2, completedAt: generatedAt },
          cycles: [forecastCycle(141, true, "100000000"), belowThreshold],
        },
      }),
      health: unhealthy,
      activity: activity([
        activityGroup(
          "update-fees",
          "needs-attention",
          "ambiguous",
          "wallet-intent:4e011bf7-f291-42c4-a35b-ab299a87ff8c",
        ),
      ]),
      activitySource: {
        status: "unavailable",
        observedAt: generatedAt,
        reason: "Durable Activity projection could not be read.",
      },
      connection: {
        schemaVersion: 1,
        status: "blocked",
        outcomeCode: "deployment-identity-mismatch",
        checkedAt: generatedAt,
        stale: false,
        configured: {
          network: "mainnet",
          networkId: 1,
          nodeRpcUrl: "http://node",
          managerPrincipal,
        },
        observed: null,
        lastSuccessful: null,
        deploymentIdentity: { status: "mismatch", stored: null, reason: "Stored manager differs" },
        checks: [
          { id: "deployment-identity", status: "fail", message: "mismatch" },
          { id: "node-network", status: "pass", message: "pass" },
          { id: "pox5", status: "pass", message: "pass" },
          { id: "principal-network", status: "pass", message: "pass" },
          { id: "manager-trait", status: "pass", message: "pass" },
        ],
      },
      now: new Date(generatedAt),
    });

    const attentionIds = result.attention.map(({ attentionId }) => attentionId);
    expect(attentionIds).toHaveLength(3);
    expect(attentionIds).toEqual(
      expect.arrayContaining([
        "connection:deployment-identity",
        "wallet-intent:4e011bf7-f291-42c4-a35b-ab299a87ff8c",
        "sidekick:activity-unavailable",
      ]),
    );
    expect(attentionIds).not.toContain("health:node-rpc-unavailable");
    expect(attentionIds).not.toContain("pool:threshold:142");
  });

  it("absorbs grant consequences into one actionable registration repair", () => {
    const result = projectOverview({
      snapshot: snapshot({
        registration: {
          registered: false,
          signerKeyHex: null,
          signerKeyGrantValid: false,
          reason: "missing",
        },
      }),
      health: health(),
      connection: null,
      now: new Date(generatedAt),
    });

    expect(result.attention).toHaveLength(1);
    expect(result.attention[0]).toMatchObject({
      attentionId: "signer:registration-missing",
      tier: "urgent",
      primaryAction: { kind: "launch-operation", operation: "register-self" },
    });
  });

  it("does not recreate first-time setup as register-self without expected participation", () => {
    const result = projectOverview({
      snapshot: snapshot({
        registration: {
          registered: false,
          signerKeyHex: null,
          signerKeyGrantValid: false,
          reason: "missing",
        },
        forecast: {
          status: "attention",
          ingestion: null,
          cycles: [],
        },
      }),
      health: health(),
      connection: null,
      now: new Date(generatedAt),
    });

    expect(result.attention).toHaveLength(1);
    expect(result.attention[0]).toMatchObject({
      attentionId: "signer:registration-missing",
      tier: "needs-attention",
      primaryAction: { kind: "open-settings", section: "capabilities" },
    });
  });

  it("keeps local-node findings distinct from network findings", () => {
    const result = projectOverview({
      snapshot: snapshot(),
      health: health({
        findings: [
          healthFinding({
            id: "node-behind-network",
            severity: "critical",
            title: "Local node is behind",
            detail: "The local node remained behind its peers.",
            source: "node",
          }),
        ],
      }),
      connection: null,
      now: new Date(generatedAt),
    });

    expect(result.node.status).toBe("behind");
    expect(result.attention[0]).toMatchObject({
      domain: "node",
      affectedDomains: ["node", "signer", "pool", "rewards"],
    });
  });

  it("keeps an ambiguous signer finding in the signer domain", () => {
    const result = projectOverview({
      snapshot: snapshot(),
      health: health({
        findings: [
          healthFinding({
            id: "signer-rejection-rate-elevated",
            severity: "warning",
            title: "Signer rejection rate is elevated",
            detail: "Recent signer responses rejected an elevated share of proposals.",
            source: "signer",
            classification: "source-disagreement",
          }),
        ],
      }),
      connection: null,
      now: new Date(generatedAt),
    });

    expect(result.signer.status).toBe("needs-attention");
    expect(result.network.status).toBe("advancing");
    expect(result.attention[0]).toMatchObject({ domain: "signer" });
  });

  it("uses a distinct configured API when the public reference is absent", () => {
    const result = projectOverview({
      snapshot: snapshot(),
      health: health({
        hiro: {
          source: source("not-configured"),
          stacksTipHeight: null,
          burnBlockHeight: null,
          localStacksDifference: null,
          localBurnDifference: null,
          lastTipAdvanceAt: null,
          advancementStatus: "insufficient-evidence",
        },
        configuredApi: {
          distinctFromReference: true,
          source: source(),
          stacksTipHeight: 8_750_000,
          burnBlockHeight: 962_300,
          localStacksDifference: 0,
          localBurnDifference: 0,
          lastTipAdvanceAt: generatedAt,
          advancementStatus: "advancing",
        },
      }),
      connection: null,
      now: new Date(generatedAt),
    });

    expect(result.network).toMatchObject({
      status: "advancing",
      reference: "configured indexed API",
      stacksTipHeight: 8_750_000,
    });
  });

  it("keeps a participating signer's node outage urgent and suppresses the derived connection symptom", () => {
    const result = projectOverview({
      snapshot: snapshot(),
      health: health({
        findings: [
          healthFinding({
            id: "node-rpc-unavailable",
            severity: "critical",
            title: "Node unavailable",
            detail: "The local node failed its persistence threshold.",
            source: "node",
          }),
        ],
      }),
      connection: connection(),
      now: new Date(generatedAt),
    });

    expect(result.attention).toHaveLength(1);
    expect(result.attention[0]).toMatchObject({
      attentionId: "health:node-rpc-unavailable",
      tier: "urgent",
    });
  });

  it("marks retained connection evidence delayed when the current check is stale", () => {
    const result = projectOverview({
      snapshot: snapshot(),
      health: health(),
      connection: connection({ status: "blocked", stale: true }),
      now: new Date(generatedAt),
    });
    expect(result.attention[0]?.evidence[0]).toMatchObject({ status: "delayed" });
  });

  it("does not call an old reachable reference actively advancing", () => {
    const result = projectOverview({
      snapshot: snapshot(),
      health: health({
        hiro: {
          ...health().hiro,
          lastTipAdvanceAt: "2026-08-14T11:00:00.000Z",
          advancementStatus: "insufficient-evidence",
        },
      }),
      connection: null,
      now: new Date(generatedAt),
    });

    expect(result.network.status).toBe("insufficient-evidence");
  });

  it("uses canonical Activity status instead of reinterpreting engine state", () => {
    const result = projectOverview({
      snapshot: snapshot(),
      health: health(),
      connection: null,
      activity: activity([activityGroup("awaiting-approval", "action-required", "pending")]),
      now: new Date(generatedAt),
    });

    expect(result.inProgress).toEqual([]);
    expect(result.attention[0]).toMatchObject({
      tier: "action-required",
      relatedActivityId: "engine-job:00000000-0000-4000-8000-000000000001",
    });
  });

  it("keeps distinct Activity groups even when they match the same domain reminder scope", () => {
    const blocked = activityGroup(
      "claim-rewards",
      "needs-attention",
      "failed",
      "engine-job:00000000-0000-4000-8000-000000000001",
    );
    const actionable = activityGroup(
      "claim-rewards",
      "action-required",
      "pending",
      "engine-job:00000000-0000-4000-8000-000000000002",
    );
    const result = overview({ activity: activity([blocked, actionable]) });

    expect(result.attention.map(({ attentionId }) => attentionId)).toEqual([
      actionable.activityId,
      blocked.activityId,
    ]);
  });

  it("replaces stale registration repair with a bounded evidence refresh", () => {
    const result = projectOverview({
      snapshot: snapshot({
        registration: {
          registered: false,
          signerKeyHex: null,
          signerKeyGrantValid: false,
          reason: "missing",
        },
        freshness: {
          status: "stale",
          snapshotGeneratedAt: generatedAt,
          servedAt: "2026-08-14T12:05:00.000Z",
          reason: "refresh-failed",
        },
      }),
      health: health(),
      connection: null,
      now: new Date("2026-08-14T12:05:00.000Z"),
    });

    expect(
      result.attention.find(({ attentionId }) => attentionId === "signer:registration-missing"),
    ).toMatchObject({
      tier: "urgent",
      primaryAction: { kind: "recheck", target: "node" },
      evidence: [{ status: "delayed" }],
    });
  });

  it("uses unavailable roster evidence instead of offering an under-evidenced threshold action", () => {
    const next = forecastCycle(142, false, "-100000000");
    next.local.rosterAvailable = false;
    const result = projectOverview({
      snapshot: snapshot({
        forecast: {
          status: "attention",
          ingestion: null,
          cycles: [forecastCycle(141, true, "100000000"), next],
        },
      }),
      health: health(),
      connection: null,
      now: new Date(generatedAt),
    });

    expect(result.attention.map(({ attentionId }) => attentionId)).toEqual([
      "pool:roster-unavailable:142",
    ]);
    expect(result.attention[0]?.primaryAction).toMatchObject({ kind: "recheck", target: "api" });
  });

  it("names a fixed-cycle exclusion without offering to repair the closed cycle", () => {
    const base = snapshot();
    const result = projectOverview({
      snapshot: snapshot({
        preflight: {
          ...base.preflight,
          cycle: {
            ...base.preflight.cycle,
            isPreparePhase: true,
            blocksUntilPreparePhase: 0,
          },
        },
        forecast: {
          status: "attention",
          ingestion: { activeDiscoveredStakers: 2, completedAt: generatedAt },
          cycles: [
            forecastCycle(141, true, "100000000"),
            forecastCycle(142, false, "-100000000"),
            forecastCycle(143, true, "100000000"),
          ],
        },
      }),
      health: health(),
      connection: null,
      now: new Date(generatedAt),
    });

    expect(result.attention).toHaveLength(1);
    expect(result.attention[0]).toMatchObject({
      attentionId: "pool:fixed-cycle-exclusion:142",
      tier: "needs-attention",
      primaryAction: { kind: "open-domain", page: "pool", section: "forecast" },
    });
  });

  it("uses the next changeable cycle's prepare deadline after the current window closes", () => {
    const base = snapshot();
    const result = projectOverview({
      snapshot: snapshot({
        preflight: {
          ...base.preflight,
          cycle: {
            ...base.preflight.cycle,
            isPreparePhase: true,
            blocksUntilPreparePhase: 0,
          },
        },
        forecast: {
          status: "attention",
          ingestion: { activeDiscoveredStakers: 2, completedAt: generatedAt },
          cycles: [
            forecastCycle(141, true, "100000000"),
            forecastCycle(142, false, "-100000000"),
            forecastCycle(143, false, "-100000000"),
          ],
        },
      }),
      health: health(),
      connection: null,
      now: new Date(generatedAt),
    });

    expect(
      result.attention.find(({ attentionId }) => attentionId === "pool:threshold:143"),
    ).toMatchObject({
      deadline: { kind: "burn-block", burnBlockHeight: 965_400 },
    });
  });

  it("surfaces a due reward calculation without advertising an unimplemented transaction action", () => {
    const base = snapshot();
    if (base.rewards === null) throw new Error("Test fixture must include rewards");
    const result = projectOverview({
      snapshot: snapshot({
        rewards: {
          ...base.rewards,
          calculation: {
            state: "pending",
            targetRewardCycle: 141,
            targetCheckpoint: "first-half",
            expectedLastRewardComputeBurnHeight: 962_299,
            observedLastRewardComputeBurnHeight: "962000",
            next: {
              state: "due",
              targetRewardCycle: 141,
              targetCheckpoint: "first-half",
              calculationBurnHeight: 962_299,
              eligibleBurnHeight: 962_300,
              blocksRemaining: 0,
              grace: {
                state: "action-required",
                firstEligibleObservedAt: "2026-08-13T11:50:00.000Z",
                firstEligibleStacksBlockHeight: 8_599_976,
                elapsedMinutes: 10,
                canonicalStacksBlocks: 24,
                requiredMinutes: 10,
                requiredCanonicalStacksBlocks: 24,
              },
            },
          },
        },
      }),
      health: health(),
      connection: null,
      now: new Date(generatedAt),
    });

    expect(result.attention[0]).toMatchObject({
      attentionId: "rewards:calculation-due:141:first-half",
      tier: "action-required",
      deadline: { kind: "burn-block", burnBlockHeight: 962_299 },
      primaryAction: { kind: "open-domain", page: "rewards", section: "calculation" },
    });
  });

  it("offers reviewed staker settlements and lets existing Activity absorb the reminder", () => {
    const base = snapshot();
    if (base.rewards === null) throw new Error("Test fixture must include rewards");
    const claimSnapshot = snapshot({
      manager: {
        ...base.manager,
        capabilities: {
          ...base.manager.capabilities,
          actions: [
            ...base.manager.capabilities.actions,
            {
              id: "reference-reward-claims",
              interfaceAvailable: true,
              executionAvailable: true,
              missingFunctions: [],
              adapter: { id: "reference-reward-claims", revision: 1, reviewedSourceSha256: "aa" },
              reason: "reviewed",
            },
          ],
        },
      },
      rewards: {
        ...base.rewards,
        totals: { ...base.rewards.totals, actionableClaims: 1 },
      },
    });
    const due = projectOverview({
      snapshot: claimSnapshot,
      health: health(),
      connection: null,
      now: new Date(generatedAt),
    });
    expect(due.attention[0]).toMatchObject({
      attentionId: "rewards:claims-due:141",
      tier: "action-required",
      primaryAction: { kind: "open-domain", page: "rewards", section: "claims" },
    });

    const active = activityGroup("claim-staker-rewards", "action-required", "pending");
    const resumed = projectOverview({
      snapshot: claimSnapshot,
      health: health(),
      connection: null,
      activity: activity([active]),
      now: new Date(generatedAt),
    });
    expect(resumed.attention).toHaveLength(1);
    expect(resumed.attention[0]).toMatchObject({
      attentionId: active.activityId,
      relatedActivityId: active.activityId,
      primaryAction: { kind: "resume-activity", activityId: active.activityId },
    });

    const stale = { ...active, operationScope: "claim-staker-rewards:140" };
    const staleResult = projectOverview({
      snapshot: claimSnapshot,
      health: health(),
      connection: null,
      activity: activity([stale]),
      now: new Date(generatedAt),
    });
    expect(staleResult.attention).toHaveLength(2);
    expect(staleResult.attention.map(({ attentionId }) => attentionId)).toEqual(
      expect.arrayContaining(["rewards:claims-due:141", stale.activityId]),
    );
  });

  it("does not silently hide active operations when their source is unavailable", () => {
    const result = projectOverview({
      snapshot: snapshot(),
      health: health(),
      connection: null,
      activitySource: {
        status: "unavailable",
        observedAt: generatedAt,
        reason: "The durable operation repository could not be read.",
      },
      now: new Date(generatedAt),
    });

    expect(result.attention[0]).toMatchObject({
      attentionId: "sidekick:activity-unavailable",
      tier: "needs-attention",
      primaryAction: { kind: "recheck", target: "activity" },
    });
  });

  it("shows observer degradation only after fallback misses the projection freshness budget", () => {
    const healthyFallback = projectOverview({
      snapshot: snapshot(),
      health: health(),
      connection: null,
      observerGap: {
        status: "degraded",
        nodeStacksHeight: 8_750_000,
        observerStacksHeight: 8_749_990,
        observerSilenceSeconds: 120,
      },
      now: new Date(generatedAt),
    });
    expect(healthyFallback.attention).toEqual([]);

    const delayed = projectOverview({
      snapshot: snapshot({
        freshness: {
          status: "stale",
          snapshotGeneratedAt: generatedAt,
          servedAt: "2026-08-14T12:05:00.000Z",
          reason: "refresh-failed",
        },
      }),
      health: health(),
      connection: null,
      observerGap: {
        status: "degraded",
        nodeStacksHeight: 8_750_000,
        observerStacksHeight: 8_749_990,
        observerSilenceSeconds: 300,
      },
      now: new Date("2026-08-14T12:05:00.000Z"),
    });
    expect(delayed.attention.map(({ attentionId }) => attentionId)).toEqual([
      "sidekick:observer-projection-delayed",
    ]);
  });

  it("pins tier, deadline, urgency, opened-at, and stable-ID ordering", () => {
    const items = [
      attention("needs", "needs-attention"),
      attention("future", "action-required", {
        deadline: { kind: "burn-block", burnBlockHeight: 200, estimatedAt: null },
      }),
      attention("no-deadline", "action-required"),
      attention("overdue-late", "action-required", {
        deadline: { kind: "burn-block", burnBlockHeight: 90, estimatedAt: null },
        urgencyAt: "2026-08-14T13:00:00.000Z",
      }),
      attention("overdue-early", "action-required", {
        deadline: { kind: "burn-block", burnBlockHeight: 90, estimatedAt: null },
        urgencyAt: "2026-08-14T12:30:00.000Z",
      }),
      attention("urgent", "urgent"),
    ];
    expect(
      sortOverviewAttention(items, {
        now: new Date(generatedAt),
        burnBlockHeight: 100,
        rewardCycleId: 141,
        phase: "reward",
      }).map(({ attentionId }) => attentionId),
    ).toEqual(["urgent", "overdue-early", "overdue-late", "future", "no-deadline", "needs"]);
  });

  it("prefers an existing Activity group for the same operation scope", () => {
    const domain: OverviewAttentionCandidate = {
      conditionKey: "rewards:claim-due",
      operationScope: "claim:141",
      authority: "domain",
      item: attention("domain", "action-required"),
    };
    const activity: OverviewAttentionCandidate = {
      conditionKey: "activity:claim-141",
      operationScope: "claim:141",
      authority: "activity",
      item: attention("activity", "action-required", {
        relatedActivityId: "engine-job:one",
        primaryAction: {
          kind: "resume-activity",
          activityId: "engine-job:one",
          label: "Resume claim",
        },
      }),
    };
    expect(
      correlateOverviewAttention([domain, activity], {
        now: new Date(generatedAt),
        burnBlockHeight: 962_300,
        rewardCycleId: 141,
        phase: "reward",
      }).map(({ attentionId }) => attentionId),
    ).toEqual(["activity"]);
  });

  it("does not let a suppressed symptom continue suppressing another reminder", () => {
    expect(
      correlateOverviewAttention(
        [
          { conditionKey: "derived", item: attention("derived", "needs-attention") },
          {
            conditionKey: "middle",
            item: attention("middle", "needs-attention"),
            suppresses: ["derived"],
          },
          {
            conditionKey: "root",
            item: attention("root", "urgent"),
            suppresses: ["middle"],
          },
        ],
        {
          now: new Date(generatedAt),
          burnBlockHeight: 100,
          rewardCycleId: 141,
          phase: "reward",
        },
      ).map(({ attentionId }) => attentionId),
    ).toEqual(["root", "derived"]);
  });

  it("fails open when suppression metadata contains a cycle", () => {
    expect(
      correlateOverviewAttention(
        [
          {
            conditionKey: "first",
            item: attention("first", "needs-attention"),
            suppresses: ["second"],
          },
          {
            conditionKey: "second",
            item: attention("second", "needs-attention"),
            suppresses: ["first"],
          },
        ],
        {
          now: new Date(generatedAt),
          burnBlockHeight: 100,
          rewardCycleId: 141,
          phase: "reward",
        },
      ).map(({ attentionId }) => attentionId),
    ).toEqual(["first", "second"]);
  });

  const inclusionPolicyCases: Array<{
    name: string;
    run(): ReturnType<typeof projectOverview>;
    attentionIds: string[];
    inProgressIds?: string[];
  }> = [
    {
      name: "deployment identity mismatch",
      run: () =>
        overview({
          connection: connection({
            status: "blocked",
            outcomeCode: "deployment-identity-mismatch",
            deploymentIdentity: { status: "mismatch", stored: null, reason: "Identity mismatch" },
          }),
        }),
      attentionIds: ["connection:deployment-identity"],
    },
    {
      name: "persisted local-node outage",
      run: () =>
        overview({
          health: health({
            findings: [
              healthFinding({
                id: "node-rpc-unavailable",
                severity: "critical",
                title: "Node unavailable",
                detail: "Persisted failure",
                source: "node",
              }),
            ],
          }),
          connection: connection(),
        }),
      attentionIds: ["health:node-rpc-unavailable"],
    },
    {
      name: "persisted signer outage",
      run: () =>
        overview({
          health: health({
            findings: [
              healthFinding({
                id: "signer-node-heartbeat-failed",
                severity: "critical",
                title: "Signer heartbeat failed",
                detail: "Persisted failure",
                source: "signer",
              }),
            ],
          }),
        }),
      attentionIds: ["health:signer-node-heartbeat-failed"],
    },
    {
      name: "signer monitoring not configured",
      run: () => {
        const value = health();
        value.signer.infoSource = source("not-configured");
        return overview({ health: value });
      },
      attentionIds: ["signer:monitoring-not-configured"],
    },
    {
      name: "day-two registration repair",
      run: () =>
        overview({
          snapshot: changedSnapshot((value) => {
            value.registration = {
              registered: false,
              signerKeyHex: null,
              signerKeyGrantValid: false,
              reason: "missing",
            };
          }),
        }),
      attentionIds: ["signer:registration-missing"],
    },
    {
      name: "actionable-cycle threshold deficit",
      run: () =>
        overview({
          snapshot: changedSnapshot((value) => {
            value.forecast = {
              status: "attention",
              ingestion: { activeDiscoveredStakers: 2, completedAt: generatedAt },
              cycles: [
                forecastCycle(141, true, "100000000"),
                forecastCycle(142, false, "-100000000"),
              ],
            };
          }),
        }),
      attentionIds: ["pool:threshold:142"],
    },
    {
      name: "fixed-cycle exclusion",
      run: () =>
        overview({
          snapshot: changedSnapshot((value) => {
            value.preflight.cycle.isPreparePhase = true;
            value.preflight.cycle.blocksUntilPreparePhase = 0;
            value.forecast = {
              status: "attention",
              ingestion: { activeDiscoveredStakers: 2, completedAt: generatedAt },
              cycles: [
                forecastCycle(141, true, "100000000"),
                forecastCycle(142, false, "-100000000"),
                forecastCycle(143, true, "100000000"),
              ],
            };
          }),
        }),
      attentionIds: ["pool:fixed-cycle-exclusion:142"],
    },
    {
      name: "Activity action required",
      run: () =>
        overview({
          activity: activity([activityGroup("claim-rewards", "action-required", "pending")]),
        }),
      attentionIds: ["engine-job:00000000-0000-4000-8000-000000000001"],
    },
    {
      name: "Activity in progress",
      run: () => {
        const group = activityGroup("claim-rewards", "in-progress", "pending");
        group.stage = "broadcast";
        return overview({ activity: activity([group]) });
      },
      attentionIds: [],
      inProgressIds: ["engine-job:00000000-0000-4000-8000-000000000001"],
    },
    {
      name: "Activity authority unavailable",
      run: () =>
        overview({
          activitySource: {
            status: "unavailable",
            observedAt: generatedAt,
            reason: "Repository unavailable",
          },
        }),
      attentionIds: ["sidekick:activity-unavailable"],
    },
    {
      name: "reward calculation due",
      run: () =>
        overview({
          snapshot: changedSnapshot((value) => {
            if (value.rewards === null) throw new Error("Test fixture must include rewards");
            value.rewards.calculation = {
              state: "pending",
              targetRewardCycle: 141,
              targetCheckpoint: "first-half",
              expectedLastRewardComputeBurnHeight: 962_299,
              observedLastRewardComputeBurnHeight: "962000",
              next: {
                state: "due",
                targetRewardCycle: 141,
                targetCheckpoint: "first-half",
                calculationBurnHeight: 962_299,
                eligibleBurnHeight: 962_300,
                blocksRemaining: 0,
                grace: {
                  state: "action-required",
                  firstEligibleObservedAt: "2026-08-13T11:50:00.000Z",
                  firstEligibleStacksBlockHeight: 8_599_976,
                  elapsedMinutes: 10,
                  canonicalStacksBlocks: 24,
                  requiredMinutes: 10,
                  requiredCanonicalStacksBlocks: 24,
                },
              },
            };
          }),
        }),
      attentionIds: ["rewards:calculation-due:141:first-half"],
    },
    {
      name: "normal pending withdrawal",
      run: () =>
        overview({
          snapshot: changedSnapshot((value) => {
            value.activity.pendingWithdrawalTotal = 1;
          }),
        }),
      attentionIds: [],
    },
    {
      name: "roster delay without a blocked decision",
      run: () =>
        overview({
          snapshot: changedSnapshot((value) => {
            const next = forecastCycle(142, true, "100000000");
            next.local.rosterAvailable = false;
            value.forecast = { status: "attention", ingestion: null, cycles: [next] };
          }),
        }),
      attentionIds: [],
    },
    {
      name: "reference API behind local node",
      run: () => overview(),
      attentionIds: [],
    },
    {
      name: "custom manager provenance only",
      run: () =>
        overview({
          snapshot: changedSnapshot((value) => {
            value.manager.source = {
              ...value.manager.source,
              profileId: null,
              tier: "unrecognized",
              origin: null,
              recognized: false,
            };
            value.manager.provenance = {
              status: "failed",
              upstreamProfileId: null,
              reason: "unrecognized",
            };
          }),
        }),
      attentionIds: [],
    },
    {
      name: "profile issue that blocks a due repair",
      run: () =>
        overview({
          snapshot: changedSnapshot((value) => {
            value.manager.installedProfiles = {
              directory: "/profiles",
              loaded: 0,
              issues: [{ fileName: "broken.json", code: "invalid", message: "Invalid" }],
            };
            value.manager.capabilities.actions = value.manager.capabilities.actions.map(
              (capability) => ({ ...capability, executionAvailable: false }),
            );
            value.registration = {
              registered: false,
              signerKeyHex: null,
              signerKeyGrantValid: false,
              reason: "missing",
            };
          }),
        }),
      attentionIds: ["signer:registration-missing"],
    },
    {
      name: "observer gap inside fallback budget",
      run: () =>
        overview({
          observerGap: {
            status: "degraded",
            nodeStacksHeight: 8_750_000,
            observerStacksHeight: 8_749_990,
            observerSilenceSeconds: 120,
          },
        }),
      attentionIds: [],
    },
    {
      name: "signer baseline collection",
      run: () => {
        const value = health();
        value.signer.lastHour.collectingBaseline = true;
        return overview({ health: value });
      },
      attentionIds: [],
    },
  ];

  it.each(inclusionPolicyCases)("applies the inclusion policy for $name", ({
    run,
    attentionIds,
    inProgressIds = [],
  }) => {
    const result = run();
    expect(result.attention.map(({ attentionId }) => attentionId)).toEqual(attentionIds);
    expect(result.inProgress.map(({ activityId }) => activityId)).toEqual(inProgressIds);
  });

  it("shows the authoritative Activity stage for in-progress work", () => {
    const group = activityGroup("claim-rewards", "in-progress", "pending");
    group.stage = "broadcast";

    expect(overview({ activity: activity([group]) }).inProgress[0]?.stage).toBe("broadcast");
  });
});
