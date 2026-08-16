import { z } from "zod";
import { type EngineChainAnchor, engineChainAnchorSchema } from "./engine.js";

export const connectionOutcomeCodeSchema = z.enum([
  "node-unreachable",
  "node-network-mismatch",
  "pox5-unavailable",
  "principal-network-mismatch",
  "manager-not-deployed",
  "manager-trait-mismatch",
  "deployment-identity-mismatch",
]);
export type ConnectionOutcomeCode = z.infer<typeof connectionOutcomeCodeSchema>;

const connectionNetworkSchema = z.enum(["mainnet", "testnet", "devnet", "regtest"]);
const connectionPrincipalSchema = z.string().min(3).max(500);
const networkIdSchema = z.number().int().nonnegative().max(0xffff_ffff);

export const deploymentIdentityBindingSchema = z
  .object({
    schemaVersion: z.literal(1),
    network: connectionNetworkSchema,
    networkId: networkIdSchema,
    parentNetworkId: networkIdSchema.nullable(),
    managerPrincipal: connectionPrincipalSchema,
    bindingSource: z.enum(["new", "legacy-evidence"]),
    boundAt: z.iso.datetime(),
    lastVerifiedAt: z.iso.datetime(),
    lastStacksTipHeight: z.number().int().nonnegative(),
    lastBurnBlockHeight: z.number().int().nonnegative(),
    lastPox5ContractId: connectionPrincipalSchema,
  })
  .strict();
export type DeploymentIdentityBinding = z.infer<typeof deploymentIdentityBindingSchema>;

export const connectionAssessmentSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["connected", "blocked", "unavailable"]),
    outcomeCode: connectionOutcomeCodeSchema.nullable(),
    checkedAt: z.iso.datetime(),
    stale: z.boolean(),
    configured: z
      .object({
        network: connectionNetworkSchema,
        networkId: networkIdSchema,
        nodeRpcUrl: z.string().min(1),
        managerPrincipal: connectionPrincipalSchema,
      })
      .strict(),
    observed: z
      .object({
        networkId: networkIdSchema,
        parentNetworkId: networkIdSchema.nullable(),
        stacksTipHeight: z.number().int().nonnegative(),
        burnBlockHeight: z.number().int().nonnegative(),
        pox5ContractId: connectionPrincipalSchema.nullable(),
        manager: z
          .object({
            deployed: z.boolean(),
            traitCompatible: z.boolean(),
            missingRequirements: z.array(z.string().min(1)).max(32),
            publishHeight: z.number().int().nonnegative().nullable(),
            clarityVersion: z.string().nullable(),
            epoch: z.string().nullable(),
          })
          .strict()
          .nullable(),
      })
      .strict()
      .nullable(),
    lastSuccessful: deploymentIdentityBindingSchema.nullable(),
    deploymentIdentity: z
      .object({
        status: z.enum(["unbound", "bound", "mismatch"]),
        stored: deploymentIdentityBindingSchema.nullable(),
        reason: z.string().nullable(),
      })
      .strict(),
    checks: z
      .array(
        z
          .object({
            id: z.enum([
              "deployment-identity",
              "node-network",
              "pox5",
              "principal-network",
              "manager-trait",
            ]),
            status: z.enum(["pass", "fail", "unavailable", "not-checked"]),
            message: z.string().min(1).max(1_000),
          })
          .strict(),
      )
      .length(5),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.status === "connected") !== (value.outcomeCode === null)) {
      context.addIssue({
        code: "custom",
        path: ["outcomeCode"],
        message: "Only a connected assessment may omit its outcome code",
      });
    }
    if (value.status === "connected" && value.stale) {
      context.addIssue({
        code: "custom",
        path: ["stale"],
        message: "A connected assessment must contain current evidence",
      });
    }
  });
export type ConnectionAssessment = z.infer<typeof connectionAssessmentSchema>;

export const deploymentRequirementSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
    component: z.enum(["node", "signer", "sidekick"]),
    importance: z.enum(["required", "recommended"]),
    status: z.enum(["pass", "attention", "not-configured", "unavailable"]),
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(2_000),
    observed: z.string().max(1_000).nullable(),
    remediation: z
      .object({
        steps: z.array(z.string().min(1).max(1_000)).min(1).max(12),
        configuration: z
          .array(
            z
              .object({
                label: z.string().min(1).max(120),
                format: z.enum(["toml", "dotenv", "command"]),
                content: z.string().min(1).max(10_000),
              })
              .strict(),
          )
          .max(8),
        restartServices: z.array(z.enum(["stacks-node", "stacks-signer", "sidekick"])).max(3),
        docsUrl: z.url().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type DeploymentRequirement = z.infer<typeof deploymentRequirementSchema>;

export const deploymentRequirementsSchema = z
  .object({
    schemaVersion: z.literal(1),
    checkedAt: z.iso.datetime(),
    status: z.enum(["ready", "attention", "blocked"]),
    requiredReady: z.boolean(),
    checks: z.array(deploymentRequirementSchema).min(1).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    const requiredReady = value.checks
      .filter(({ importance }) => importance === "required")
      .every(({ status }) => status === "pass");
    const expectedStatus = !requiredReady
      ? "blocked"
      : value.checks.every(({ status }) => status === "pass")
        ? "ready"
        : "attention";
    if (value.requiredReady !== requiredReady) {
      context.addIssue({
        code: "custom",
        path: ["requiredReady"],
        message: "requiredReady must reflect every required deployment check",
      });
    }
    if (value.status !== expectedStatus) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Deployment status must reflect required and recommended checks",
      });
    }
  });
export type DeploymentRequirements = z.infer<typeof deploymentRequirementsSchema>;

export const rateLimitInfoSchema = z
  .object({
    source: z.enum(["hiro-api", "stacks-api", "node"]),
    retryAfterSeconds: z.number().int().positive(),
    apiKeyConfigured: z.boolean().optional(),
  })
  .strict();
export type RateLimitInfo = z.infer<typeof rateLimitInfoSchema>;

export const localNodeAuthoritySchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["current", "catching-up", "unknown"]),
    observedAt: z.iso.datetime(),
    stacksTipHeight: z.number().int().nonnegative(),
    highestProvenCurrentStacksTipHeight: z.number().int().nonnegative().nullable(),
    consecutiveCurrentObservations: z.number().int().nonnegative(),
    reason: z.string().min(1).max(1_000),
  })
  .strict();
export type LocalNodeAuthority = z.infer<typeof localNodeAuthoritySchema>;

const historyRecoveryDomainSchema = z
  .object({
    status: z.enum(["not-started", "reconstructing", "complete"]),
    updatedAt: z.iso.datetime().nullable(),
  })
  .strict();

export const historyRecoveryCoverageSchema = z
  .object({
    schemaVersion: z.literal(1),
    monitoringStartedAt: z.iso.datetime().nullable(),
    managerHistory: historyRecoveryDomainSchema.extend({
      recoveryBoundaryStacksHeight: z.number().int().nonnegative().nullable(),
    }),
    currentMemberHistory: historyRecoveryDomainSchema.extend({
      currentMembers: z.number().int().nonnegative(),
      membersComplete: z.number().int().nonnegative(),
      pagesProcessed: z.number().int().nonnegative(),
      transactionsInspected: z.number().int().nonnegative(),
      relevantEvents: z.number().int().nonnegative(),
    }),
    rewardHistory: historyRecoveryDomainSchema.extend({
      recoveryBoundaryStacksHeight: z.number().int().nonnegative().nullable(),
    }),
    signerHealthHistory: z
      .object({
        status: z.literal("monitoring-since-install"),
        monitoringStartedAt: z.iso.datetime().nullable(),
      })
      .strict(),
  })
  .strict();
export type HistoryRecoveryCoverage = z.infer<typeof historyRecoveryCoverageSchema>;

const runtimeSettingsShape = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string().nullable(),
  pool: z.looseObject({
    displayName: z.string(),
    websiteUrl: z.string(),
    supportContact: z.string(),
    leatherUrl: z.string(),
  }),
  display: z.object({
    defaultTheme: z.enum(["light", "dark", "system"]),
  }),
  dataSources: z.looseObject({
    nodeRpcUrl: z.string(),
    apiUrl: z.string(),
    apiKeyHeader: z.string(),
    apiKeyConfigured: z.boolean(),
    apiKeySource: z.enum(["environment", "database", "none"]),
    nodeMetricsUrl: z.string(),
    signerMonitoringUrl: z.string(),
    hiroReferenceApiUrl: z.string(),
  }),
  forecast: z.looseObject({ horizonCycles: z.number().int().nonnegative() }),
  embed: z.object({ publicApiUrl: z.string() }),
  audit: z.array(
    z.looseObject({
      revision: z.number().int().nonnegative(),
      changedFields: z.array(z.string()),
      changedAt: z.string(),
    }),
  ),
});

export const runtimeSettingsSchema = runtimeSettingsShape;
export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;

const sourceStateSchema = z.looseObject({
  configured: z.boolean(),
  status: z.enum(["healthy", "unavailable", "not-configured"]),
  checkedAt: z.iso.datetime().nullable(),
  lastSuccessAt: z.iso.datetime().nullable(),
  latencyMs: z.number().nonnegative().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
});

export const healthClassificationSchema = z.enum([
  "healthy",
  "likely-local-node",
  "likely-local-signer",
  "source-disagreement",
  "suspected-network-wide",
  "insufficient-evidence",
]);
export type HealthClassification = z.infer<typeof healthClassificationSchema>;

const healthEvidenceWindowSchema = z
  .object({
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime(),
    sampleCount: z.number().int().nonnegative(),
    distinctSources: z.number().int().nonnegative(),
  })
  .strict();

const healthFindingEvidenceSchema = z
  .object({
    code: z.string().min(1).max(120),
    source: z.enum([
      "local-node",
      "node-peers",
      "signer-monitoring",
      "configured-api",
      "reference-api",
      "on-chain",
    ]),
    status: z.enum(["supporting", "contradicting", "unavailable", "collecting"]),
    observedAt: z.iso.datetime().nullable(),
    value: z.string().max(500).nullable(),
    detail: z.string().min(1).max(1_000),
  })
  .strict();

export const healthFindingSchema = z
  .object({
    id: z.string().min(1).max(120),
    episodeId: z.string().uuid().nullable(),
    severity: z.enum(["critical", "warning", "info"]),
    title: z.string().min(1).max(200),
    detail: z.string().min(1).max(2_000),
    source: z.enum(["node", "signer", "network", "source"]),
    classification: healthClassificationSchema.exclude(["healthy"]),
    confidence: z.enum(["high", "medium", "low"]),
    firstObservedAt: z.iso.datetime(),
    lastObservedAt: z.iso.datetime(),
    evidenceWindow: healthEvidenceWindowSchema,
    evidence: z.array(healthFindingEvidenceSchema).min(1).max(20),
  })
  .strict();

export const healthFindingEpisodeSchema = healthFindingSchema
  .omit({ episodeId: true })
  .extend({
    episodeId: z.string().uuid(),
    status: z.enum(["active", "resolved"]),
    resolvedAt: z.iso.datetime().nullable(),
    occurrences: z.number().int().positive(),
  })
  .strict();

