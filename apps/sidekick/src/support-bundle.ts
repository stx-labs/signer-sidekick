import { STACKS_CORE_4_0_0, STACKS_CORE_4_0_1 } from "@stx-labs/signer-sidekick-protocol";
import { z } from "zod";
import type { SidekickConfig } from "./config.js";
import type { PoolEnrollmentDocument } from "./enrollment-info.js";
import { poolEnrollmentDocumentSchema } from "./enrollment-info.js";
import type { ManagerVerificationReport } from "./manager-verification.js";
import { type OperatorRecord, operatorRecordSchema } from "./operator-record.js";
import type { PreflightResult } from "./preflight.js";
import type { RegistrationVerification } from "./registration-verification.js";
import type { PoolSetupStatus } from "./setup-status.js";

const checkSchema = z
  .object({
    id: z.string(),
    status: z.enum(["pass", "warn", "fail"]),
    message: z.string(),
  })
  .strict();

export const supportBundleSchema = z
  .object({
    schemaVersion: z.literal(2),
    documentType: z.literal("signer-sidekick-support-bundle"),
    application: z
      .object({
        version: z.string(),
        stacksCoreTag: z.string(),
        stacksCoreCommit: z.string().regex(/^[0-9a-f]{40}$/),
        launchStacksCoreTag: z.string(),
        launchStacksCoreCommit: z.string().regex(/^[0-9a-f]{40}$/),
      })
      .strict(),
    configuration: z
      .object({
        network: z.enum(["mainnet", "testnet", "devnet", "regtest"]),
        nodeRpcUrl: z.url(),
        apiUrl: z.url(),
        apiKeyHeader: z.string(),
        apiKeyConfigured: z.boolean(),
        maxApiBurnBlockLag: z.number().int().nonnegative(),
        forecastHorizonCycles: z.number().int().min(1).max(96),
        compatibilityProfilesConfigured: z.boolean(),
      })
      .strict(),
    diagnostics: z
      .object({
        preflight: z
          .object({
            status: z.enum(["pass", "warn", "fail"]),
            node: z
              .object({
                networkId: z.number().int(),
                parentNetworkId: z.number().int().nonnegative().nullable(),
                serverVersion: z.string().nullable(),
                version: z.string().nullable(),
                commit: z.string().nullable(),
                burnBlockHeight: z.number().int().nonnegative(),
                stacksTipHeight: z.number().int().nonnegative(),
              })
              .strict(),
            api: z
              .object({
                serverVersion: z.string(),
                burnBlockHeight: z.number().int().nonnegative(),
                stacksTipHeight: z.number().int().nonnegative(),
                burnBlockLag: z.number().int().nonnegative(),
              })
              .strict(),
            pox5: z
              .object({
                available: z.boolean(),
                activationState: z.enum(["active", "scheduled", "unavailable"]),
                contractId: z.string().nullable(),
                scheduledContractId: z.string().nullable(),
                sourceSha256: z
                  .string()
                  .regex(/^[0-9a-f]{64}$/)
                  .nullable(),
                sbtcTokenContract: z.string().nullable(),
                sbtcRegistryContract: z.string().nullable(),
                blocksUntilEpoch4: z.number().int().nonnegative().nullable(),
              })
              .strict(),
            networkCompatibility: z
              .object({
                status: z.enum(["matched", "unrecognized", "inconsistent"]),
                profileId: z.string().nullable(),
                profileRevision: z.number().int().positive().nullable(),
                profileLabel: z.string().nullable(),
                origin: z.enum(["built-in", "operator-provided"]).nullable(),
                managerProfileId: z.string().nullable(),
                managerSourceSha256: z
                  .string()
                  .regex(/^[0-9a-f]{64}$/)
                  .nullable(),
                nodeBuildPreviouslyTested: z.boolean(),
                reason: z.string(),
                loadIssues: z.array(
                  z
                    .object({
                      fileName: z.string().nullable(),
                      code: z.string(),
                      message: z.string(),
                    })
                    .strict(),
                ),
              })
              .strict(),
            checks: z.array(checkSchema),
          })
          .strict(),
        manager: z
          .object({
            principal: z.string(),
            networkMatches: z.boolean(),
            sourceMatch: z.enum(["exact", "canonical", "unknown"]),
            profileId: z.string().nullable(),
            sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
            canonicalSourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
            recognitionTier: z.enum([
              "reference-built-in",
              "reference-render",
              "custom-observe",
              "unrecognized",
            ]),
            profileOrigin: z.enum(["built-in", "operator-installed"]).nullable(),
            provenance: z
              .object({
                status: z.enum(["built-in", "verified", "not-applicable", "failed"]),
                upstreamProfileId: z.string().nullable(),
                reason: z.string(),
              })
              .strict(),
            installedProfiles: z
              .object({
                directoryConfigured: z.boolean(),
                loaded: z.number().int().nonnegative(),
                issues: z.array(
                  z
                    .object({
                      fileName: z.string().nullable(),
                      code: z.string(),
                      message: z.string(),
                    })
                    .strict(),
                ),
              })
              .strict(),
            interfaceCompatible: z.boolean(),
            attachAllowed: z.boolean(),
            automationEligible: z.boolean(),
            automationEligibilityReason: z.string(),
            reasons: z.array(z.string()),
          })
          .strict(),
        registration: z
          .object({
            registered: z.boolean(),
            signerKeyHex: z
              .string()
              .regex(/^[0-9a-f]{66}$/)
              .nullable(),
            signerKeyGrantValid: z.boolean().nullable(),
            reason: z.string(),
          })
          .strict()
          .nullable(),
        setupStatus: z.enum(["ready", "attention", "blocked"]),
        setupChecks: z.array(checkSchema),
      })
      .strict(),
    operatorRecord: operatorRecordSchema,
    enrollment: poolEnrollmentDocumentSchema.nullable(),
    safety: z
      .object({
        construction: z.literal("explicit-allowlist"),
        apiKeyIncluded: z.literal(false),
        signerSignatureIncluded: z.literal(false),
        signedTransactionIncluded: z.literal(false),
        environmentDumpIncluded: z.literal(false),
        signerHostHealthIncluded: z.literal(false),
      })
      .strict(),
  })
  .strict();

