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

function activityGroup(
  code: string,
  displayStatus: ActivityGroupSummary["displayStatus"],
  outcome: ActivityGroupSummary["outcome"],
): ActivityGroupSummary {
  const activityId = "engine-job:00000000-0000-4000-8000-000000000001";
  return {
    schemaVersion: 1,
    activityId,
    kind: "operation",
    domain: "rewards",
    code,
    title: "Claim rewards",
    summary: "The reward claim is waiting for approval.",
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

  it("keeps a participating signer's node outage urgent and suppresses the derived connection symptom", () => {
    const result = projectOverview({
      snapshot: snapshot(),
      health: health({
        findings: [
          {
            id: "node-rpc-unavailable",
            severity: "critical",
            title: "Node unavailable",
            detail: "The local node failed its persistence threshold.",
            source: "node",
          },
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
          },
        },
      }),
      health: health(),
      connection: null,
      now: new Date(generatedAt),
    });

    expect(result.attention[0]).toMatchObject({
      attentionId: "rewards:calculation-due:141:first-half",
      tier: "needs-attention",
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
              {
                id: "node-rpc-unavailable",
                severity: "critical",
                title: "Node unavailable",
                detail: "Persisted failure",
                source: "node",
              },
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
              {
                id: "signer-node-heartbeat-failed",
                severity: "critical",
                title: "Signer heartbeat failed",
                detail: "Persisted failure",
                source: "signer",
              },
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
      run: () =>
        overview({
          activity: activity([activityGroup("claim-rewards", "in-progress", "pending")]),
        }),
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
});
