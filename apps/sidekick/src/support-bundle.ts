import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  connectionAssessmentSchema,
  dashboardSnapshotSchema,
  deploymentRequirementsSchema,
  engineJobPageSchema,
  engineStatusSchema,
  healthSnapshotSchema,
  reconciliationOperationSchema,
  runtimeSettingsSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { STACKS_CORE_4_0_0, STACKS_CORE_4_0_1 } from "@stx-labs/signer-sidekick-protocol";
import { z } from "zod";

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
const connectionSectionSchema = supportSectionBaseSchema
  .extend({ data: connectionAssessmentSchema.nullable() })
  .strict();
const deploymentRequirementsSectionSchema = supportSectionBaseSchema
  .extend({ data: deploymentRequirementsSchema.nullable() })
  .strict();
const runtimeSettingsSectionSchema = supportSectionBaseSchema
  .extend({ data: runtimeSettingsSchema.nullable() })
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

const observerReconciliationDomainSchema = z
  .object({
    pending: z.boolean(),
    running: z.boolean(),
    requests: z.number().int().nonnegative(),
    coalescedRequests: z.number().int().nonnegative(),
    successes: z.number().int().nonnegative(),
    failuresTotal: z.number().int().nonnegative(),
    consecutiveFailures: z.number().int().nonnegative(),
    requestedStacksHeight: z.number().int().nonnegative().nullable(),
    requestedBurnHeight: z.number().int().nonnegative().nullable(),
    lastRequestedAt: z.iso.datetime().nullable(),
    lastStartedAt: z.iso.datetime().nullable(),
    lastSuccessAt: z.iso.datetime().nullable(),
    lastFailureAt: z.iso.datetime().nullable(),
    lastError: z.string().max(500).nullable(),
    nextRetryAt: z.iso.datetime().nullable(),
    callbackLatency: z
      .object({
        samples: z.number().int().nonnegative(),
        sumSeconds: z.number().nonnegative(),
        maxSeconds: z.number().nonnegative(),
        lastSeconds: z.number().nonnegative().nullable(),
        withinTwoSeconds: z.number().int().nonnegative(),
        buckets: z
          .object({
            le1: z.number().int().nonnegative(),
            le2: z.number().int().nonnegative(),
            le5: z.number().int().nonnegative(),
            le10: z.number().int().nonnegative(),
            le30: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

const observerRuntimeStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    enabled: z.boolean(),
    listening: z.boolean(),
    listener: z
      .object({
        host: z.string().min(1),
        port: z.number().int().min(1).max(65_535),
        maxBodyBytes: z
          .number()
          .int()
          .min(1_024)
          .max(16 * 1_024 * 1_024),
      })
      .strict()
      .nullable(),
    inbox: z
      .object({
        schemaVersion: z.literal(1),
        uniqueDeliveries: z.number().int().nonnegative(),
        deliveryAttempts: z.number().int().nonnegative(),
        processingAttempts: z.number().int().nonnegative(),
        duplicates: z.number().int().nonnegative(),
        queueDepth: z.number().int().nonnegative(),
        processing: z.number().int().nonnegative(),
        nodeVerified: z.number().int().nonnegative(),
        quarantined: z.number().int().nonnegative(),
        expired: z.number().int().nonnegative(),
        retainedPayloadBytes: z.number().int().nonnegative(),
        prunedPayloads: z.number().int().nonnegative(),
        lastReceivedAt: z.iso.datetime().nullable(),
        lastProcessedAt: z.iso.datetime().nullable(),
        oldestPendingAt: z.iso.datetime().nullable(),
        lastClaimedStacksBlock: z
          .object({
            height: z.number().int().nonnegative(),
            blockHash: z.string().regex(/^0x[0-9a-f]{64}$/),
            indexBlockHash: z.string().regex(/^0x[0-9a-f]{64}$/),
          })
          .strict()
          .nullable(),
        lastVerifiedStacksBlock: z
          .object({
            height: z.number().int().nonnegative(),
            indexBlockHash: z.string().regex(/^0x[0-9a-f]{64}$/),
            receivedAt: z.iso.datetime(),
            verifiedAt: z.iso.datetime(),
          })
          .strict()
          .nullable(),
        lastClaimedBurnBlock: z
          .object({
            height: z.number().int().nonnegative(),
            blockHash: z.string().regex(/^0x[0-9a-f]{64}$/),
          })
          .strict()
          .nullable(),
        lastQuarantine: z
          .object({
            endpointKind: z.enum(["new-block", "new-burn-block", "attachments"]),
            reason: z.string().min(1).max(500),
            receivedAt: z.iso.datetime(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    reconciliation: z
      .object({
        schemaVersion: z.literal(1),
        started: z.boolean(),
        domains: z
          .object({
            current: observerReconciliationDomainSchema,
            "manager-activity": observerReconciliationDomainSchema,
            rewards: observerReconciliationDomainSchema.optional(),
            roster: observerReconciliationDomainSchema,
          })
          .strict(),
      })
      .strict()
      .nullable(),
    gap: z
      .object({
        schemaVersion: z.literal(1),
        started: z.boolean(),
        status: z.enum(["not-started", "unknown", "healthy", "degraded"]),
        reason: z.enum([
          "not-started",
          "awaiting-first-node-sample",
          "node-check-failed",
          "awaiting-next-node-advance",
          "observer-catch-up-window",
          "observer-current",
          "observer-behind-node",
        ]),
        intervalSeconds: z.number().positive(),
        checksTotal: z.number().int().nonnegative(),
        failuresTotal: z.number().int().nonnegative(),
        consecutiveFailures: z.number().int().nonnegative(),
        startedAt: z.iso.datetime().nullable(),
        checkedAt: z.iso.datetime().nullable(),
        baselineStacksHeight: z.number().int().nonnegative().nullable(),
        nodeStacksHeight: z.number().int().nonnegative().nullable(),
        observerStacksHeight: z.number().int().nonnegative().nullable(),
        stacksGap: z.number().int().nonnegative().nullable(),
        observerSilenceSeconds: z.number().nonnegative().nullable(),
        lastError: z.string().max(500).nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.enabled !== (value.listener !== null)) {
      context.addIssue({
        code: "custom",
        message: "Enabled observer status must include listener configuration",
        path: ["listener"],
      });
    }
    if (value.listening && !value.enabled) {
      context.addIssue({
        code: "custom",
        message: "A disabled observer listener cannot be listening",
        path: ["listening"],
      });
    }
  });
const observerSectionSchema = supportSectionBaseSchema
  .extend({ data: observerRuntimeStatusSchema.nullable() })
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

const supportHandoffSchema = z
  .object({
    correlation: z
      .object({
        startedAt: z.iso.datetime(),
        endedAt: z.iso.datetime(),
        activeHealthEpisodeIds: z.array(z.string().uuid()).max(50),
      })
      .strict(),
    companionArtifact: z
      .object({
        kind: z.literal("stacksup-or-operator-infrastructure-support-bundle"),
        required: z.literal(false),
        purpose: z.string().min(1).max(1_000),
        requestedEvidence: z.array(
          z.enum([
            "host-resource-saturation",
            "process-or-container-lifecycle",
            "service-logs",
            "disk-and-filesystem-health",
            "host-network-connectivity",
          ]),
        ),
        excludedFromSidekick: z.array(
          z.enum(["host-control", "unrestricted-logs", "private-key-material"]),
        ),
      })
      .strict(),
  })
  .strict();

export const operatorSupportBundleSchema = z
  .object({
    schemaVersion: z.literal(2),
    documentType: z.literal("signer-sidekick-operator-support-bundle"),
    bundleId: z.string().uuid(),
    generatedAt: z.iso.datetime(),
    collectionStatus: z.enum(["complete", "partial", "failed"]),
    application: operatorSupportApplicationSchema,
    handoff: supportHandoffSchema,
    sections: z
      .object({
        connection: connectionSectionSchema,
        deploymentRequirements: deploymentRequirementsSectionSchema.optional(),
        runtimeSettings: runtimeSettingsSectionSchema,
        operator: operatorSectionSchema,
        nodeAndSignerHealth: healthSectionSchema,
        transactionEngine: engineSectionSchema,
        recentOperations: recentOperationsSectionSchema,
        recentSidekickErrors: recentSidekickErrorsSectionSchema,
        database: databaseSectionSchema,
        observer: observerSectionSchema,
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
  connection?: () => Promise<unknown> | unknown;
  deploymentRequirements?: () => Promise<unknown> | unknown;
  runtimeSettings?: () => Promise<unknown> | unknown;
  operator?: () => Promise<unknown>;
  health?: () => Promise<unknown>;
  engine?: () => Promise<unknown> | unknown;
  recentOperations?: () => Promise<unknown>;
  recentSidekickErrors?: () => Promise<unknown> | unknown;
  database?: () => Promise<unknown> | unknown;
  observer?: () => Promise<unknown> | unknown;
  automation?: () => Promise<unknown> | unknown;
  now?: () => Date;
  timeoutMs?: number;
  bundleId?: string;
}): Promise<OperatorSupportBundle> {
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deploymentRequirementsPromise = options.deploymentRequirements
    ? collectSupportSection(
        options.deploymentRequirements,
        deploymentRequirementsSchema,
        now,
        timeoutMs,
      )
    : Promise.resolve(null);
  const [
    connection,
    runtimeSettings,
    operator,
    nodeAndSignerHealth,
    transactionEngine,
    recentOperations,
    recentSidekickErrors,
    database,
    observer,
    automation,
    deploymentRequirements,
  ] = await Promise.all([
    collectSupportSection(options.connection, connectionAssessmentSchema, now, timeoutMs),
    collectSupportSection(options.runtimeSettings, runtimeSettingsSchema, now, timeoutMs),
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
    collectSupportSection(options.observer, observerRuntimeStatusSchema, now, timeoutMs),
    collectSupportSection(options.automation, automationStatusSchema, now, timeoutMs),
    deploymentRequirementsPromise,
  ]);
  const sections = {
    connection,
    ...(deploymentRequirements ? { deploymentRequirements } : {}),
    runtimeSettings,
    operator,
    nodeAndSignerHealth,
    transactionEngine,
    recentOperations,
    recentSidekickErrors,
    database,
    observer,
    automation,
  };
  const statuses = Object.values(sections).map(({ status }) => status);
  const collectionStatus = statuses.every((status) => status === "ok")
    ? "complete"
    : statuses.every((status) => status !== "ok")
      ? "failed"
      : "partial";
  const generatedAt = now().toISOString();
  const healthData = healthSnapshotSchema.safeParse(nodeAndSignerHealth.data);
  const activeEpisodes = healthData.success
    ? healthData.data.history.recentEpisodes.filter(({ status }) => status === "active")
    : [];
  const correlationStart = activeEpisodes
    .map(({ firstObservedAt }) => firstObservedAt)
    .sort()
    .at(0);
  const bundle = {
    schemaVersion: 2,
    documentType: "signer-sidekick-operator-support-bundle",
    bundleId: options.bundleId ?? randomUUID(),
    generatedAt,
    collectionStatus,
    application: options.application,
    handoff: {
      correlation: {
        startedAt:
          correlationStart ?? new Date(Date.parse(generatedAt) - 60 * 60 * 1_000).toISOString(),
        endedAt: generatedAt,
        activeHealthEpisodeIds: activeEpisodes.map(({ episodeId }) => episodeId),
      },
      companionArtifact: {
        kind: "stacksup-or-operator-infrastructure-support-bundle",
        required: false,
        purpose:
          "Correlate Sidekick's protocol and signer evidence with infrastructure conditions from the same time window when escalation needs host-level context.",
        requestedEvidence: [
          "host-resource-saturation",
          "process-or-container-lifecycle",
          "service-logs",
          "disk-and-filesystem-health",
          "host-network-connectivity",
        ],
        excludedFromSidekick: ["host-control", "unrestricted-logs", "private-key-material"],
      },
    },
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
