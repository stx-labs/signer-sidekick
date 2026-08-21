import { Cl, cvToHex } from "@stacks/transactions";
import {
  type EngineApprovalReview,
  engineApprovalReviewSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import {
  MANAGER_CLAIM_REWARDS_ADAPTER_ID,
  MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
  MANAGER_CLAIM_REWARDS_FUNCTION_NAME,
  type ManagerClaimRewardsPlan,
  planManagerClaimRewards,
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

export type ManagerClaimObserveBlockCode =
  | "adapter-disabled"
  | "manager-profile-ineligible"
  | "manager-source-mismatch"
  | "attestation-not-current"
  | "rewards-paused"
  | "fee-cap-exceeded"
  | "external-completion-mismatch";

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

function blocksFor(value: ParsedManagerClaimObserveFacts): ManagerClaimObserveBlock[] {
  const blocks: ManagerClaimObserveBlock[] = [];
  if (!value.controls.adapterEnabled) {
    blocks.push({ code: "adapter-disabled", message: "Manager-claim transactions are disabled" });
  }
  if (
    value.manager.profile.recognitionTier !== "reference-built-in" &&
    value.manager.profile.recognitionTier !== "reference-render"
  ) {
    blocks.push({
      code: "manager-profile-ineligible",
      message: "Reward claims require a verified reference manager",
    });
  }
  if (value.manager.profile.sourceSha256 !== value.manager.observedSourceSha256) {
    blocks.push({
      code: "manager-source-mismatch",
      message: "Manager source does not match its verified profile",
    });
  }
  if (!value.acceptedAttestation.current) {
    blocks.push({
      code: "attestation-not-current",
      message: "Compatibility attestation expired. Install a current attestation",
    });
  }
  if (value.controls.rewardsPaused) {
    blocks.push({ code: "rewards-paused", message: "Manager rewards are paused" });
  }
  if (value.gasPayer.estimatedFeeUstx > value.gasPayer.maximumFeeUstx) {
    blocks.push({
      code: "fee-cap-exceeded",
      message: "Estimated claim fee exceeds the configured cap",
    });
  }
  return blocks;
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

  private async assertAcceptedAttestation(value: ParsedManagerClaimObserveFacts): Promise<void> {
    const accepted = await this.repository.get(value.acceptedAttestation.issuer);
    if (
      accepted === null ||
      accepted.acceptedState.revision !== value.acceptedAttestation.revision ||
      accepted.acceptedState.payloadSha256 !== value.acceptedAttestation.payloadSha256
    ) {
      throw new ManagerClaimObserveError(
        "Manager-claim facts do not reference the currently accepted attestation",
      );
    }
  }

  private async buildRecords(
    value: ParsedManagerClaimObserveFacts,
    scopeKey: string,
  ): Promise<{
    plan: ManagerClaimRewardsPlan;
    records: ManagerClaimObserveResult["records"];
    idempotencyKey: string;
  }> {
    const plan = await planManagerClaimRewards({
      schemaVersion: 1,
      adapterRevision: MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
      network: value.network,
      managerContract: value.manager.contract,
      pox5Contract: value.contracts.pox5,
      sbtcTokenContract: value.contracts.sbtcToken,
      rewardCycle: value.rewardCheckpoint.rewardCycle,
      expectedSbtcOutflow: value.expectedSignerOutflowSats,
      chainAnchor: {
        ...value.chainAnchor,
        rewardCycle: BigInt(value.chainAnchor.rewardCycle),
      },
      attestationDigest: value.acceptedAttestation.payloadSha256,
      managerSourceFingerprint: value.manager.observedSourceSha256,
      rewardObservation: {
        calculationCheckpoint: value.rewardCheckpoint.calculationCheckpoint,
        lastRewardComputeBurnHeight: value.rewardCheckpoint.lastRewardComputeBurnHeight,
        rewardsPerToken: value.rewardCheckpoint.rewardsPerToken,
      },
      stxEarnedSats: value.stxEarnedSats,
      bondBuckets: value.bondBuckets,
      feeSnapshot: value.feeSnapshot,
      sender: {
        principal: value.gasPayer.principal,
        publicKey: value.gasPayer.publicKey,
      },
      nonce: value.gasPayer.observedNonce,
      fee: value.gasPayer.estimatedFeeUstx,
    });
    const reconciliation: ManagerClaimReconciliationPredicate = {
      schemaVersion: 1,
      kind: "reference-manager-claim-rewards",
      managerContract: value.manager.contract,
      rewardCycle: value.rewardCheckpoint.rewardCycle.toString(),
      rewardCheckpoint: {
        calculationCheckpoint: value.rewardCheckpoint.calculationCheckpoint,
        lastRewardComputeBurnHeight: value.rewardCheckpoint.lastRewardComputeBurnHeight,
        rewardsPerToken: value.rewardCheckpoint.rewardsPerToken.toString(),
      },
      bondBucketsSha256: bondBucketsDigest(value),
      expectedFeeSnapshot: {
        state: "present",
        effectiveFeeBips: value.feeSnapshot.effectiveFeeBips.toString(),
      },
      expectedEffect: {
        asset: plan.material.expectedEffect.asset,
        sender: plan.material.expectedEffect.sender,
        recipient: plan.material.expectedEffect.recipient,
        amountSats: plan.material.expectedEffect.amount,
      },
    };
    const intent: ManagerClaimIntentRecord = {
      schemaVersion: 1,
      kind: "reference-manager-claim-rewards",
      operationScopeKey: scopeKey,
      managerProfile: {
        id: value.manager.profile.id,
        recognitionTier: value.manager.profile.recognitionTier,
        expectedSourceSha256: value.manager.profile.sourceSha256,
        observedSourceSha256: value.manager.observedSourceSha256,
      },
      acceptedAttestation: {
        issuer: value.acceptedAttestation.issuer,
        revision: value.acceptedAttestation.revision,
        payloadSha256: value.acceptedAttestation.payloadSha256,
      },
      review: managerClaimReviewMaterialSchema.parse({
        adapter: {
          id: MANAGER_CLAIM_REWARDS_ADAPTER_ID,
          revision: MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
        },
        network: `${value.network.kind}:${value.network.chainId}`,
        managerPrincipal: value.manager.contract,
        call: {
          contract: value.manager.contract,
          functionName: MANAGER_CLAIM_REWARDS_FUNCTION_NAME,
          arguments: [
            {
              name: "bond-periods",
              clarityValue: cvToHex(
                Cl.list(value.bondBuckets.map(({ bondIndex }) => Cl.uint(bondIndex))),
              ),
              displayValue: `[${value.bondBuckets.map(({ bondIndex }) => bondIndex).join(", ")}]`,
            },
            {
              name: "reward-cycle",
              clarityValue: `u${value.rewardCheckpoint.rewardCycle}`,
              displayValue: value.rewardCheckpoint.rewardCycle.toString(),
            },
          ],
        },
        anchor: value.chainAnchor,
        checkpoint: {
          rewardCycle: Number(value.rewardCheckpoint.rewardCycle),
          calculationCheckpoint: value.rewardCheckpoint.calculationCheckpoint,
          lastRewardComputeHeight: value.rewardCheckpoint.lastRewardComputeBurnHeight,
          rewardsPerToken: value.rewardCheckpoint.rewardsPerToken.toString(),
        },
        expectedEffect: {
          recipient: { kind: "manager", principal: value.manager.contract },
          asset: {
            assetId: plan.material.expectedEffect.asset,
            symbol: "sBTC",
            maximumOutflow: plan.material.expectedEffect.amount,
            unit: "sats",
          },
          postconditions: [
            `${plan.material.expectedEffect.sender} sends exactly ${plan.material.expectedEffect.amount} sats of ${plan.material.expectedEffect.asset}`,
          ],
          reconciliationPredicate: JSON.stringify(reconciliation),
        },
        fee: {
          snapshot: {
            state: value.feeSnapshot.state === "absent" ? "missing" : "present",
            feeBips: Number(value.feeSnapshot.effectiveFeeBips),
            source: `manager-profile:${value.manager.profile.id}`,
          },
          estimatedFeeUstx: value.gasPayer.estimatedFeeUstx.toString(),
          maximumFeeUstx: value.gasPayer.maximumFeeUstx.toString(),
          policyRevision: 1,
        },
        expectedPostState: JSON.stringify({
          predicate: reconciliation,
          effectRemaining: false,
        }),
      }),
      sealedPlan: plan,
      reconciliation,
    };
    const policy: ManagerClaimPolicyRecord = {
      schemaVersion: 1,
      kind: "reference-manager-claim-rewards-policy",
      mode: value.controls.mode,
      adapterEnabled: value.controls.adapterEnabled,
      rewardsPaused: value.controls.rewardsPaused,
      maximumFeeUstx: value.gasPayer.maximumFeeUstx.toString(),
      estimatedFeeUstx: value.gasPayer.estimatedFeeUstx.toString(),
      approvalRequired: value.controls.mode === "assist",
      nonceReservationAllowed: value.controls.mode === "assist",
      signingAllowed: value.controls.mode === "assist",
      broadcastAllowed: value.controls.mode === "assist",
    };
    const intentSha256 = transactionEngineDocumentSha256(intent);
    const policySha256 = transactionEngineDocumentSha256(policy);
    return {
      plan,
      records: {
        intent,
        intentSha256,
        policy,
        policySha256,
        reconciliation,
        reconciliationSha256: transactionEngineDocumentSha256(reconciliation),
      },
      idempotencyKey: `manager-claim-job:${transactionEngineDocumentSha256({
        intentSha256,
        policySha256,
      })}`,
    };
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

    await this.assertAcceptedAttestation(value);
    const built = await this.buildRecords(value, scopeKey);
    const durable = this.repository.createOrSupersedeLogicalJob(
      {
        idempotencyKey: built.idempotencyKey,
        operationScopeKey: scopeKey,
        adapterId: MANAGER_CLAIM_REWARDS_ADAPTER_ID,
        adapterRevision: MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
        managerPrincipal: value.manager.contract,
        intent: built.records.intent,
        intentSha256: built.records.intentSha256,
        policy: built.records.policy,
        policySha256: built.records.policySha256,
        chainAnchor: value.chainAnchor,
        attestation: value.acceptedAttestation,
        createdAt: value.observedAt,
      },
      { changedAt: value.observedAt, reason: "authoritative-manager-claim-facts-changed" },
    );
    const blocks = blocksFor(value);
    let job = durable.job;
    if (job.state === "prepared") {
      if (blocks.length === 0) {
        job = this.repository.transitionLogicalJob({
          jobId: job.jobId,
          expectedState: "prepared",
          expectedStateVersion: job.stateVersion,
          nextState: "preflighted",
          changedAt: value.observedAt,
        });
      } else {
        const blockReason = observationReason(blocks);
        if (blockReason === undefined) throw new Error("Planning block reason is missing");
        job = this.repository.transitionLogicalJob({
          jobId: job.jobId,
          expectedState: "prepared",
          expectedStateVersion: job.stateVersion,
          nextState: "blocked",
          blockReason,
          changedAt: value.observedAt,
        });
      }
    }
    this.appendObservation(
      job,
      value,
      built.records,
      blocks.length === 0 ? "pending" : "blocked",
      true,
      blocks,
    );
    return {
      status: blocks.length === 0 ? "planned" : "blocked",
      job,
      created: durable.created,
      supersededJobId: durable.supersededJobId,
      blocks,
      plan: built.plan,
      records: built.records,
    };
  }
}
