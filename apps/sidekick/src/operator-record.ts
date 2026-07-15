import {
  parseContractPrincipal,
  validatePrincipal,
} from "@stx-labs/signer-sidekick-protocol/principals";
import { z } from "zod";
import type { PoolEnrollmentDocument } from "./enrollment-info.js";
import type { ManagerVerificationReport } from "./manager-verification.js";
import type { PreflightResult } from "./preflight.js";
import type { RegistrationVerification } from "./registration-verification.js";
import type { PoolSetupStatus } from "./setup-status.js";

const canonicalUintSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => BigInt(value) < 1n << 128n, "Value exceeds Clarity uint range");

const standardPrincipalSchema = z
  .string()
  .refine((principal) => !principal.includes(".") && validatePrincipal(principal), {
    message: "Expected a standard Stacks principal",
  });

export const operatorRecordMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    signerGrantAuthId: canonicalUintSchema.optional(),
    gasPayerPrincipal: standardPrincipalSchema.optional(),
  })
  .strict();

export type OperatorRecordMetadata = z.infer<typeof operatorRecordMetadataSchema>;

const eligibilitySchema = z
  .object({
    cycleId: z.number().int().nonnegative(),
    delegatedUstx: z.string().regex(/^(0|[1-9][0-9]*)$/),
    thresholdUstx: z.string().regex(/^(0|[1-9][0-9]*)$/),
    marginUstx: z.string().regex(/^(0|[1-9][0-9]*|-[1-9][0-9]*)$/),
    meetsThreshold: z.boolean(),
    inSignerSet: z.boolean(),
    thresholdAndMembershipAgree: z.boolean(),
  })
  .strict();

export const operatorRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    documentType: z.literal("signer-sidekick-operator-record"),
    mode: z.literal("observe"),
    network: z.enum(["mainnet", "testnet", "devnet", "regtest"]),
    observedAt: z
      .object({
        burnBlockHeight: z.number().int().nonnegative(),
        stacksTipHeight: z.number().int().nonnegative(),
      })
      .strict(),
    manager: z
      .object({
        principal: z.string(),
        adminPrincipal: z.string(),
        profileId: z.string().nullable(),
        sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
        sourceRecognized: z.boolean(),
        attachAllowed: z.boolean(),
      })
      .strict(),
    signer: z
      .object({
        publicKeyHex: z
          .string()
          .regex(/^[0-9a-f]{66}$/)
          .nullable(),
        registered: z.boolean(),
        grantValid: z.boolean().nullable(),
        grantAuthId: canonicalUintSchema.nullable(),
        grantAuthIdSource: z.enum(["operator-record-config", "not-recorded"]),
      })
      .strict(),
    pool: z
      .object({
        displayName: z.string(),
        configuredFeeBips: z.number().int().min(0).max(10_000),
        directSbtc: z.literal(true),
        bitcoinL1: z.boolean(),
        minimumCycles: z.number().int().min(1).max(96),
        maximumCycles: z.number().int().min(1).max(96),
        enrollmentReady: z.boolean(),
      })
      .strict()
      .nullable(),
    automation: z
      .object({
        productionEligible: z.boolean(),
        gasPayerPrincipal: standardPrincipalSchema.nullable(),
        signerKeyHeldBySidekick: z.literal(false),
        managerAdminKeyHeldBySidekick: z.literal(false),
      })
      .strict(),
    enrollmentWindow: z
      .object({
        status: z.enum(["open", "prepare-phase", "unknown"]),
        targetCycleId: z.number().int().nonnegative().nullable(),
        preparePhaseStartBurnHeight: z.number().int().nonnegative().nullable(),
        blocksUntilPreparePhase: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    eligibility: z
      .object({
        current: eligibilitySchema.nullable(),
        next: eligibilitySchema.nullable(),
      })
      .strict(),
    remainingActions: z.array(z.string()),
  })
  .strict();

export type OperatorRecord = z.infer<typeof operatorRecordSchema>;

function principalNetwork(principal: string): "mainnet" | "testnet" {
  return principal.startsWith("SP") || principal.startsWith("SM") ? "mainnet" : "testnet";
}

export function createOperatorRecord(
  metadataInput: unknown,
  preflight: PreflightResult,
  manager: ManagerVerificationReport,
  registration: RegistrationVerification | null,
  setup: PoolSetupStatus,
  enrollment: PoolEnrollmentDocument | null,
): OperatorRecord {
  const metadata = operatorRecordMetadataSchema.parse(metadataInput);
  const { address: adminPrincipal } = parseContractPrincipal(manager.managerPrincipal);
  if (metadata.gasPayerPrincipal) {
    const expectedNetwork = preflight.network === "mainnet" ? "mainnet" : "testnet";
    if (principalNetwork(metadata.gasPayerPrincipal) !== expectedNetwork) {
      throw new Error("Gas-payer principal does not match the configured network");
    }
    if (metadata.gasPayerPrincipal === adminPrincipal) {
      throw new Error("Gas-payer principal must not be the manager admin principal");
    }
  }
  if (enrollment && enrollment.manager.principal !== manager.managerPrincipal) {
    throw new Error("Enrollment document and operator record refer to different managers");
  }

  const remainingActions = setup.checks
    .filter((check) => check.status !== "pass")
    .map((check) => check.message);
  if (!metadata.signerGrantAuthId) remainingActions.push("Record the signer grant auth ID");
  if (!metadata.gasPayerPrincipal) {
    remainingActions.push("Configure a dedicated gas payer before enabling Assist or Automate");
  }
  if (!manager.automationEligible) {
    remainingActions.push("Keep Sidekick in Observe mode until the manager profile is approved");
  }
  if (!enrollment) remainingActions.push("Generate the pool enrollment information document");

  return operatorRecordSchema.parse({
    schemaVersion: 1,
    documentType: "signer-sidekick-operator-record",
    mode: "observe",
    network: preflight.network,
    observedAt: setup.observedAt,
    manager: {
      principal: manager.managerPrincipal,
      adminPrincipal,
      profileId: manager.source.profileId,
      sourceSha256: manager.source.sha256,
      sourceRecognized: manager.source.recognized,
      attachAllowed: manager.attachAllowed,
    },
    signer: {
      publicKeyHex: registration?.signerKeyHex ?? null,
      registered: registration?.registered ?? false,
      grantValid: registration?.signerKeyGrantValid ?? null,
      grantAuthId: metadata.signerGrantAuthId ?? null,
      grantAuthIdSource: metadata.signerGrantAuthId ? "operator-record-config" : "not-recorded",
    },
    pool: enrollment
      ? {
          displayName: enrollment.pool.displayName,
          configuredFeeBips: enrollment.fee.currentConfiguredBips,
          directSbtc: enrollment.rewardDestinations.directSbtc,
          bitcoinL1: enrollment.rewardDestinations.bitcoinL1,
          minimumCycles: enrollment.durationPolicy.minimumCycles,
          maximumCycles: enrollment.durationPolicy.maximumCycles,
          enrollmentReady: enrollment.readiness.enrollmentReady,
        }
      : null,
    automation: {
      productionEligible: manager.automationEligible,
      gasPayerPrincipal: metadata.gasPayerPrincipal ?? null,
      signerKeyHeldBySidekick: false,
      managerAdminKeyHeldBySidekick: false,
    },
    enrollmentWindow: setup.enrollmentWindow,
    eligibility: setup.eligibility,
    remainingActions: [...new Set(remainingActions)],
  });
}
