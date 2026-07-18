const managerPrincipal = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.signer-manager";

function principal(index) {
  return `ST${String(index).padStart(38, "0")}`;
}

export const roster = Array.from({ length: 237 }, (_, index) => ({
  stakerPrincipal: principal(index + 1),
  active: index % 11 !== 0,
  hasStx: true,
  stxNodeVerified: index % 17 !== 0,
  position: {
    amountUstx: String(40_000_000_000 + index * 250_000_000),
    firstRewardCycle: String(101 + (index % 35)),
    numCycles: String(2 + (index % 12)),
    unlockCycle: String(140 + (index % 14)),
    unlockBurnHeight: String(9_400 + (index % 14) * 2_100),
    active: index % 11 !== 0,
  },
}));

export const rewardStakers = roster.map((entry, index) => ({
  stakerPrincipal: entry.stakerPrincipal,
  payout: { kind: index % 3 === 0 ? "l1" : "direct", maxFeeSats: index % 3 === 0 ? "900" : null },
  rewards: {
    earnedSats: String(25_000 + index * 100),
    feeSats: String(250 + index),
    grossSats: String(25_250 + index * 101),
  },
  claimableByPolicy: index % 7 !== 0,
}));

export const cycleHistory = Array.from({ length: 48 }, (_, index) => ({
  rewardCycle: 139 - index,
  status: index % 9 === 0 ? "attention" : "ready",
  observedBurnBlockHeight: 9_240 - index * 2_100,
  stakerCount: Math.max(3, 237 - index * 4),
  grossSats: String(2_500_000 - index * 15_000),
  earnedSats: String(2_475_000 - index * 14_850),
  feeSats: String(25_000 - index * 150),
  configuredFeeBips: "100",
  feeSnapshotBips: "100",
  actionableClaims: index % 6,
}));

const claims = Array.from({ length: 318 }, (_, index) => ({
  txId: `0x${String(index + 1).padStart(64, "0")}`,
  eventIndex: index % 4,
  blockHeight: 14_000 - index,
  stakerPrincipal: roster[index % roster.length].stakerPrincipal,
  rewardCycle: String(139 - (index % 48)),
  amountSats: String(20_000 + index),
  destination: index % 3 === 0 ? "bitcoin" : "sbtc",
  withdrawalRequestId: index % 3 === 0 ? String(index) : null,
}));

const withdrawals = Array.from({ length: 71 }, (_, index) => ({
  requestId: String(index + 1),
  stakerPrincipal: roster[index % roster.length].stakerPrincipal,
  amountSats: String(18_000 + index * 10),
  maxFeeSats: "900",
  initiatedBlockHeight: 13_000 - index,
  state: index % 5 === 0 ? "pending" : index % 7 === 0 ? "reclaimed" : "settled",
}));

export const runtimeSettings = {
  schemaVersion: 1,
  revision: 12,
  updatedAt: "2026-07-15T12:00:00.000Z",
  pool: {
    displayName: "Sidekick Test Pool",
    websiteUrl: "https://pool.example",
    supportContact: "ops@pool.example",
    leatherUrl: "https://earn.leather.io",
  },
  display: {
    defaultTheme: "light",
  },
  dataSources: {
    nodeRpcUrl: "http://stacks-node:20443",
    apiUrl: "http://stacks-api:3999",
    apiKeyHeader: "x-api-key",
    apiKeyConfigured: true,
    apiKeySource: "environment",
    nodeMetricsUrl: "http://stacks-node:9153",
    signerMonitoringUrl: "http://stacks-signer:9153",
    hiroReferenceApiUrl: "https://api.testnet-pox5.hiro.so",
  },
  forecast: { horizonCycles: 6 },
  embed: { publicApiUrl: "https://pool.example/sidekick" },
  audit: [
    { revision: 12, changedFields: ["pool.displayName"], changedAt: "2026-07-15T12:00:00.000Z" },
  ],
};

