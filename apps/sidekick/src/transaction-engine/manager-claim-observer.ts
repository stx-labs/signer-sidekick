import {
  type EngineApprovalReview,
  engineApprovalReviewSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import {
  MANAGER_CLAIM_REWARDS_ADAPTER_ID,
  MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
  type ManagerClaimRewardsPlan,
} from "@stx-labs/signer-sidekick-protocol/manager-claim-rewards";
import { MAX_BOND_PERIODS_PER_CYCLE } from "@stx-labs/signer-sidekick-protocol/pox5-bonds";
import { validatePrincipal } from "@stx-labs/signer-sidekick-protocol/principals";
import { z } from "zod";
import {
  chainAnchorSchema,
  deriveRewardCalculationTarget,
  type RewardCalculationCheckpoint,
} from "../chain-anchor.js";
import {
  type StoredTransactionJob,
  type TransactionEngineRepository,
  transactionEngineDocumentSha256,
} from "./repository.js";

const digestSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/i)
  .transform((value) => value.toLowerCase());
const identifierSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/);
const contractPrincipalSchema = z
  .string()
  .refine((value) => value.includes(".") && validatePrincipal(value), "Invalid contract principal");
const standardPrincipalSchema = z
  .string()
  .refine(
    (value) => !value.includes(".") && validatePrincipal(value),
    "Invalid standard principal",
  );
const publicKeySchema = z
  .string()
  .regex(/^(02|03)[0-9a-f]{64}$/i)
  .transform((value) => value.toLowerCase());
const positiveUintSchema = z.bigint().positive();
const uintSchema = z.bigint().nonnegative();

