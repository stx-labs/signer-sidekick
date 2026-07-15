import { STACKS_CORE_4_0_0 } from "@stx-labs/signer-sidekick-protocol";
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
    schemaVersion: z.literal(1),
    documentType: z.literal("signer-sidekick-support-bundle"),
    application: z
      .object({
        version: z.string(),
        stacksCoreTag: z.string(),
        stacksCoreCommit: z.string().regex(/^[0-9a-f]{40}$/),
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
                contractId: z.string().nullable(),
                blocksUntilEpoch4: z.number().int().nonnegative().nullable(),
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
            interfaceCompatible: z.boolean(),
            attachAllowed: z.boolean(),
            automationEligible: z.boolean(),
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
    schemaVersion: 1,
    documentType: "signer-sidekick-support-bundle",
    application: {
      version: applicationVersion,
      stacksCoreTag: STACKS_CORE_4_0_0.tag,
      stacksCoreCommit: STACKS_CORE_4_0_0.commit,
    },
    configuration: {
      network: config.network,
      nodeRpcUrl: config.nodeRpcUrl,
      apiUrl: config.apiUrl,
      apiKeyHeader: config.apiKeyHeader,
      apiKeyConfigured: Boolean(config.apiKey),
      maxApiBurnBlockLag: config.maxApiBurnBlockLag,
    },
    diagnostics: {
      preflight: {
        status: preflight.status,
        node: preflight.node,
        api: preflight.api,
        pox5: {
          available: preflight.pox.pox5Available,
          contractId: preflight.pox.pox5ContractId,
          blocksUntilEpoch4: preflight.pox.blocksUntilEpoch4,
        },
        checks: preflight.checks,
      },
      manager: {
        principal: manager.managerPrincipal,
        networkMatches: manager.networkMatches,
        sourceMatch: manager.source.match,
        profileId: manager.source.profileId,
        sourceSha256: manager.source.sha256,
        interfaceCompatible: manager.interface.compatible,
        attachAllowed: manager.attachAllowed,
        automationEligible: manager.automationEligible,
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