export type SupportBundle = z.infer<typeof supportBundleSchema>;

export function createSupportBundle(
  config: SidekickConfig,
  preflight: PreflightResult,
  manager: ManagerVerificationReport,
  registration: RegistrationVerification | null,
  setup: PoolSetupStatus,
  operatorRecord: OperatorRecord,
  enrollment: PoolEnrollmentDocument | null,
  applicationVersion = "0.0.0",
): SupportBundle {
  return supportBundleSchema.parse({
    schemaVersion: 2,
    documentType: "signer-sidekick-support-bundle",
    application: {
      version: applicationVersion,
      stacksCoreTag: STACKS_CORE_4_0_0.tag,
      stacksCoreCommit: STACKS_CORE_4_0_0.commit,
      launchStacksCoreTag: STACKS_CORE_4_0_1.tag,
      launchStacksCoreCommit: STACKS_CORE_4_0_1.commit,
    },
    configuration: {
      network: config.network,
      nodeRpcUrl: config.nodeRpcUrl,
      apiUrl: config.apiUrl,
      apiKeyHeader: config.apiKeyHeader,
      apiKeyConfigured: Boolean(config.apiKey),
      maxApiBurnBlockLag: config.maxApiBurnBlockLag,
      forecastHorizonCycles: config.forecastHorizonCycles,
      compatibilityProfilesConfigured: Boolean(config.compatibilityProfilesDirectory),
    },
    diagnostics: {
      preflight: {
        status: preflight.status,
        node: {
          networkId: preflight.node.networkId,
          parentNetworkId: preflight.node.parentNetworkId,
          serverVersion: preflight.node.serverVersion,
          version: preflight.node.version,
          commit: preflight.node.commit,
          burnBlockHeight: preflight.node.burnBlockHeight,
          stacksTipHeight: preflight.node.stacksTipHeight,
        },
        api: preflight.api,
        pox5: {
          available: preflight.pox.pox5Available,
          activationState: preflight.pox.activationState,
          contractId: preflight.pox.pox5ContractId,
          scheduledContractId: preflight.pox.scheduledPox5ContractId,
          sourceSha256: preflight.pox.sourceSha256,
          sbtcTokenContract: preflight.pox.sbtcTokenContract,
          sbtcRegistryContract: preflight.pox.sbtcRegistryContract,
          blocksUntilEpoch4: preflight.pox.blocksUntilEpoch4,
        },
        networkCompatibility: {
          ...preflight.compatibility,
          loadIssues: preflight.compatibility.loadIssues.map((issue) => ({
            ...issue,
            message: [config.compatibilityProfilesDirectory].reduce<string>(
              (message, path) =>
                path ? message.replaceAll(path, "<network-compatibility-configuration>") : message,
              issue.message,
            ),
          })),
        },
        checks: preflight.checks,
      },
      manager: {
        principal: manager.managerPrincipal,
        networkMatches: manager.networkMatches,
        sourceMatch: manager.source.match,
        profileId: manager.source.profileId,
        sourceSha256: manager.source.sha256,
        canonicalSourceSha256: manager.source.canonicalSha256,
        recognitionTier: manager.source.tier,
        profileOrigin: manager.source.origin,
        provenance: manager.provenance,
        installedProfiles: {
          directoryConfigured: manager.installedProfiles.directory !== null,
          loaded: manager.installedProfiles.loaded,
          issues: manager.installedProfiles.issues.map((issue) => ({
            ...issue,
            message: manager.installedProfiles.directory
              ? issue.message.replaceAll(
                  manager.installedProfiles.directory,
                  "<trusted-manager-profile-directory>",
                )
              : issue.message,
          })),
        },
        interfaceCompatible: manager.interface.compatible,
        attachAllowed: manager.attachAllowed,
        automationEligible: manager.automationEligible,
        automationEligibilityReason: manager.automationEligibilityReason,
        reasons: manager.reasons,
      },
      registration: registration
        ? {
            registered: registration.registered,
            signerKeyHex: registration.signerKeyHex,
            signerKeyGrantValid: registration.signerKeyGrantValid,
            reason: registration.reason,
          }
        : null,
      setupStatus: setup.status,
      setupChecks: setup.checks,
    },
    operatorRecord,
    enrollment,
    safety: {
      construction: "explicit-allowlist",
      apiKeyIncluded: false,
      signerSignatureIncluded: false,
      signedTransactionIncluded: false,
      environmentDumpIncluded: false,
      signerHostHealthIncluded: false,
    },
  });
}
