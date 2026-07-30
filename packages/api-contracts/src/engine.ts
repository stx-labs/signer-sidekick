import { z } from "zod";

const instantSchema = z.iso.datetime();
const identifierSchema = z.string().min(1).max(500);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const uuidSchema = z.string().uuid();
const unsignedIntegerTextSchema = z.string().regex(/^(0|[1-9]\d*)$/);
const indexBlockHashSchema = z.string().regex(/^0x[0-9a-f]{64}$/);
const txidSchema = z.string().regex(/^0x[0-9a-f]{64}$/);

export const engineModeSchema = z.enum(["observe", "assist"]);
export type EngineMode = z.infer<typeof engineModeSchema>;

export const engineJobStateSchema = z.enum([
  "prepared",
  "preflighted",
  "awaiting_approval",
  "nonce_reserved",
  "broadcast",
  "confirmed",
  "reconciled",
  "blocked",
  "superseded",
  "ambiguous",
  "noncanonical_reobserve",
]);
export type EngineJobState = z.infer<typeof engineJobStateSchema>;

export const engineChainAnchorSchema = z
  .object({
    stacksBlockHeight: z.number().int().nonnegative(),
    indexBlockHash: indexBlockHashSchema,
    burnBlockHeight: z.number().int().nonnegative(),
    rewardCycle: z.number().int().nonnegative(),
    rewardCycleLength: z.number().int().positive(),
    prepareCycleLength: z.number().int().nonnegative(),
    cyclePosition: z.number().int().nonnegative(),
    phase: z.enum(["reward", "prepare"]),
    checkpoint: z.enum(["first-half", "second-half"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.prepareCycleLength > value.rewardCycleLength) {
      context.addIssue({
        code: "custom",
        message: "prepareCycleLength cannot exceed rewardCycleLength",
        path: ["prepareCycleLength"],
      });
    }
    if (value.cyclePosition >= value.rewardCycleLength) {
      context.addIssue({
        code: "custom",
        message: "cyclePosition must be within rewardCycleLength",
        path: ["cyclePosition"],
      });
    }
    const expectedPhase =
      value.cyclePosition >= value.rewardCycleLength - value.prepareCycleLength
        ? "prepare"
        : "reward";
    if (value.phase !== expectedPhase) {
      context.addIssue({
        code: "custom",
        message: `phase must be ${expectedPhase} at this cycle position`,
        path: ["phase"],
      });
    }
    const expectedCheckpoint =
      value.cyclePosition < Math.floor(value.rewardCycleLength / 2) ? "first-half" : "second-half";
    if (value.checkpoint !== expectedCheckpoint) {
      context.addIssue({
        code: "custom",
        message: `checkpoint must be ${expectedCheckpoint} at this cycle position`,
        path: ["checkpoint"],
      });
    }
  });
export type EngineChainAnchor = z.infer<typeof engineChainAnchorSchema>;

export const engineAdapterIdentitySchema = z
  .object({
    id: identifierSchema,
    revision: z.number().int().positive(),
  })
  .strict();
export type EngineAdapterIdentity = z.infer<typeof engineAdapterIdentitySchema>;

export const engineCallSchema = z
  .object({
    contract: identifierSchema,
    functionName: identifierSchema,
    arguments: z.array(
      z
        .object({
          name: identifierSchema,
          clarityValue: z.string().min(1).max(10_000),
          displayValue: z.string().min(1).max(10_000),
        })
        .strict(),
    ),
  })
  .strict();
export type EngineCall = z.infer<typeof engineCallSchema>;

export const engineCheckpointSchema = z
  .object({
    rewardCycle: z.number().int().nonnegative(),
    calculationCheckpoint: z.enum(["first-half", "second-half"]),
    lastRewardComputeHeight: z.number().int().nonnegative(),
    rewardsPerToken: unsignedIntegerTextSchema,
  })
  .strict();
export type EngineCheckpoint = z.infer<typeof engineCheckpointSchema>;

export const engineExpectedEffectSchema = z
  .object({
    recipient: z
      .object({
        kind: z.enum(["manager", "principal", "contract"]),
        principal: identifierSchema,
      })
      .strict(),
    asset: z
      .object({
        assetId: identifierSchema,
        symbol: z.string().min(1).max(32),
        maximumOutflow: unsignedIntegerTextSchema,
        unit: z.string().min(1).max(32),
      })
      .strict(),
    postconditions: z.array(z.string().min(1).max(10_000)).min(1),
    reconciliationPredicate: z.string().min(1).max(10_000),
  })
  .strict();
export type EngineExpectedEffect = z.infer<typeof engineExpectedEffectSchema>;

export const engineFeeReviewSchema = z
  .object({
    snapshot: z
      .object({
        state: z.enum(["missing", "present"]),
        feeBips: z.number().int().nonnegative().nullable(),
        source: z.string().min(1).max(500),
      })
      .strict(),
    estimatedFeeUstx: unsignedIntegerTextSchema,
    maximumFeeUstx: unsignedIntegerTextSchema,
    policyRevision: z.number().int().positive(),
  })
  .strict();
export type EngineFeeReview = z.infer<typeof engineFeeReviewSchema>;

export const engineIntentHashesSchema = z
  .object({
    intentSha256: sha256Schema,
    policySha256: sha256Schema,
    attestationSha256: sha256Schema,
  })
  .strict();
export type EngineIntentHashes = z.infer<typeof engineIntentHashesSchema>;

export const engineApprovalReviewSchema = z
  .object({
    adapter: engineAdapterIdentitySchema,
    network: z.string().min(1).max(100),
    managerPrincipal: identifierSchema,
    call: engineCallSchema,
    anchor: engineChainAnchorSchema,
    checkpoint: engineCheckpointSchema,
    expectedEffect: engineExpectedEffectSchema,
    fee: engineFeeReviewSchema,
    hashes: engineIntentHashesSchema,
    expectedPostState: z.string().min(1).max(10_000),
  })
  .strict();
export type EngineApprovalReview = z.infer<typeof engineApprovalReviewSchema>;

export const engineApprovalSchema = z
  .object({
    approvalId: uuidSchema,
    jobId: uuidSchema,
    review: engineApprovalReviewSchema,
    approvalSha256: sha256Schema,
    actor: z.string().min(1).max(500),
    createdAt: instantSchema,
    expiresAt: instantSchema,
    invalidatedAt: instantSchema.nullable(),
    invalidationReason: z.string().min(1).max(1_000).nullable(),
    version: z.number().int().nonnegative(),
  })
  .strict();
export type EngineApproval = z.infer<typeof engineApprovalSchema>;

export const engineAttemptSchema = z
  .object({
    attemptNumber: z.number().int().positive(),
    state: z.enum(["signed", "submitted", "ambiguous", "confirmed", "rejected", "reconciled"]),
    nonce: unsignedIntegerTextSchema,
    feeUstx: unsignedIntegerTextSchema,
    txid: txidSchema.nullable(),
    submittedAt: instantSchema.nullable(),
    confirmation: z
      .object({
        stacksBlockHeight: z.number().int().nonnegative(),
        blockHash: indexBlockHashSchema,
        indexBlockHash: indexBlockHashSchema,
        executionStatus: z.enum(["success", "abort_by_response", "abort_by_post_condition"]),
        canonical: z.boolean(),
        finalized: z.boolean(),
        observedAt: instantSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type EngineAttempt = z.infer<typeof engineAttemptSchema>;

export const engineReconciliationSchema = z
  .object({
    predicate: z.string().min(1).max(10_000),
    observedAt: instantSchema,
    anchor: engineChainAnchorSchema,
    outcome: z.enum(["satisfied", "not-satisfied", "external-success", "superseded", "unknown"]),
    canonical: z.boolean(),
    finalized: z.boolean(),
    evidence: z.array(
      z
        .object({
          source: z.enum(["node", "api", "database"]),
          field: z.string().min(1).max(500),
          value: z.string().max(10_000),
        })
        .strict(),
    ),
  })
  .strict();
export type EngineReconciliation = z.infer<typeof engineReconciliationSchema>;

export const engineJobSummarySchema = z
  .object({
    jobId: uuidSchema,
    mode: engineModeSchema,
    state: engineJobStateSchema,
    blockReason: z.string().min(1).max(1_000).nullable(),
    adapter: engineAdapterIdentitySchema,
    network: z.string().min(1).max(100),
    managerPrincipal: identifierSchema,
    contract: identifierSchema,
    functionName: identifierSchema,
    rewardCycle: z.number().int().nonnegative(),
    approvalState: z.enum(["not-required", "awaiting", "approved", "expired", "invalidated"]),
    updatedAt: instantSchema,
  })
  .strict();
export type EngineJobSummary = z.infer<typeof engineJobSummarySchema>;

export const engineJobDetailSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: uuidSchema,
    mode: engineModeSchema,
    state: engineJobStateSchema,
    stateVersion: z.number().int().nonnegative(),
    blockReason: z.string().min(1).max(1_000).nullable(),
    supersededByJobId: uuidSchema.nullable(),
    review: engineApprovalReviewSchema,
    approvalWindow: z
      .object({
        eligible: z.boolean(),
        expiresAt: instantSchema.nullable(),
        reason: z.string().min(1).max(1_000).nullable(),
      })
      .strict(),
    approval: engineApprovalSchema.nullable(),
    nonce: z
      .object({
        value: unsignedIntegerTextSchema,
        state: z.enum(["reserved", "ambiguous", "resolved"]),
        foreignActivity: z.boolean(),
      })
      .strict()
      .nullable(),
    attempts: z.array(engineAttemptSchema),
    reconciliation: engineReconciliationSchema.nullable(),
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .strict();
export type EngineJobDetail = z.infer<typeof engineJobDetailSchema>;

export const engineJobPageSchema = z
  .object({
    schemaVersion: z.literal(1),
    items: z.array(engineJobSummarySchema),
    nextCursor: z.string().min(1).max(2_000).nullable(),
    total: z.number().int().nonnegative(),
  })
  .strict();
export type EngineJobPage = z.infer<typeof engineJobPageSchema>;

export const engineAdapterStatusSchema = z
  .object({
    adapter: engineAdapterIdentitySchema,
    label: z.string().min(1).max(500),
    mode: engineModeSchema,
    enabled: z.boolean(),
    availability: z.enum(["available", "blocked", "disabled"]),
    blockReason: z.string().min(1).max(1_000).nullable(),
  })
  .strict();
export type EngineAdapterStatus = z.infer<typeof engineAdapterStatusSchema>;

export const engineStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: engineModeSchema,
    forcedObserve: z
      .object({
        active: z.boolean(),
        reason: z.string().min(1).max(1_000).nullable(),
        actor: z.string().min(1).max(500).nullable(),
        forcedAt: instantSchema.nullable(),
      })
      .strict(),
    adapters: z.array(engineAdapterStatusSchema),
    jobs: z
      .object({
        active: z.number().int().nonnegative(),
        awaitingApproval: z.number().int().nonnegative(),
        ambiguous: z.number().int().nonnegative(),
      })
      .strict(),
    generatedAt: instantSchema,
  })
  .strict();
export type EngineStatus = z.infer<typeof engineStatusSchema>;

export const operationReadinessCheckSchema = z
  .object({
    id: z.enum(["control-plane", "setup", "engine"]),
    status: z.enum(["ready", "attention", "blocked"]),
    detail: z.string().min(1).max(1_000),
  })
  .strict();
export type OperationReadinessCheck = z.infer<typeof operationReadinessCheckSchema>;

export const operationReadinessSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["ready", "attention", "blocked"]),
    generatedAt: instantSchema,
    checks: z.array(operationReadinessCheckSchema).length(3),
  })
  .strict();
