import { z } from "zod";

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
  checkedAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  latencyMs: z.number().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
});

export const healthSnapshotSchema = z.looseObject({
  generatedAt: z.string(),
  overallStatus: z.enum(["healthy", "needs-attention", "partial", "unavailable"]),
  coverage: z.looseObject({ available: z.number(), total: z.number() }),
  burnBlockTiming: z
    .looseObject({
      averageSeconds: z.number(),
      windowHours: z.union([z.literal(12), z.literal(24)]),
      sampleBlocks: z.number(),
      sampledAt: z.string(),
    })
    .nullable(),
  findings: z.array(
    z.looseObject({
      id: z.string(),
      severity: z.enum(["critical", "warning", "info"]),
      title: z.string(),
      detail: z.string(),
      source: z.enum(["node", "signer"]),
    }),
  ),
  node: z.looseObject({
    rpc: sourceStateSchema,
    metrics: sourceStateSchema,
    version: z.string().nullable(),
    networkId: z.number().nullable(),
    stacksTipHeight: z.number().nullable(),
    burnBlockHeight: z.number().nullable(),
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
    lastHour: z.looseObject({
      proposals: z.number().nullable(),
      accepted: z.number().nullable(),
      rejected: z.number().nullable(),
      rejectionPercent: z.number().nullable(),
      responseP95Seconds: z.number().nullable(),
      disagreements: z.number().nullable(),
      collectingBaseline: z.boolean(),
    }),
  }),
});
export type HealthSnapshot = z.infer<typeof healthSnapshotSchema>;

export interface ActivationStep {
  id: string;
  status: "complete" | "ready" | "pending" | "attention" | "blocked";
  title: string;
  detail: string;
  command: string | null;
}

export interface OnboardingState {
  path: "attach" | "fresh";
  status: "in-progress" | "blocked" | "complete";
  currentStep: string;
  managerPrincipal: string;
  updatedAt: string;
  activationPlan: null | { status: string; steps: ActivationStep[] };
  freshInput: null | {
    adminPrincipal: string;
    contractName: string;
    authId: string;
    signerConfigPath: string;
  };
  artifact: {
    available: boolean;
    sourceFile: string | null;
    manifestFile: string | null;
    manifest: null | {
      operatorReviewRequired: true;
      warnings: string[];
      network: string;
      adminPrincipal: string;
      artifact: { sourceSha256: string; canonicalSourceSha256: string };
      transaction: { contractName: string; clarityVersion: 6 };
    };
  };
  signerGrant: {
    preparation: null | { command: string; expectedMessageHashHex: string; authId: string };
    verified: null | {
      managerPrincipal: string;
      authId: string;
      signerKeyHex: string;
      signerSignatureHex: string;
      expectedMessageHashHex: string;
      registerSelfCall: {
        contract: string;
        functionName: string;
        arguments: string[];
        signingPrincipal: string;
      };
    };
  };
  audit: Array<{
    action: string;
    path: "attach" | "fresh";
    currentStep: string;
    status: string;
    changedAt: string;
  }>;
}

export interface OnboardingWizardState {
  dismissed: boolean;
  dismissedAt: string | null;
  updatedAt: string | null;
  audit: Array<{ action: "dismissed" | "resumed"; changedAt: string }>;
}

interface Eligibility {
  cycleId: number;
  delegatedUstx: string;
  thresholdUstx: string;
  meetsThreshold: boolean;
  inSignerSet: boolean;
}