export const healthRollupSchema = z
  .object({
    windowStartedAt: z.iso.datetime(),
    windowEndedAt: z.iso.datetime(),
    sampleCount: z.number().int().positive(),
    nodeRpcAvailabilityPercent: z.number().min(0).max(100),
    signerAvailabilityPercent: z.number().min(0).max(100).nullable(),
    nodeStacksHeightStart: z.number().int().nonnegative().nullable(),
    nodeStacksHeightEnd: z.number().int().nonnegative().nullable(),
    nodeAdvanceCount: z.number().int().nonnegative(),
    proposals: z.number().int().nonnegative().nullable(),
    accepted: z.number().int().nonnegative().nullable(),
    rejected: z.number().int().nonnegative().nullable(),
    disagreements: z.number().int().nonnegative().nullable(),
    responseP95Seconds: z.number().nonnegative().nullable(),
    validationP95Seconds: z.number().nonnegative().nullable().default(null),
  })
  .strict();

const signerWindowSchema = z
  .object({
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime(),
    sampleCount: z.number().int().nonnegative(),
    proposals: z.number().int().nonnegative().nullable(),
    validationAccepted: z.number().int().nonnegative().nullable(),
    validationRejected: z.number().int().nonnegative().nullable(),
    accepted: z.number().int().nonnegative().nullable(),
    rejected: z.number().int().nonnegative().nullable(),
    responseGap: z.number().int().nonnegative().nullable(),
    rejectionPercent: z.number().min(0).max(100).nullable(),
    responseP95Seconds: z.number().nonnegative().nullable(),
    validationP95Seconds: z.number().nonnegative().nullable(),
    nodeRpcP95Seconds: z.number().nonnegative().nullable(),
    capitulationP95Seconds: z.number().nonnegative().nullable(),
    disagreements: z.number().int().nonnegative().nullable(),
    preCommits: z.number().int().nonnegative().nullable(),
    collectingBaseline: z.boolean(),
  })
  .strict();

export const healthSnapshotSchema = z.looseObject({
  schemaVersion: z.literal(2),
  generatedAt: z.iso.datetime(),
  overallStatus: z.enum(["healthy", "monitoring", "needs-attention", "partial", "unavailable"]),
  coverage: z.looseObject({ available: z.number(), total: z.number() }),
  burnBlockTiming: z
    .looseObject({
      averageSeconds: z.number(),
      windowHours: z.union([z.literal(12), z.literal(24)]),
      sampleBlocks: z.number(),
      sampledAt: z.iso.datetime(),
    })
    .nullable(),
  diagnosis: z
    .object({
      status: z.enum(["healthy", "monitoring", "needs-attention", "collecting", "unavailable"]),
      classification: healthClassificationSchema,
      confidence: z.enum(["high", "medium", "low"]),
      title: z.string().min(1).max(200),
      summary: z.string().min(1).max(2_000),
      evidenceWindow: healthEvidenceWindowSchema,
      activeFindingIds: z.array(z.string().min(1).max(120)),
    })
    .strict(),
  findings: z.array(healthFindingSchema),
  history: z
    .object({
      sampleIntervalSeconds: z.literal(5),
      rawRetentionHours: z.literal(72),
      rollupIntervalMinutes: z.literal(5),
      rollupRetentionDays: z.literal(90),
      observedSince: z.iso.datetime().nullable(),
      observationCount: z.number().int().nonnegative(),
      recentRollups: z.array(healthRollupSchema).max(288),
      recentEpisodes: z.array(healthFindingEpisodeSchema).max(50),
    })
    .strict(),
  operator: z
    .object({
      network: z.string(),
      managerPrincipal: z.string(),
      currentRewardCycle: z.number().int().nonnegative(),
      registered: z.boolean().nullable(),
      signerKeyHex: z.string().nullable(),
      signerKeyGrantValid: z.boolean().nullable(),
      expectedCurrentParticipation: z.boolean(),
      expectedNextParticipation: z.boolean(),
    })
    .strict()
    .nullable(),
  node: z.looseObject({
    rpc: sourceStateSchema,
    metrics: sourceStateSchema,
    version: z.string().nullable(),
    networkId: z.number().nullable(),
    stacksTipHeight: z.number().nullable(),
    burnBlockHeight: z.number().nullable(),
    isFullySynced: z.boolean().nullable().optional(),
    peerHeightDifference: z.number().nullable().optional(),
    lastTipAdvanceAt: z.string().nullable(),
    inboundPeers: z.number().nullable(),
    outboundPeers: z.number().nullable(),
    lastHour: z.looseObject({ warnings: z.number().nullable(), errors: z.number().nullable() }),
  }),
  hiro: z.looseObject({
    source: sourceStateSchema,
    stacksTipHeight: z.number().nullable(),
    burnBlockHeight: z.number().nullable(),
    localStacksDifference: z.number().nullable(),
    localBurnDifference: z.number().nullable(),
    lastTipAdvanceAt: z.iso.datetime().nullable().optional(),
    advancementStatus: z.enum(["advancing", "collecting", "insufficient-evidence"]).optional(),
  }),
  configuredApi: z.looseObject({
    distinctFromReference: z.boolean(),
    source: sourceStateSchema,
    stacksTipHeight: z.number().nullable(),
    burnBlockHeight: z.number().nullable(),
    localStacksDifference: z.number().nullable(),
    localBurnDifference: z.number().nullable(),
    lastTipAdvanceAt: z.iso.datetime().nullable(),
    advancementStatus: z.enum(["advancing", "collecting", "insufficient-evidence"]),
  }),
  signer: z.looseObject({
    infoSource: sourceStateSchema,
    heartbeat: sourceStateSchema,
    metrics: sourceStateSchema,
    version: z.string().nullable(),
    network: z.string().nullable(),
    publicKey: z.string().nullable(),
    stxAddress: z.string().nullable(),
    observedNodeHeight: z.number().nullable(),
    nodeHeightDifference: z.number().nullable(),
    rewardCycle: z.number().nullable(),
    stxBalanceUstx: z.number().nullable(),
    identityMatchesRegistration: z.boolean().nullable(),
    networkMatchesConfiguration: z.boolean().nullable(),
    rewardCycleMatchesNode: z.boolean().nullable(),
    last15Minutes: signerWindowSchema,
    lastHour: z.looseObject({
      proposals: z.number().nullable(),
      accepted: z.number().nullable(),
      rejected: z.number().nullable(),
      rejectionPercent: z.number().nullable(),
      responseP95Seconds: z.number().nullable(),
      // Retained health snapshots from before validation latency was exposed
      // should remain readable after an upgrade.
      validationP95Seconds: z.number().nullable().default(null),
      disagreements: z.number().nullable(),
      collectingBaseline: z.boolean(),
    }),
  }),
});
export type HealthSnapshot = z.infer<typeof healthSnapshotSchema>;

export type BrowserWalletIntentAction =
  | "deploy-manager"
  | "register-self"
  | "add-admin"
  | "remove-admin"
  | "update-fees"
  | "withdraw-fees"
  | "sweep-fee-refunds"
  | "claim-rewards"
  | "claim-staker-rewards"
  | "calculate-rewards";
export type RecurringWalletIntentAction = Exclude<BrowserWalletIntentAction, "deploy-manager">;
export type BrowserWalletIntentNetwork = "mainnet" | "pox5-testnet" | "devnet" | "regtest";
export type BrowserWalletConnectNetwork = BrowserWalletIntentNetwork;
export type OnboardingBrowserWalletIntentCreateRequest =
  | { action: "deploy-manager" }
  | { action: "register-self" };
export type BrowserWalletIntentCreateRequest =
  | { action: "deploy-manager" }
  | { action: "register-self"; actorPrincipal: string }
  | { action: "add-admin" | "remove-admin"; actorPrincipal: string; adminPrincipal: string }
  | { action: "update-fees"; actorPrincipal: string; feeBips: string }
  | {
      action: "withdraw-fees";
      actorPrincipal: string;
      amountSats: string;
      recipient: string;
    }
  | { action: "sweep-fee-refunds"; actorPrincipal: string; recipient: string }
  | { action: "claim-rewards"; actorPrincipal: string; jobId: string }
  | { action: "calculate-rewards"; actorPrincipal: string }
  | {
      action: "claim-staker-rewards";
      actorPrincipal: string;
      stakerPrincipal: string;
      rewardCycle: string;
      bondIndex: string | null;
    };
export type BrowserWalletIntentRequest =
  | OnboardingBrowserWalletIntentCreateRequest
  | BrowserWalletIntentCreateRequest;
export type RecurringBrowserWalletIntentCreateRequest = Exclude<
  BrowserWalletIntentCreateRequest,
  { action: "deploy-manager" }
>;

export interface SignerGrantSession {
  preparation: null | {
    managerPrincipal: string;
    pox5ContractId: string;
    command: string;
    expectedMessageHashHex: string;
    authId: string;
  };
  verified: null | {
    managerPrincipal: string;
    pox5ContractId: string;
    authId: string;
    signerKeyHex: string;
    signerSignatureHex: string;
    expectedMessageHashHex: string;
    signatureValid: true;
    registerSelfCall: {
      contract: string;
      functionName: string;
      arguments: string[];
      signingPrincipal: string;
      signingAuthority: "external-offline-admin";
    };
  };
}
export type BrowserWalletIntentStatus =
  | "prepared"
  | "submitted"
  | "mempool"
  | "confirmed"
  | "complete"
  | "expired"
  | "superseded"
  | "failed"
  | "reobserve";

export type BrowserWalletTransaction =
  | {
      method: "stx_deployContract";
      params: {
        name: string;
        clarityCode: string;
        clarityVersion: 6;
        network: BrowserWalletConnectNetwork;
        address: string;
        sponsored: false;
        postConditionMode: "deny";
        postConditions: [];
      };
    }
  | {
      method: "stx_callContract";
      params: {
        contract: string;
        functionName:
          | "register-self"
          | "update-admin"
          | "update-fees"
          | "withdraw-fees"
          | "sweep-fee-refunds"
          | "claim-rewards"
          | "claim-staker-rewards"
          | "calculate-rewards";
        functionArgs: string[];
        network: BrowserWalletConnectNetwork;
        address: string;
        sponsored: false;
        postConditionMode: "deny";
        postConditions: string[];
      };
    };

export interface BrowserWalletIntent {
  schemaVersion: 1 | 2;
  id: string;
  action: BrowserWalletIntentAction;
  network: BrowserWalletIntentNetwork;
  chainId: number;
  requiredSender: string;
  createdAt: string;
  expiresAt: string;
  transaction: BrowserWalletTransaction;
  request?: BrowserWalletIntentRequest | undefined;
  /** Immutable operation-specific completion binding. */
  binding?:
    | {
        kind: "calculate-rewards";
        pox5ContractId: string;
        targetRewardCycle: number;
        targetCheckpoint: "first-half" | "second-half";
        expectedLastRewardComputeBurnHeight: number;
      }
    | undefined;
  review: {
    title: string;
    summary: string;
    expectedPostState: string;
    fields: Array<{ label: string; value: string }>;
  };
  seal: {
    factsSha256: string;
    manifestSha256: string;
  };
  status: BrowserWalletIntentStatus;
  txid: string | null;
  verification: null | {
    outcome:
      | "submitted"
      | "mempool"
      | "canonical-success"
      | "complete"
      | "not-found"
      | "noncanonical"
      | "superseded"
      | "mismatch"
      | "abort"
      | "unavailable";
    observedAt: string;
    canonical: boolean | null;
    blockHeight: number | null;
    indexBlockHash: string | null;
    detail: string;
  };
}

interface Eligibility {
  cycleId: number;
  delegatedUstx: string;
  thresholdUstx: string;
  meetsThreshold: boolean;
  inSignerSet: boolean;
}

