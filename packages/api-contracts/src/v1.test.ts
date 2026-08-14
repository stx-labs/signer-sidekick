import { describe, expect, it } from "vitest";
import {
  activityDetailSchema,
  activityDisplayStatusSchema,
  activityGroupSummarySchema,
  activityOutcomeSchema,
  activityResponseSchema,
  browserWalletIntentCreateRequestSchema,
  browserWalletIntentSchema,
  contextualActionSchema,
  dashboardSnapshotSchema,
  onboardingBrowserWalletIntentCreateRequestSchema,
  overviewPageSchema,
  reconciliationOperationSchema,
  reconciliationSummarySchema,
  rewardsActivityResponseSchema,
  runtimeSettingsSchema,
  signerGrantSessionResponseSchema,
  syncResponseSchema,
  walletIntentAnchorMismatchErrorSchema,
  walletIntentAnchorUnstableErrorSchema,
} from "./v1.js";

describe("Overview V1 contracts", () => {
  const observedAt = "2026-08-14T12:00:00.000Z";
  const anchor = {
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
  const evidence = {
    status: "current" as const,
    observedAt,
    anchor,
    source: "local-node" as const,
    reason: null,
  };
  const openHealth = (section: "findings" | "node" | "signer" | "network" | "sources") => ({
    kind: "open-domain" as const,
    page: "health" as const,
    section,
    label: "Review health evidence",
  });

  function overviewFixture() {
    return {
      schemaVersion: 1 as const,
      generatedAt: observedAt,
      monitoring: {
        network: "mainnet",
        managerPrincipal: "SP000000000000000000002Q6VF78.signer-manager",
      },
      cycle: {
        status: "current" as const,
        rewardCycleId: 141,
        phase: "reward" as const,
        burnBlockHeight: 962_300,
        stacksTipHeight: 8_750_000,
        nextRewardCalculation: {
          status: "scheduled" as const,
          burnBlockHeight: 962_349,
          blocksRemaining: 49,
          estimatedAt: "2026-08-14T20:10:00.000Z",
          evidence: [evidence],
        },
        nextPreparePhase: {
          status: "scheduled" as const,
          burnBlockHeight: 963_300,
          blocksRemaining: 1_000,
          estimatedAt: "2026-08-21T10:00:00.000Z",
          evidence: [evidence],
        },
        evidence: [evidence],
      },
      network: {
        status: "advancing" as const,
        reference: "Hiro reference API",
        stacksTipHeight: 8_750_000,
        burnBlockHeight: 962_300,
        lastObservedAt: observedAt,
        detail: "The independently observed network tip is advancing.",
        evidence: [{ ...evidence, source: "network-reference" as const }],
        detailsAction: openHealth("network"),
      },
      node: {
        status: "aligned" as const,
        stacksTipHeight: 8_750_000,
        burnBlockHeight: 962_300,
        peerHeightDifference: 0,
        lastAdvancedAt: observedAt,
        detail: "The local node is aligned with its observed peers.",
        evidence: [evidence],
        detailsAction: openHealth("node"),
      },
      signer: {
        status: "healthy" as const,
        rewardCycleId: 141,
        nodeHeightDifference: 0,
        proposalsLastHour: 12,
        acceptedLastHour: 12,
        rejectedLastHour: 0,
        responseP95Seconds: 0.8,
        detail: "Signer monitoring is healthy and aligned with the node.",
        evidence: [{ ...evidence, source: "signer" as const }],
        detailsAction: openHealth("signer"),
      },
      attention: [
        {
          schemaVersion: 1 as const,
          attentionId: "pool:next-cycle-threshold",
          tier: "action-required" as const,
          domain: "pool" as const,
          affectedDomains: ["pool" as const],
          code: "next-cycle-below-threshold",
          title: "Next cycle is below threshold",
          summary: "Cycle 142 does not currently meet the signer threshold.",
          impact: "The manager will not enter the next signer set unless the position changes.",
          openedAt: observedAt,
          updatedAt: observedAt,
          deadline: { kind: "burn-block" as const, burnBlockHeight: 963_300, estimatedAt: null },
          urgencyAt: "2026-08-21T10:00:00.000Z",
          evidence: [evidence],
          relatedActivityId: null,
          relatedFindingId: null,
          primaryAction: {
            kind: "open-domain" as const,
            page: "pool" as const,
            section: "forecast" as const,
            label: "Review next cycle",
          },
          detailsAction: null,
        },
      ],
      inProgress: [],
      pool: {
        status: "needs-attention" as const,
        current: { rewardCycleId: 141, amountUstx: "4000000000000", inSignerSet: true },
        next: { rewardCycleId: 142, amountUstx: "3600000000000", inSignerSet: false },
        nextThresholdMarginUstx: "-400000000000",
        participants: { stxOnly: 4, bitcoinBond: 1 },
        nextChange: {
          kind: "amount-change" as const,
          rewardCycleId: 142,
          participantCount: 1,
          amountDeltaUstx: "-400000000000",
        },
        evidence: [evidence],
        detailsAction: {
          kind: "open-domain" as const,
          page: "pool" as const,
          section: "forecast" as const,
          label: "Open pool forecast",
        },
      },
      rewards: {
        status: "ready" as const,
        rewardCycleId: 141,
        globalAccruedSats: "200000",
        estimatedPoolRewardSats: "150000",
        operatorFeeSats: "7500",
        confidence: "exact" as const,
        calculationState: "completed" as const,
        actionableClaims: 2,
        evidence: [evidence],
        detailsAction: {
          kind: "open-domain" as const,
          page: "rewards" as const,
          section: "outlook" as const,
          label: "Open rewards",
        },
      },
    };
  }

  it("accepts the closed operational snapshot and typed actions", () => {
    const parsed = overviewPageSchema.safeParse(overviewFixture());
    if (!parsed.success) throw parsed.error;
    expect(parsed.data.schemaVersion).toBe(1);
  });

  it("rejects setup-only operations and arbitrary or mismatched navigation targets", () => {
    expect(
      contextualActionSchema.safeParse({
        kind: "launch-operation",
        operation: "deploy-manager",
        context: { kind: "none" },
        label: "Deploy manager",
      }).success,
    ).toBe(false);
    expect(
      contextualActionSchema.safeParse({
        kind: "launch-operation",
        operation: "calculate-rewards",
        context: { kind: "none" },
        label: "Calculate rewards",
      }).success,
    ).toBe(true);
    expect(
      contextualActionSchema.safeParse({
        kind: "open-domain",
        page: "pool",
        section: "claims",
        label: "Open claims",
      }).success,
    ).toBe(false);
    expect(
      contextualActionSchema.safeParse({
        kind: "open-domain",
        page: "health",
        section: "node",
        href: "https://example.com/injected",
        label: "Open node health",
      }).success,
    ).toBe(false);
  });

  it("preserves the local node as a distinct attention domain", () => {
    const localNode = overviewFixture();
    const item = localNode.attention[0];
    if (!item) throw new Error("Overview fixture must contain one attention item");
    Object.assign(item, { domain: "node", affectedDomains: ["node", "signer"] });
    expect(overviewPageSchema.safeParse(localNode).success).toBe(true);
  });

  it("rejects old alerts, missing primary actions, duplicate IDs, and unknown versions", () => {
    const oldAlert = overviewFixture();
    oldAlert.attention = [
      {
        id: "old-alert",
        severity: "critical",
        title: "Old alert",
        detail: "Stringly action",
        action: { kind: "navigate", target: "manager", label: "Open" },
      } as never,
    ];
    expect(overviewPageSchema.safeParse(oldAlert).success).toBe(false);

    const missingAction = overviewFixture();
    delete (missingAction.attention[0] as Partial<(typeof missingAction.attention)[number]>)
      .primaryAction;
    expect(overviewPageSchema.safeParse(missingAction).success).toBe(false);

    const duplicate = overviewFixture();
    const duplicateItem = duplicate.attention[0];
    if (!duplicateItem) throw new Error("Overview fixture must contain one attention item");
    duplicate.attention.push({ ...duplicateItem });
    expect(overviewPageSchema.safeParse(duplicate).success).toBe(false);

    expect(overviewPageSchema.safeParse({ ...overviewFixture(), schemaVersion: 2 }).success).toBe(
      false,
    );
  });
});

describe("Activity V1 contracts", () => {
  const observedAt = "2026-08-14T12:00:00.000Z";
  const coverage = {
    source: "wallet-intents" as const,
    status: "current" as const,
    observedAt,
    anchor: null,
    reason: null,
  };
  const item = {
    schemaVersion: 1 as const,
    activityId: "wallet-intent:00000000-0000-4000-8000-000000000001",
    kind: "operation" as const,
    domain: "rewards" as const,
    code: "claim-rewards",
    title: "Claim manager rewards",
    summary: "Transaction review is ready for the operator.",
    displayStatus: "action-required" as const,
    outcome: "pending" as const,
    occurredAt: observedAt,
    updatedAt: observedAt,
    deadline: { kind: "time" as const, at: "2026-08-14T12:10:00.000Z" },
    urgencyAt: "2026-08-14T12:10:00.000Z",
    actorPrincipal: "SP000000000000000000002Q6VF78",
    txids: [],
    anchor: null,
    supersedesActivityId: null,
    supersededByActivityId: null,
    primaryAction: {
      kind: "resume-activity" as const,
      activityId: "wallet-intent:00000000-0000-4000-8000-000000000001",
      label: "Resume operation",
    },
    coverage: [coverage],
  };

  it("accepts the versioned page and rejects the retired claims/withdrawals Activity shape", () => {
    expect(
      activityResponseSchema.safeParse({
        schemaVersion: 1,
        generatedAt: observedAt,
        active: [item],
        items: [],
        nextCursor: null,
        coverage: [coverage],
      }).success,
    ).toBe(true);
    const retired = { claims: [], withdrawals: [], claimTotal: 0, withdrawalTotal: 0 };
    expect(activityResponseSchema.safeParse(retired).success).toBe(false);
    expect(rewardsActivityResponseSchema.safeParse(retired).success).toBe(true);
  });

  it("enforces the closed display-status and outcome compatibility table", () => {
    const accepted = new Set([
      "action-required:pending",
      "in-progress:pending",
      "needs-attention:pending",
      "needs-attention:failed",
      "needs-attention:aborted",
      "needs-attention:ambiguous",
      "complete:succeeded",
      "superseded:superseded",
      "observed:observed",
    ]);
    for (const displayStatus of activityDisplayStatusSchema.options) {
      for (const outcome of activityOutcomeSchema.options) {
        expect(
          activityGroupSummarySchema.safeParse({ ...item, displayStatus, outcome }).success,
          `${displayStatus}:${outcome}`,
        ).toBe(accepted.has(`${displayStatus}:${outcome}`));
      }
    }
  });

  it("rejects mismatched resume targets and incomplete absorbed aliases", () => {
    expect(
      activityGroupSummarySchema.safeParse({
        ...item,
        primaryAction: {
          kind: "resume-activity",
          activityId: "engine-job:00000000-0000-4000-8000-000000000002",
          label: "Resume operation",
        },
      }).success,
    ).toBe(false);
    expect(
      activityDetailSchema.safeParse({
        schemaVersion: 1,
        requestedActivityId: "chain-tx:1:0xdead",
        canonicalActivityId: item.activityId,
        aliases: [item.activityId],
        summary: item,
        timeline: [],
      }).success,
    ).toBe(false);
  });
});

describe("dashboard snapshot contract", () => {
  const base = {
    schemaVersion: 1,
    generatedAt: "2026-08-13T12:00:00.000Z",
    network: "mainnet",
    managerPrincipal: "SP000000000000000000002Q6VF78.signer-manager",
    preflight: {},
    manager: {},
    activity: {},
    roster: [],
    alerts: [],
  };

  it("rejects a version-skewed manager without capability data", () => {
    expect(dashboardSnapshotSchema.safeParse(base).success).toBe(false);
  });

  it("accepts the capability boundary consumed by the dashboard", () => {
    expect(
      dashboardSnapshotSchema.safeParse({
        ...base,
        manager: {
          capabilities: {
            signerManagerTrait: { compatible: true, reason: "Exact trait signature" },
            observedFunctions: { public: ["update-fees"], readOnly: ["is-admin"] },
            sourceReview: {
              exactReviewed: true,
              reason: "Reviewed artifact",
              clarityVersion: "Clarity6",
              epoch: "Epoch40",
              interfaceSha256: "11".repeat(32),
            },
            eventVocabulary: {
              id: "reference-manager-v1",
              normalizationAvailable: true,
              adapter: {
                id: "reference-manager-print-events",
                revision: 1,
                reviewedSourceSha256: "22".repeat(32),
              },
              reason: "Reviewed events",
            },
            actions: [
              {
                id: "update-fees",
                interfaceAvailable: true,
                executionAvailable: true,
                missingFunctions: [],
                adapter: {
                  id: "reference-manager-update-fees",
                  revision: 1,
                  reviewedSourceSha256: "22".repeat(32),
                },
                reason: "Reviewed action",
              },
            ],
          },
        },
      }).success,
    ).toBe(true);
  });
});

describe("signer grant contracts", () => {
  it("accepts the complete public grant returned by the signer grant service", () => {
    expect(
      signerGrantSessionResponseSchema.safeParse({
        signerGrant: {
          preparation: {
            managerPrincipal: "SP000000000000000000002Q6VF78.signer-manager",
            pox5ContractId: "SP000000000000000000002Q6VF78.pox-5",
            authId: "8",
            expectedMessageHashHex: "07".repeat(32),
            command: "stacks-signer generate-staking-signature --auth-id 8 --json",
          },
          verified: {
            managerPrincipal: "SP000000000000000000002Q6VF78.signer-manager",
            pox5ContractId: "SP000000000000000000002Q6VF78.pox-5",
            authId: "8",
            signerKeyHex: `02${"11".repeat(32)}`,
            signerSignatureHex: "22".repeat(65),
            expectedMessageHashHex: "07".repeat(32),
            signatureValid: true,
            registerSelfCall: {
              contract: "SP000000000000000000002Q6VF78.signer-manager",
              functionName: "register-self",
              arguments: ["0x01"],
              signingPrincipal: "SP000000000000000000002Q6VF78",
              signingAuthority: "external-offline-admin",
            },
          },
        },
      }).success,
    ).toBe(true);
  });
});

describe("reconciliation contracts", () => {
  const reconciliation = {
    observedAt: "2026-07-19T18:00:00.000Z",
    stakers: {
      resumed: false,
      status: "completed" as const,
      authoritative: true,
      pagesProcessed: 2,
      itemsProcessed: 125,
      activeStakers: 120,
      nodeVerifiedStxPositions: 118,
      unverifiedStxDiscoveries: 2,
      discrepanciesObserved: 1,
    },
    events: {
      resumed: true,
      pagesProcessed: 1,
      eventsProcessed: 20,
      newEvents: 3,
      replayedEvents: 17,
      decodeFailures: 0,
      reorgedEvents: 0,
      stoppedAtKnownOverlap: true,
    },
  };

  it("accepts bounded process-local progress and success summaries", () => {
    expect(reconciliationSummarySchema.safeParse(reconciliation).success).toBe(true);
    const operation = {
      schemaVersion: 1,
      operationId: "10000000-0000-4000-8000-000000000001",
      trigger: "automatic",
      status: "succeeded",
      phase: "complete",
      processLocal: true,
      startedAt: "2026-07-19T18:00:00.000Z",
      updatedAt: "2026-07-19T18:00:02.000Z",
      completedAt: "2026-07-19T18:00:02.000Z",
      progress: {
        completedSteps: 4,
        totalSteps: 4,
        itemsCompleted: null,
        itemsTotal: null,
        message: "Reconciliation complete",
      },
      result: {
        reconciliation,
        snapshotGeneratedAt: "2026-07-19T18:00:02.000Z",
      },
      error: null,
    };
    expect(reconciliationOperationSchema.safeParse(operation).success).toBe(true);
    expect(syncResponseSchema.safeParse({ operation }).success).toBe(true);
  });

  it("rejects unbounded or unrecognized reconciliation result fields", () => {
    expect(
      reconciliationSummarySchema.safeParse({ ...reconciliation, rawRows: ["must-not-cross-api"] })
        .success,
    ).toBe(false);
  });
});

describe("V1 runtime settings contract", () => {
  it("strips retired settings from legacy-shaped responses", () => {
    const parsed = runtimeSettingsSchema.parse({
      schemaVersion: 1,
      revision: 2,
      updatedAt: "2026-07-17T12:00:00.000Z",
      pool: {
        displayName: "Pool",
        websiteUrl: "",
        supportContact: "",
        leatherUrl: "https://earn.leather.io",
      },
      display: {
        timezone: "UTC",
        timeFormat: "relative",
        numberFormat: "1,234.5678",
        defaultTheme: "system",
      },
      dataSources: {
        nodeRpcUrl: "http://127.0.0.1:20443",
        apiUrl: "https://api.mainnet.hiro.so",
        apiKeyHeader: "x-api-key",
        apiKeyConfigured: false,
        apiKeySource: "none",
        nodeMetricsUrl: "",
        signerMonitoringUrl: "",
        hiroReferenceApiUrl: "",
      },
      forecast: { horizonCycles: 12 },
      embed: { type: "live", publicApiUrl: "https://pool.example.com" },
      payoutPolicy: { maxTransactionFeeUstx: "100000" },
      automation: { mode: "observe", gasPayerPrincipal: "" },
      alerts: { webhookUrl: "", criticalOnly: false },
      audit: [],
    });

    expect(parsed.display).toEqual({ defaultTheme: "system" });
    expect(parsed.embed).toEqual({ publicApiUrl: "https://pool.example.com" });
    expect(parsed).not.toHaveProperty("payoutPolicy");
    expect(parsed).not.toHaveProperty("automation");
    expect(parsed).not.toHaveProperty("alerts");
  });
});

describe("browser-wallet intent contracts", () => {
  const actor = "ST000000000000000000002AMW42H";

  function managerIntent(
    network: "mainnet" | "pox5-testnet" | "devnet" | "regtest",
    chainId: number,
  ) {
    return {
      schemaVersion: 2,
      id: "10000000-0000-4000-8000-000000000001",
      action: "update-fees",
      request: { action: "update-fees", actorPrincipal: actor, feeBips: "250" },
      network,
      chainId,
      requiredSender: actor,
      createdAt: "2026-07-19T12:00:00.000Z",
      expiresAt: "2026-07-19T12:15:00.000Z",
      transaction: {
        method: "stx_callContract",
        params: {
          contract: `${actor}.signer-manager`,
          functionName: "update-fees",
          functionArgs: ["01000000000000000000000000000000fa"],
          network,
          address: actor,
          sponsored: false,
          postConditionMode: "deny",
          postConditions: [],
        },
      },
      review: {
        title: "Update fees",
        summary: "Set exact fees",
        expectedPostState: "Fee is 250 bips",
        fields: [{ label: "New fee", value: "250" }],
      },
      seal: { factsSha256: "a".repeat(64), manifestSha256: "b".repeat(64) },
      status: "prepared",
      txid: null,
      verification: null,
    };
  }

  it("keeps setup aliases separate from actor-bound manager actions", () => {
    expect(
      onboardingBrowserWalletIntentCreateRequestSchema.safeParse({ action: "register-self" })
        .success,
    ).toBe(true);
    expect(
      onboardingBrowserWalletIntentCreateRequestSchema.safeParse({
        action: "register-self",
        actorPrincipal: actor,
      }).success,
    ).toBe(false);
    expect(
      browserWalletIntentCreateRequestSchema.safeParse({ action: "register-self" }).success,
    ).toBe(false);
    expect(
      browserWalletIntentCreateRequestSchema.safeParse({
        action: "register-self",
        actorPrincipal: actor,
      }).success,
    ).toBe(true);
  });

  it("describes a retryable exact-anchor mismatch with each observed height", () => {
    const mismatch = {
      error: "wallet_intent_anchor_mismatch",
      retryable: true,
      node: { stacksTipHeight: 28_079, burnBlockHeight: 4_818 },
      api: { stacksTipHeight: 28_097, burnBlockHeight: 4_819 },
      poxBurnBlockHeight: 4_819,
    };

    expect(walletIntentAnchorMismatchErrorSchema.safeParse(mismatch).success).toBe(true);
    expect(
      walletIntentAnchorMismatchErrorSchema.safeParse({ ...mismatch, retryable: false }).success,
    ).toBe(false);
    expect(
      walletIntentAnchorMismatchErrorSchema.safeParse({
        ...mismatch,
        node: { ...mismatch.node, stacksTipHeight: -1 },
      }).success,
    ).toBe(false);
    expect(
      walletIntentAnchorMismatchErrorSchema.safeParse({ ...mismatch, unexpected: true }).success,
    ).toBe(false);
    expect(
      walletIntentAnchorUnstableErrorSchema.safeParse({
        error: "wallet_intent_anchor_unstable",
        retryable: true,
      }).success,
    ).toBe(true);
    expect(
      walletIntentAnchorUnstableErrorSchema.safeParse({
        error: "wallet_intent_anchor_unstable",
        retryable: false,
      }).success,
    ).toBe(false);
  });

  it("accepts only canonical bounded uint action inputs", () => {
    expect(
      browserWalletIntentCreateRequestSchema.safeParse({
        action: "update-fees",
        actorPrincipal: actor,
        feeBips: "9999",
      }).success,
    ).toBe(true);
    for (const feeBips of ["01", "10000", "-1"]) {
      expect(
        browserWalletIntentCreateRequestSchema.safeParse({
          action: "update-fees",
          actorPrincipal: actor,
          feeBips,
        }).success,
      ).toBe(false);
    }
    expect(
      browserWalletIntentCreateRequestSchema.safeParse({
        action: "withdraw-fees",
        actorPrincipal: actor,
        amountSats: "0",
        recipient: actor,
      }).success,
    ).toBe(false);
    expect(
      browserWalletIntentCreateRequestSchema.safeParse({
        action: "add-admin",
        actorPrincipal: actor,
        adminPrincipal: `${actor}.contract-admin`,
      }).success,
    ).toBe(false);
  });

  it("binds reward claims to one existing engine job", () => {
    const request = {
      action: "claim-rewards",
      actorPrincipal: actor,
      jobId: "10000000-0000-4000-8000-000000000001",
    };
    expect(browserWalletIntentCreateRequestSchema.safeParse(request).success).toBe(true);
    expect(
      browserWalletIntentCreateRequestSchema.safeParse({
        action: "claim-rewards",
        actorPrincipal: actor,
      }).success,
    ).toBe(false);

    const intent = {
      schemaVersion: 2,
      id: "10000000-0000-4000-8000-000000000002",
      action: "claim-rewards",
      request,
      network: "pox5-testnet",
      chainId: 0x80000005,
      requiredSender: actor,
      createdAt: "2026-07-19T12:00:00.000Z",
      expiresAt: "2026-07-19T12:15:00.000Z",
      transaction: {
        method: "stx_callContract",
        params: {
          contract: `${actor}.signer-manager`,
          functionName: "claim-rewards",
          functionArgs: ["0x0b00000000", "0x0100000000000000000000000000000005"],
          network: "pox5-testnet",
          address: actor,
          sponsored: false,
          postConditionMode: "deny",
          postConditions: ["0x0001"],
        },
      },
      review: {
        title: "Claim rewards",
        summary: "Claim the exact engine job",
        expectedPostState: "The engine reconciles the claim",
        fields: [{ label: "Job", value: request.jobId }],
      },
      seal: { factsSha256: "a".repeat(64), manifestSha256: "b".repeat(64) },
      status: "prepared",
      txid: null,
      verification: null,
    };
    expect(browserWalletIntentSchema.safeParse(intent).success).toBe(true);
    expect(
      browserWalletIntentSchema.safeParse({
        ...intent,
        transaction: {
          ...intent.transaction,
          params: { ...intent.transaction.params, postConditions: [] },
        },
      }).success,
    ).toBe(false);
  });

  it("binds V2 PoX-5 Testnet intents to the exact chain and immutable request", () => {
    const intent = managerIntent("pox5-testnet", 0x80000005);
    expect(browserWalletIntentSchema.safeParse(intent).success).toBe(true);
    expect(browserWalletIntentSchema.safeParse({ ...intent, chainId: 0x80000000 }).success).toBe(
      false,
    );
    expect(browserWalletIntentSchema.safeParse({ ...intent, request: undefined }).success).toBe(
      false,
    );
  });

  it.each([
    ["devnet", 0x80000000],
    ["regtest", 256],
  ] as const)("accepts V2 %s intents with sealed uint32 private chain IDs", (network, chainId) => {
    expect(browserWalletIntentSchema.safeParse(managerIntent(network, chainId)).success).toBe(true);
  });

  it("rejects private-network label mismatches and non-uint32 chain IDs", () => {
    const intent = managerIntent("devnet", 256);
    expect(
      browserWalletIntentSchema.safeParse({
        ...intent,
        transaction: {
          ...intent.transaction,
          params: { ...intent.transaction.params, network: "regtest" },
        },
      }).success,
    ).toBe(false);
    expect(browserWalletIntentSchema.safeParse({ ...intent, chainId: -1 }).success).toBe(false);
    expect(browserWalletIntentSchema.safeParse({ ...intent, chainId: 0x1_0000_0000 }).success).toBe(
      false,
    );
  });

  it("rejects an action paired with a different allowlisted function", () => {
    const intent = managerIntent("mainnet", 1);
    expect(
      browserWalletIntentSchema.safeParse({
        ...intent,
        transaction: {
          ...intent.transaction,
          params: {
            ...intent.transaction.params,
            functionName: "update-admin",
            functionArgs: ["0x051a0000000000000000000000000000000000000000", "0x03"],
          },
        },
      }).success,
    ).toBe(false);
  });

  it("keeps schema version 1 mainnet-only", () => {
    const intent = {
      schemaVersion: 1,
      id: "10000000-0000-4000-8000-000000000003",
      action: "deploy-manager",
      network: "mainnet",
      chainId: 1,
      requiredSender: actor,
      createdAt: "2026-07-19T12:00:00.000Z",
      expiresAt: "2026-07-19T12:15:00.000Z",
      transaction: {
        method: "stx_deployContract",
        params: {
          name: "signer-manager",
          clarityCode: "(ok true)",
          clarityVersion: 6,
          network: "mainnet",
          address: actor,
          sponsored: false,
          postConditionMode: "deny",
          postConditions: [],
        },
      },
      review: {
        title: "Deploy manager",
        summary: "Deploy the sealed manager source",
        expectedPostState: "The manager is deployed",
        fields: [],
      },
      seal: { factsSha256: "a".repeat(64), manifestSha256: "b".repeat(64) },
      status: "prepared",
      txid: null,
      verification: null,
    };
    expect(browserWalletIntentSchema.safeParse(intent).success).toBe(true);
    expect(
      browserWalletIntentSchema.safeParse({
        ...intent,
        network: "devnet",
        chainId: 256,
        transaction: {
          ...intent.transaction,
          params: { ...intent.transaction.params, network: "devnet" },
        },
      }).success,
    ).toBe(false);
  });
});
