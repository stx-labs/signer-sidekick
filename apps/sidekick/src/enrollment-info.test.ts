import { describe, expect, it } from "vitest";
import {
  createPoolEnrollmentDocument,
  poolEnrollmentConfigSchema,
  poolEnrollmentDocumentSchema,
} from "./enrollment-info.js";
import type { ManagerVerificationReport } from "./manager-verification.js";
import type { PreflightResult } from "./preflight.js";
import type { RegistrationVerification } from "./registration-verification.js";
import type { PoolSetupStatus } from "./setup-status.js";

const managerPrincipal = "SP000000000000000000002Q6VF78.signer-manager";
const pox5ContractId = "SP000000000000000000002Q6VF78.pox-5";

const preflight = {
  status: "pass",
  network: "mainnet",
  node: { networkId: 1, burnBlockHeight: 960_240, stacksTipHeight: 8_600_000 },
  api: {
    serverVersion: "stacks-blockchain-api v9.0.0",
    burnBlockHeight: 960_240,
    stacksTipHeight: 8_600_000,
    burnBlockLag: 0,
  },
  pox: {
    activeContractId: pox5ContractId,
    rewardCycleId: 141,
    rewardCycleLength: 2_100,
    prepareCycleLength: 100,
    pox5Available: true,
    pox5ContractId,
    blocksUntilEpoch4: 0,
  },
  cycle: {
    currentId: 141,
    currentMinThresholdUstx: "50000000000",
    currentStackedUstx: "500000000000000",
    nextId: 142,
    nextMinThresholdUstx: "50000000000",
    nextStackedUstx: "75000000000",
    preparePhaseStartBurnHeight: 962_050,
    blocksUntilPreparePhase: 1_810,
    rewardPhaseStartBurnHeight: 962_150,
    blocksUntilRewardPhase: 1_910,
    isPreparePhase: false,
  },
  checks: [],
} satisfies PreflightResult;

const manager = {
  managerPrincipal,
  configuredNetwork: "mainnet",
  principalNetwork: "mainnet",
  networkMatches: true,
  publishHeight: 8_599_000,
  source: {
    match: "exact",
    profileId: "stacks-4.0.0-mainnet-reference-manager",
    sha256: "a".repeat(64),
    canonicalSha256: "b".repeat(64),
    recognized: true,
    tier: "reference-built-in",
    origin: "built-in",
  },
  provenance: {
    status: "built-in",
    upstreamProfileId: "stacks-4.0.0-mainnet-reference-manager",
    reason: "Built-in profile",
  },
  interface: { compatible: true, missingFunctions: [] },
  capabilities: {
    signerManagerTrait: { compatible: true, reason: "Exact trait signature" },
    observedFunctions: { public: ["validate-stake!"], readOnly: [] },
    sourceReview: { exactReviewed: true, reason: "Reviewed source" },
    eventVocabulary: {
      id: "reference-manager-v1",
      normalizationAvailable: true,
      adapter: {
        id: "reference-manager-print-events",
        revision: 1,
        reviewedSourceSha256: "a".repeat(64),
      },
      reason: "Reviewed event vocabulary",
    },
    actions: [],
  },
  installedProfiles: { directory: null, loaded: 0, issues: [] },
  attachAllowed: true,
  automationEligible: false,
  automationEligibilityReason: "Profile is not production-approved",
  recommendedMode: "observe",
  reasons: [],
} satisfies ManagerVerificationReport;

const registration = {
  managerPrincipal,
  pox5ContractId,
  registered: true,
  signerKeyHex: `02${"11".repeat(32)}`,
  signerKeyGrantValid: true,
  reason: "valid",
} satisfies RegistrationVerification;

const setup = {
  status: "ready",
  managerPrincipal,
  pox5ContractId,
  observedAt: { burnBlockHeight: 960_240, stacksTipHeight: 8_600_000 },
  enrollmentWindow: {
    status: "open",
    targetCycleId: 141,
    preparePhaseStartBurnHeight: 962_050,
    blocksUntilPreparePhase: 1_810,
  },
  eligibility: {
    current: {
      cycleId: 141,
      delegatedUstx: "51000000000",
      thresholdUstx: "50000000000",
      marginUstx: "1000000000",
      meetsThreshold: true,
      inSignerSet: true,
      thresholdAndMembershipAgree: true,
    },
    next: {
      cycleId: 142,
      delegatedUstx: "52000000000",
      thresholdUstx: "50000000000",
      marginUstx: "2000000000",
      meetsThreshold: true,
      inSignerSet: true,
      thresholdAndMembershipAgree: true,
    },
  },
  checks: [],
} satisfies PoolSetupStatus;

const config = {
  schemaVersion: 1,
  displayName: "Example Pool",
  websiteUrl: "https://pool.example.com",
  support: { email: "help@pool.example.com" },
  currentFeeBips: 500,
  rewardDestinations: { directSbtc: true, bitcoinL1: false },
  durationPolicy: { minimumCycles: 1, maximumCycles: 12 },
};

describe("pool enrollment information", () => {
  it("produces a strict, provider-neutral public document", () => {
    const document = createPoolEnrollmentDocument(config, preflight, manager, registration, setup);

    expect(() => poolEnrollmentDocumentSchema.parse(document)).not.toThrow();
    expect(document).toMatchObject({
      schemaVersion: 2,
      documentType: "stx-only-pool-enrollment-info",
      readiness: { enrollmentReady: true },
      fee: { currentConfiguredBips: 500, source: "operator-config" },
      links: {
        officialPlatforms: [
          {
            id: "leather",
            url: "https://earn.leather.io",
            integration: "link-only",
          },
        ],
      },
      userInteraction: {
        collectsAmount: false,
        collectsBitcoinAddress: false,
        connectsWallet: false,
        signsTransactions: false,
        submitsTransactions: false,
      },
    });
    expect(JSON.stringify(document)).not.toContain("apiKey");
    expect(() =>
      poolEnrollmentDocumentSchema.parse({
        ...document,
        signer: { ...document.signer, privateKey: "secret" },
      }),
    ).toThrow();
  });

  it("does not call an unregistered pool enrollment-ready", () => {
    const document = createPoolEnrollmentDocument(config, preflight, manager, null, {
      ...setup,
      status: "blocked",
      checks: [{ id: "registration", status: "fail", message: "Registration missing" }],
    });

    expect(document.readiness).toEqual({
      setupStatus: "blocked",
      enrollmentReady: false,
      notices: ["Registration missing"],
    });
  });

  it("rejects invalid fees, impossible durations, and undeclared fields", () => {
    expect(() => poolEnrollmentConfigSchema.parse({ ...config, currentFeeBips: 10_001 })).toThrow();
    expect(() =>
      poolEnrollmentConfigSchema.parse({
        ...config,
        durationPolicy: { minimumCycles: 12, maximumCycles: 1 },
      }),
    ).toThrow();
    expect(() => poolEnrollmentConfigSchema.parse({ ...config, apiKey: "secret" })).toThrow();
    expect(() =>
      poolEnrollmentConfigSchema.parse({ ...config, websiteUrl: "javascript:alert(1)" }),
    ).toThrow("Expected an HTTP(S) URL");
    expect(() =>
      poolEnrollmentConfigSchema.parse({
        ...config,
        officialPlatforms: [{ id: "unsafe", label: "Unsafe", url: "data:text/html,unsafe" }],
      }),
    ).toThrow("Expected an HTTP(S) URL");
  });
});