export type ManagerActionCapabilityId =
  | "register-self"
  | "update-admin"
  | "update-fees"
  | "withdraw-fees"
  | "sweep-fee-refunds"
  | "reference-reward-claims";

export interface ManagerActionCapability {
  id: ManagerActionCapabilityId;
  interfaceAvailable: boolean;
  executionAvailable: boolean;
  missingFunctions: string[];
  adapter: null | {
    id: string;
    revision: number;
    reviewedSourceSha256: string;
  };
  reason: string;
}

export interface ManagerCapabilities {
  signerManagerTrait: {
    compatible: boolean;
    reason: string;
  };
  observedFunctions: {
    public: string[];
    readOnly: string[];
  };
  sourceReview: {
    exactReviewed: boolean;
    reason: string;
    clarityVersion?: string | null;
    epoch?: string | null;
    interfaceSha256?: string;
  };
  eventVocabulary: {
    id: "reference-manager-v1";
    normalizationAvailable: boolean;
    adapter: null | {
      id: string;
      revision: number;
      reviewedSourceSha256: string;
    };
    reason: string;
  };
  actions: ManagerActionCapability[];
}

export interface OperatorSnapshot {
  managerPrincipal: string;
  network: string;
  readiness?: OperatorSnapshot["setup"];
  setup: null | {
    status: "ready" | "attention" | "blocked";
    enrollmentWindow: {
      status: "open" | "prepare-phase" | "unknown";
      targetCycleId: number | null;
      preparePhaseStartBurnHeight: number | null;
      blocksUntilPreparePhase: number | null;
    };
    eligibility: { current: Eligibility | null; next: Eligibility | null };
    checks: Array<{ id: string; status: "pass" | "warn" | "fail"; message: string }>;
  };
  preflight: {
    status: "pass" | "warn" | "fail";
    node: {
      serverVersion: string | null;
      version: string | null;
      commit: string | null;
      burnBlockHeight: number;
    };
    pox: {
      activationState: "active" | "scheduled" | "unavailable";
      blocksUntilActivation: number | null;
    };
    cycle: {
      currentId: number | null;
      nextId: number | null;
      preparePhaseStartBurnHeight: number | null;
      blocksUntilPreparePhase: number | null;
      rewardPhaseStartBurnHeight: number | null;
      blocksUntilRewardPhase: number | null;
      isPreparePhase: boolean | null;
    };
    compatibility: {
      status: "matched" | "unrecognized" | "inconsistent";
      profileId: string | null;
      profileRevision: number | null;
      profileLabel: string | null;
      origin: "built-in" | "operator-provided" | null;
      nodeBuildPreviouslyTested: boolean;
      reason: string;
    };
    checks: Array<{ id: string; status: "pass" | "warn" | "fail"; message: string }>;
  };
  runtimeSettings?: RuntimeSettings;
  manager?: {
    automationEligible: boolean;
    automationEligibilityReason: string;
    capabilities: ManagerCapabilities;
    source: {
      profileId: string | null;
      tier: "reference-built-in" | "reference-render" | "custom-observe" | "unrecognized";
      origin: "built-in" | "operator-installed" | null;
    };
    installedProfiles: {
      directory: string | null;
      loaded: number;
      issues: Array<{ fileName: string | null; code: string; message: string }>;
    };
  };
}

export interface DashboardAlert {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  action?:
    | { kind: "reconcile"; label: string }
    | {
        kind: "navigate";
        label: string;
        target: "settings" | "pool" | "rewards" | "activity" | "health";
        settingsSection?:
          | "attachment"
          | "sources"
          | "capabilities"
          | "observer"
          | "auth"
          | "support";
      }
    | {
        kind: "navigate";
        label: string;
        target: "settings";
        managerAction: "register-self";
      };
}

export interface ForecastCycle {
  cycleId: number;
  status: "ready" | "attention";
  provenance: {
    classification: "authoritative" | "projected";
    contractSource: "pox5-read-only";
    localRosterSource: "api-indexed-node-verified" | "unavailable";
  };
  local: { stakerCount: number | null; enumeratedStxUstx: string | null; rosterAvailable: boolean };
  contract: { pendingStxUstx: string; inSignerSet: boolean };
  threshold: { marginUstx: string; meetsThreshold: boolean };
  changesFromPrevious: null | {
    joiningStakers: number;
    leavingStakers: number;
    changedAmountStakers: number;
  };
}

export interface RosterEntry {
  stakerPrincipal: string;
  active: boolean;
  hasStx: boolean;
  stxNodeVerified: boolean | null;
  /**
   * PoX-5 `get-bond-membership` at the reconciliation anchor, not the indexer's `types` label.
   * `isL1Lock` distinguishes a native Bitcoin timelock from sBTC held by the protocol.
   */
  bond: null | {
    bondIndex: string;
    amountUstx: string;
    amountSats: string;
    isL1Lock: boolean;
  };
  position: null | {
    amountUstx: string;
    firstRewardCycle: string;
    numCycles: string;
    unlockCycle: string;
    unlockBurnHeight: string | null;
    active: boolean;
  };
}

export interface RewardCycleSummary {
  rewardCycle: number;
  status: "ready" | "attention";
  observedBurnBlockHeight: number;
  stakerCount: number;
  grossSats: string;
  earnedSats: string;
  feeSats: string;
  configuredFeeBips: string | null;
  feeSnapshotBips: string | null;
  actionableClaims: number;
}

export interface RewardCalculationRealization {
  txId: string;
  eventIndex: number;
  blockHeight: number;
  indexBlockHash: string;
  burnBlockHeight: number;
  targetRewardCycle: number;
  targetCheckpoint: "first-half" | "second-half";
  calculationBurnHeight: number;
  observedAt: string;
  global: {
    grossAccruedRewardsSats: string;
    totalBondRewardsSats: string;
    totalStxStakerRewardsSats: string;
    reserveDepositSats: string;
  };
  poolSats: string | null;
  poolEstimateUnavailableReason:
    | "historical-anchor-unavailable"
    | "same-block-state-ambiguous"
    | "anchored-inputs-unavailable"
    | "contract-simulation-failed"
    | null;
  evaluation: null | {
    modelRevision: number;
    forecastObservedBurnHeight: number;
    leadBlocks: number;
    pointErrorSats: string;
    pointErrorBips: string | null;
    rangeContainsActual: boolean;
    rangeWidthBips: string | null;
  };
}

const unsignedIntegerTextSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/);
const stacksHashSchema = z.string().regex(/^0x[0-9a-f]{64}$/i);