export const managerClaimObserveFactsSchema = z
  .object({
    schemaVersion: z.literal(1),
    observedAt: z.iso.datetime(),
    network: z
      .object({
        kind: z.enum(["mainnet", "testnet"]),
        chainId: z.number().int().nonnegative().max(0xffff_ffff),
      })
      .strict(),
    manager: z
      .object({
        contract: contractPrincipalSchema,
        profile: z
          .object({
            id: identifierSchema,
            recognitionTier: z.enum([
              "reference-built-in",
              "reference-render",
              "custom-observe",
              "unrecognized",
            ]),
            sourceSha256: digestSchema,
          })
          .strict(),
        observedSourceSha256: digestSchema,
      })
      .strict(),
    chainAnchor: chainAnchorSchema,
    acceptedAttestation: z
      .object({
        issuer: identifierSchema,
        revision: z.number().int().positive(),
        payloadSha256: digestSchema,
        current: z.boolean(),
      })
      .strict(),
    contracts: z
      .object({
        pox5: contractPrincipalSchema,
        sbtcToken: contractPrincipalSchema,
      })
      .strict(),
    rewardCheckpoint: z
      .object({
        rewardCycle: uintSchema,
        calculationCheckpoint: z.enum(["first-half", "second-half"]),
        lastRewardComputeBurnHeight: z.number().int().positive().safe(),
        rewardsPerToken: uintSchema,
      })
      .strict(),
    stxEarnedSats: uintSchema,
    /**
     * Every bond bucket this claim will name, ascending. Empty for an STX-only pool, which is now
     * just the case where no bond period holds anything for this manager.
     */
    bondBuckets: z
      .array(
        z
          .object({
            bondIndex: uintSchema,
            managerSharesSats: uintSchema,
            earnedSats: uintSchema,
            feeSnapshot: z
              .object({
                state: z.enum(["absent", "present"]),
                effectiveFeeBips: z.bigint().min(0n).max(9_999n),
              })
              .strict(),
          })
          .strict(),
      )
      .max(MAX_BOND_PERIODS_PER_CYCLE),
    observedSignerEarnedSats: uintSchema,
    feeSnapshot: z
      .object({
        state: z.enum(["absent", "present"]),
        effectiveFeeBips: z.bigint().min(0n).max(9_999n),
      })
      .strict(),
    expectedSignerOutflowSats: positiveUintSchema,
    gasPayer: z
      .object({
        principal: standardPrincipalSchema,
        publicKey: publicKeySchema,
        observedNonce: uintSchema,
        estimatedFeeUstx: positiveUintSchema,
        maximumFeeUstx: positiveUintSchema,
      })
      .strict(),
    controls: z
      .object({
        mode: z.enum(["observe", "assist"]).default("observe"),
        adapterEnabled: z.boolean(),
        rewardsPaused: z.boolean(),
      })
      .strict(),
    effect: z.discriminatedUnion("remaining", [
      z
        .object({
          remaining: z.literal(true),
          completionEvidenceSha256: z.null(),
        })
        .strict(),
      z
        .object({
          remaining: z.literal(false),
          completionEvidenceSha256: digestSchema,
        })
        .strict(),
    ]),
    authoritative: z
      .object({
        complete: z.literal(true),
        canonical: z.literal(true),
        finalityDepth: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const target = deriveRewardCalculationTarget(value.chainAnchor);
    if (target.status === "invalid") {
      context.addIssue({
        code: "custom",
        path: ["chainAnchor"],
        message: `Chain anchor has no valid completed reward calculation: ${target.reason}`,
      });
    } else {
      if (BigInt(target.rewardCycle) !== value.rewardCheckpoint.rewardCycle) {
        context.addIssue({
          code: "custom",
          path: ["rewardCheckpoint", "rewardCycle"],
          message: "Reward checkpoint cycle does not match the completed calculation",
        });
      }
      if (target.calculationCheckpoint !== value.rewardCheckpoint.calculationCheckpoint) {
        context.addIssue({
          code: "custom",
          path: ["rewardCheckpoint", "calculationCheckpoint"],
          message: "Calculation checkpoint does not match the completed calculation",
        });
      }
      if (
        target.expectedLastRewardComputeBurnHeight !==
        value.rewardCheckpoint.lastRewardComputeBurnHeight
      ) {
        context.addIssue({
          code: "custom",
          path: ["rewardCheckpoint", "lastRewardComputeBurnHeight"],
          message: "Reward-compute height does not match the completed calculation",
        });
      }
    }
    // `observedSignerEarnedSats` is the whole claim: the STX bucket plus every bond bucket named in
    // the call. PoX-5 pays a claim out in one transfer, so the outflow, the postcondition and the
    // per-bucket breakdown all have to agree on that one number.
    // Only meaningful while the claim is still outstanding. Reconciling a completed claim replays
    // the sealed buckets, whose earnings the claim itself has already zeroed on chain.
    const bucketTotal =
      value.stxEarnedSats +
      value.bondBuckets.reduce((total, bucket) => total + bucket.earnedSats, 0n);
    if (value.effect.remaining && bucketTotal !== value.observedSignerEarnedSats) {
      context.addIssue({
        code: "custom",
        path: ["observedSignerEarnedSats"],
        message: "Observed earned rewards must equal the STX bucket plus every bond bucket",
      });
    }
    if (value.effect.remaining) {
      if (value.observedSignerEarnedSats === 0n) {
        context.addIssue({
          code: "custom",
          path: ["observedSignerEarnedSats"],
          message: "A remaining manager claim requires positive observed earned rewards",
        });
      }
      if (value.expectedSignerOutflowSats !== value.observedSignerEarnedSats) {
        context.addIssue({
          code: "custom",
          path: ["expectedSignerOutflowSats"],
          message: "Expected outflow must equal the positive observed earned rewards",
        });
      }
    } else if (value.observedSignerEarnedSats !== 0n) {
      context.addIssue({
        code: "custom",
        path: ["observedSignerEarnedSats"],
        message: "External completion requires zero observed earned rewards",
      });
    }
    if (!value.effect.remaining && value.feeSnapshot.state !== "present") {
      context.addIssue({
        code: "custom",
        path: ["feeSnapshot", "state"],
        message: "External completion requires an authoritative present fee snapshot",
      });
    }
  });

export type ManagerClaimObserveFacts = z.input<typeof managerClaimObserveFactsSchema>;
type ParsedManagerClaimObserveFacts = z.output<typeof managerClaimObserveFactsSchema>;

export type ManagerClaimObserveBlockCode = "external-completion-mismatch";

export interface ManagerClaimObserveBlock {
  code: ManagerClaimObserveBlockCode;
  message: string;
}

export interface ManagerClaimReconciliationPredicate {
  schemaVersion: 1;
  kind: "reference-manager-claim-rewards";
  managerContract: string;
  rewardCycle: string;
  rewardCheckpoint: {
    calculationCheckpoint: RewardCalculationCheckpoint;
    lastRewardComputeBurnHeight: number;
    rewardsPerToken: string;
  };
  /** Digest over the exact bucket readings this claim was planned from. */
  bondBucketsSha256: string;
  expectedFeeSnapshot: {
    state: "present";
    effectiveFeeBips: string;
  };
  expectedEffect: {
    asset: string;
    sender: string;
    recipient: string;
    amountSats: string;
  };
}

export interface ManagerClaimIntentRecord {
  schemaVersion: 1;
  kind: "reference-manager-claim-rewards";
  operationScopeKey: string;
  managerProfile: {
    id: string;
    recognitionTier: "reference-built-in" | "reference-render" | "custom-observe" | "unrecognized";
    expectedSourceSha256: string;
    observedSourceSha256: string;
  };
  acceptedAttestation: {
    issuer: string;
    revision: number;
    payloadSha256: string;
  };
  review: ManagerClaimReviewMaterial;
  sealedPlan: ManagerClaimRewardsPlan;
  reconciliation: ManagerClaimReconciliationPredicate;
}

export const managerClaimReviewMaterialSchema = engineApprovalReviewSchema.omit({ hashes: true });
export type ManagerClaimReviewMaterial = Omit<EngineApprovalReview, "hashes">;

export interface ManagerClaimPolicyRecord {
  schemaVersion: 1;
  kind: "reference-manager-claim-rewards-policy";
  mode: "observe" | "assist";
  adapterEnabled: boolean;
  rewardsPaused: boolean;
  maximumFeeUstx: string;
  estimatedFeeUstx: string;
  approvalRequired: boolean;
  nonceReservationAllowed: boolean;
  signingAllowed: boolean;
  broadcastAllowed: boolean;
}

export interface ManagerClaimObserveResult {
  status: "planned" | "blocked" | "reconciled";
  job: StoredTransactionJob;
  created: boolean;
  supersededJobId: string | null;
  blocks: readonly ManagerClaimObserveBlock[];
  plan: ManagerClaimRewardsPlan | null;
  records: {
    intent: ManagerClaimIntentRecord;
    intentSha256: string;
    policy: ManagerClaimPolicyRecord;
    policySha256: string;
    reconciliation: ManagerClaimReconciliationPredicate;
    reconciliationSha256: string;
  };
}

export class ManagerClaimObserveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagerClaimObserveError";
  }
}

const storedPredicateSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("reference-manager-claim-rewards"),
    managerContract: contractPrincipalSchema,
    rewardCycle: z.string().regex(/^(0|[1-9]\d*)$/),
    rewardCheckpoint: z
      .object({
        calculationCheckpoint: z.enum(["first-half", "second-half"]),
        lastRewardComputeBurnHeight: z.number().int().positive(),
        rewardsPerToken: z.string().regex(/^(0|[1-9]\d*)$/),
      })
      .strict(),
    bondBucketsSha256: digestSchema,
    expectedFeeSnapshot: z
      .object({
        state: z.literal("present"),
        effectiveFeeBips: z.string().regex(/^(0|[1-9]\d*)$/),
      })
      .strict(),
    expectedEffect: z
      .object({
        asset: z.string().min(1),
        sender: contractPrincipalSchema,
        recipient: contractPrincipalSchema,
        amountSats: z.string().regex(/^[1-9]\d*$/),
      })
      .strict(),
  })
  .strict();

const storedIntentSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("reference-manager-claim-rewards"),
    operationScopeKey: z.string().min(1),
    managerProfile: z
      .object({
        id: identifierSchema,
        recognitionTier: z.enum([
          "reference-built-in",
          "reference-render",
          "custom-observe",
          "unrecognized",
        ]),
        expectedSourceSha256: digestSchema,
        observedSourceSha256: digestSchema,
      })
      .strict(),
    acceptedAttestation: z
      .object({
        issuer: identifierSchema,
        revision: z.number().int().positive(),
        payloadSha256: digestSchema,
      })
      .strict(),
    review: managerClaimReviewMaterialSchema,
    sealedPlan: z.unknown(),
    reconciliation: storedPredicateSchema,
  })
  .strict();

const storedPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("reference-manager-claim-rewards-policy"),
    mode: z.enum(["observe", "assist"]),
    adapterEnabled: z.boolean(),
    rewardsPaused: z.boolean(),
    maximumFeeUstx: z.string().regex(/^(0|[1-9]\d*)$/),
    estimatedFeeUstx: z.string().regex(/^(0|[1-9]\d*)$/),
    approvalRequired: z.boolean(),
    nonceReservationAllowed: z.boolean(),
    signingAllowed: z.boolean(),
    broadcastAllowed: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const authorityEnabled = value.mode === "assist";
    for (const field of [
      "approvalRequired",
      "nonceReservationAllowed",
      "signingAllowed",
      "broadcastAllowed",
    ] as const) {
      if (value[field] !== authorityEnabled) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} must match the sealed engine mode`,
        });
      }
    }
  });

export function parseManagerClaimIntentRecord(input: unknown): ManagerClaimIntentRecord {
  return storedIntentSchema.parse(input) as unknown as ManagerClaimIntentRecord;
}

export function parseManagerClaimPolicyRecord(input: unknown): ManagerClaimPolicyRecord {
  return storedPolicySchema.parse(input);
}

export interface ManagerClaimOperationScope {
  network: { kind: "mainnet" | "testnet"; chainId: number };
  managerContract: string;
  rewardCycle: bigint;
  calculationCheckpoint: RewardCalculationCheckpoint;
  lastRewardComputeBurnHeight: number;
  rewardsPerToken: bigint;
}

function scopeMaterial(value: ManagerClaimOperationScope): object {
  return {
    schemaVersion: 1,
    adapter: {
      id: MANAGER_CLAIM_REWARDS_ADAPTER_ID,
      revision: MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
    },
    network: value.network,
    managerContract: value.managerContract,
    rewardCycle: value.rewardCycle.toString(),
    calculationCheckpoint: value.calculationCheckpoint,
    lastRewardComputeBurnHeight: value.lastRewardComputeBurnHeight,
    rewardsPerToken: value.rewardsPerToken.toString(),
  };
}

export function managerClaimOperationScopeKey(value: ManagerClaimOperationScope): string {
  return `manager-claim-scope:${transactionEngineDocumentSha256(scopeMaterial(value))}`;
}

function operationScopeKey(value: ParsedManagerClaimObserveFacts): string {
  return managerClaimOperationScopeKey({
    network: value.network,
    managerContract: value.manager.contract,
    rewardCycle: value.rewardCheckpoint.rewardCycle,
    calculationCheckpoint: value.rewardCheckpoint.calculationCheckpoint,
    lastRewardComputeBurnHeight: value.rewardCheckpoint.lastRewardComputeBurnHeight,
    rewardsPerToken: value.rewardCheckpoint.rewardsPerToken,
  });
}

function deterministicUuid(material: unknown): string {
  const hash = transactionEngineDocumentSha256(material);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(
    17,
    20,
  )}-${hash.slice(20, 32)}`;
}

function observationReason(blocks: readonly ManagerClaimObserveBlock[]): string | undefined {
  return blocks.length === 0 ? undefined : blocks.map(({ code }) => code).join(",");
}

export function storedManagerClaimRecords(
  job: StoredTransactionJob,
): ManagerClaimObserveResult["records"] {
  const intent = parseManagerClaimIntentRecord(job.intent);
  const policy = parseManagerClaimPolicyRecord(job.policy);
  return {
    intent,
    intentSha256: job.intentSha256,
    policy,
    policySha256: job.policySha256,
    reconciliation: intent.reconciliation,
    reconciliationSha256: transactionEngineDocumentSha256(intent.reconciliation),
  };
}

