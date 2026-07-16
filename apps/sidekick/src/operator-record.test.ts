import { describe, expect, it } from "vitest";
import type { PoolEnrollmentDocument } from "./enrollment-info.js";
import type { ManagerVerificationReport } from "./manager-verification.js";
import {
  createOperatorRecord,
  operatorRecordMetadataSchema,
  operatorRecordSchema,
} from "./operator-record.js";
import type { PreflightResult } from "./preflight.js";
import type { RegistrationVerification } from "./registration-verification.js";
import type { PoolSetupStatus } from "./setup-status.js";

const managerPrincipal = "SP000000000000000000002Q6VF78.signer-manager";
const gasPayerPrincipal = "SP2JXKMSH007NPYAQHKJPQMAQYAD90NQGTVJVQ02B";

const preflight = {
  network: "mainnet",
} as PreflightResult;

const manager = {
  managerPrincipal,
  source: {
    profileId: "stacks-4.0.0-mainnet-reference-manager",
    sha256: "a".repeat(64),
    recognized: true,
    tier: "reference-built-in",
    origin: "built-in",
  },
  provenance: {
    status: "built-in",
    upstreamProfileId: "stacks-4.0.0-mainnet-reference-manager",
    reason: "Built-in profile",
  },
  attachAllowed: true,
  automationEligible: false,
  automationEligibilityReason: "Profile is not production-approved",
} as ManagerVerificationReport;

const registration = {
  registered: true,
  signerKeyHex: `02${"11".repeat(32)}`,
  signerKeyGrantValid: true,
} as RegistrationVerification;

const setup = {
  observedAt: { burnBlockHeight: 960_240, stacksTipHeight: 8_600_000 },
  enrollmentWindow: {
    status: "open",
    targetCycleId: 141,
    preparePhaseStartBurnHeight: 962_050,
    blocksUntilPreparePhase: 1_810,
  },
  eligibility: {
    current: null,
    next: {
      cycleId: 141,
      delegatedUstx: "52000000000",
      thresholdUstx: "50000000000",
      marginUstx: "2000000000",
      meetsThreshold: true,
      inSignerSet: true,
      thresholdAndMembershipAgree: true,
    },
  },
  checks: [],
} as PoolSetupStatus;

const enrollment = {
  manager: { principal: managerPrincipal },
  pool: { displayName: "Example Pool" },
  fee: { currentConfiguredBips: 500 },
  rewardDestinations: { directSbtc: true, bitcoinL1: false },
  durationPolicy: { minimumCycles: 1, maximumCycles: 12 },
  readiness: { enrollmentReady: true },
} as PoolEnrollmentDocument;

describe("operator record", () => {
  it("builds an allowlisted record without holding privileged keys", () => {
    const record = createOperatorRecord(
      {
        schemaVersion: 1,
        signerGrantAuthId: "42",
        gasPayerPrincipal,
      },
      preflight,
      manager,
      registration,
      setup,
      enrollment,
    );

    expect(() => operatorRecordSchema.parse(record)).not.toThrow();
    expect(record).toMatchObject({
      mode: "observe",
      manager: {
        principal: managerPrincipal,
        adminPrincipal: "SP000000000000000000002Q6VF78",
      },
      signer: {
        grantAuthId: "42",
        grantAuthIdSource: "operator-record-config",
      },
      automation: {
        gasPayerPrincipal,
        signerKeyHeldBySidekick: false,
        managerAdminKeyHeldBySidekick: false,
      },
    });
    expect(record.remainingActions).toContain(
      "Keep Sidekick in Observe mode until the matching built-in profile is production-approved",
    );
    expect(JSON.stringify(record)).not.toContain("signerSignature");
  });

  it("records missing non-secret metadata as an action instead of inventing it", () => {
    const record = createOperatorRecord(
      { schemaVersion: 1 },
      preflight,
      manager,
      registration,
      setup,
      enrollment,
    );

    expect(record.signer).toMatchObject({
      grantAuthId: null,
      grantAuthIdSource: "not-recorded",
    });
    expect(record.remainingActions).toContain("Record the signer grant auth ID");
    expect(record.remainingActions).toContain(
      "Configure a dedicated gas payer before enabling Assist or Automate",
    );
  });

  it("rejects secrets and unsafe gas-payer identities", () => {
    expect(() =>
      operatorRecordMetadataSchema.parse({
        schemaVersion: 1,
        signerPrivateKey: "secret",
      }),
    ).toThrow();
    expect(() =>
      createOperatorRecord(
        {
          schemaVersion: 1,
          gasPayerPrincipal: "SP000000000000000000002Q6VF78",
        },
        preflight,
        manager,
        registration,
        setup,
        enrollment,
      ),
    ).toThrow("must not be the manager admin principal");
  });
});
