import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  dashboardSnapshotSchema,
  engineJobPageSchema,
  engineStatusSchema,
  healthSnapshotSchema,
  reconciliationOperationSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
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

const supportCollectionErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
  })
  .strict();

const supportSectionBaseSchema = z
  .object({
    status: z.enum(["ok", "failed", "unavailable"]),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
    durationMs: z.number().int().nonnegative(),
    error: supportCollectionErrorSchema.nullable(),
  })
  .strict();

const operatorSectionSchema = supportSectionBaseSchema
  .extend({ data: dashboardSnapshotSchema.nullable() })
  .strict();
const healthSectionSchema = supportSectionBaseSchema
  .extend({ data: healthSnapshotSchema.nullable() })
  .strict();
const engineSectionSchema = supportSectionBaseSchema
  .extend({ data: engineStatusSchema.nullable() })
  .strict();
const recentOperationsSectionSchema = supportSectionBaseSchema
  .extend({ data: engineJobPageSchema.nullable() })
  .strict();

const sidekickDiagnosticEventSchema = z
  .object({
    recordedAt: z.iso.datetime(),
    severity: z.enum(["warning", "error"]),
    source: z.enum(["operator-api", "reconciliation"]),
    code: z.string(),
    message: z.string(),
    requestId: z.string().nullable(),
  })
  .strict();
const recentSidekickErrorsSectionSchema = supportSectionBaseSchema
  .extend({ data: z.array(sidekickDiagnosticEventSchema).max(50).nullable() })
  .strict();

const databaseStatusSchema = z
  .object({
    schemaVersion: z.number().int().nonnegative(),
    journalMode: z.string(),
    synchronous: z.number().int().min(0).max(3),
    foreignKeys: z.boolean(),
  })
  .strict();
const databaseSectionSchema = supportSectionBaseSchema
  .extend({ data: databaseStatusSchema.nullable() })
  .strict();

