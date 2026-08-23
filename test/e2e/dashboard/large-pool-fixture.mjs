const managerPrincipal = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.signer-manager";

const deploymentIdentity = {
  schemaVersion: 1,
  network: "testnet",
  networkId: 0x80000005,
  parentNetworkId: 0x80000000,
  managerPrincipal,
  boundAt: "2026-08-13T12:00:00.000Z",
  lastVerifiedAt: "2026-08-13T12:00:00.000Z",
  lastStacksTipHeight: 14_200,
  lastBurnBlockHeight: 9_240,
  lastPox5ContractId: "ST000000000000000000002AMW42H.pox-5",
};

export const connection = {
  schemaVersion: 1,
  status: "connected",
  outcomeCode: null,
  checkedAt: "2026-08-13T12:00:00.000Z",
  stale: false,
  configured: {
    network: "testnet",
    networkId: 0x80000005,
    nodeRpcUrl: "http://stacks-node:20443",
    managerPrincipal,
  },
  observed: {
    networkId: 0x80000005,
    parentNetworkId: 0x80000000,
    stacksTipHeight: 14_200,
    burnBlockHeight: 9_240,
    pox5ContractId: "ST000000000000000000002AMW42H.pox-5",
    manager: {
      deployed: true,
      traitCompatible: true,
      missingRequirements: [],
      publishHeight: 9_100,
      clarityVersion: "Clarity4",
      epoch: "Epoch40",
    },
  },
  lastSuccessful: deploymentIdentity,
  deploymentIdentity: { status: "bound", stored: deploymentIdentity, reason: null },
  checks: [
    { id: "deployment-identity", status: "pass", message: "Database identity matches." },
    { id: "node-network", status: "pass", message: "Node network matches." },
    { id: "pox5", status: "pass", message: "PoX-5 is active." },
    { id: "principal-network", status: "pass", message: "Principal network matches." },
    { id: "manager-trait", status: "pass", message: "Manager trait matches." },
  ],
};

export const deploymentRequirements = {
  schemaVersion: 1,
  checkedAt: "2026-08-15T12:00:00.000Z",
  status: "blocked",
  requiredReady: false,
  checks: [
    {
      id: "node-rpc",
      component: "node",
      importance: "required",
      status: "pass",
      title: "Stacks node RPC",
      summary: "Sidekick reached the configured node and verified its network and PoX-5 state.",
      observed: "http://127.0.0.1:20443",
      remediation: null,
    },
    {
      id: "node-transaction-index",
      component: "node",
      importance: "required",
      status: "not-configured",
      title: "Node transaction index",
      summary: "Stacks Core returned HTTP 501 because transaction indexing is disabled.",
      observed: "HTTP 501 transaction-index-unavailable",
      remediation: {
        steps: [
          "Add txindex = true to the node's existing [node] table.",
          "Restart stacks-node and allow its transaction index to catch up.",
        ],
        configuration: [
          {
            label: "Stacks node [node] table",
            format: "toml",
            content: "[node]\ntxindex = true",
          },
        ],
        restartServices: ["stacks-node"],
        docsUrl:
          "https://github.com/stx-labs/signer-sidekick/blob/main/docs/operator/node-signer-requirements.md",
      },
    },
  ],
};

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

function sorted(rows, key, direction, value) {
  if (!key) return rows;
  const multiplier = direction === "desc" ? -1 : 1;
  return [...rows].sort((left, right) => {
    const leftValue = value(left, key);
    const rightValue = value(right, key);
    if (leftValue === null) return rightValue === null ? 0 : 1;
    if (rightValue === null) return -1;
    return (leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0) * multiplier;
  });
}

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
  schemaVersion: 2,
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
    hiroReferenceApiKeyHeader: "x-api-key",
    hiroReferenceApiKeyConfigured: true,
    hiroReferenceApiKeySource: "database",
  },
  forecast: { horizonCycles: 6 },
  embed: { publicApiUrl: "https://pool.example/sidekick" },
  audit: [
    { revision: 12, changedFields: ["pool.displayName"], changedAt: "2026-07-15T12:00:00.000Z" },
  ],
};