export const rewardCalculationRealizationSchema = z
  .object({
    txId: stacksHashSchema,
    eventIndex: z.number().int().nonnegative().safe(),
    blockHeight: z.number().int().nonnegative().safe(),
    indexBlockHash: stacksHashSchema,
    burnBlockHeight: z.number().int().nonnegative().safe(),
    targetRewardCycle: z.number().int().nonnegative().safe(),
    targetCheckpoint: z.enum(["first-half", "second-half"]),
    calculationBurnHeight: z.number().int().nonnegative().safe(),
    observedAt: z.iso.datetime(),
    global: z
      .object({
        grossAccruedRewardsSats: unsignedIntegerTextSchema,
        totalBondRewardsSats: unsignedIntegerTextSchema,
        totalStxStakerRewardsSats: unsignedIntegerTextSchema,
        reserveDepositSats: unsignedIntegerTextSchema,
      })
      .strict(),
    poolSats: unsignedIntegerTextSchema.nullable(),
    poolEstimateUnavailableReason: z
      .enum([
        "historical-anchor-unavailable",
        "same-block-state-ambiguous",
        "anchored-inputs-unavailable",
        "contract-simulation-failed",
      ])
      .nullable(),
    evaluation: z
      .object({
        modelRevision: z.number().int().positive(),
        forecastObservedBurnHeight: z.number().int().nonnegative().safe(),
        leadBlocks: z.number().int().safe(),
        pointErrorSats: unsignedIntegerTextSchema,
        pointErrorBips: unsignedIntegerTextSchema.nullable(),
        rangeContainsActual: z.boolean(),
        rangeWidthBips: unsignedIntegerTextSchema.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict() satisfies z.ZodType<RewardCalculationRealization>;

export interface RewardOutlookStatus {
  pox5ContractId: string;
  observedAt: string;
  chainAnchor: EngineChainAnchor | null;
  accrued: {
    globalSats: string;
    source: "pox5-get-new-rewards";
  };
  poolEstimate: null | {
    kind: "if-calculated-now";
    targetRewardCycle: number;
    targetCheckpoint: "first-half" | "second-half";
    calculationBurnHeight: number;
    grossSats: string;
    stxSats: string;
    bondSats: string;
    inputs: {
      globalStxSharesUstx: string;
      managerStxSharesUstx: string;
      activeBonds: Array<{
        bondIndex: string;
        targetRateBips: string;
        globalSharesSats: string;
        managerSharesSats: string;
      }>;
    };
    assumptions: Array<
      | "current-global-accrual"
      | "current-cycle-shares"
      | "current-active-bond-set"
      | "contract-integer-rounding"
    >;
  };
  poolEstimateUnavailableReason:
    | "chain-anchor-unavailable"
    | "calculation-target-unavailable"
    | "incomplete-active-bond-state"
    | "anchored-inputs-unavailable"
    | "contract-simulation-failed"
    | null;
  forecast: null | {
    kind: "checkpoint-run-rate";
    targetRewardCycle: number;
    targetCheckpoint: "first-half" | "second-half";
    calculationBurnHeight: number;
    globalSats: { low: string; point: string; high: string };
    poolSats: { low: string; point: string; high: string };
    sample: {
      observations: number;
      firstObservedBurnHeight: number;
      lastObservedBurnHeight: number;
      sampleBlocks: number;
      elapsedBlocks: number;
      remainingBlocks: number;
    };
    confidence: "low" | "developing" | "calibrated";
    assumptions: Array<
      | "zero-accrual-after-last-calculation"
      | "observed-accrual-sample-window"
      | "linear-global-accrual-run-rate"
      | "current-cycle-shares"
      | "current-active-bond-set"
      | "unchanged-reserve-before-calculation"
      | "contract-integer-rounding"
    >;
  };
  forecastUnavailableReason:
    | "chain-anchor-unavailable"
    | "calculation-target-unavailable"
    | "current-pool-estimate-unavailable"
    | "insufficient-samples"
    | "non-monotonic-accrual"
    | "forecast-inputs-unavailable"
    | "contract-simulation-failed"
    | null;
  operatorFeeForecast: null | {
    kind: "reference-manager-exact";
    sats: { low: string; point: string; high: string };
    inputs: {
      stakers: number;
      buckets: Array<{
        bondIndex: string | null;
        feeBips: string;
        source: "cycle-snapshot" | "configured-fee-assumption";
      }>;
    };
    assumptions: Array<"per-staker-per-bucket-integer-rounding" | "configured-fee-until-claim">;
  };
  operatorFeeEstimate?: null | {
    kind: "reference-manager-exact";
    sats: string;
    inputs: {
      stakers: number;
      buckets: Array<{
        bondIndex: string | null;
        feeBips: string;
        source: "cycle-snapshot" | "configured-fee-assumption";
      }>;
    };
    assumptions: Array<"per-staker-per-bucket-integer-rounding" | "configured-fee-until-claim">;
  };
  operatorFeeEstimateUnavailableReason?:
    | "reviewed-fee-capability-unavailable"
    | "authoritative-roster-unavailable"
    | "per-staker-shares-incomplete"
    | "anchored-fee-inputs-unavailable"
    | null;
  operatorFeeForecastUnavailableReason:
    | "reviewed-fee-capability-unavailable"
    | "forecast-unavailable"
    | "authoritative-roster-unavailable"
    | "per-staker-shares-incomplete"
    | "anchored-fee-inputs-unavailable"
    | null;
  calibration: {
    modelRevision: number;
    status: "collecting" | "passing" | "failing";
    eligibleRealizations: number;
    rewardCycles: number;
    nonzeroOutcomes: number;
    rangeHits: number;
    medianPointErrorBips: string | null;
    medianRangeWidthBips: string | null;
    requirements: {
      realizations: number;
      rewardCycles: number;
      nonzeroOutcomes: number;
      rangeHits: number;
      maxMedianPointErrorBips: string;
      maxMedianRangeWidthBips: string;
      evaluationLeadBlocks: number;
      evaluationToleranceBlocks: number;
    };
  };
  calculation: {
    state: "pending" | "completed" | "ahead" | "unknown";
    targetRewardCycle: number | null;
    targetCheckpoint: "first-half" | "second-half" | null;
    expectedLastRewardComputeBurnHeight: number | null;
    observedLastRewardComputeBurnHeight: string;
    next: null | {
      state: "due" | "scheduled";
      targetRewardCycle: number;
      targetCheckpoint: "first-half" | "second-half";
      calculationBurnHeight: number;
      eligibleBurnHeight: number;
      blocksRemaining: number;
      grace: null | {
        state: "scheduled" | "awaiting-calculation" | "action-required";
        firstEligibleObservedAt: string | null;
        firstEligibleStacksBlockHeight: number | null;
        elapsedMinutes: number;
        canonicalStacksBlocks: number;
        requiredMinutes: 10;
        requiredCanonicalStacksBlocks: 24;
      };
    };
  };
}

export interface DashboardSnapshot extends OperatorSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  chainAnchor?: EngineChainAnchor;
  /** Whether cycle-sensitive local-node reads can be treated as present-day authority. */
  nodeAuthority?: LocalNodeAuthority;
  historyRecovery?: HistoryRecoveryCoverage;
  freshness?: {
    status: "current" | "stale";
    snapshotGeneratedAt: string;
    servedAt: string;
    reason: "refreshing" | "refresh-failed" | "rate-limited" | null;
    rateLimit?: RateLimitInfo;
  };
  config?: {
    nodeRpcUrl: string;
    apiUrl: string;
    apiKeyConfigured: boolean;
    forecastHorizonCycles: number;
  };
  preflight: OperatorSnapshot["preflight"] & {
    node: OperatorSnapshot["preflight"]["node"] & {
      networkId: number;
      stacksTipHeight: number;
      isFullySynced?: boolean | null;
      peerHeightDifference?: number | null;
    };
    api: {
      available?: boolean;
      networkCompatible?: boolean;
      status?: string | null;
      serverVersion: string;
      burnBlockHeight: number;
      stacksTipHeight: number;
      burnBlockLag: number;
      stacksTipLag?: number;
      position?: "equal" | "behind" | "ahead" | "unavailable";
      error?: string | null;
    };
    pox: OperatorSnapshot["preflight"]["pox"] & {
      rewardCycleId: number;
      pox5Available: boolean;
      pox5ContractId: string | null;
    };
    cycle: OperatorSnapshot["preflight"]["cycle"] & { currentId: number };
  };
  manager: NonNullable<OperatorSnapshot["manager"]> & {
    attachAllowed: boolean;
    publishHeight: number;
    source: NonNullable<OperatorSnapshot["manager"]>["source"] & {
      recognized: boolean;
      sha256: string;
      match: string;
    };
    provenance: {
      status: "built-in" | "verified" | "not-applicable" | "failed";
      upstreamProfileId: string | null;
      reason: string;
    };
    reasons: string[];
  };
  registration: null | {
    registered: boolean;
    signerKeyHex: string | null;
    signerKeyGrantValid: boolean | null;
    reason: string;
  };
  forecast: null | {
    status: "ready" | "attention";
    ingestion: null | { activeDiscoveredStakers: number; completedAt: string };
    cycles: ForecastCycle[];
  };
  /** PoX-5 global reward state, available independently of signer-manager action support. */
  rewardOutlook?: RewardOutlookStatus | null;
  rewards: null | {
    status: "ready" | "attention";
    rewardCycle: number;
    global: {
      lastRewardComputeBurnHeight: string;
      lastComputedRewardCycle: string | null;
      /** Exact global PoX-5 rewards accrued since the last calculation. */
      globalAccruedRewardsSats: string;
      /** The STX-only bucket. `buckets` carries the whole picture. */
      signerEarnedBeforeManagerClaimSats: string;
      signerEarnedAcrossBucketsSats: string;
    };
    /**
     * Whether the permissionless global `calculate-rewards` has run for the cycle Sidekick would
     * claim. Nothing is claimable until it has, and Observe never calls it.
     */
    calculation: {
      state: "pending" | "completed" | "ahead" | "unknown";
      targetRewardCycle: number | null;
      targetCheckpoint: "first-half" | "second-half" | null;
      expectedLastRewardComputeBurnHeight: number | null;
      observedLastRewardComputeBurnHeight: string;
      next: null | {
        state: "due" | "scheduled";
        targetRewardCycle: number;
        targetCheckpoint: "first-half" | "second-half";
        calculationBurnHeight: number;
        eligibleBurnHeight: number;
        blocksRemaining: number;
        grace: null | {
          state: "scheduled" | "awaiting-calculation" | "action-required";
          firstEligibleObservedAt: string | null;
          firstEligibleStacksBlockHeight: number | null;
          elapsedMinutes: number;
          canonicalStacksBlocks: number;
          requiredMinutes: 10;
          requiredCanonicalStacksBlocks: 24;
        };
      };
    };
    /** The STX bucket first, then every bond period holding shares for this cycle. */
    buckets: Array<{
      bondIndex: string | null;
      managerSharesSats: string;
      signerEarnedBeforeManagerClaimSats: string;
      rewardsPerToken: string;
      feeSnapshotBips: string | null;
      participating: boolean;
    }>;
    manager: {
      configuredFeeBips: string;
      feeSnapshotBips: string | null;
      earnedFeesSats: string;
      withdrawalLiabilitySats: string;
      unclaimedStakerRewardsSats: string;
    };
    totals: {
      stakers: number;
      grossSats: string;
      earnedSats: string;
      feeSats: string;
      actionableClaims: number;
      l1ClaimsWaitingForFeeThreshold: number;
    };
    stakers: Array<{
      stakerPrincipal: string;
      payout: { kind: string; maxFeeSats: string | null };
      rewards: { earnedSats: string; feeSats: string; grossSats: string };
      claimableByPolicy: boolean;
    }>;
  };
  activity: {
    eventCount: number;
    latestBlockHeight: number | null;
    claimTotal: number;
    withdrawalTotal: number;
    pendingWithdrawalTotal: number;
    admins: {
      status: "current" | "sync-required";
      principals: string[];
      updatesObserved: number;
    };
    claims: Array<{
      txId: string;
      eventIndex: number;
      blockHeight: number;
      stakerPrincipal: string;
      rewardCycle: string;
      amountSats: string;
      destination: string;
      withdrawalRequestId: string | null;
    }>;
    withdrawals: Array<{
      requestId: string;
      stakerPrincipal: string;
      amountSats: string;
      maxFeeSats: string;
      initiatedBlockHeight: number;
      state: "pending" | "settled" | "reclaimed";
    }>;
  };
  roster: RosterEntry[];
  rosterTotal?: number;
  rosterStats?: { deferredUnlocks: number };
  alerts: DashboardAlert[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasRecord<Key extends string>(
  value: Record<string, unknown>,
  key: Key,
): value is Record<string, unknown> & Record<Key, Record<string, unknown>> {
  return isRecord(value[key]);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

const managerActionCapabilityIds = new Set<ManagerActionCapabilityId>([
  "register-self",
  "update-admin",
  "update-fees",
  "withdraw-fees",
  "sweep-fee-refunds",
  "reference-reward-claims",
]);

function isManagerCapabilityAdapter(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      typeof value.id === "string" &&
      typeof value.revision === "number" &&
      Number.isInteger(value.revision) &&
      typeof value.reviewedSourceSha256 === "string")
  );
}

function isManagerCapabilities(value: unknown): value is ManagerCapabilities {
  if (!isRecord(value)) return false;
  const trait = value.signerManagerTrait;
  const observed = value.observedFunctions;
  const sourceReview = value.sourceReview;
  const vocabulary = value.eventVocabulary;
  if (
    !isRecord(trait) ||
    typeof trait.compatible !== "boolean" ||
    typeof trait.reason !== "string" ||
    !isRecord(observed) ||
    !isStringArray(observed.public) ||
    !isStringArray(observed.readOnly) ||
    !isRecord(sourceReview) ||
    typeof sourceReview.exactReviewed !== "boolean" ||
    typeof sourceReview.reason !== "string" ||
    (sourceReview.clarityVersion !== undefined &&
      sourceReview.clarityVersion !== null &&
      typeof sourceReview.clarityVersion !== "string") ||
    (sourceReview.epoch !== undefined &&
      sourceReview.epoch !== null &&
      typeof sourceReview.epoch !== "string") ||
    (sourceReview.interfaceSha256 !== undefined &&
      typeof sourceReview.interfaceSha256 !== "string") ||
    !isRecord(vocabulary) ||
    vocabulary.id !== "reference-manager-v1" ||
    typeof vocabulary.normalizationAvailable !== "boolean" ||
    !isManagerCapabilityAdapter(vocabulary.adapter) ||
    typeof vocabulary.reason !== "string" ||
    !Array.isArray(value.actions)
  ) {
    return false;
  }
  return value.actions.every(
    (action) =>
      isRecord(action) &&
      typeof action.id === "string" &&
      managerActionCapabilityIds.has(action.id as ManagerActionCapabilityId) &&
      typeof action.interfaceAvailable === "boolean" &&
      typeof action.executionAvailable === "boolean" &&
      isStringArray(action.missingFunctions) &&
      isManagerCapabilityAdapter(action.adapter) &&
      typeof action.reason === "string",
  );
}

function isDashboardSnapshot(value: unknown): value is DashboardSnapshot {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.generatedAt === "string" &&
    typeof value.network === "string" &&
    typeof value.managerPrincipal === "string" &&
    (value.chainAnchor === undefined ||
      engineChainAnchorSchema.safeParse(value.chainAnchor).success) &&
    (value.nodeAuthority === undefined ||
      localNodeAuthoritySchema.safeParse(value.nodeAuthority).success) &&
    (value.historyRecovery === undefined ||
      historyRecoveryCoverageSchema.safeParse(value.historyRecovery).success) &&
    hasRecord(value, "preflight") &&
    hasRecord(value, "manager") &&
    isManagerCapabilities(value.manager.capabilities) &&
    hasRecord(value, "activity") &&
    Array.isArray(value.roster) &&
    Array.isArray(value.alerts)
  );
}

export const dashboardSnapshotSchema = z.custom<DashboardSnapshot>(isDashboardSnapshot, {
  error: "Invalid dashboard snapshot",
});
export type StatusResponse = z.infer<typeof dashboardSnapshotSchema>;
export const statusResponseSchema = dashboardSnapshotSchema;

export type ReconciliationOperationPhase =
  | "idle"
  | "reconciling-stakers-discovery"
  | "reconciling-stakers-verification"
  | "reconciling-events"
  | "refreshing-snapshot"
  | "complete"
  | "failed";

export const reconciliationSummarySchema = z
  .object({
    observedAt: z.string(),
    stakers: z
      .object({
        resumed: z.boolean(),
        status: z.enum(["completed", "incomplete"]),
        authoritative: z.boolean(),
        pagesProcessed: z.number().int().nonnegative(),
        itemsProcessed: z.number().int().nonnegative(),
        activeStakers: z.number().int().nonnegative(),
        nodeVerifiedStxPositions: z.number().int().nonnegative(),
        unverifiedStxDiscoveries: z.number().int().nonnegative(),
        discrepanciesObserved: z.number().int().nonnegative(),
      })
      .strict(),
    events: z
      .object({
        resumed: z.boolean(),
        pagesProcessed: z.number().int().nonnegative(),
        eventsProcessed: z.number().int().nonnegative(),
        newEvents: z.number().int().nonnegative(),
        replayedEvents: z.number().int().nonnegative(),
        decodeFailures: z.number().int().nonnegative(),
        reorgedEvents: z.number().int().nonnegative(),
        stoppedAtKnownOverlap: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type ReconciliationSummary = z.infer<typeof reconciliationSummarySchema>;

export interface ReconciliationOperation {
  schemaVersion: 1;
  operationId: string | null;
  trigger: "manual" | "automatic" | null;
  status: "idle" | "running" | "succeeded" | "failed";
  phase: ReconciliationOperationPhase;
  processLocal: true;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  progress: {
    completedSteps: number;
    totalSteps: number;
    itemsCompleted: number | null;
    itemsTotal: number | null;
    message: string;
  };
  result: null | {
    reconciliation: ReconciliationSummary;
    snapshotGeneratedAt: string;
  };
  error: null | (ApiError & { retryable: boolean });
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isReconciliationOperation(value: unknown): value is ReconciliationOperation {
  if (!isRecord(value) || !isRecord(value.progress)) return false;
  const result = value.result;
  const error = value.error;
  return (
    value.schemaVersion === 1 &&
    isNullableString(value.operationId) &&
    (value.trigger === null || value.trigger === "manual" || value.trigger === "automatic") &&
    ["idle", "running", "succeeded", "failed"].includes(String(value.status)) &&
    [
      "idle",
      "reconciling-stakers-discovery",
      "reconciling-stakers-verification",
      "reconciling-events",
      "refreshing-snapshot",
      "complete",
      "failed",
    ].includes(String(value.phase)) &&
    value.processLocal === true &&
    isNullableString(value.startedAt) &&
    isNullableString(value.updatedAt) &&
    isNullableString(value.completedAt) &&
    typeof value.progress.completedSteps === "number" &&
    typeof value.progress.totalSteps === "number" &&
    (value.progress.itemsCompleted === null || typeof value.progress.itemsCompleted === "number") &&
    (value.progress.itemsTotal === null || typeof value.progress.itemsTotal === "number") &&
    typeof value.progress.message === "string" &&
    (result === null ||
      (isRecord(result) &&
        reconciliationSummarySchema.safeParse(result.reconciliation).success &&
        typeof result.snapshotGeneratedAt === "string")) &&
    (error === null ||
      (isRecord(error) && typeof error.error === "string" && typeof error.retryable === "boolean"))
  );
}

export const reconciliationOperationSchema = z.custom<ReconciliationOperation>(
  isReconciliationOperation,
  { error: "Invalid reconciliation operation" },
);
export const syncResponseSchema = z.object({ operation: reconciliationOperationSchema }).strict();
export type SyncResponse = z.infer<typeof syncResponseSchema>;

export const poolPageResponseSchema = z.custom<{
  roster: RosterEntry[];
  total: number;
  freshness?: DashboardSnapshot["freshness"];
}>((value) => isRecord(value) && Array.isArray(value.roster) && typeof value.total === "number", {
  error: "Invalid pool response",
});
export type PoolPageResponse = z.infer<typeof poolPageResponseSchema>;

export const rewardsPageResponseSchema = z.custom<{
  rewards: DashboardSnapshot["rewards"];
  rewardOutlook?: DashboardSnapshot["rewardOutlook"];
  rewardRealizations?: RewardCalculationRealization[];
  freshness?: DashboardSnapshot["freshness"];
}>(
  (value) => {
    if (!isRecord(value) || (value.rewards !== null && !isRecord(value.rewards))) return false;
    return (
      value.rewardRealizations === undefined ||
      (Array.isArray(value.rewardRealizations) &&
        value.rewardRealizations.every(
          (entry) => rewardCalculationRealizationSchema.safeParse(entry).success,
        ))
    );
  },
  {
    error: "Invalid rewards response",
  },
);
export type RewardsPageResponse = z.infer<typeof rewardsPageResponseSchema>;

export const rewardsActivityResponseSchema = z.custom<DashboardSnapshot["activity"]>(
  (value) =>
    isRecord(value) &&
    Array.isArray(value.claims) &&
    Array.isArray(value.withdrawals) &&
    typeof value.claimTotal === "number" &&
    typeof value.withdrawalTotal === "number",
  { error: "Invalid activity response" },
);
export type RewardsActivityResponse = z.infer<typeof rewardsActivityResponseSchema>;

export const rewardHistoryResponseSchema = z.custom<{
  items: RewardCycleSummary[];
  total: number;
}>((value) => isRecord(value) && Array.isArray(value.items) && typeof value.total === "number", {
  error: "Invalid reward history response",
});
export type RewardHistoryResponse = z.infer<typeof rewardHistoryResponseSchema>;

const walletIntentChainTipSchema = z
  .object({
    stacksTipHeight: z.number().int().nonnegative(),
    burnBlockHeight: z.number().int().nonnegative(),
  })
  .strict();

export const walletIntentAnchorMismatchErrorSchema = z
  .object({
    error: z.literal("wallet_intent_anchor_mismatch"),
    retryable: z.literal(true),
    node: walletIntentChainTipSchema,
    api: walletIntentChainTipSchema,
    poxBurnBlockHeight: z.number().int().nonnegative(),
  })
  .strict();
export type WalletIntentAnchorMismatchError = z.infer<typeof walletIntentAnchorMismatchErrorSchema>;

export const walletIntentAnchorUnstableErrorSchema = z
  .object({
    error: z.literal("wallet_intent_anchor_unstable"),
    retryable: z.literal(true),
  })
  .strict();
export type WalletIntentAnchorUnstableError = z.infer<typeof walletIntentAnchorUnstableErrorSchema>;

export const apiErrorSchema = z.looseObject({
  error: z.string(),
  message: z.string().optional(),
  retryable: z.boolean().optional(),
  rateLimit: rateLimitInfoSchema.optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const healthSourceTestRequestSchema = z
  .object({
    kind: z.enum(["node-metrics", "signer-monitoring", "hiro-reference"]),
    url: z.string().min(1).max(500),
  })
  .strict();
export type HealthSourceTestRequest = z.infer<typeof healthSourceTestRequestSchema>;
export type HealthSourceKind = HealthSourceTestRequest["kind"];

export const healthSourceTestResponseSchema = z.looseObject({
  status: z.literal("connected"),
  signals: z.number().int().nonnegative(),
});
export type HealthSourceTestResponse = z.infer<typeof healthSourceTestResponseSchema>;

export const managerSignerGrantPrepareRequestSchema = z
  .object({
    authId: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
    signerConfigPath: z.string().min(1).max(500),
  })
  .strict();
export type ManagerSignerGrantPrepareRequest = z.infer<
  typeof managerSignerGrantPrepareRequestSchema
>;

export const signerGrantVerifyRequestSchema = z.object({ signerOutput: z.unknown() }).strict();
export type SignerGrantVerifyRequest = z.infer<typeof signerGrantVerifyRequestSchema>;

const signerGrantSessionSchema = z
  .object({
    preparation: z
      .looseObject({
        managerPrincipal: z.string().min(1),
        pox5ContractId: z.string().min(1),
        command: z.string().min(1),
        expectedMessageHashHex: z.string().regex(/^[0-9a-f]{64}$/),
        authId: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
      })
      .nullable(),
    verified: z
      .looseObject({
        managerPrincipal: z.string().min(1),
        pox5ContractId: z.string().min(1),
        authId: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
        signerKeyHex: z.string().regex(/^(?:02|03)[0-9a-f]{64}$/),
        signerSignatureHex: z.string().regex(/^[0-9a-f]{130}$/),
        expectedMessageHashHex: z.string().regex(/^[0-9a-f]{64}$/),
        signatureValid: z.literal(true),
        registerSelfCall: z
          .object({
            contract: z.string().min(1),
            functionName: z.string().min(1),
            arguments: z.array(z.string()),
            signingPrincipal: z.string().min(1),
            signingAuthority: z.literal("external-offline-admin"),
          })
          .strict(),
      })
      .nullable(),
  })
  .strict();
export const signerGrantSessionResponseSchema = z
  .object({ signerGrant: signerGrantSessionSchema })
  .strict();
export type SignerGrantSessionResponse = z.infer<typeof signerGrantSessionResponseSchema>;

export const browserWalletIntentActionSchema = z.enum([
  "deploy-manager",
  "register-self",
  "add-admin",
  "remove-admin",
  "update-fees",
  "withdraw-fees",
  "sweep-fee-refunds",
  "claim-rewards",
  "claim-staker-rewards",
  "calculate-rewards",
]);
export const recurringWalletIntentActionSchema = z.enum([
  "register-self",
  "add-admin",
  "remove-admin",
  "update-fees",
  "withdraw-fees",
  "sweep-fee-refunds",
  "claim-rewards",
  "claim-staker-rewards",
  "calculate-rewards",
]);
export const operatorOperationCodeSchema = recurringWalletIntentActionSchema;
export type OperatorOperationCode = z.infer<typeof operatorOperationCodeSchema>;

const contextualActionLabelSchema = z.string().min(1).max(120);
const contextualActionContextSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("engine-job"),
      jobId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("staker-reward"),
      stakerPrincipal: z.string().min(1).max(500),
      rewardCycle: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
      bondIndex: z
        .string()
        .regex(/^(?:0|[1-9][0-9]*)$/)
        .nullable(),
    })
    .strict(),
]);

const openDomainActionSchema = z.union([
  z
    .object({
      kind: z.literal("open-domain"),
      label: contextualActionLabelSchema,
      page: z.literal("overview"),
      section: z.enum(["attention", "cycle", "pool", "rewards", "health"]).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("open-domain"),
      label: contextualActionLabelSchema,
      page: z.literal("pool"),
      section: z.enum(["positions", "forecast", "roster"]).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("open-domain"),
      label: contextualActionLabelSchema,
      page: z.literal("rewards"),
      section: z
        .enum(["outlook", "calculation", "claims", "fees", "withdrawals", "history"])
        .nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("open-domain"),
      label: contextualActionLabelSchema,
      page: z.literal("activity"),
      section: z.enum(["active", "history"]).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("open-domain"),
      label: contextualActionLabelSchema,
      page: z.literal("health"),
      section: z.enum(["findings", "node", "signer", "network", "sources"]).nullable(),
    })
    .strict(),
]);

const networkHealthDetailsActionSchema = z
  .object({
    kind: z.literal("open-domain"),
    label: contextualActionLabelSchema,
    page: z.literal("health"),
    section: z.literal("network"),
  })
  .strict();
const nodeHealthDetailsActionSchema = z
  .object({
    kind: z.literal("open-domain"),
    label: contextualActionLabelSchema,
    page: z.literal("health"),
    section: z.literal("node"),
  })
  .strict();
const signerHealthDetailsActionSchema = z
  .object({
    kind: z.literal("open-domain"),
    label: contextualActionLabelSchema,
    page: z.literal("health"),
    section: z.literal("signer"),
  })
  .strict();
const poolDetailsActionSchema = z
  .object({
    kind: z.literal("open-domain"),
    label: contextualActionLabelSchema,
    page: z.literal("pool"),
    section: z.enum(["positions", "forecast", "roster"]).nullable(),
  })
  .strict();
const rewardsDetailsActionSchema = z
  .object({
    kind: z.literal("open-domain"),
    label: contextualActionLabelSchema,
    page: z.literal("rewards"),
    section: z
      .enum(["outlook", "calculation", "claims", "fees", "withdrawals", "history"])
      .nullable(),
  })
  .strict();

export const contextualActionSchema = z.union([
  z
    .object({
      kind: z.literal("launch-operation"),
      operation: operatorOperationCodeSchema,
      context: contextualActionContextSchema,
      label: contextualActionLabelSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("resume-activity"),
      activityId: z.string().min(1).max(500),
      label: contextualActionLabelSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("open-settings"),
      section: z.enum(["attachment", "sources", "capabilities", "observer", "auth", "support"]),
      label: contextualActionLabelSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("recheck"),
      target: z.enum(["connection", "node", "api", "signer", "activity"]),
      label: contextualActionLabelSchema,
    })
    .strict(),
  openDomainActionSchema,
]);
export type ContextualAction = z.infer<typeof contextualActionSchema>;

export const overviewEvidenceSchema = z
  .object({
    status: z.enum(["current", "delayed", "unavailable", "not-configured"]),
    observedAt: z.iso.datetime().nullable(),
    anchor: engineChainAnchorSchema.nullable(),
    source: z.enum(["local-node", "signer", "indexed-api", "network-reference", "sidekick-store"]),
    reason: z.string().min(1).max(1_000).nullable(),
  })
  .strict();
export type OverviewEvidence = z.infer<typeof overviewEvidenceSchema>;

export const operatorDeadlineSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("burn-block"),
      burnBlockHeight: z.number().int().nonnegative(),
      estimatedAt: z.iso.datetime().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("reward-cycle"),
      rewardCycleId: z.number().int().nonnegative(),
      phase: z.enum(["before-prepare", "cycle-start"]),
    })
    .strict(),
  z.object({ kind: z.literal("time"), at: z.iso.datetime() }).strict(),
]);
export type OperatorDeadline = z.infer<typeof operatorDeadlineSchema>;

export const activityDisplayStatusSchema = z.enum([
  "action-required",
  "in-progress",
  "needs-attention",
  "complete",
  "superseded",
  "observed",
]);
export type ActivityDisplayStatus = z.infer<typeof activityDisplayStatusSchema>;

export const activityOutcomeSchema = z.enum([
  "pending",
  "succeeded",
  "failed",
  "aborted",
  "ambiguous",
  "superseded",
  "observed",
]);
export type ActivityOutcome = z.infer<typeof activityOutcomeSchema>;

export const activityKindSchema = z.enum([
  "operation",
  "chain-event",
  "configuration-change",
  "finding-change",
]);
export type ActivityKind = z.infer<typeof activityKindSchema>;

export const activityDomainSchema = z.enum([
  "manager",
  "pool",
  "rewards",
  "node",
  "signer",
  "network",
  "sidekick",
]);
export type ActivityDomain = z.infer<typeof activityDomainSchema>;

export const activityCoverageSourceSchema = z.enum([
  "wallet-intents",
  "transaction-engine",
  "indexed-manager-history",
  "indexed-pool-history",
  "observer",
  "settings-audit",
]);
export type ActivityCoverageSource = z.infer<typeof activityCoverageSourceSchema>;

export const activityCoverageSchema = z
  .object({
    source: activityCoverageSourceSchema,
    status: z.enum(["current", "delayed", "unavailable", "not-configured"]),
    observedAt: z.iso.datetime().nullable(),
    anchor: engineChainAnchorSchema.nullable(),
    reason: z.string().min(1).max(1_000).nullable(),
  })
  .strict();
export type ActivityCoverage = z.infer<typeof activityCoverageSchema>;

export const activityStageSchema = z.enum([
  "review-ready",
  "preflighted",
  "awaiting-approval",
  "nonce-reserved",
  "submitted",
  "mempool",
  "broadcast",
  "confirmed",
  "reobserving",
  "blocked",
  "ambiguous",
  "failed",
  "complete",
  "superseded",
  "observed",
  "recorded",
]);
export type ActivityStage = z.infer<typeof activityStageSchema>;

const activityStatusOutcomePairs = new Set([
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

export const activityGroupSummarySchema = z
  .object({
    schemaVersion: z.literal(1),
    activityId: z.string().min(1).max(500),
    kind: activityKindSchema,
    domain: activityDomainSchema,
    code: z.string().min(1).max(120),
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(1_000),
    stage: activityStageSchema,
    operationScope: z.string().min(1).max(500).nullable(),
    displayStatus: activityDisplayStatusSchema,
    outcome: activityOutcomeSchema,
    occurredAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deadline: operatorDeadlineSchema.nullable(),
    urgencyAt: z.iso.datetime().nullable(),
    actorPrincipal: z.string().min(1).max(500).nullable(),
    txids: z.array(z.string().regex(/^0x[0-9a-f]{64}$/)).max(100),
    anchor: engineChainAnchorSchema.nullable(),
    supersedesActivityId: z.string().min(1).max(500).nullable(),
    supersededByActivityId: z.string().min(1).max(500).nullable(),
    primaryAction: contextualActionSchema.nullable(),
    coverage: z.array(activityCoverageSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (!activityStatusOutcomePairs.has(`${value.displayStatus}:${value.outcome}`)) {
      context.addIssue({
        code: "custom",
        message: "Activity display status and outcome are incompatible",
        path: ["outcome"],
      });
    }
    if (
      value.primaryAction?.kind === "resume-activity" &&
      value.primaryAction.activityId !== value.activityId
    ) {
      context.addIssue({
        code: "custom",
        message: "Resume action must target the containing Activity group",
        path: ["primaryAction", "activityId"],
      });
    }
  });
export type ActivityGroupSummary = z.infer<typeof activityGroupSummarySchema>;

export const activityTimelineEntrySchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: z.string().min(1).max(500),
    code: z.string().min(1).max(120),
    title: z.string().min(1).max(200),
    detail: z.string().min(1).max(2_000),
    occurredAt: z.iso.datetime(),
    source: activityCoverageSourceSchema,
    txid: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/)
      .nullable(),
    stacksBlockHeight: z.number().int().nonnegative().nullable(),
    indexBlockHash: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/)
      .nullable(),
    canonical: z.boolean().nullable(),
    finalized: z.boolean().nullable(),
  })
  .strict()
  .refine((value) => (value.stacksBlockHeight === null) === (value.indexBlockHash === null), {
    message: "Timeline block height and index-block hash must both be present or both be null",
    path: ["indexBlockHash"],
  });
export type ActivityTimelineEntry = z.infer<typeof activityTimelineEntrySchema>;

export const activityPageSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.iso.datetime(),
    active: z.array(activityGroupSummarySchema),
    items: z.array(activityGroupSummarySchema),
    nextCursor: z.string().min(1).max(2_000).nullable(),
    coverage: z.array(activityCoverageSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    for (const [section, items] of [
      ["active", value.active],
      ["items", value.items],
    ] as const) {
      for (const [index, item] of items.entries()) {
        if (ids.has(item.activityId)) {
          context.addIssue({
            code: "custom",
            message: "Activity groups must not be duplicated between active work and history",
            path: [section, index, "activityId"],
          });
        }
        ids.add(item.activityId);
      }
    }
  });
