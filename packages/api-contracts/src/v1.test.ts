import { describe, expect, it } from "vitest";
import {
  browserWalletIntentCreateRequestSchema,
  browserWalletIntentSchema,
  onboardingBrowserWalletIntentCreateRequestSchema,
  reconciliationOperationSchema,
  reconciliationSummarySchema,
  runtimeSettingsSchema,
  syncResponseSchema,
  walletIntentAnchorMismatchErrorSchema,
  walletIntentAnchorUnstableErrorSchema,
} from "./v1.js";

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
