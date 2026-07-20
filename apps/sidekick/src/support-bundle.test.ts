import { describe, expect, it } from "vitest";
import type { SidekickConfig } from "./config.js";
import type { ManagerVerificationReport } from "./manager-verification.js";
import type { OperatorRecord } from "./operator-record.js";
import type { PreflightResult } from "./preflight.js";
import type { RegistrationVerification } from "./registration-verification.js";
import type { PoolSetupStatus } from "./setup-status.js";
import { createSupportBundle, supportBundleSchema } from "./support-bundle.js";

const managerPrincipal = "SP000000000000000000002Q6VF78.signer-manager";
const pox5ContractId = "SP000000000000000000002Q6VF78.pox-5";

const config: SidekickConfig = {
  network: "mainnet",
  nodeRpcUrl: "http://127.0.0.1:20443",
  apiUrl: "https://api.mainnet.hiro.so",
  apiKey: "do-not-export",
  apiKeyHeader: "x-api-key",
  maxApiBurnBlockLag: 12,
  forecastHorizonCycles: 6,
  databasePath: "/tmp/sidekick.sqlite",
};

const preflight = {
  status: "pass",
  network: "mainnet",
  node: {
    networkId: 1,
    parentNetworkId: null,
    serverVersion: "stacks-node 4.0.1.0.0 (62e03cc, release build, linux [x86_64])",
    version: "4.0.1.0.0",
    commit: "62e03cc",
    burnBlockHeight: 960_240,
    stacksTipHeight: 8_600_000,
  },
  api: {
    serverVersion: "stacks-blockchain-api v9.0.0",
    burnBlockHeight: 960_240,
    stacksTipHeight: 8_600_000,
    burnBlockLag: 0,
  },
  pox: {
    activationState: "active",
    pox5Available: true,
    pox5ContractId,
    scheduledPox5ContractId: pox5ContractId,
    sourceSha256: "c".repeat(64),
    sbtcTokenContract: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
    sbtcRegistryContract: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-registry",
    blocksUntilEpoch4: 0,
  },
  compatibility: {
    status: "matched",
    profileId: "stacks-mainnet-pox5-launch-4.0.1",
    profileRevision: 1,
    profileLabel: "Stacks mainnet PoX-5 launch",
    origin: "built-in",
    managerProfileId: "stacks-4.0.0-mainnet-reference-manager",
    managerSourceSha256: "d".repeat(64),
    nodeBuildPreviouslyTested: false,
    reason: "Live network fingerprint matches the launch profile",
    loadIssues: [],
  },
  checks: [{ id: "api-status", status: "pass", message: "API is ready" }],
} as PreflightResult;

const manager = {
  managerPrincipal,
  networkMatches: true,
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
  installedProfiles: { directory: null, loaded: 0, issues: [] },
  interface: { compatible: true },
  attachAllowed: true,
  automationEligible: false,
  automationEligibilityReason: "Profile is not production-approved",
  reasons: ["Profile is not production-approved"],
} as ManagerVerificationReport;

const registration = {
  registered: true,
  signerKeyHex: `02${"11".repeat(32)}`,
  signerKeyGrantValid: true,
  reason: "Registration and grant are valid",
} as RegistrationVerification;

const setup = {
  status: "attention",
  checks: [{ id: "profile", status: "warn", message: "Observe mode only" }],
} as PoolSetupStatus;

const operatorRecord = {
  schemaVersion: 2,
  documentType: "signer-sidekick-operator-record",
  mode: "observe",
  network: "mainnet",
  observedAt: { burnBlockHeight: 960_240, stacksTipHeight: 8_600_000 },
  manager: {
    principal: managerPrincipal,
    adminPrincipal: "SP000000000000000000002Q6VF78",
    profileId: "stacks-4.0.0-mainnet-reference-manager",
    sourceSha256: "a".repeat(64),
    sourceRecognized: true,
    recognitionTier: "reference-built-in",
    profileOrigin: "built-in",
    provenanceStatus: "built-in",
    attachAllowed: true,
  },
  signer: {
    publicKeyHex: `02${"11".repeat(32)}`,
    registered: true,
    grantValid: true,
    grantAuthId: "42",
    grantAuthIdSource: "operator-record-config",
  },
  pool: null,
  automation: {
    productionEligible: false,
    eligibilityReason: "Profile is not production-approved",
    gasPayerPrincipal: null,
    signerKeyHeldBySidekick: false,
    managerAdminKeyHeldBySidekick: false,
  },
  enrollmentWindow: {
    status: "open",
    targetCycleId: 141,
    preparePhaseStartBurnHeight: 962_050,
    blocksUntilPreparePhase: 1_810,
  },
  eligibility: { current: null, next: null },
  remainingActions: [],
} satisfies OperatorRecord;

describe("support bundle", () => {
  it("exports only reviewed diagnostic fields and explicit safety flags", () => {
    const bundle = createSupportBundle(
      config,
      preflight,
      manager,
      registration,
      setup,
      operatorRecord,
      null,
      "1.0.0-test",
    );

    expect(() => supportBundleSchema.parse(bundle)).not.toThrow();
    expect(bundle).toMatchObject({
      application: { version: "1.0.0-test" },
      configuration: { apiKeyConfigured: true },
      diagnostics: {
        manager: {
          recognitionTier: "reference-built-in",
          profileOrigin: "built-in",
          automationEligible: false,
          installedProfiles: { directoryConfigured: false, loaded: 0, issues: [] },
        },
      },
      safety: {
        construction: "explicit-allowlist",
        apiKeyIncluded: false,
        signerSignatureIncluded: false,
        signerHostHealthIncluded: false,
      },
    });
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain("do-not-export");
    expect(serialized).not.toContain("process.env");
  });

  it("rejects undeclared fields at nested public boundaries", () => {
    const bundle = createSupportBundle(
      config,
      preflight,
      manager,
      registration,
      setup,
      operatorRecord,
      null,
    );

    expect(() =>
      supportBundleSchema.parse({
        ...bundle,
        configuration: { ...bundle.configuration, apiKey: "secret" },
      }),
    ).toThrow();
  });

  it("redacts the configured profile directory from load errors", () => {
    const privateDirectory = "/private/operator/config/trusted-managers";
    const bundle = createSupportBundle(
      config,
      preflight,
      {
        ...manager,
        installedProfiles: {
          directory: privateDirectory,
          loaded: 0,
          issues: [
            {
              fileName: null,
              code: "directory-unreadable",
              message: `ENOENT: no such directory, scandir '${privateDirectory}'`,
            },
          ],
        },
      },
      registration,
      setup,
      operatorRecord,
      null,
    );
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain(privateDirectory);
    expect(serialized).toContain("<trusted-manager-profile-directory>");
  });

  it("redacts compatibility profile paths from load errors", () => {
    const privateDirectory = "/private/operator/config/network-compatibility";
    const bundle = createSupportBundle(
      {
        ...config,
        compatibilityProfilesDirectory: privateDirectory,
      },
      {
        ...preflight,
        compatibility: {
          ...preflight.compatibility,
          loadIssues: [
            {
              fileName: null,
              code: "directory-unavailable",
              message: `Unable to open ${privateDirectory}`,
            },
          ],
        },
      },
      manager,
      registration,
      setup,
      operatorRecord,
      null,
    );
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain(privateDirectory);
    expect(serialized).toContain("<network-compatibility-configuration>");
  });
});