export const activityResponseSchema = activityPageSchema;
export type ActivityResponse = z.infer<typeof activityPageSchema>;

export const activityDetailSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestedActivityId: z.string().min(1).max(500),
    canonicalActivityId: z.string().min(1).max(500),
    aliases: z.array(z.string().min(1).max(500)),
    summary: activityGroupSummarySchema,
    timeline: z.array(activityTimelineEntrySchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.summary.activityId !== value.canonicalActivityId) {
      context.addIssue({
        code: "custom",
        message: "Activity detail summary must use the canonical Activity id",
        path: ["summary", "activityId"],
      });
    }
    if (!value.aliases.includes(value.requestedActivityId)) {
      context.addIssue({
        code: "custom",
        message: "Activity detail aliases must contain the requested id",
        path: ["aliases"],
      });
    }
    if (!value.aliases.includes(value.canonicalActivityId)) {
      context.addIssue({
        code: "custom",
        message: "Activity detail aliases must contain the canonical id",
        path: ["aliases"],
      });
    }
  });
export type ActivityDetail = z.infer<typeof activityDetailSchema>;

const overviewProtocolMomentSchema = z
  .object({
    status: z.enum(["scheduled", "due", "unavailable"]),
    burnBlockHeight: z.number().int().nonnegative().nullable(),
    blocksRemaining: z.number().int().nonnegative().nullable(),
    estimatedAt: z.iso.datetime().nullable(),
    evidence: z.array(overviewEvidenceSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.status === "unavailable" &&
      (value.burnBlockHeight !== null ||
        value.blocksRemaining !== null ||
        value.estimatedAt !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "An unavailable protocol moment cannot carry schedule values",
      });
    }
    if (
      value.status !== "unavailable" &&
      (value.burnBlockHeight === null || value.blocksRemaining === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "A scheduled or due protocol moment requires a block and remaining distance",
      });
    }
    if (value.status === "due" && value.blocksRemaining !== 0) {
      context.addIssue({
        code: "custom",
        path: ["blocksRemaining"],
        message: "A due protocol moment must have zero blocks remaining",
      });
    }
    if (value.status === "scheduled" && (value.blocksRemaining ?? 0) < 1) {
      context.addIssue({
        code: "custom",
        path: ["blocksRemaining"],
        message: "A scheduled protocol moment must be in the future",
      });
    }
  });