export type OperationReadiness = z.infer<typeof operationReadinessSchema>;

export const engineApprovalRequestSchema = z
  .object({
    decision: z.literal("approve"),
    intentSha256: sha256Schema,
    policySha256: sha256Schema,
    expiresAt: instantSchema,
  })
  .strict();
export type EngineApprovalRequest = z.infer<typeof engineApprovalRequestSchema>;

export const engineApprovalResponseSchema = z
  .object({
    approval: engineApprovalSchema,
    job: engineJobDetailSchema,
    created: z.boolean(),
  })
  .strict();
export type EngineApprovalResponse = z.infer<typeof engineApprovalResponseSchema>;

export const engineInvalidateApprovalRequestSchema = z
  .object({
    decision: z.literal("invalidate"),
    reason: z.string().min(1).max(1_000),
  })
  .strict();
export type EngineInvalidateApprovalRequest = z.infer<typeof engineInvalidateApprovalRequestSchema>;

export const engineInvalidateApprovalResponseSchema = z
  .object({
    approval: engineApprovalSchema,
    job: engineJobDetailSchema,
  })
  .strict();
export type EngineInvalidateApprovalResponse = z.infer<
  typeof engineInvalidateApprovalResponseSchema
>;

export const engineForceObserveRequestSchema = z
  .object({
    decision: z.literal("force-observe"),
    reason: z.string().min(1).max(1_000),
  })
  .strict();
export type EngineForceObserveRequest = z.infer<typeof engineForceObserveRequestSchema>;

export const engineForceObserveResponseSchema = z.object({ status: engineStatusSchema }).strict();
export type EngineForceObserveResponse = z.infer<typeof engineForceObserveResponseSchema>;

export const engineDisableAdapterRequestSchema = z
  .object({
    decision: z.literal("disable"),
    reason: z.string().min(1).max(1_000),
  })
  .strict();
export type EngineDisableAdapterRequest = z.infer<typeof engineDisableAdapterRequestSchema>;

export const engineDisableAdapterResponseSchema = z
  .object({
    adapter: engineAdapterStatusSchema,
    status: engineStatusSchema,
  })
  .strict();
export type EngineDisableAdapterResponse = z.infer<typeof engineDisableAdapterResponseSchema>;