export interface OperatorSnapshot {
  managerPrincipal: string;
  network: string;
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
        target: "setup" | "settings" | "pool" | "rewards" | "operations";
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

export interface DashboardSnapshot extends OperatorSnapshot {
  generatedAt: string;
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
    };
    api: {
      serverVersion: string;
      burnBlockHeight: number;
      stacksTipHeight: number;
      burnBlockLag: number;
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
  rewards: null | {
    status: "ready" | "attention";
    rewardCycle: number;
    global: {
      lastRewardComputeBurnHeight: string;
      lastComputedRewardCycle: string | null;
      signerEarnedBeforeManagerClaimSats: string;
    };
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

export interface EnrollmentDocument {
  pool: { displayName: string; websiteUrl?: string; support?: { email?: string; url?: string } };
  chain: { network: string; burnBlockHeight: number; rewardCycleId: number };
  manager: { principal: string; sourceSha256: string };
  signer: { publicKeyHex: string | null; grantValid: boolean | null };
  fee: { currentConfiguredBips: number };
  eligibility: {
    current: null | { delegatedUstx: string; meetsThreshold: boolean; inSignerSet: boolean };
  };
  links: { managerExplorer: string; officialPlatforms: Array<{ label: string; url: string }> };
}

export interface PoolCardArtifact {
  mode: "live" | "static";
  filename: string;
  contentType: string;
  body: string;
  json: { filename: string; contentType: string; body: string };
  enrollment: EnrollmentDocument;
  liveFields: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasRecord(value: Record<string, unknown>, key: string): boolean {
  return isRecord(value[key]);
}

function isDashboardSnapshot(value: unknown): value is DashboardSnapshot {
  return (
    isRecord(value) &&
    typeof value.generatedAt === "string" &&
    typeof value.network === "string" &&
    typeof value.managerPrincipal === "string" &&
    hasRecord(value, "preflight") &&
    hasRecord(value, "manager") &&
    hasRecord(value, "activity") &&
    Array.isArray(value.roster) &&
    Array.isArray(value.alerts)
  );
}

function isOnboardingState(value: unknown): value is OnboardingState {
  return (
    isRecord(value) &&
    (value.path === "attach" || value.path === "fresh") &&
    typeof value.currentStep === "string" &&
    typeof value.managerPrincipal === "string" &&
    hasRecord(value, "artifact") &&
    hasRecord(value, "signerGrant") &&
    Array.isArray(value.audit)
  );
}

const onboardingStateSchema = z.custom<OnboardingState>(isOnboardingState, {
  error: "Invalid onboarding response",
});

export const dashboardSnapshotSchema = z.custom<DashboardSnapshot>(isDashboardSnapshot, {
  error: "Invalid dashboard snapshot",
});
export type StatusResponse = z.infer<typeof dashboardSnapshotSchema>;
export const statusResponseSchema = dashboardSnapshotSchema;

export const syncResponseSchema = z.custom<{ snapshot: DashboardSnapshot }>(
  (value) => isRecord(value) && isDashboardSnapshot(value.snapshot),
  { error: "Invalid sync response" },
);
export type SyncResponse = z.infer<typeof syncResponseSchema>;

export const poolPageResponseSchema = z.custom<{ roster: RosterEntry[]; total: number }>(
  (value) => isRecord(value) && Array.isArray(value.roster) && typeof value.total === "number",
  { error: "Invalid pool response" },
);
export type PoolPageResponse = z.infer<typeof poolPageResponseSchema>;

export const rewardsPageResponseSchema = z.custom<{ rewards: DashboardSnapshot["rewards"] }>(
  (value) => isRecord(value) && (value.rewards === null || isRecord(value.rewards)),
  { error: "Invalid rewards response" },
);
export type RewardsPageResponse = z.infer<typeof rewardsPageResponseSchema>;

export const activityResponseSchema = z.custom<DashboardSnapshot["activity"]>(
  (value) =>
    isRecord(value) &&
    Array.isArray(value.claims) &&
    Array.isArray(value.withdrawals) &&
    typeof value.claimTotal === "number" &&
    typeof value.withdrawalTotal === "number",
  { error: "Invalid activity response" },
);
export type ActivityResponse = z.infer<typeof activityResponseSchema>;

export const rewardHistoryResponseSchema = z.custom<{
  items: RewardCycleSummary[];
  total: number;
}>((value) => isRecord(value) && Array.isArray(value.items) && typeof value.total === "number", {
  error: "Invalid reward history response",
});
export type RewardHistoryResponse = z.infer<typeof rewardHistoryResponseSchema>;

export const onboardingEnvelopeSchema = z.custom<{
  onboarding: OnboardingState | null;
  wizard: OnboardingWizardState;
}>(
  (value) =>
    isRecord(value) &&
    (value.onboarding === null || isOnboardingState(value.onboarding)) &&
    isRecord(value.wizard) &&
    typeof value.wizard.dismissed === "boolean" &&
    Array.isArray(value.wizard.audit),
  { error: "Invalid onboarding response" },
);
export type OnboardingEnvelope = z.infer<typeof onboardingEnvelopeSchema>;

export const onboardingActionResponseSchema = z.object({ onboarding: onboardingStateSchema });
export type OnboardingActionResponse = z.infer<typeof onboardingActionResponseSchema>;

export const freshRefreshResponseSchema = z.custom<{
  onboarding: OnboardingState;
  preflight: OperatorSnapshot["preflight"];
  setup: NonNullable<OperatorSnapshot["setup"]>;
}>(
  (value) =>
    isRecord(value) &&
    isOnboardingState(value.onboarding) &&
    hasRecord(value, "preflight") &&
    hasRecord(value, "setup"),
  { error: "Invalid onboarding refresh response" },
);
export type FreshRefreshResponse = z.infer<typeof freshRefreshResponseSchema>;

export const poolCardResponseSchema = z.custom<PoolCardArtifact>(
  (value) =>
    isRecord(value) &&
    (value.mode === "live" || value.mode === "static") &&
    typeof value.filename === "string" &&
    typeof value.contentType === "string" &&
    typeof value.body === "string" &&
    hasRecord(value, "json") &&
    hasRecord(value, "enrollment") &&
    Array.isArray(value.liveFields),
  { error: "Invalid pool card response" },
);

export const apiErrorSchema = z.looseObject({ error: z.string() });
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

export const onboardingStartRequestSchema = z
  .object({ path: z.enum(["attach", "fresh"]), reset: z.boolean().optional() })
  .strict();
export type OnboardingStartRequest = z.infer<typeof onboardingStartRequestSchema>;

export const onboardingAttachRequestSchema = z
  .object({ managerPrincipal: z.string().min(1) })
  .strict();
export type OnboardingAttachRequest = z.infer<typeof onboardingAttachRequestSchema>;

export const onboardingGrantVerifyRequestSchema = z.object({ signerOutput: z.unknown() }).strict();
export type OnboardingGrantVerifyRequest = z.infer<typeof onboardingGrantVerifyRequestSchema>;

export const onboardingProgressRequestSchema = z
  .object({ currentStep: z.string().min(1) })
  .strict();
export type OnboardingProgressRequest = z.infer<typeof onboardingProgressRequestSchema>;

export const poolCardGenerateRequestSchema = z
  .object({ mode: z.enum(["live", "static"]) })
  .strict();
export type PoolCardGenerateRequest = z.infer<typeof poolCardGenerateRequestSchema>;