export const overviewCycleSnapshotSchema = z
  .object({
    status: z.enum(["current", "unavailable"]),
    rewardCycleId: z.number().int().nonnegative().nullable(),
    phase: z.enum(["reward", "prepare"]).nullable(),
    burnBlockHeight: z.number().int().nonnegative().nullable(),
    stacksTipHeight: z.number().int().nonnegative().nullable(),
    nextRewardCalculation: overviewProtocolMomentSchema,
    nextPreparePhase: overviewProtocolMomentSchema,
    evidence: z.array(overviewEvidenceSchema).min(1),
  })
  .strict();
export type OverviewCycleSnapshot = z.infer<typeof overviewCycleSnapshotSchema>;

export const overviewNetworkHealthSummarySchema = z
  .object({
    status: z.enum(["advancing", "needs-attention", "unavailable", "insufficient-evidence"]),
    reference: z.string().min(1).max(120).nullable(),
    stacksTipHeight: z.number().int().nonnegative().nullable(),
    burnBlockHeight: z.number().int().nonnegative().nullable(),
    lastObservedAt: z.iso.datetime().nullable(),
    detail: z.string().min(1).max(1_000),
    evidence: z.array(overviewEvidenceSchema).min(1),
    detailsAction: networkHealthDetailsActionSchema,
  })
  .strict();
export type OverviewNetworkHealthSummary = z.infer<typeof overviewNetworkHealthSummarySchema>;