export const snapshot = {
  generatedAt: "2026-07-15T12:10:00.000Z",
  network: "devnet",
  managerPrincipal,
  config: {
    nodeRpcUrl: "http://stacks-node:20443",
    apiUrl: "http://stacks-api:3999",
    apiKeyConfigured: true,
    forecastHorizonCycles: 6,
  },
  runtimeSettings,
  preflight: {
    status: "pass",
    node: {
      networkId: 0x80000005,
      serverVersion: "stacks-node 4.0.1 (62e03cc, release build, linux [x86_64])",
      version: "4.0.1",
      commit: "62e03cc",
      burnBlockHeight: 9_240,
      stacksTipHeight: 14_200,
    },
    api: {
      serverVersion: "stacks-blockchain-api v9.0.1",
      burnBlockHeight: 9_240,
      stacksTipHeight: 14_200,
      burnBlockLag: 0,
    },
    pox: {
      rewardCycleId: 139,
      activationState: "active",
      blocksUntilActivation: 0,
      pox5Available: true,
      pox5ContractId: "ST000000000000000000002AMW42H.pox-5",
    },
    compatibility: {
      status: "matched",
      profileId: "stacks-pox5-testnet-4.0.1",
      profileRevision: 1,
      profileLabel: "PoX-5 Testnet",
      origin: "built-in",
      nodeBuildPreviouslyTested: true,
      reason: "Live network fingerprint matches PoX-5 Testnet",
    },
    cycle: {
      currentId: 139,
      nextId: 140,
      blocksUntilPreparePhase: 1_540,
      preparePhaseStartBurnHeight: 10_780,
      blocksUntilRewardPhase: 1_640,
      rewardPhaseStartBurnHeight: 10_880,
      isPreparePhase: false,
    },
    checks: [
      { id: "node", status: "pass", message: "Stacks node is available" },
      { id: "api", status: "pass", message: "API indexer is caught up" },
      { id: "pox5", status: "pass", message: "PoX-5 is active" },
    ],
  },
  manager: {
    attachAllowed: true,
    automationEligible: true,
    automationEligibilityReason: "Source matches approved devnet reference profile",
    publishHeight: 9_100,
    source: {
      recognized: true,
      profileId: "devnet",
      sha256: "ca97d964",
      match: "exact",
      tier: "reference-built-in",
      origin: "built-in",
    },
    provenance: {
      status: "built-in",
      upstreamProfileId: "devnet",
      reason: "Source matches approved devnet reference profile",
    },
    installedProfiles: { directory: null, loaded: 0, issues: [] },
    reasons: [],
  },
  registration: {
    registered: true,
    signerKeyHex: `02${"12".repeat(32)}`,
    signerKeyGrantValid: true,
    reason: "registered",
  },
  setup: {
    status: "ready",
    enrollmentWindow: {
      status: "open",
      targetCycleId: 140,
      preparePhaseStartBurnHeight: 10_780,
      blocksUntilPreparePhase: 1_540,
    },
    eligibility: {
      current: {
        cycleId: 139,
        delegatedUstx: "16800000000000",
        thresholdUstx: "12600000000000",
        marginUstx: "4200000000000",
        meetsThreshold: true,
        inSignerSet: true,
      },
      next: {
        cycleId: 140,
        delegatedUstx: "17100000000000",
        thresholdUstx: "12600000000000",
        marginUstx: "4500000000000",
        meetsThreshold: true,
        inSignerSet: true,
      },
    },
    checks: [{ id: "eligible", status: "pass", message: "Pool is eligible" }],
  },
  forecast: {
    status: "ready",
    ingestion: { activeDiscoveredStakers: 237, completedAt: "2026-07-15T12:09:00.000Z" },
    cycles: Array.from({ length: 6 }, (_, index) => ({
      cycleId: 139 + index,
      status: "ready",
      provenance: {
        classification: index === 0 ? "authoritative" : "projected",
        contractSource: "pox5-read-only",
        localRosterSource: "api-indexed-node-verified",
      },
      local: {
        stakerCount: 237 - index * 3,
        enumeratedStxUstx: String(16_800_000_000_000 - index * 200_000_000_000),
        rosterAvailable: true,
      },
      contract: {
        pendingStxUstx: String(16_800_000_000_000 - index * 200_000_000_000),
        inSignerSet: true,
      },
      threshold: {
        marginUstx: String(4_200_000_000_000 - index * 100_000_000_000),
        meetsThreshold: true,
      },
      changesFromPrevious:
        index === 0
          ? null
          : { joiningStakers: index + 2, leavingStakers: index, changedAmountStakers: index + 1 },
    })),
  },
  rewards: {
    status: "ready",
    rewardCycle: 139,
    global: {
      lastRewardComputeBurnHeight: "9230",
      lastComputedRewardCycle: "139",
      signerEarnedBeforeManagerClaimSats: "0",
    },
    manager: {
      configuredFeeBips: "100",
      feeSnapshotBips: "100",
      earnedFeesSats: "25000",
      withdrawalLiabilitySats: "36000",
      unclaimedStakerRewardsSats: "2475000",
    },
    totals: {
      stakers: 237,
      grossSats: "2500000",
      earnedSats: "2475000",
      feeSats: "25000",
      actionableClaims: 34,
      l1ClaimsWaitingForFeeThreshold: 7,
    },
    stakers: rewardStakers.slice(0, 50),
  },
  activity: {
    eventCount: 4_200,
    latestBlockHeight: 14_200,
    claimTotal: claims.length,
    withdrawalTotal: withdrawals.length,
    pendingWithdrawalTotal: withdrawals.filter(({ state }) => state === "pending").length,
    claims: claims.slice(0, 50),
    withdrawals: withdrawals.slice(0, 50),
  },
  roster: roster.slice(0, 50),
  rosterTotal: roster.length,
  rosterStats: { deferredUnlocks: roster.length },
  alerts: [
    {
      id: "prepare",
      severity: "info",
      title: "Prepare phase approaching",
      detail: "Review cycle 140 enrollment.",
    },
  ],
};

