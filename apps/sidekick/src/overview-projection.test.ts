import {
  type DashboardSnapshot,
  type EngineJobSummary,
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
        signerEarnedBeforeManagerClaimSats: "1000",
        signerEarnedAcrossBucketsSats: "1500",
      },
      calculation: {
        state: "completed" as const,
        targetRewardCycle: 141,
        targetCheckpoint: "first-half" as const,
        expectedLastRewardComputeBurnHeight: 962_299,
        observedLastRewardComputeBurnHeight: "962299",
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
        actionableClaims: 2,
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

function health(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
  const base = {
    generatedAt,
    overallStatus: "healthy" as const,
    coverage: { available: 20, total: 20 },
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

function engineJob(
  state: EngineJobSummary["state"],
  approvalState: EngineJobSummary["approvalState"] = "not-required",
): EngineJobSummary {
  return {
    jobId: "00000000-0000-4000-8000-000000000001",
    mode: "observe",
    state,
    blockReason: state === "blocked" ? "A required witness is unavailable." : null,
    adapter: { id: "reference-reward-claims", revision: 1 },
    network: "mainnet",
    managerPrincipal,
    contract: managerPrincipal,
    functionName: "claim-rewards",
    rewardCycle: 141,
    approvalState,
    updatedAt: generatedAt,
  };
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
      burnBlockHeight: 962_349,
      blocksRemaining: 49,
    });
  });

  it("returns one safe-mode root cause and suppresses derived signer, health, and pool symptoms", () => {
    const belowThreshold = forecastCycle(142, false, "-100000000");
    const unhealthy = health({
      findings: [
        {
          id: "node-rpc-unavailable",
          severity: "critical",
          title: "Node unavailable",
          detail: "Three failures",
          source: "node",
        },
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

    expect(result.attention.map(({ attentionId }) => attentionId)).toEqual([
      "connection:deployment-identity",
    ]);
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
          {
            id: "node-behind-network",
            severity: "critical",
            title: "Local node is behind",
            detail: "The local node remained behind its peers.",
            source: "node",
          },
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

  it.each([
    "prepared",
    "preflighted",
    "awaiting_approval",
  ] as const)("maps %s engine work to action required rather than in progress", (state) => {
    const result = projectOverview({
      snapshot: snapshot(),
      health: health(),
      connection: null,
      engineJobs: [engineJob(state, "awaiting")],
      now: new Date(generatedAt),
    });

    expect(result.inProgress).toEqual([]);
    expect(result.attention[0]).toMatchObject({
      tier: "action-required",
      relatedActivityId: "engine-job:00000000-0000-4000-8000-000000000001",
    });
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
    ).toEqual(["urgent", "overdue-early", "overdue-late", "future", "needs"]);
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
});