export const overviewNodeHealthSummarySchema = z
  .object({
    status: z.enum(["aligned", "behind", "unavailable", "insufficient-evidence"]),
    stacksTipHeight: z.number().int().nonnegative().nullable(),
    burnBlockHeight: z.number().int().nonnegative().nullable(),
    peerHeightDifference: z.number().int().nullable(),
    lastAdvancedAt: z.iso.datetime().nullable(),
    detail: z.string().min(1).max(1_000),
    evidence: z.array(overviewEvidenceSchema).min(1),
    detailsAction: nodeHealthDetailsActionSchema,
  })
  .strict();
export type OverviewNodeHealthSummary = z.infer<typeof overviewNodeHealthSummarySchema>;

export const overviewSignerHealthSummarySchema = z
  .object({
    status: z.enum(["healthy", "needs-attention", "unavailable", "not-configured", "collecting"]),
    rewardCycleId: z.number().int().nonnegative().nullable(),
    nodeHeightDifference: z.number().int().nullable(),
    proposalsLastHour: z.number().int().nonnegative().nullable(),
    acceptedLastHour: z.number().int().nonnegative().nullable(),
    rejectedLastHour: z.number().int().nonnegative().nullable(),
    responseP95Seconds: z.number().nonnegative().nullable(),
    // Overview payloads retained across a Sidekick upgrade predate this field.
    validationP95Seconds: z.number().nonnegative().nullable().default(null),
    detail: z.string().min(1).max(1_000),
    evidence: z.array(overviewEvidenceSchema).min(1),
    detailsAction: signerHealthDetailsActionSchema,
  })
  .strict();
export type OverviewSignerHealthSummary = z.infer<typeof overviewSignerHealthSummarySchema>;

export const overviewAttentionTierSchema = z.enum(["urgent", "action-required", "needs-attention"]);
export type OverviewAttentionTier = z.infer<typeof overviewAttentionTierSchema>;
export const overviewDomainSchema = z.enum([
  "connection",
  "manager",
  "pool",
  "rewards",
  "node",
  "signer",
  "network",
  "sidekick",
]);
export type OverviewDomain = z.infer<typeof overviewDomainSchema>;

export const overviewAttentionItemSchema = z
  .object({
    schemaVersion: z.literal(1),
    attentionId: z.string().min(1).max(500),
    tier: overviewAttentionTierSchema,
    domain: overviewDomainSchema,
    affectedDomains: z.array(overviewDomainSchema).min(1),
    code: z.string().min(1).max(120),
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(1_000),
    impact: z.string().min(1).max(1_000),
    openedAt: z.iso.datetime().nullable(),
    updatedAt: z.iso.datetime(),
    deadline: operatorDeadlineSchema.nullable(),
    urgencyAt: z.iso.datetime().nullable(),
    evidence: z.array(overviewEvidenceSchema).min(1),
    relatedActivityId: z.string().min(1).max(500).nullable(),
    relatedFindingId: z.string().min(1).max(500).nullable(),
    primaryAction: contextualActionSchema,
    detailsAction: contextualActionSchema.nullable(),
  })
  .strict();
export type OverviewAttentionItem = z.infer<typeof overviewAttentionItemSchema>;

export const overviewInProgressItemSchema = z
  .object({
    schemaVersion: z.literal(1),
    activityId: z.string().min(1).max(500),
    domain: z.enum(["manager", "pool", "rewards", "node", "signer", "network", "sidekick"]),
    title: z.string().min(1).max(200),
    stage: z.string().min(1).max(200),
    updatedAt: z.iso.datetime(),
    evidence: z.array(overviewEvidenceSchema).min(1),
    primaryAction: z
      .object({
        kind: z.literal("resume-activity"),
        activityId: z.string().min(1).max(500),
        label: contextualActionLabelSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.primaryAction.activityId !== value.activityId) {
      context.addIssue({
        code: "custom",
        path: ["primaryAction", "activityId"],
        message: "In-progress action must resume the projected activity",
      });
    }
  });
export type OverviewInProgressItem = z.infer<typeof overviewInProgressItemSchema>;

const overviewPoolCycleSchema = z
  .object({
    rewardCycleId: z.number().int().nonnegative(),
    amountUstx: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
    inSignerSet: z.boolean(),
  })
  .strict();

export const overviewPoolSummarySchema = z
  .object({
    status: z.enum(["ready", "needs-attention", "unavailable", "insufficient-evidence"]),
    current: overviewPoolCycleSchema.nullable(),
    next: overviewPoolCycleSchema.nullable(),
    nextThresholdMarginUstx: z
      .string()
      .regex(/^-?(?:0|[1-9][0-9]*)$/)
      .nullable(),
    participants: z
      .object({
        stxOnly: z.number().int().nonnegative(),
        bitcoinBond: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    nextChange: z
      .object({
        kind: z.enum(["join", "exit", "amount-change", "unlock"]),
        rewardCycleId: z.number().int().nonnegative(),
        participantCount: z.number().int().nonnegative(),
        amountDeltaUstx: z
          .string()
          .regex(/^-?(?:0|[1-9][0-9]*)$/)
          .nullable(),
      })
      .strict()
      .nullable(),
    evidence: z.array(overviewEvidenceSchema).min(1),
    detailsAction: poolDetailsActionSchema,
  })
  .strict();
export type OverviewPoolSummary = z.infer<typeof overviewPoolSummarySchema>;

export const overviewRewardsSummarySchema = z
  .object({
    status: z.enum(["ready", "needs-attention", "unavailable", "insufficient-evidence"]),
    rewardCycleId: z.number().int().nonnegative().nullable(),
    globalAccruedSats: z
      .string()
      .regex(/^(?:0|[1-9][0-9]*)$/)
      .nullable(),
    estimatedPoolRewardSats: z
      .string()
      .regex(/^(?:0|[1-9][0-9]*)$/)
      .nullable(),
    operatorFeeSats: z
      .string()
      .regex(/^(?:0|[1-9][0-9]*)$/)
      .nullable(),
    operatorFeeUnavailableReason: z
      .enum([
        "reward-outlook-unavailable",
        "reviewed-fee-capability-unavailable",
        "forecast-unavailable",
        "authoritative-roster-unavailable",
        "per-staker-shares-incomplete",
        "anchored-fee-inputs-unavailable",
      ])
      .nullable(),
    estimateKind: z.enum(["checkpoint-forecast", "if-calculated-now", "unavailable"]),
    confidence: z.enum(["contract-exact", "low", "developing", "calibrated", "unavailable"]),
    calculationState: z.enum(["pending", "completed", "ahead", "unknown"]).nullable(),
    actionableClaims: z.number().int().nonnegative().nullable(),
    evidence: z.array(overviewEvidenceSchema).min(1),
    detailsAction: rewardsDetailsActionSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.estimatedPoolRewardSats === null) {
      if (value.estimateKind !== "unavailable" || value.confidence !== "unavailable") {
        context.addIssue({
          code: "custom",
          path: ["estimatedPoolRewardSats"],
          message: "An unavailable pool estimate must have unavailable kind and confidence",
        });
      }
    } else if (value.estimateKind === "unavailable" || value.confidence === "unavailable") {
      context.addIssue({
        code: "custom",
        path: ["estimatedPoolRewardSats"],
        message: "An available pool estimate must identify its kind and confidence",
      });
    }
    if (value.estimateKind === "if-calculated-now" && value.confidence !== "contract-exact") {
      context.addIssue({
        code: "custom",
        path: ["confidence"],
        message: "An if-calculated-now estimate must be contract-exact",
      });
    }
    if (
      value.estimateKind === "checkpoint-forecast" &&
      value.confidence !== "low" &&
      value.confidence !== "developing" &&
      value.confidence !== "calibrated"
    ) {
      context.addIssue({
        code: "custom",
        path: ["confidence"],
        message: "A checkpoint forecast must expose its calibration confidence",
      });
    }
    if ((value.operatorFeeSats === null) === (value.operatorFeeUnavailableReason === null)) {
      context.addIssue({
        code: "custom",
        path: ["operatorFeeSats"],
        message: "An operator fee must have either a value or an unavailability reason",
      });
    }
    if (value.operatorFeeSats !== null && value.estimateKind === "unavailable") {
      context.addIssue({
        code: "custom",
        path: ["operatorFeeSats"],
        message: "An operator fee estimate requires an available pool estimate",
      });
    }
  });
export type OverviewRewardsSummary = z.infer<typeof overviewRewardsSummarySchema>;

export const overviewPageSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.iso.datetime(),
    monitoring: z
      .object({
        network: z.string().min(1).max(100),
        managerPrincipal: z.string().min(1).max(500),
      })
      .strict(),
    cycle: overviewCycleSnapshotSchema,
    network: overviewNetworkHealthSummarySchema,
    node: overviewNodeHealthSummarySchema,
    signer: overviewSignerHealthSummarySchema,
    attention: z.array(overviewAttentionItemSchema),
    inProgress: z.array(overviewInProgressItemSchema),
    pool: overviewPoolSummarySchema,
    rewards: overviewRewardsSummarySchema,
  })
  .strict()
  .superRefine((value, context) => {
    const attentionIds = new Set<string>();
    for (const [index, item] of value.attention.entries()) {
      if (attentionIds.has(item.attentionId)) {
        context.addIssue({
          code: "custom",
          path: ["attention", index, "attentionId"],
          message: "Attention IDs must be unique",
        });
      }
      attentionIds.add(item.attentionId);
    }
    const activityIds = new Set<string>();
    for (const [index, item] of value.inProgress.entries()) {
      if (activityIds.has(item.activityId)) {
        context.addIssue({
          code: "custom",
          path: ["inProgress", index, "activityId"],
          message: "In-progress activity IDs must be unique",
        });
      }
      activityIds.add(item.activityId);
    }
  });
export type OverviewPage = z.infer<typeof overviewPageSchema>;

export const browserWalletIntentNetworkSchema = z.enum([
  "mainnet",
  "pox5-testnet",
  "devnet",
  "regtest",
]);
export const browserWalletConnectNetworkSchema = browserWalletIntentNetworkSchema;

const clarityUintMaximum = (1n << 128n) - 1n;
const uint32Schema = z.number().int().nonnegative().max(0xffff_ffff);
const canonicalClarityUintSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)$/)
  .refine((value) => BigInt(value) <= clarityUintMaximum, "Value exceeds Clarity uint range");
const positiveClarityUintSchema = canonicalClarityUintSchema.refine(
  (value) => value !== "0",
  "Value must be positive",
);
const walletPrincipalInputSchema = z.string().min(1).max(500);
const walletActorPrincipalInputSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => !value.includes("."), "Expected a standard principal");

export const onboardingBrowserWalletIntentCreateRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("deploy-manager") }).strict(),
  z.object({ action: z.literal("register-self") }).strict(),
]);
export const browserWalletIntentCreateRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("deploy-manager") }).strict(),
  z
    .object({
      action: z.literal("register-self"),
      actorPrincipal: walletActorPrincipalInputSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("add-admin"),
      actorPrincipal: walletActorPrincipalInputSchema,
      adminPrincipal: walletActorPrincipalInputSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("remove-admin"),
      actorPrincipal: walletActorPrincipalInputSchema,
      adminPrincipal: walletActorPrincipalInputSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("update-fees"),
      actorPrincipal: walletActorPrincipalInputSchema,
      feeBips: canonicalClarityUintSchema.refine(
        (value) => BigInt(value) < 10_000n,
        "Fee must be below 10000 basis points",
      ),
    })
    .strict(),
  z
    .object({
      action: z.literal("withdraw-fees"),
      actorPrincipal: walletActorPrincipalInputSchema,
      amountSats: positiveClarityUintSchema,
      recipient: walletPrincipalInputSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("sweep-fee-refunds"),
      actorPrincipal: walletActorPrincipalInputSchema,
      recipient: walletPrincipalInputSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("claim-rewards"),
      actorPrincipal: walletActorPrincipalInputSchema,
      jobId: z.uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("calculate-rewards"),
      actorPrincipal: walletActorPrincipalInputSchema,
    })
    .strict(),
  z
    .object({
      // One `(staker, reward-cycle, bond-index)` per request. `claim-staker-rewards` takes a
      // single staker and has no batch form, so a settlement is one transaction per tuple.
      action: z.literal("claim-staker-rewards"),
      actorPrincipal: walletActorPrincipalInputSchema,
      stakerPrincipal: walletPrincipalInputSchema,
      rewardCycle: canonicalClarityUintSchema,
      /** `null` claims the STX-only bucket; a value claims one bond bucket. */
      bondIndex: canonicalClarityUintSchema.nullable(),
    })
    .strict(),
]);
export const recurringBrowserWalletIntentCreateRequestSchema =
  browserWalletIntentCreateRequestSchema
    .refine(
      (value): value is RecurringBrowserWalletIntentCreateRequest =>
        value.action !== "deploy-manager",
      "Manager deployment is not a recurring Sidekick operation",
    )
    .transform((value) => value as RecurringBrowserWalletIntentCreateRequest);

/**
 * What settling a cycle costs, shown before the operator signs anything. The outstanding claim
 * count is the transaction count: the contract offers no way to combine them.
 */
export const stakerClaimsResponseSchema = z
  .object({
    generatedAt: z.string().optional(),
    rewardCycle: z.number().int().nonnegative(),
    page: z
      .object({
        stakerPrincipals: z.array(z.string()),
        offset: z.number().int().nonnegative(),
        limit: z.number().int().positive(),
        stakersTotal: z.number().int().nonnegative(),
        nextCursor: z.string().nullable(),
      })
      .strict(),
    settlement: z
      .object({
        // Scoped to the stakers this page actually read, never the whole cycle.
        scope: z.literal("page"),
        stakersScanned: z.number().int().nonnegative(),
        outstandingClaims: z.number().int().nonnegative(),
        transactionCount: z.number().int().nonnegative(),
        totalNetSats: canonicalClarityUintSchema,
        blockedClaims: z.number().int().nonnegative(),
      })
      .strict(),
    candidates: z.array(
      z
        .object({
          stakerPrincipal: z.string(),
          bondIndex: canonicalClarityUintSchema.nullable(),
          payout: z
            .object({
              kind: z.enum(["direct-sbtc", "bitcoin-l1"]),
              maxFeeSats: canonicalClarityUintSchema.nullable(),
            })
            .strict(),
          rewards: z
            .object({
              earnedSats: canonicalClarityUintSchema,
              feeSats: canonicalClarityUintSchema,
              grossSats: canonicalClarityUintSchema,
            })
            .strict(),
          claimable: z.boolean(),
          blockedReason: z
            .enum([
              "nothing-settled",
              "manager-has-not-claimed",
              "l1-below-max-fee",
              "l1-below-dust-limit",
            ])
            .nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const browserWalletIntentSubmissionRequestSchema = z
  .object({ txid: z.string().regex(/^0x[0-9a-f]{64}$/i) })
  .strict();
export type BrowserWalletIntentSubmissionRequest = z.infer<
  typeof browserWalletIntentSubmissionRequestSchema
>;

const browserWalletCommonParamsSchema = z
  .object({
    network: browserWalletConnectNetworkSchema,
    address: z.string().min(1),
    sponsored: z.literal(false),
    postConditionMode: z.literal("deny"),
  })
  .strict();

const clarityHexSchema = z.string().regex(/^(?:0x)?(?:[0-9a-f]{2})+$/i);
const serializedPostConditionSchema = z
  .string()
  .min(4)
  .max(2_048)
  .regex(/^(?:0x)?(?:[0-9a-f]{2})+$/i);
const browserWalletNoPostConditionsParamsSchema = browserWalletCommonParamsSchema.extend({
  postConditions: z.tuple([]),
});
const browserWalletAssetPostConditionParamsSchema = browserWalletCommonParamsSchema.extend({
  postConditions: z.array(serializedPostConditionSchema).length(1),
});

export const browserWalletTransactionSchema = z.union([
  z
    .object({
      method: z.literal("stx_deployContract"),
      params: browserWalletNoPostConditionsParamsSchema
        .extend({
          name: z.string().min(1),
          clarityCode: z.string().min(1),
          clarityVersion: z.literal(6),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal("stx_callContract"),
      params: browserWalletNoPostConditionsParamsSchema
        .extend({
          contract: z.string().min(1),
          functionName: z.literal("register-self"),
          functionArgs: z.array(clarityHexSchema).length(4),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal("stx_callContract"),
      params: browserWalletNoPostConditionsParamsSchema
        .extend({
          contract: z.string().min(1),
          functionName: z.literal("update-admin"),
          functionArgs: z.array(clarityHexSchema).length(2),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal("stx_callContract"),
      params: browserWalletNoPostConditionsParamsSchema
        .extend({
          contract: z.string().min(1),
          functionName: z.literal("update-fees"),
          functionArgs: z.array(clarityHexSchema).length(1),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal("stx_callContract"),
      params: browserWalletAssetPostConditionParamsSchema
        .extend({
          contract: z.string().min(1),
          functionName: z.literal("withdraw-fees"),
          functionArgs: z.array(clarityHexSchema).length(2),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal("stx_callContract"),
      params: browserWalletNoPostConditionsParamsSchema
        .extend({
          contract: z.string().min(1),
          functionName: z.literal("calculate-rewards"),
          functionArgs: z.array(clarityHexSchema).length(1),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal("stx_callContract"),
      params: browserWalletAssetPostConditionParamsSchema
        .extend({
          contract: z.string().min(1),
          functionName: z.literal("claim-rewards"),
          functionArgs: z.array(clarityHexSchema).length(2),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal("stx_callContract"),
      params: browserWalletAssetPostConditionParamsSchema
        .extend({
          contract: z.string().min(1),
          // (staker, reward-cycle, bond-index) -- exactly one settleable tuple.
          functionName: z.literal("claim-staker-rewards"),
          functionArgs: z.array(clarityHexSchema).length(3),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal("stx_callContract"),
      params: browserWalletAssetPostConditionParamsSchema
        .extend({
          contract: z.string().min(1),
          functionName: z.literal("sweep-fee-refunds"),
          functionArgs: z.array(clarityHexSchema).length(1),
        })
        .strict(),
    })
    .strict(),
]);

export const browserWalletIntentSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    id: z.uuid(),
    action: browserWalletIntentActionSchema,
    network: browserWalletIntentNetworkSchema,
    chainId: uint32Schema,
    requiredSender: z.string().min(1),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    transaction: browserWalletTransactionSchema,
    request: z
      .union([
        onboardingBrowserWalletIntentCreateRequestSchema,
        browserWalletIntentCreateRequestSchema,
      ])
      .optional(),
    binding: z
      .object({
        kind: z.literal("calculate-rewards"),
        pox5ContractId: z.string().min(1),
        targetRewardCycle: z.number().int().nonnegative(),
        targetCheckpoint: z.enum(["first-half", "second-half"]),
        expectedLastRewardComputeBurnHeight: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    review: z
      .object({
        title: z.string().min(1),
        summary: z.string().min(1),
        expectedPostState: z.string().min(1),
        fields: z
          .array(z.object({ label: z.string().min(1), value: z.string().min(1) }).strict())
          .max(16)
          .default([]),
      })
      .strict(),
    seal: z
      .object({
        factsSha256: z.string().regex(/^[0-9a-f]{64}$/),
        manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    status: z.enum([
      "prepared",
      "submitted",
      "mempool",
      "confirmed",
      "complete",
      "expired",
      "superseded",
      "failed",
      "reobserve",
    ]),
    txid: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/)
      .nullable(),
    verification: z
      .object({
        outcome: z.enum([
          "submitted",
          "mempool",
          "canonical-success",
          "complete",
          "not-found",
          "noncanonical",
          "superseded",
          "mismatch",
          "abort",
          "unavailable",
        ]),
        observedAt: z.iso.datetime(),
        canonical: z.boolean().nullable(),
        blockHeight: z.number().int().nonnegative().nullable(),
        indexBlockHash: z
          .string()
          .regex(/^0x[0-9a-f]{64}$/)
          .nullable(),
        detail: z.string().min(1),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedChainId =
      value.network === "mainnet" ? 1 : value.network === "pox5-testnet" ? 0x80000005 : null;
    if (
      value.transaction.params.network !== value.network ||
      (expectedChainId !== null && value.chainId !== expectedChainId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["network"],
        message: "Wallet intent network and chain binding do not match",
      });
    }
    if (value.schemaVersion === 1) {
      if (
        value.network !== "mainnet" ||
        !["deploy-manager", "register-self"].includes(value.action)
      ) {
        context.addIssue({
          code: "custom",
          path: ["schemaVersion"],
          message: "Schema version 1 supports mainnet setup actions only",
        });
      }
    } else {
      if (value.review.fields.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["review", "fields"],
          message: "Schema version 2 requires immutable review fields",
        });
      }
      if (!value.request || value.request.action !== value.action) {
        context.addIssue({
          code: "custom",
          path: ["request"],
          message: "Schema version 2 requires the immutable action request",
        });
      }
      if (
        (value.action === "calculate-rewards") !==
        (value.binding?.kind === "calculate-rewards")
      ) {
        context.addIssue({
          code: "custom",
          path: ["binding"],
          message: "Reward-calculation intents require their immutable completion binding",
        });
      }
    }
    const transaction = value.transaction;
    const actionMatches =
      (value.action === "deploy-manager" && transaction.method === "stx_deployContract") ||
      (value.action === "register-self" &&
        transaction.method === "stx_callContract" &&
        transaction.params.functionName === "register-self") ||
      (["add-admin", "remove-admin"].includes(value.action) &&
        transaction.method === "stx_callContract" &&
        transaction.params.functionName === "update-admin") ||
      (value.action === "update-fees" &&
        transaction.method === "stx_callContract" &&
        transaction.params.functionName === "update-fees") ||
      (value.action === "withdraw-fees" &&
        transaction.method === "stx_callContract" &&
        transaction.params.functionName === "withdraw-fees") ||
      (value.action === "sweep-fee-refunds" &&
        transaction.method === "stx_callContract" &&
        transaction.params.functionName === "sweep-fee-refunds") ||
      (value.action === "claim-rewards" &&
        transaction.method === "stx_callContract" &&
        transaction.params.functionName === "claim-rewards") ||
      (value.action === "claim-staker-rewards" &&
        transaction.method === "stx_callContract" &&
        transaction.params.functionName === "claim-staker-rewards") ||
      (value.action === "calculate-rewards" &&
        transaction.method === "stx_callContract" &&
        transaction.params.functionName === "calculate-rewards");
    if (!actionMatches) {
      context.addIssue({
        code: "custom",
        path: ["transaction"],
        message: "Wallet intent action and transaction do not match",
      });
    }
  });

export const browserWalletIntentResponseSchema = z
  .object({ intent: browserWalletIntentSchema })
  .strict();
export type BrowserWalletIntentResponse = z.infer<typeof browserWalletIntentResponseSchema>;