export const onboarding = {
  onboarding: null,
  wizard: { dismissed: false, dismissedAt: null, updatedAt: null, audit: [] },
};

export const health = {
  generatedAt: "2026-07-15T12:10:00.000Z",
  overallStatus: "healthy",
  coverage: { available: 22, total: 22 },
  burnBlockTiming: {
    averageSeconds: 600,
    windowHours: 24,
    sampleBlocks: 144,
    sampledAt: "2026-07-15T12:09:42.000Z",
  },
  findings: [],
  node: {
    rpc: {
      configured: true,
      status: "healthy",
      checkedAt: "2026-07-15T12:10:00.000Z",
      lastSuccessAt: "2026-07-15T12:10:00.000Z",
      latencyMs: 12,
      consecutiveFailures: 0,
      errorCode: null,
    },
    metrics: {
      configured: true,
      status: "healthy",
      checkedAt: "2026-07-15T12:10:00.000Z",
      lastSuccessAt: "2026-07-15T12:10:00.000Z",
      latencyMs: 8,
      consecutiveFailures: 0,
      errorCode: null,
    },
    version: "stacks-node 4.0.1",
    networkId: 2147483653,
    stacksTipHeight: 12990,
    burnBlockHeight: 13000,
    lastTipAdvanceAt: "2026-07-15T12:09:42.000Z",
    inboundPeers: 14,
    outboundPeers: 8,
    lastHour: { warnings: 2, errors: 0 },
  },
  hiro: {
    source: {
      configured: true,
      status: "healthy",
      checkedAt: "2026-07-15T12:10:00.000Z",
      lastSuccessAt: "2026-07-15T12:10:00.000Z",
      latencyMs: 90,
      consecutiveFailures: 0,
      errorCode: null,
    },
    stacksTipHeight: 12990,
    burnBlockHeight: 13000,
    localStacksDifference: 0,
    localBurnDifference: 0,
  },
  signer: {
    infoSource: {
      configured: true,
      status: "healthy",
      checkedAt: "2026-07-15T12:10:00.000Z",
      lastSuccessAt: "2026-07-15T12:10:00.000Z",
      latencyMs: 5,
      consecutiveFailures: 0,
      errorCode: null,
    },
    heartbeat: {
      configured: true,
      status: "healthy",
      checkedAt: "2026-07-15T12:10:00.000Z",
      lastSuccessAt: "2026-07-15T12:10:00.000Z",
      latencyMs: 4,
      consecutiveFailures: 0,
      errorCode: null,
    },
    metrics: {
      configured: true,
      status: "healthy",
      checkedAt: "2026-07-15T12:10:00.000Z",
      lastSuccessAt: "2026-07-15T12:10:00.000Z",
      latencyMs: 6,
      consecutiveFailures: 0,
      errorCode: null,
    },
    version: "stacks-signer 4.0.1",
    network: "testnet",
    publicKey: "03b01234567890abcdef01234567890abcdef01234567890abcdef01234567890ab",
    stxAddress: "ST3PF13W7Z0RRM42A8VZRVFQ75SV1K26RXEP8YGKJ",
    observedNodeHeight: 12990,
    nodeHeightDifference: 0,
    rewardCycle: 141,
    stxBalanceUstx: 125000000,
    lastHour: {
      proposals: 12,
      accepted: 11,
      rejected: 1,
      rejectionPercent: 8.3,
      responseP95Seconds: 1,
      disagreements: 0,
      collectingBaseline: false,
    },
  },
};