/**
 * Digest of the exact bucket readings a claim was planned from.
 *
 * This replaces the revision 1 no-bond roster proof. That proof was a negative claim derived from a
 * complete staker crawl; this is a positive statement about what each bucket held at the anchor,
 * read straight from PoX-5. Binding it means a claim is invalidated when any bucket moves, the same
 * way a changed amount invalidates one.
 */
export function bondBucketsDigest(
  value: Pick<ParsedManagerClaimObserveFacts, "stxEarnedSats" | "bondBuckets">,
): string {
  return transactionEngineDocumentSha256({
    schemaVersion: 1,
    kind: "manager-claim-bond-buckets",
    stxEarnedSats: value.stxEarnedSats.toString(),
    bondBuckets: value.bondBuckets.map((bucket) => ({
      bondIndex: bucket.bondIndex.toString(),
      managerSharesSats: bucket.managerSharesSats.toString(),
      earnedSats: bucket.earnedSats.toString(),
      feeSnapshot: {
        state: bucket.feeSnapshot.state,
        effectiveFeeBips: bucket.feeSnapshot.effectiveFeeBips.toString(),
      },
    })),
  });
}

function completionBlocks(
  value: ParsedManagerClaimObserveFacts,
  records: ManagerClaimObserveResult["records"],
): ManagerClaimObserveBlock[] {
  const predicate = records.reconciliation;
  const matches =
    predicate.managerContract === value.manager.contract &&
    predicate.rewardCycle === value.rewardCheckpoint.rewardCycle.toString() &&
    predicate.rewardCheckpoint.calculationCheckpoint ===
      value.rewardCheckpoint.calculationCheckpoint &&
    predicate.rewardCheckpoint.lastRewardComputeBurnHeight ===
      value.rewardCheckpoint.lastRewardComputeBurnHeight &&
    predicate.rewardCheckpoint.rewardsPerToken ===
      value.rewardCheckpoint.rewardsPerToken.toString() &&
    predicate.bondBucketsSha256 === bondBucketsDigest(value) &&
    predicate.expectedFeeSnapshot.effectiveFeeBips ===
      value.feeSnapshot.effectiveFeeBips.toString() &&
    predicate.expectedEffect.amountSats === value.expectedSignerOutflowSats.toString() &&
    records.intent.managerProfile.id === value.manager.profile.id &&
    records.intent.managerProfile.expectedSourceSha256 === value.manager.profile.sourceSha256 &&
    records.intent.managerProfile.observedSourceSha256 === value.manager.observedSourceSha256 &&
    records.intent.acceptedAttestation.issuer === value.acceptedAttestation.issuer &&
    records.intent.acceptedAttestation.revision === value.acceptedAttestation.revision &&
    records.intent.acceptedAttestation.payloadSha256 === value.acceptedAttestation.payloadSha256;
  return matches
    ? []
    : [
        {
          code: "external-completion-mismatch",
          message: "External completion evidence does not bind the active manager claim",
        },
      ];
}

export interface ObserveManagerClaimPlannerOptions {
  finalityDepth?: number;
}

export class ObserveManagerClaimPlanner {
  private readonly finalityDepth: number;

  constructor(
    private readonly repository: TransactionEngineRepository,
    options: ObserveManagerClaimPlannerOptions = {},
  ) {
    this.finalityDepth = z
      .number()
      .int()
      .min(1)
      .max(144)
      .parse(options.finalityDepth ?? 1);
  }

  private appendObservation(
    job: StoredTransactionJob,
    value: ParsedManagerClaimObserveFacts,
    records: ManagerClaimObserveResult["records"],
    outcome: "pending" | "blocked" | "satisfied" | "external_success",
    effectRemaining: boolean,
    blocks: readonly ManagerClaimObserveBlock[],
  ): void {
    const reason = observationReason(blocks);
    const observationId = deterministicUuid({
      jobId: job.jobId,
      predicateSha256: records.reconciliationSha256,
      chainAnchor: value.chainAnchor,
      outcome,
      effectRemaining,
      reason: reason ?? null,
      completionEvidenceSha256: value.effect.completionEvidenceSha256,
      observedAt: value.observedAt,
    });
    this.repository.appendReconciliationObservation({
      observationId,
      jobId: job.jobId,
      predicate: records.reconciliation,
      predicateSha256: records.reconciliationSha256,
      chainAnchor: value.chainAnchor,
      authoritative: true,
      canonical: true,
      finalityDepth: value.authoritative.finalityDepth,
      outcome,
      effectRemaining,
      ...(reason === undefined ? {} : { reason }),
      observedAt: value.observedAt,
    });
  }