const snapshotRefreshMetricsSchema = z
  .object({
    attemptsTotal: z.number().int().nonnegative(),
    successesTotal: z.number().int().nonnegative(),
    failuresTotal: z.number().int().nonnegative(),
    consecutiveFailures: z.number().int().nonnegative(),
    retryBackoffSeconds: z.number().nonnegative(),
    lastSuccessTimestampSeconds: z.number().nonnegative(),
    snapshotGeneratedTimestampSeconds: z.number().nonnegative(),
    snapshotAgeSeconds: z.number().nonnegative(),
    snapshotFresh: z.union([z.literal(0), z.literal(1)]),
    sourcePositions: z
      .object({
        nodeStacksHeight: z.number().int().nonnegative(),
        apiStacksHeight: z.number().int().nonnegative(),
        nodeBurnHeight: z.number().int().nonnegative(),
        apiBurnHeight: z.number().int().nonnegative(),
        poxBurnHeight: z.number().int().nonnegative(),
        poxRewardCycle: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict();

const rosterRefreshMetricsSchema = z
  .object({
    attemptsTotal: z.number().int().nonnegative(),
    successesTotal: z.number().int().nonnegative(),
    skipsTotal: z.number().int().nonnegative(),
    failuresTotal: z.number().int().nonnegative(),
    consecutiveFailures: z.number().int().nonnegative(),
    retryBackoffSeconds: z.number().nonnegative(),
    lastSuccessTimestampSeconds: z.number().nonnegative(),
    nextAttemptTimestampSeconds: z.number().nonnegative(),
  })
  .strict();

const automationStatusSchema = z
  .object({
    processRequests: z
      .object({
        total: z.number().int().nonnegative(),
        syncRequests: z.number().int().nonnegative(),
        syncRuns: z.number().int().nonnegative(),
        syncFailures: z.number().int().nonnegative(),
      })
      .strict(),
    operatorSnapshotRefresh: snapshotRefreshMetricsSchema,
    rosterReconciliation: rosterRefreshMetricsSchema,
    currentReconciliation: reconciliationOperationSchema,
  })
  .strict();
const automationSectionSchema = supportSectionBaseSchema
  .extend({ data: automationStatusSchema.nullable() })
  .strict();

const operatorSupportApplicationSchema = z
  .object({
    version: z.string(),
    buildCommit: z.union([z.string().regex(/^[0-9a-f]{7,40}$/), z.literal("unknown")]),
    sourceFingerprintSha256: z.union([z.string().regex(/^[0-9a-f]{64}$/), z.literal("unknown")]),
    stacksCoreCompatibility: z
      .object({
        baselineTag: z.string(),
        baselineCommit: z.string().regex(/^[0-9a-f]{40}$/),
        launchTag: z.string(),
        launchCommit: z.string().regex(/^[0-9a-f]{40}$/),
      })
      .strict(),
    runtime: z
      .object({
        nodeVersion: z.string(),
        platform: z.string(),
        architecture: z.string(),
        startedAt: z.iso.datetime(),
        uptimeSeconds: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const operatorSupportBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    documentType: z.literal("signer-sidekick-operator-support-bundle"),
    bundleId: z.string().uuid(),
    generatedAt: z.iso.datetime(),
    collectionStatus: z.enum(["complete", "partial", "failed"]),
    application: operatorSupportApplicationSchema,
    sections: z
      .object({
        operator: operatorSectionSchema,
        nodeAndSignerHealth: healthSectionSchema,
        transactionEngine: engineSectionSchema,
        recentOperations: recentOperationsSectionSchema,
        recentSidekickErrors: recentSidekickErrorsSectionSchema,
        database: databaseSectionSchema,
        automation: automationSectionSchema,
      })
      .strict(),
    safety: z
      .object({
        construction: z.literal("reviewed-sources-with-explicit-secret-denylist"),
        identifyingOperationalMetadataIncluded: z.literal(true),
        internalEndpointsAndPathsIncluded: z.literal(true),
        apiKeyValueIncluded: z.literal(false),
        operatorCredentialIncluded: z.literal(false),
        privateKeyMaterialIncluded: z.literal(false),
        signerSignatureIncluded: z.literal(false),
        signedTransactionIncluded: z.literal(false),
        environmentDumpIncluded: z.literal(false),
        rawLogsIncluded: z.literal(false),
      })
      .strict(),
  })
  .strict();

export type OperatorSupportBundle = z.infer<typeof operatorSupportBundleSchema>;
export type OperatorSupportApplication = z.infer<typeof operatorSupportApplicationSchema>;
export type OperatorSupportAutomationStatus = z.infer<typeof automationStatusSchema>;

const forbiddenSupportKeys = new Set([
  "apikey",
  "apikeysecret",
  "authtoken",
  "authorization",
  "bearertoken",
  "cookie",
  "credential",
  "credentials",
  "mnemonic",
  "password",
  "privatekey",
  "privatekeyhex",
  "secret",
  "seed",
  "seedphrase",
  "signersignature",
  "signersignaturehex",
  "signedtransaction",
  "signedtransactionhex",
  "token",
]);

function normalizedSupportKey(value: string): string {
  return value.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
}

function assertNoForbiddenSupportKeys(value: unknown, path = "bundle"): void {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      assertNoForbiddenSupportKeys(entry, `${path}[${index}]`);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (forbiddenSupportKeys.has(normalizedSupportKey(key))) {
      throw new Error(`Support bundle rejected forbidden field ${path}.${key}`);
    }
    assertNoForbiddenSupportKeys(entry, `${path}.${key}`);
  }
}

function safeSupportError(error: unknown): { code: string; message: string } {
  const candidate = error instanceof Error ? error : new Error(String(error));
  const candidateCode =
    typeof (candidate as Error & { code?: unknown }).code === "string"
      ? String((candidate as Error & { code: string }).code)
      : candidate.name || "Error";
  const errorCode = /^[A-Za-z0-9._-]{1,200}$/.test(candidateCode)
    ? candidateCode
    : candidate.name || "Error";
  const message = candidate.message
    .replaceAll(/\bBearer\s+[^\s,;]+/gi, "Bearer <redacted>")
    .replaceAll(/\b(api[-_ ]?key|password|secret|token)\b\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>")
    .replaceAll(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1<redacted>@")
    .slice(0, 2_000);
  return { code: errorCode.slice(0, 200), message };
}

async function collectSupportSection(
  collector: (() => Promise<unknown> | unknown) | undefined,
  schema: z.ZodType,
  now: () => Date,
  timeoutMs: number,
): Promise<{
  status: "ok" | "failed" | "unavailable";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  error: { code: string; message: string } | null;
  data: unknown | null;
}> {
  const startedAt = now();
  if (!collector) {
    const completedAt = now();
    return {
      status: "unavailable",
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      error: { code: "not-configured", message: "This diagnostic source is not configured" },
      data: null,
    };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Diagnostic collection exceeded ${timeoutMs} ms`)),
        timeoutMs,
      );
      timer.unref?.();
    });
    const data = schema.parse(await Promise.race([Promise.resolve().then(collector), timeout]));
    assertNoForbiddenSupportKeys(data);
    const completedAt = now();
    return {
      status: "ok",
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      error: null,
      data,
    };
  } catch (error) {
    const completedAt = now();
    return {
      status: "failed",
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      error: safeSupportError(error),
      data: null,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function operatorSupportApplication(
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
  uptimeSeconds = process.uptime(),
): OperatorSupportApplication {
  const configuredCommit = env.SIDEKICK_BUILD_COMMIT?.trim().toLowerCase();
  let sourceFingerprintSha256 = "unknown";
  if (env.SIDEKICK_SOURCE_FINGERPRINT_PATH?.trim()) {
    try {
      const candidate = readFileSync(env.SIDEKICK_SOURCE_FINGERPRINT_PATH.trim(), "utf8")
        .trim()
        .toLowerCase();
      if (/^[0-9a-f]{64}$/.test(candidate)) sourceFingerprintSha256 = candidate;
    } catch {
      // A missing build fingerprint is represented explicitly rather than blocking diagnostics.
    }
  }
  return operatorSupportApplicationSchema.parse({
    version: env.SIDEKICK_BUILD_VERSION?.trim() || env.npm_package_version?.trim() || "dev",
    buildCommit: configuredCommit?.match(/^[0-9a-f]{7,40}$/) ? configuredCommit : "unknown",
    sourceFingerprintSha256,
    stacksCoreCompatibility: {
      baselineTag: STACKS_CORE_4_0_0.tag,
      baselineCommit: STACKS_CORE_4_0_0.commit,
      launchTag: STACKS_CORE_4_0_1.tag,
      launchCommit: STACKS_CORE_4_0_1.commit,
    },
    runtime: {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      startedAt: new Date(now.getTime() - uptimeSeconds * 1_000).toISOString(),
      uptimeSeconds: Math.max(0, Math.floor(uptimeSeconds)),
    },
  });
}

export async function createOperatorSupportBundle(options: {
  application: OperatorSupportApplication;
  operator(): Promise<unknown>;
  health?: () => Promise<unknown>;
  engine?: () => Promise<unknown> | unknown;
  recentOperations?: () => Promise<unknown>;
  recentSidekickErrors?: () => Promise<unknown> | unknown;
  database?: () => Promise<unknown> | unknown;
  automation?: () => Promise<unknown> | unknown;
  now?: () => Date;
  timeoutMs?: number;
  bundleId?: string;
}): Promise<OperatorSupportBundle> {
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 30_000;
  const [
    operator,
    nodeAndSignerHealth,
    transactionEngine,
    recentOperations,
    recentSidekickErrors,
    database,
    automation,
  ] = await Promise.all([
    collectSupportSection(options.operator, dashboardSnapshotSchema, now, timeoutMs),
    collectSupportSection(options.health, healthSnapshotSchema, now, timeoutMs),
    collectSupportSection(options.engine, engineStatusSchema, now, timeoutMs),
    collectSupportSection(options.recentOperations, engineJobPageSchema, now, timeoutMs),
    collectSupportSection(
      options.recentSidekickErrors,
      z.array(sidekickDiagnosticEventSchema).max(50),
      now,
      timeoutMs,
    ),
    collectSupportSection(options.database, databaseStatusSchema, now, timeoutMs),
    collectSupportSection(options.automation, automationStatusSchema, now, timeoutMs),
  ]);
  const sections = {
    operator,
    nodeAndSignerHealth,
    transactionEngine,
    recentOperations,
    recentSidekickErrors,
    database,
    automation,
  };
  const statuses = Object.values(sections).map(({ status }) => status);
  const collectionStatus = statuses.every((status) => status === "ok")
    ? "complete"
    : statuses.every((status) => status !== "ok")
      ? "failed"
      : "partial";
  const bundle = {
    schemaVersion: 1,
    documentType: "signer-sidekick-operator-support-bundle",
    bundleId: options.bundleId ?? randomUUID(),
    generatedAt: now().toISOString(),
    collectionStatus,
    application: options.application,
    sections,
    safety: {
      construction: "reviewed-sources-with-explicit-secret-denylist",
      identifyingOperationalMetadataIncluded: true,
      internalEndpointsAndPathsIncluded: true,
      apiKeyValueIncluded: false,
      operatorCredentialIncluded: false,
      privateKeyMaterialIncluded: false,
      signerSignatureIncluded: false,
      signedTransactionIncluded: false,
      environmentDumpIncluded: false,
      rawLogsIncluded: false,
    },
  } as const;
  assertNoForbiddenSupportKeys(bundle);
  return operatorSupportBundleSchema.parse(bundle);
}

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