function page(items, offset, limit) {
  return items.slice(offset, offset + limit);
}

export function responseFor(url) {
  const request = new URL(url);
  const offset = Number(request.searchParams.get("offset") ?? 0);
  const limit = Number(request.searchParams.get("limit") ?? 50);
  if (request.pathname === "/api/v1/status" || request.pathname === "/api/v1/sync") return snapshot;
  if (request.pathname === "/api/v1/settings") return runtimeSettings;
  if (request.pathname === "/api/v1/health" || request.pathname === "/api/v1/health/refresh")
    return health;
  if (request.pathname === "/api/v1/onboarding") return onboarding;
  if (request.pathname === "/api/v1/pool") {
    const query = (request.searchParams.get("query") ?? "").toLowerCase();
    const filtered = query
      ? roster.filter(({ stakerPrincipal }) => stakerPrincipal.toLowerCase().includes(query))
      : roster;
    return { total: filtered.length, offset, limit, roster: page(filtered, offset, limit) };
  }
  if (request.pathname === "/api/v1/rewards") {
    return {
      total: rewardStakers.length,
      offset,
      limit,
      rewards: { ...snapshot.rewards, stakers: page(rewardStakers, offset, limit) },
    };
  }
  if (request.pathname === "/api/v1/rewards/history") {
    return { total: cycleHistory.length, offset, limit, items: page(cycleHistory, offset, limit) };
  }
  if (request.pathname === "/api/v1/activity") {
    const claimOffset = Number(request.searchParams.get("claimOffset") ?? 0);
    const claimLimit = Number(request.searchParams.get("claimLimit") ?? 50);
    const withdrawalOffset = Number(request.searchParams.get("withdrawalOffset") ?? 0);
    const withdrawalLimit = Number(request.searchParams.get("withdrawalLimit") ?? 50);
    return {
      ...snapshot.activity,
      claims: page(claims, claimOffset, claimLimit),
      withdrawals: page(withdrawals, withdrawalOffset, withdrawalLimit),
    };
  }
  return { error: "fixture_route_not_found", path: request.pathname };
}