export const snapshot = {
  schemaVersion: 1,
  get generatedAt() {
    return new Date().toISOString();
  },
  network: "testnet",
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
      { id: "node-network", status: "pass", message: "Node network matches testnet" },
      { id: "api-network", status: "pass", message: "API and node network IDs agree" },
      { id: "pox5", status: "pass", message: "PoX-5 is active" },
    ],
  },
  manager: {
    attachAllowed: true,
    automationEligible: true,
    automationEligibilityReason: "Source matches PoX-5 Testnet reference profile",
    publishHeight: 9_100,
    source: {
      recognized: true,
      profileId: "pox5-testnet-reference-manager",
      sha256: "ca97d964",
      match: "exact",
      tier: "reference-built-in",
      origin: "built-in",
    },
    provenance: {
      status: "built-in",
      upstreamProfileId: "pox5-testnet-reference-manager",
      reason: "Source matches PoX-5 Testnet reference profile",
    },
    capabilities: {
      signerManagerTrait: {
        compatible: true,
        reason: "Manager exposes the exact PoX-5 signer-manager trait.",
      },
      observedFunctions: {
        public: [
          "register-self",
          "update-admin",
          "update-fees",
          "withdraw-fees",
          "sweep-fee-refunds",
          "claim-rewards",
          "claim-staker-rewards",
          "validate-stake!",
        ],
        readOnly: ["is-admin", "get-earned-fees", "get-earned-staker-rewards"],
      },
      sourceReview: { exactReviewed: true, reason: "Fixture source is reviewed." },
      eventVocabulary: {
        id: "reference-manager-v1",
        normalizationAvailable: true,
        adapter: {
          id: "reference-manager-print-events",
          revision: 1,
          reviewedSourceSha256: "ca97d964",
        },
        reason: "Fixture events are reviewed.",
      },
      actions: [
        ["register-self", "reference-manager-register-self"],
        ["update-admin", "reference-manager-update-admin"],
        ["update-fees", "reference-manager-update-fees"],
        ["withdraw-fees", "reference-manager-withdraw-fees"],
        ["sweep-fee-refunds", "reference-manager-sweep-fee-refunds"],
        ["reference-reward-claims", "reference-manager-claim-rewards"],
      ].map(([id, adapterId]) => ({
        id,
        interfaceAvailable: true,
        executionAvailable: true,
        missingFunctions: [],
        adapter: { id: adapterId, revision: 1, reviewedSourceSha256: "ca97d964" },
        reason: "Fixture capability is reviewed.",
      })),
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
  readiness: {
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
  rewardOutlook: {
    pox5ContractId: "ST000000000000000000002AMW42H.pox-5",
    observedAt: "2026-08-14T12:00:00.000Z",
    chainAnchor: {
      stacksBlockHeight: 8_750_000,
      indexBlockHash: `0x${"44".repeat(32)}`,
      burnBlockHeight: 9_240,
      rewardCycle: 139,
      rewardCycleLength: 2_100,
      prepareCycleLength: 100,
      cyclePosition: 1_050,
      phase: "reward",
      checkpoint: "second-half",
    },
    accrued: { globalSats: "2500000", source: "pox5-get-new-rewards" },
    poolEstimate: {
      kind: "if-calculated-now",
      targetRewardCycle: 139,
      targetCheckpoint: "second-half",
      calculationBurnHeight: 10_289,
      grossSats: "500000",
      stxSats: "425000",
      bondSats: "75000",
      inputs: {
        globalStxSharesUstx: "84000000000000",
        managerStxSharesUstx: "16800000000000",
        activeBonds: [
          {
            bondIndex: "2",
            targetRateBips: "500",
            globalSharesSats: "75000000",
            managerSharesSats: "15000000",
          },
        ],
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
      targetRewardCycle: 139,
      targetCheckpoint: "second-half",
      calculationBurnHeight: 10289,
      globalSats: { low: "4000000", point: "5000000", high: "6000000" },
      poolSats: { low: "800000", point: "1000000", high: "1200000" },
      sample: {
        observations: 3,
        firstObservedBurnHeight: 9234,
        lastObservedBurnHeight: 9240,
        sampleBlocks: 6,
        elapsedBlocks: 10,
        remainingBlocks: 1049,
      },
      confidence: "low",
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
    calculation: {
      state: "completed",
      targetRewardCycle: 139,
      targetCheckpoint: "first-half",
      expectedLastRewardComputeBurnHeight: 9230,
      observedLastRewardComputeBurnHeight: "9230",
      next: {
        state: "scheduled",
        targetRewardCycle: 139,
        targetCheckpoint: "second-half",
        calculationBurnHeight: 10289,
        eligibleBurnHeight: 10290,
        blocksRemaining: 1050,
      },
    },
  },
  rewards: {
    status: "ready",
    rewardCycle: 139,
    global: {
      lastRewardComputeBurnHeight: "9230",
      lastComputedRewardCycle: "139",
      globalAccruedRewardsSats: "2500000",
      signerEarnedBeforeManagerClaimSats: "0",
      signerEarnedAcrossBucketsSats: "0",
    },
    calculation: {
      state: "completed",
      targetRewardCycle: 139,
      targetCheckpoint: "first-half",
      expectedLastRewardComputeBurnHeight: 9230,
      observedLastRewardComputeBurnHeight: "9230",
      next: {
        state: "scheduled",
        targetRewardCycle: 139,
        targetCheckpoint: "second-half",
        calculationBurnHeight: 10289,
        eligibleBurnHeight: 10290,
        blocksRemaining: 1050,
      },
    },
    buckets: [
      {
        bondIndex: null,
        managerSharesSats: "0",
        signerEarnedBeforeManagerClaimSats: "0",
        rewardsPerToken: "0",
        feeSnapshotBips: "100",
        participating: false,
      },
    ],
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

export const operationReadiness = {
  schemaVersion: 2,
  status: "ready",
  generatedAt: "2026-07-15T12:00:00.000Z",
  checks: [
    { id: "control-plane", status: "ready", detail: "Control plane is ready." },
    { id: "manager", status: "ready", detail: "Manager attachment is ready." },
    { id: "signer", status: "ready", detail: "Signer registration is ready." },
    { id: "engine", status: "ready", detail: "Transaction engine is ready." },
  ],
};

export const engineStatus = {
  schemaVersion: 1,
  mode: "observe",
  forcedObserve: { active: false, reason: null, actor: null, forcedAt: null },
  adapters: [],
  jobs: { active: 0, awaitingApproval: 0, ambiguous: 0 },
  generatedAt: "2026-07-15T12:00:00.000Z",
};

export const engineJobs = {
  schemaVersion: 1,
  items: [],
  nextCursor: null,
  total: 0,
};

export const health = {
  schemaVersion: 2,
  generatedAt: "2026-07-15T12:10:00.000Z",
  overallStatus: "healthy",
  coverage: { available: 22, total: 22 },
  diagnosis: {
    status: "healthy",
    title: "Signer is operating as expected",
    classification: "healthy",
    confidence: "high",
    summary: "The signer and local node are connected and aligned.",
    evidenceWindow: {
      startedAt: "2026-07-15T12:00:00.000Z",
      endedAt: "2026-07-15T12:10:00.000Z",
      sampleCount: 121,
      distinctSources: 4,
    },
    activeFindingIds: [],
  },
  history: {
    sampleIntervalSeconds: 5,
    rawRetentionHours: 72,
    rollupIntervalMinutes: 5,
    rollupRetentionDays: 90,
    observedSince: "2026-07-15T10:10:00.000Z",
    observationCount: 1441,
    recentRollups: [],
    recentEpisodes: [],
    skippedObservationRows: 0,
    skippedRollupRows: 0,
    skippedEpisodeRows: 0,
  },
  operator: {
    network: "testnet",
    managerPrincipal: "ST000000000000000000002AMW42H.signer-manager",
    currentRewardCycle: 141,
    registered: true,
    signerKeyHex: "03b01234567890abcdef01234567890abcdef01234567890abcdef01234567890ab",
    signerKeyGrantValid: true,
    expectedCurrentParticipation: true,
    expectedNextParticipation: true,
  },
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
    peerHealth: {
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
    tipIndexBlockHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
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
    indexBlockHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    localStacksDifference: 0,
    localBurnDifference: 0,
    lastTipAdvanceAt: "2026-07-15T12:09:42.000Z",
    advancementStatus: "advancing",
  },
  configuredApi: {
    distinctFromReference: false,
    source: {
      configured: false,
      status: "not-configured",
      checkedAt: null,
      lastSuccessAt: null,
      latencyMs: null,
      consecutiveFailures: 0,
      errorCode: null,
    },
    stacksTipHeight: null,
    burnBlockHeight: null,
    indexBlockHash: null,
    localStacksDifference: null,
    localBurnDifference: null,
    lastTipAdvanceAt: null,
    advancementStatus: "insufficient-evidence",
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
    identityMatchesRegistration: true,
    networkMatchesConfiguration: true,
    rewardCycleMatchesNode: true,
    last15Minutes: {
      startedAt: "2026-07-15T11:55:00.000Z",
      endedAt: "2026-07-15T12:10:00.000Z",
      sampleCount: 181,
      proposals: 4,
      validationAccepted: 4,
      validationRejected: 0,
      accepted: 4,
      rejected: 0,
      responseGap: 0,
      rejectionPercent: 0,
      responseP95Seconds: 1,
      validationP95Seconds: 0.5,
      validationLatencySamples: 4,
      nodeRpcP95Seconds: 0.1,
      capitulationP95Seconds: null,
      disagreements: 0,
      preCommits: 4,
      collectingBaseline: false,
    },
    lastHour: {
      proposals: 12,
      accepted: 11,
      rejected: 1,
      rejectionPercent: 8.3,
      responseP95Seconds: 1,
      validationP95Seconds: 0.5,
      disagreements: 0,
      collectingBaseline: false,
    },
  },
};

export function healthFinding(overrides) {
  return {
    id: "signer-node-heartbeat-failed",
    episodeId: "10000000-0000-4000-8000-000000000001",
    severity: "critical",
    title: "Signer cannot reach its Stacks node",
    detail: "The signer heartbeat failed three consecutive checks.",
    source: "signer",
    classification: "likely-local-signer",
    confidence: "high",
    firstObservedAt: "2026-07-15T12:09:50.000Z",
    lastObservedAt: "2026-07-15T12:10:00.000Z",
    evidenceWindow: {
      startedAt: "2026-07-15T12:09:50.000Z",
      endedAt: "2026-07-15T12:10:00.000Z",
      sampleCount: 3,
      distinctSources: 1,
    },
    evidence: [
      {
        code: "signer-heartbeat-node-failure",
        source: "signer-monitoring",
        status: "supporting",
        observedAt: "2026-07-15T12:10:00.000Z",
        value: "failed",
        detail: "The signer heartbeat reports that its node connection is unhealthy.",
      },
    ],
    ...overrides,
  };
}

function page(items, offset, limit) {
  return items.slice(offset, offset + limit);
}

const activityCoverage = [
  {
    source: "wallet-intents",
    status: "current",
    observedAt: "2026-08-14T17:05:00.000Z",
    anchor: null,
    reason: null,
  },
];

const activeActivity = {
  schemaVersion: 1,
  activityId: "wallet-intent:6ed58dac-c42c-4cb5-ad02-ed50671f3d27",
  kind: "operation",
  domain: "manager",
  code: "update-fees",
  title: "Update manager fee",
  summary: "A reviewed manager fee transaction is ready for the operator.",
  stage: "review-ready",
  operationScope: "update-fees",
  displayStatus: "action-required",
  outcome: "pending",
  occurredAt: "2026-08-14T17:00:00.000Z",
  updatedAt: "2026-08-14T17:05:00.000Z",
  deadline: null,
  urgencyAt: null,
  actorPrincipal: roster[0].stakerPrincipal,
  txids: [],
  anchor: null,
  supersedesActivityId: null,
  supersededByActivityId: null,
  primaryAction: {
    kind: "resume-activity",
    activityId: "wallet-intent:6ed58dac-c42c-4cb5-ad02-ed50671f3d27",
    label: "Resume transaction review",
  },
  coverage: activityCoverage,
};

const historicalActivity = {
  ...activeActivity,
  activityId: `chain-tx:1:0x${"ab".repeat(32)}`,
  kind: "chain-event",
  domain: "rewards",
  code: "claim-staker-rewards",
  title: "Staker reward claimed",
  summary: "The verified manager event records a completed staker reward claim.",
  stage: "observed",
  operationScope: null,
  displayStatus: "observed",
  outcome: "observed",
  occurredAt: "2026-08-13T16:00:00.000Z",
  updatedAt: "2026-08-13T16:01:00.000Z",
  txids: [`0x${"ab".repeat(32)}`],
  primaryAction: null,
  coverage: [
    {
      source: "indexed-manager-history",
      status: "current",
      observedAt: "2026-08-13T16:01:00.000Z",
      anchor: null,
      reason: null,
    },
  ],
};

function activityDetail(activityId) {
  const summary =
    activityId === historicalActivity.activityId ? historicalActivity : activeActivity;
  return {
    schemaVersion: 1,
    requestedActivityId: activityId,
    canonicalActivityId: summary.activityId,
    aliases: [summary.activityId],
    summary,
    timeline: [
      {
        schemaVersion: 1,
        eventId: `${summary.activityId}:recorded`,
        code: summary.displayStatus === "observed" ? "event-verified" : "plan-created",
        title: summary.displayStatus === "observed" ? "Manager event verified" : "Plan created",
        detail: summary.summary,
        occurredAt: summary.updatedAt,
        source: summary.coverage[0].source,
        txid: summary.txids[0] ?? null,
        stacksBlockHeight: null,
        indexBlockHash: null,
        canonical: summary.displayStatus === "observed" ? true : null,
        finalized: null,
      },
    ],
  };
}

export function reconciliationResponse(status = "idle") {
  const completed = status === "succeeded";
  const running = status === "running";
  return {
    operation: {
      schemaVersion: 1,
      operationId: status === "idle" ? null : "8c665428-04e4-4801-87aa-d6dcff225af1",
      trigger: status === "idle" ? null : "manual",
      status,
      phase: completed ? "complete" : running ? "reconciling-events" : "idle",
      processLocal: true,
      startedAt: completed || running ? "2026-07-19T16:00:00.000Z" : null,
      updatedAt: completed || running ? "2026-07-19T16:00:01.000Z" : null,
      completedAt: completed ? "2026-07-19T16:00:01.000Z" : null,
      progress: {
        completedSteps: completed ? 4 : running ? 2 : 0,
        totalSteps: 4,
        itemsCompleted: null,
        itemsTotal: null,
        message: completed
          ? "Chain data sync complete"
          : running
            ? "Syncing manager events"
            : "No chain data sync has run",
      },
      result: completed
        ? {
            reconciliation: {
              observedAt: snapshot.generatedAt,
              stakers: {
                resumed: false,
                status: "completed",
                authoritative: true,
                pagesProcessed: 2,
                itemsProcessed: roster.length,
                activeStakers: roster.length,
                nodeVerifiedStxPositions: roster.filter(({ stxNodeVerified }) => stxNodeVerified)
                  .length,
                unverifiedStxDiscoveries: roster.filter(({ stxNodeVerified }) => !stxNodeVerified)
                  .length,
                discrepanciesObserved: 0,
              },
              events: {
                resumed: false,
                pagesProcessed: 1,
                eventsProcessed: claims.length + withdrawals.length,
                newEvents: 0,
                replayedEvents: claims.length + withdrawals.length,
                decodeFailures: 0,
                reorgedEvents: 0,
                stoppedAtKnownOverlap: true,
              },
            },
            snapshotGeneratedAt: snapshot.generatedAt,
          }
        : null,
      error: null,
    },
  };
}

const overviewAnchor = {
  stacksBlockHeight: 14_200,
  indexBlockHash: `0x${"11".repeat(32)}`,
  burnBlockHeight: 9_240,
  rewardCycle: 140,
  rewardCycleLength: 2_100,
  prepareCycleLength: 100,
  cyclePosition: 1_000,
  phase: "reward",
  checkpoint: "first-half",
};

const overviewEvidence = {
  status: "current",
  observedAt: "2026-08-14T17:05:00.000Z",
  anchor: overviewAnchor,
  source: "local-node",
  reason: null,
};

export const overview = {
  schemaVersion: 1,
  generatedAt: "2026-08-14T17:05:00.000Z",
  monitoring: { network: "PoX-5 Testnet", managerPrincipal },
  cycle: {
    status: "current",
    rewardCycleId: 140,
    phase: "reward",
    burnBlockHeight: 9_240,
    stacksTipHeight: 14_200,
    nextRewardCalculation: {
      status: "scheduled",
      burnBlockHeight: 9_249,
      blocksRemaining: 9,
      estimatedAt: "2026-08-14T18:35:00.000Z",
      evidence: [overviewEvidence],
    },
    nextPreparePhase: {
      status: "scheduled",
      burnBlockHeight: 10_240,
      blocksRemaining: 1_000,
      estimatedAt: "2026-08-21T10:00:00.000Z",
      evidence: [overviewEvidence],
    },
    evidence: [overviewEvidence],
  },
  network: {
    status: "advancing",
    reference: "Hiro reference API",
    stacksTipHeight: 14_200,
    burnBlockHeight: 9_240,
    lastObservedAt: "2026-08-14T17:05:00.000Z",
    detail: "The independently observed network tip is advancing.",
    evidence: [{ ...overviewEvidence, source: "network-reference" }],
    detailsAction: {
      kind: "open-domain",
      page: "health",
      section: "network",
      label: "Review network evidence",
    },
  },
  node: {
    status: "aligned",
    stacksTipHeight: 14_200,
    burnBlockHeight: 9_240,
    peerHeightDifference: 0,
    lastAdvancedAt: "2026-08-14T17:05:00.000Z",
    detail: "The local node is aligned with its observed peers.",
    evidence: [overviewEvidence],
    detailsAction: {
      kind: "open-domain",
      page: "health",
      section: "node",
      label: "Review node evidence",
    },
  },
  signer: {
    status: "healthy",
    rewardCycleId: 140,
    nodeHeightDifference: 0,
    proposalsLastHour: 12,
    acceptedLastHour: 12,
    rejectedLastHour: 0,
    responseP95Seconds: 0.8,
    validationP95Seconds: 0.5,
    detail: "Signer monitoring is healthy and aligned with the node.",
    evidence: [{ ...overviewEvidence, source: "signer" }],
    detailsAction: {
      kind: "open-domain",
      page: "health",
      section: "signer",
      label: "Review signer evidence",
    },
  },
  attention: [
    {
      schemaVersion: 1,
      attentionId: "pool:next-cycle-threshold",
      tier: "action-required",
      domain: "pool",
      affectedDomains: ["pool"],
      code: "next-cycle-below-threshold",
      title: "Next cycle is below threshold",
      summary: "Cycle 141 does not currently meet the signer threshold.",
      impact: "The manager will not enter the next signer set unless the position changes.",
      openedAt: "2026-08-14T17:05:00.000Z",
      updatedAt: "2026-08-14T17:05:00.000Z",
      deadline: { kind: "burn-block", burnBlockHeight: 10_240, estimatedAt: null },
      urgencyAt: "2026-08-21T10:00:00.000Z",
      evidence: [overviewEvidence],
      relatedActivityId: null,
      relatedFindingId: null,
      primaryAction: {
        kind: "open-domain",
        page: "pool",
        section: "forecast",
        label: "Review next cycle",
      },
      detailsAction: null,
    },
  ],
  inProgress: [
    {
      schemaVersion: 1,
      activityId: activeActivity.activityId,
      domain: "rewards",
      title: "Reward claim is awaiting approval",
      stage: "awaiting approval",
      updatedAt: "2026-08-14T17:04:00.000Z",
      evidence: [{ ...overviewEvidence, source: "sidekick-store" }],
      primaryAction: {
        kind: "resume-activity",
        activityId: activeActivity.activityId,
        label: "Resume claim",
      },
    },
  ],
  pool: {
    status: "needs-attention",
    current: { rewardCycleId: 140, amountUstx: "16800000000000", inSignerSet: true },
    next: { rewardCycleId: 141, amountUstx: "16600000000000", inSignerSet: false },
    nextThresholdMarginUstx: "-200000000000",
    participants: { stxOnly: 158, bitcoinBond: 79 },
    nextChange: {
      kind: "amount-change",
      rewardCycleId: 141,
      participantCount: 3,
      amountDeltaUstx: "-200000000000",
    },
    evidence: [overviewEvidence],
    detailsAction: {
      kind: "open-domain",
      page: "pool",
      section: "forecast",
      label: "Open pool forecast",
    },
  },
  rewards: {
    status: "ready",
    rewardCycleId: 140,
    estimatedNetworkRewardSats: "200000",
    estimatedPoolRewardSats: "150000",
    distributionCheckpoint: "first-half",
    estimatedOperatorFeeSats: "7500",
    operatorFeeUnavailableReason: null,
    estimateKind: "checkpoint-forecast",
    confidence: "calibrated",
    evidence: [overviewEvidence],
    detailsAction: {
      kind: "open-domain",
      page: "rewards",
      section: "outlook",
      label: "Open rewards",
    },
  },
};

// ---------------------------------------------------------------------------------------------
// Reward ledger (plan S1) and gas wallet (plan S2) fixtures for the Rewards page and Overview card.
// Cycle 140 · First Distribution is calculated and ready to collect & distribute; cycles 128–139
// are complete history.
// ---------------------------------------------------------------------------------------------

const ledgerStakers = roster.slice(0, 40).map(({ stakerPrincipal }) => stakerPrincipal);

function ledgerTx(seed) {
  return `0x${seed.toString(16).padStart(2, "0").repeat(32)}`;
}

function ledgerPayment(cycle, distribution, index, staker, status, overrides = {}) {
  const gross = 245_900 - index * 3_100;
  const fee = Math.floor(gross * 0.05);
  const entitlement = gross - fee;
  const bitcoin = index % 7 === 1;
  const paid = status !== "outstanding";
  return {
    schemaVersion: 1,
    cycle,
    distribution,
    bucket: "stx",
    stakerPrincipal: staker,
    route: bitcoin ? "bitcoin" : "sbtc",
    grossRewardSats: String(gross),
    operatorFeeSats: String(fee),
    stakerEntitlementSats: String(entitlement),
    payoutSats: bitcoin ? String(entitlement - 10_000) : String(entitlement),
    payoutAsset: bitcoin ? "BTC" : "sBTC",
    l1MaxFeeSats: bitcoin ? "10000" : null,
    l1ActualFeeSats: null,
    feeRefundSats: null,
    returnedSats: null,
    status,
    coverage: "exact",
    includesPriorDistribution: false,
    paymentTxId: paid ? ledgerTx(0x30 + index) : null,
    paymentBlockHeight: paid ? 3_000 + cycle * 10 + index : null,
    paidAt: paid ? "2026-08-15T09:12:00.000Z" : null,
    by: paid ? (index % 2 === 0 ? "you" : "another-caller") : null,
    l1RequestId: bitcoin && paid ? String(4_100 + index) : null,
    l1Status: bitcoin && paid ? "retired" : null,
    settleOrReclaimTxId: null,
    btcSweepTxId: null,
    unavailableReason: null,
    ...overrides,
  };
}

function ledgerDistribution(cycle, distribution, status, stakers) {
  const calculated = status !== "accruing";
  const outstanding = status === "ready";
  const payments = stakers.map((staker, index) =>
    ledgerPayment(
      cycle,
      distribution,
      index,
      staker,
      outstanding ? "outstanding" : index % 7 === 1 ? "retired" : "paid",
    ),
  );
  const distributed = outstanding
    ? 0n
    : payments.reduce((sum, p) => sum + BigInt(p.stakerEntitlementSats), 0n);
  const fees = outstanding ? 0n : payments.reduce((sum, p) => sum + BigInt(p.operatorFeeSats), 0n);
  const outstandingSats = outstanding
    ? payments.reduce((sum, p) => sum + BigInt(p.stakerEntitlementSats), 0n)
    : 0n;
  const pool = payments.reduce((sum, p) => sum + BigInt(p.grossRewardSats), 0n);
  return {
    payments,
    distribution: {
      schemaVersion: 1,
      cycle,
      distribution,
      current: false,
      calculation: calculated
        ? {
            state: "done",
            txId: ledgerTx(0x10 + distribution),
            blockHeight: 2_000 + cycle * 10,
            calculationBurnHeight: 900_000 + cycle * 2_100,
            observedAt: "2026-08-15T03:20:00.000Z",
            poolSats: pool.toString(),
            poolSatsUnavailableReason: null,
            by: "another-caller",
          }
        : {
            state: "waiting",
            txId: null,
            blockHeight: null,
            calculationBurnHeight: null,
            observedAt: null,
            poolSats: null,
            poolSatsUnavailableReason: null,
            by: null,
          },
      collects:
        outstanding || !calculated
          ? []
          : [
              {
                sats: pool.toString(),
                stxSats: pool.toString(),
                txId: ledgerTx(0x20 + distribution),
                blockHeight: 2_100 + cycle * 10,
                by: "you",
              },
            ],
      collectedSats: outstanding || !calculated ? "0" : pool.toString(),
      availableToCollectSats: outstanding ? pool.toString() : "0",
      feeBips: "500",
      feeEvidence: "locked",
      payments: {
        made: outstanding ? 0 : payments.length,
        outstanding: outstanding ? payments.length : 0,
        notPayable: 0,
        belowFee: 0,
        rolledForward: 0,
        arriving: 0,
        rejected: 0,
        returned: 0,
        distributedSats: distributed.toString(),
        outstandingSats: outstandingSats.toString(),
        operatorFeeSats: fees.toString(),
      },
      status,
      statusDetail:
        status === "ready"
          ? "Calculated; collect and distribute"
          : status === "complete"
            ? "Complete"
            : "Accruing",
      coverage: "exact",
    },
  };
}

function ledgerCycle(cycle, statuses, stakers) {
  const built = statuses.map((status, index) =>
    ledgerDistribution(cycle, index + 1, status, stakers),
  );
  const distributions = built.map(({ distribution }) => distribution);
  return {
    payments: built.flatMap(({ payments }) => payments),
    cycle: {
      cycle,
      feeBips: "500",
      feeEvidence: "locked",
      collectedSats: distributions.reduce((sum, d) => sum + BigInt(d.collectedSats), 0n).toString(),
      distributedSats: distributions
        .reduce((sum, d) => sum + BigInt(d.payments.distributedSats), 0n)
        .toString(),
      operatorFeeSats: distributions
        .reduce((sum, d) => sum + BigInt(d.payments.operatorFeeSats), 0n)
        .toString(),
      outstandingSats: distributions
        .reduce((sum, d) => sum + BigInt(d.payments.outstandingSats), 0n)
        .toString(),
      coverage: "exact",
      distributions,
    },
  };
}

const ledgerCycles = [
  ledgerCycle(140, ["ready"], ledgerStakers),
  ...Array.from({ length: 12 }, (_, index) =>
    ledgerCycle(139 - index, ["complete", "complete"], ledgerStakers),
  ),
];
ledgerCycles[0].cycle.distributions[0].current = true;

export function rewardLedger(url) {
  const request = new URL(url);
  const cycleText = request.searchParams.get("cycle");
  const distributionText = request.searchParams.get("distribution");
  const scope = request.searchParams.get("scope") === "all" ? "all" : "selection";
  const selectedCycle = cycleText === null ? 140 : Number(cycleText);
  const selectedDistribution =
    distributionText === null ? (cycleText === null ? 1 : null) : Number(distributionText);
  const payments =
    scope === "all"
      ? ledgerCycles.flatMap(({ payments: rows }) => rows)
      : ledgerCycles
          .filter(({ cycle }) => cycle.cycle === selectedCycle)
          .flatMap(({ payments: rows }) => rows)
          .filter(
            (row) => selectedDistribution === null || row.distribution === selectedDistribution,
          );
  return {
    schemaVersion: 1,
    generatedAt: snapshot.generatedAt,
    managerPrincipal: snapshot.managerPrincipal,
    network: "testnet",
    pox5ContractId: "ST000000000000000000002AMW42H.pox-5",
    anchor: {
      stacksTipHeight: 5_000,
      burnBlockHeight: 905_000,
      indexBlockHash: `0x${"11".repeat(32)}`,
    },
    capabilityLevel: "reviewed-event-vocabulary",
    monitoringStartedAt: "2026-07-01T00:00:00.000Z",
    recovery: { managerHistory: "complete", currentMemberHistory: "complete" },
    evidenceWindow: { truncated: false, oldestRetainedBlockHeight: null, limit: 10_000 },
    current: { cycle: 140, distribution: 1 },
    cycles: ledgerCycles.map(({ cycle }) => cycle),
    payments,
    paymentsTruncated: false,
    fees: {
      feeBips: "500",
      earnedIndexedSats: ledgerCycles
        .reduce((sum, { cycle }) => sum + BigInt(cycle.operatorFeeSats), 0n)
        .toString(),
      balanceInManagerSats: "504000",
      withdrawnDerivedSats: "1100000",
      refunds: [],
    },
    query: { cycle: selectedCycle, distribution: selectedDistribution, staker: null, scope },
  };
}

export const gasWalletStatus = {
  schemaVersion: 1,
  generatedAt: snapshot.generatedAt,
  network: "testnet",
  engineMode: "observe",
  configured: false,
  enabled: false,
  source: null,
  principal: null,
  publicKey: null,
  secretFilePath: null,
  createdAt: null,
  enabledAt: null,
  signer: "not-loaded",
  signerError: null,
  balanceUstx: null,
  balanceObservedAt: null,
  balanceError: null,
  feeBasisUstx: "100000",
  feeBasis: "fee-cap",
  estimatedTransactions: null,
  refusal: {
    checkedAt: null,
    isManagerAdmin: null,
    isSignerKey: null,
    isContract: false,
    refusalReason: null,
  },
  banners: { setupDismissedAt: null, lowBalanceDismissedUntil: null },
  activeSweepId: null,
  sweeps: [],
};

export const gasWalletCreated = {
  ...gasWalletStatus,
  engineMode: "operator-run",
  configured: true,
  source: "generated",
  principal: "ST2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7",
  publicKey: `02${"ab".repeat(32)}`,
  secretFilePath: "/var/lib/sidekick/gas-wallet.key",
  createdAt: snapshot.generatedAt,
  signer: "disabled",
  balanceUstx: "12480000",
  balanceObservedAt: snapshot.generatedAt,
  estimatedTransactions: 124,
  refusal: {
    checkedAt: snapshot.generatedAt,
    isManagerAdmin: false,
    isSignerKey: false,
    isContract: false,
    refusalReason: null,
  },
};

// ---------------------------------------------------------------------------------------------
// Reward runs (plan S3): a sealed recipe for cycle 140 · First Distribution (collect + payments).
// Tests drive the lifecycle by overriding the run routes; the default list is empty.
// ---------------------------------------------------------------------------------------------

export function rewardRunFixture(status = "awaiting-approval", overrides = {}) {
  const runId = "00000000-0000-4000-8000-00000000a001";
  const current = ledgerCycles[0];
  const payments = current.payments.filter((row) => row.distribution === 1);
  const accounts = payments.map((row) => ({
    accountKey: `${row.stakerPrincipal}:140:stx`,
    stakerPrincipal: row.stakerPrincipal,
    rewardCycle: 140,
    bondIndex: null,
    maximumGrossSats: row.grossRewardSats,
    payoutRoute: row.route === "bitcoin" ? "bitcoin-l1" : "direct-sbtc",
  }));
  const collectSats = payments
    .reduce((sum, row) => sum + BigInt(row.grossRewardSats), 0n)
    .toString();
  const recipeChildren = [
    {
      index: 0,
      operation: "claim-rewards",
      adapterId: "reference-manager-claim-rewards",
      adapterRevision: 3,
      accountKey: null,
      requestId: null,
      stakerPrincipal: null,
      maximumAmountSats: collectSats,
      withdrawalAmountSats: null,
      maxFeeSats: null,
    },
    ...accounts.map((account, index) => ({
      index: index + 1,
      operation: "claim-staker-rewards",
      adapterId: "reference-manager-claim-staker-rewards",
      adapterRevision: 2,
      accountKey: account.accountKey,
      requestId: null,
      stakerPrincipal: account.stakerPrincipal,
      maximumAmountSats: account.maximumGrossSats,
      withdrawalAmountSats: null,
      maxFeeSats: null,
    })),
  ];
  const completed =
    overrides.completed ?? (status === "awaiting-approval" || status === "approved" ? 0 : 13);
  const inFlight = overrides.inFlight ?? (status === "running" || status === "halted" ? 1 : 0);
  const children = recipeChildren.map((child, index) => ({
    index: child.index,
    operation: child.operation,
    accountKey: child.accountKey,
    status:
      index < completed
        ? "confirmed"
        : index === completed && inFlight > 0
          ? "broadcast"
          : "pending",
    maximumAmountSats: child.maximumAmountSats,
    materializedAmountSats: index < completed ? child.maximumAmountSats : null,
    planSha256: index <= completed && status !== "awaiting-approval" ? "ab".repeat(32) : null,
    txid:
      index < completed || (index === completed && inFlight > 0)
        ? `0x${(0x40 + index).toString(16).padStart(2, "0").repeat(32)}`
        : null,
    provenance: index < completed ? "you" : null,
    failureReason: null,
    updatedAt: snapshot.generatedAt,
  }));
  const started = status !== "awaiting-approval" && status !== "approved";
  return {
    schemaVersion: 1,
    runId,
    status,
    walletPrincipal: gasWalletCreated.principal,
    recipeSha256: "ef".repeat(32),
    recipe: {
      schemaVersion: 1,
      runId,
      prepareRequestSha256: "12".repeat(32),
      walletPrincipal: gasWalletCreated.principal,
      managerPrincipal: snapshot.managerPrincipal,
      pox5Contract: "ST000000000000000000002AMW42H.pox-5",
      sbtcTokenContract: "ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT.sbtc-token",
      sbtcRegistryContract: "ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT.sbtc-registry",
      network: "testnet",
      chainId: 0x8000_0005,
      cycle: 140,
      distribution: 1,
      orderedOperations: ["claim-rewards", "claim-staker-rewards"],
      accounts,
      reviewedTotalSats: collectSats,
      reviewedPaymentCount: accounts.length,
      maxTransactions: 200,
      eligibleTransactions: recipeChildren.length,
      truncated: false,
      remainingTransactions: 0,
      feeCapUstx: "100000",
      gasBudgetUstx: String(100_000 * recipeChildren.length),
      managerSourceFingerprint: "34".repeat(32),
      pox5SourceFingerprint: "56".repeat(32),
      adapterRevisions: {
        "reference-manager-claim-rewards": 3,
        "reference-manager-claim-staker-rewards": 2,
      },
      children: recipeChildren,
      preparedAnchor: {
        stacksBlockHeight: 5_000,
        burnBlockHeight: 905_000,
        indexBlockHash: `0x${"ab".repeat(32)}`,
      },
    },
    cursor: completed,
    progress: { completed, total: recipeChildren.length, inFlight },
    gasSpentUstx: String(2_000 * completed),
    approvalExpiresAt: "2026-08-14T17:35:00.000Z",
    runtimeExpiresAt: started ? "2026-08-14T23:05:00.000Z" : null,
    approvedAt: status === "awaiting-approval" ? null : "2026-08-14T17:06:00.000Z",
    startedAt: started ? "2026-08-14T17:06:10.000Z" : null,
    completedAt: ["completed", "cancelled", "expired"].includes(status)
      ? "2026-08-14T17:30:00.000Z"
      : null,
    failureReason: status === "halted" ? "Broadcast outcome is ambiguous" : null,
    createdAt: "2026-08-14T17:05:00.000Z",
    updatedAt: snapshot.generatedAt,
    children,
  };
}

export function responseFor(url) {
  const request = new URL(url);
  const offset = Number(request.searchParams.get("offset") ?? 0);
  const limit = Number(request.searchParams.get("limit") ?? 50);
  if (request.pathname === "/api/v1/auth/session") return { authenticated: false };
  if (
    request.pathname === "/api/v1/connection" ||
    request.pathname === "/api/v1/connection/recheck"
  )
    return connection;
  if (
    request.pathname === "/api/v1/deployment-requirements" ||
    request.pathname === "/api/v1/deployment-requirements/refresh"
  )
    return deploymentRequirements;
  if (request.pathname === "/api/v1/overview") return overview;
  if (request.pathname === "/api/v1/status") return snapshot;
  if (request.pathname === "/api/v1/activity") {
    return {
      schemaVersion: 1,
      generatedAt: "2026-08-14T17:05:00.000Z",
      active: [activeActivity],
      items: [historicalActivity],
      nextCursor: null,
      coverage: activityCoverage,
    };
  }
  if (request.pathname.startsWith("/api/v1/activity/")) {
    return activityDetail(decodeURIComponent(request.pathname.slice("/api/v1/activity/".length)));
  }
  if (request.pathname === "/api/v1/operations/readiness") return operationReadiness;
  if (request.pathname === "/api/v1/engine") return engineStatus;
  if (request.pathname === "/api/v1/engine/jobs") return engineJobs;
  if (request.pathname === "/api/v1/sync") return reconciliationResponse();
  if (request.pathname === "/api/v1/settings") return runtimeSettings;
  if (request.pathname === "/api/v1/health" || request.pathname === "/api/v1/health/refresh")
    return health;
  if (request.pathname === "/api/v1/pool") {
    const query = (request.searchParams.get("query") ?? "").toLowerCase();
    const filtered = query
      ? roster.filter(({ stakerPrincipal }) => stakerPrincipal.toLowerCase().includes(query))
      : roster;
    const ordered = sorted(
      filtered,
      request.searchParams.get("sort"),
      request.searchParams.get("direction"),
      (entry, sort) => {
        if (sort === "amount") return BigInt(entry.position.amountUstx);
        return entry.stakerPrincipal;
      },
    );
    return { total: ordered.length, offset, limit, roster: page(ordered, offset, limit) };
  }
  if (request.pathname === "/api/v1/rewards") {
    return {
      total: rewardStakers.length,
      offset,
      limit,
      rewards: { ...snapshot.rewards, stakers: page(rewardStakers, offset, limit) },
      rewardOutlook: snapshot.rewardOutlook,
    };
  }
  if (request.pathname === "/api/v1/rewards/staker-claims") {
    return {
      generatedAt: snapshot.generatedAt,
      rewardCycle: snapshot.rewards.rewardCycle,
      page: {
        stakerPrincipals: [roster[1].stakerPrincipal],
        offset,
        limit,
        stakersTotal: 1,
        nextCursor: null,
      },
      settlement: {
        scope: "page",
        stakersScanned: 1,
        outstandingClaims: 1,
        transactionCount: 1,
        totalNetSats: "25000",
        blockedClaims: 0,
      },
      candidates: [
        {
          stakerPrincipal: roster[1].stakerPrincipal,
          bondIndex: null,
          payout: { kind: "direct-sbtc", maxFeeSats: null },
          rewards: { earnedSats: "25000", feeSats: "250", grossSats: "25250" },
          claimable: true,
          blockedReason: null,
        },
      ],
    };
  }
  if (request.pathname === "/api/v1/rewards/ledger") return rewardLedger(url);
  if (request.pathname.startsWith("/api/v1/rewards/ledger/")) {
    const ledger = rewardLedger(url);
    if (request.pathname.endsWith("payments.json")) return ledger.payments;
    if (request.pathname.endsWith("distributions.json"))
      return ledger.cycles.flatMap((cycle) => cycle.distributions);
    if (request.pathname.endsWith("fees.json")) return { fees: ledger.fees, rows: [] };
    return {
      fixtureStatus: 200,
      fixtureContentType: "text/csv",
      fixtureText: "cycle,distribution\n140,1\n",
    };
  }
  if (request.pathname === "/api/v1/settings/gas-wallet") return gasWalletStatus;
  if (request.pathname.startsWith("/api/v1/settings/gas-wallet/")) return gasWalletStatus;
  if (request.pathname === "/api/v1/rewards/runs") return [];
  if (request.pathname.startsWith("/api/v1/rewards/runs/")) {
    return {
      fixtureStatus: 404,
      error: "reward_run_not_found",
      message: "Reward run does not exist",
    };
  }
  if (request.pathname === "/api/v1/rewards/history") {
    return { total: cycleHistory.length, offset, limit, items: page(cycleHistory, offset, limit) };
  }
  if (request.pathname === "/api/v1/rewards/activity") {
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
