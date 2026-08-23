import { z } from "zod";

export const rewardRunStatusSchema = z.enum([
  "awaiting-approval",
  "approved",
  "running",
  "paused",
  "completed",
  "halted",
  "cancelled",
  "expired",
]);
export type RewardRunStatus = z.infer<typeof rewardRunStatusSchema>;

export const rewardRunOperationSchema = z.enum([
  "calculate-rewards",
  "claim-rewards",
  "claim-staker-rewards",
  "settle-accepted-withdrawal",
  "reclaim-failed-withdrawal",
]);
export type RewardRunOperation = z.infer<typeof rewardRunOperationSchema>;

export const rewardRunPrepareRequestSchema = z
  .object({
    /** Client-generated retry key. Reusing it returns the original run or conflicts on a new body. */
    requestId: z.string().uuid().optional(),
    cycle: z.number().int().nonnegative(),
    distribution: z.union([z.literal(1), z.literal(2)]),
    operations: z.array(rewardRunOperationSchema).min(1).max(5).optional(),
    maxTransactions: z.number().int().min(1).max(200).optional(),
  })
  .strict();
export type RewardRunPrepareRequest = z.infer<typeof rewardRunPrepareRequestSchema>;

export const rewardRunApproveRequestSchema = z
  .object({ recipeSha256: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();
export type RewardRunApproveRequest = z.infer<typeof rewardRunApproveRequestSchema>;

export const rewardRunAccountBoundSchema = z
  .object({
    accountKey: z.string().min(1),
    stakerPrincipal: z.string().min(1),
    rewardCycle: z.number().int().nonnegative(),
    bondIndex: z.string().regex(/^\d+$/).nullable(),
    maximumGrossSats: z.string().regex(/^\d+$/),
    payoutRoute: z.enum(["direct-sbtc", "bitcoin-l1"]),
  })
  .strict();
export type RewardRunAccountBound = z.infer<typeof rewardRunAccountBoundSchema>;

export const rewardRunRecipeChildSchema = z
  .object({
    index: z.number().int().nonnegative(),
    operation: rewardRunOperationSchema,
    adapterId: z.string().min(1),
    adapterRevision: z.number().int().positive(),
    accountKey: z.string().nullable(),
    requestId: z.string().regex(/^\d+$/).nullable(),
    stakerPrincipal: z.string().nullable(),
    maximumAmountSats: z.string().regex(/^\d+$/).nullable(),
    withdrawalAmountSats: z.string().regex(/^\d+$/).nullable(),
    maxFeeSats: z.string().regex(/^\d+$/).nullable(),
  })
  .strict();
export type RewardRunRecipeChild = z.infer<typeof rewardRunRecipeChildSchema>;

export const rewardRunRecipeSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().uuid(),
    prepareRequestSha256: z.string().regex(/^[0-9a-f]{64}$/),
    walletPrincipal: z.string().min(1),
    managerPrincipal: z.string().min(1),
    pox5Contract: z.string().min(1),
    sbtcTokenContract: z.string().min(1),
    sbtcRegistryContract: z.string().min(1),
    network: z.enum(["mainnet", "testnet"]),
    chainId: z.number().int().nonnegative(),
    cycle: z.number().int().nonnegative(),
    distribution: z.union([z.literal(1), z.literal(2)]),
    orderedOperations: z.array(rewardRunOperationSchema).min(1).max(5),
    accounts: z.array(rewardRunAccountBoundSchema).max(200),
    reviewedTotalSats: z.string().regex(/^\d+$/),
    reviewedPaymentCount: z.number().int().nonnegative().max(200),
    maxTransactions: z.number().int().min(1).max(200),
    eligibleTransactions: z.number().int().positive(),
    truncated: z.boolean(),
    remainingTransactions: z.number().int().nonnegative(),
    feeCapUstx: z.string().regex(/^\d+$/),
    gasBudgetUstx: z.string().regex(/^\d+$/),
    managerSourceFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    pox5SourceFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    adapterRevisions: z.record(z.string(), z.number().int().positive()),
    children: z.array(rewardRunRecipeChildSchema).min(1).max(200),
    preparedAnchor: z
      .object({
        stacksBlockHeight: z.number().int().nonnegative(),
        burnBlockHeight: z.number().int().nonnegative(),
        indexBlockHash: z.string().regex(/^0x[0-9a-f]{64}$/),
      })
      .strict(),
  })
  .strict();
export type RewardRunRecipe = z.infer<typeof rewardRunRecipeSchema>;

export const rewardRunChildStatusSchema = z.enum([
  "pending",
  "materialized",
  "broadcast",
  "confirmed",
  "externally-completed",
  "skipped",
  "halted",
]);
export type RewardRunChildStatus = z.infer<typeof rewardRunChildStatusSchema>;

export const rewardRunChildSchema = z
  .object({
    index: z.number().int().nonnegative(),
    operation: rewardRunOperationSchema,
    accountKey: z.string().nullable(),
    status: rewardRunChildStatusSchema,
    maximumAmountSats: z.string().regex(/^\d+$/).nullable(),
    materializedAmountSats: z.string().regex(/^\d+$/).nullable(),
    planSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    txid: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/)
      .nullable(),
    provenance: z.enum(["you", "another-caller", "policy-exception"]).nullable(),
    failureReason: z.string().nullable(),
    updatedAt: z.string(),
  })
  .strict();
export type RewardRunChild = z.infer<typeof rewardRunChildSchema>;

export const rewardRunSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().uuid(),
    status: rewardRunStatusSchema,
    walletPrincipal: z.string().min(1),
    recipeSha256: z.string().regex(/^[0-9a-f]{64}$/),
    recipe: rewardRunRecipeSchema,
    cursor: z.number().int().nonnegative(),
    progress: z
      .object({
        completed: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        inFlight: z.number().int().nonnegative().max(1),
      })
      .strict(),
    gasSpentUstx: z.string().regex(/^\d+$/),
    approvalExpiresAt: z.string(),
    runtimeExpiresAt: z.string().nullable(),
    approvedAt: z.string().nullable(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    failureReason: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    children: z.array(rewardRunChildSchema),
  })
  .strict();
export type RewardRun = z.infer<typeof rewardRunSchema>;
