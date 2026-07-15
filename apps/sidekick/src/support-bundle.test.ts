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
};

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
    pox5Available: true,
    pox5ContractId,
    blocksUntilEpoch4: 0,
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
  },
  interface: { compatible: true },
  attachAllowed: true,
  automationEligible: false,
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
  schemaVersion: 1,
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
});