  private reconcileExternalCompletion(
    value: ParsedManagerClaimObserveFacts,
    job: StoredTransactionJob,
    records: ManagerClaimObserveResult["records"],
    created: boolean,
  ): ManagerClaimObserveResult {
    const blocks = completionBlocks(value, records);
    if (blocks.length > 0) {
      const blockReason = observationReason(blocks);
      if (blockReason === undefined) throw new Error("Completion block reason is missing");
      let blockedJob = job;
      if (job.state !== "blocked" && job.state !== "reconciled") {
        blockedJob = this.repository.transitionLogicalJob({
          jobId: job.jobId,
          expectedState: job.state,
          expectedStateVersion: job.stateVersion,
          nextState: "blocked",
          blockReason,
          changedAt: value.observedAt,
        });
      }
      this.appendObservation(blockedJob, value, records, "blocked", true, blocks);
      return {
        status: "blocked",
        job: blockedJob,
        created,
        supersededJobId: null,
        blocks,
        plan: null,
        records,
      };
    }

    const attempts = this.repository.listAttempts(job.jobId);
    const hasCanonicalLocalSuccess = attempts.some(
      ({ inclusion }) => inclusion?.canonical && inclusion.executionStatus === "success",
    );
    this.appendObservation(
      job,
      value,
      records,
      hasCanonicalLocalSuccess ? "satisfied" : "external_success",
      false,
      [],
    );
    const hasUnresolvedLocalAttempt = attempts.some(({ state }) =>
      ["signed", "submitted", "ambiguous", "confirmed"].includes(state),
    );
    const externalCompletionStillCompetesWithLocalNonce =
      hasUnresolvedLocalAttempt && !hasCanonicalLocalSuccess;
    if (
      job.state !== "reconciled" &&
      (value.authoritative.finalityDepth < this.finalityDepth ||
        externalCompletionStillCompetesWithLocalNonce)
    ) {
      const confirming =
        job.state === "confirmed"
          ? job
          : this.repository.transitionLogicalJob({
              jobId: job.jobId,
              expectedState: job.state,
              expectedStateVersion: job.stateVersion,
              nextState: "confirmed",
              changedAt: value.observedAt,
            });
      return {
        status: "planned",
        job: confirming,
        created,
        supersededJobId: null,
        blocks: [],
        plan: null,
        records,
      };
    }
    const reconciled =
      job.state === "reconciled"
        ? job
        : this.repository.transitionLogicalJob({
            jobId: job.jobId,
            expectedState: job.state,
            expectedStateVersion: job.stateVersion,
            nextState: "reconciled",
            changedAt: value.observedAt,
          });
    return {
      status: "reconciled",
      job: reconciled,
      created,
      supersededJobId: null,
      blocks: [],
      plan: null,
      records,
    };
  }

  async observe(input: ManagerClaimObserveFacts): Promise<ManagerClaimObserveResult> {
    const value = managerClaimObserveFactsSchema.parse(input);
    const scopeKey = operationScopeKey(value);

    if (!value.effect.remaining) {
      const active = this.repository.getActiveLogicalJobForScope(scopeKey);
      if (active !== null) {
        return this.reconcileExternalCompletion(
          value,
          active,
          storedManagerClaimRecords(active),
          false,
        );
      }
      const latest = this.repository.getLatestLogicalJobForScope(scopeKey);
      if (latest?.state === "reconciled") {
        return this.reconcileExternalCompletion(
          value,
          latest,
          storedManagerClaimRecords(latest),
          false,
        );
      }
      throw new ManagerClaimObserveError(
        "External manager-claim completion has no matching durable logical job",
      );
    }

    throw new ManagerClaimObserveError(
      "Legacy manager-claim jobs are read-only; prepare a current operation from Rewards",
    );
  }
}
