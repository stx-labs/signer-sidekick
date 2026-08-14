import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { validatePrincipal } from "@stx-labs/signer-sidekick-protocol/principals";
import { z } from "zod";
import { type ChainAnchor, chainAnchorSchema } from "../chain-anchor.js";
import type { SidekickNetwork } from "../config.js";
import { TransactionEngineRepository } from "../transaction-engine/repository.js";
import { type Migration, migrations } from "./migrations.js";
import { WalletIntentRepository } from "./wallet-intent-repository.js";

const sourceInputSchema = z
  .object({
    sourceId: z.string().min(1),
    kind: z.enum(["api", "node"]),
    network: z.enum(["mainnet", "testnet", "devnet", "regtest"]),
    baseUrl: z.url(),
    observedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    const url = new URL(value.baseUrl);
    if (url.username || url.password || url.search || url.hash) {
      context.addIssue({
        code: "custom",
        message: "Chain source URL must not contain credentials, query parameters, or a fragment",
        path: ["baseUrl"],
      });
    }
  });

const cursorInputSchema = z
  .object({
    sourceId: z.string().min(1),
    stream: z.string().min(1),
    cursor: z.string().nullable(),
    lastBlockHeight: z.number().int().nonnegative().nullable(),
    lastIndexBlockHash: z.string().nullable(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const hashSchema = z.string().regex(/^0x[0-9a-f]{64}$/);
const eventInputSchema = z
  .object({
    chainId: z.number().int().nonnegative(),
    txId: hashSchema,
    eventIndex: z.number().int().nonnegative(),
    blockHeight: z.number().int().nonnegative(),
    blockHash: hashSchema,
    indexBlockHash: hashSchema,
    microblockHash: hashSchema.nullable(),
    microblockSequence: z.number().int().nonnegative().nullable(),
    canonical: z.boolean(),
    microblockCanonical: z.boolean(),
    contractId: z.string().nullable(),
    topic: z.string().nullable(),
    rawPayload: z.unknown(),
    decodedSchemaVersion: z.number().int().positive().nullable(),
    decodedPayload: z.unknown().nullable(),
    sourceId: z.string().min(1),
    observedAt: z.iso.datetime(),
  })
  .strict()
  .refine(
    (value) => (value.decodedSchemaVersion === null) === (value.decodedPayload === null),
    "decodedSchemaVersion and decodedPayload must either both be present or both be null",
  );

const cursorRowSchema = z.object({
  source_id: z.string(),
  stream: z.string(),
  cursor: z.string().nullable(),
  last_block_height: z.number().int().nonnegative().nullable(),
  last_index_block_hash: z.string().nullable(),
  updated_at: z.string(),
});

const eventRowSchema = z.object({
  chain_id: z.number().int().nonnegative(),
  tx_id: z.string(),
  event_index: z.number().int().nonnegative(),
  block_height: z.number().int().nonnegative(),
  block_hash: z.string(),
  index_block_hash: z.string(),
  microblock_hash: z.string().nullable(),
  microblock_sequence: z.number().int().nonnegative().nullable(),
  canonical: z.union([z.literal(0), z.literal(1)]),
  microblock_canonical: z.union([z.literal(0), z.literal(1)]),
  contract_id: z.string().nullable(),
  topic: z.string().nullable(),
  raw_payload_json: z.string(),
  decoded_schema_version: z.number().int().positive().nullable(),
  decoded_payload_json: z.string().nullable(),
  source_id: z.string(),
  first_seen_at: z.string(),
  updated_at: z.string(),
});

const unsignedIntegerTextSchema = z.string().regex(/^\d+$/);
const managerActivityEnvelopeSchema = z.object({
  transactionStatus: z.literal("success"),
  event: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("claim-staker-rewards"),
      stakerPrincipal: z.string(),
      rewardCycle: unsignedIntegerTextSchema,
      bondIndex: unsignedIntegerTextSchema.nullable(),
      amountSats: unsignedIntegerTextSchema,
      l1Withdrawal: z
        .object({
          requestId: unsignedIntegerTextSchema,
          amountSats: unsignedIntegerTextSchema,
          maxFeeSats: unsignedIntegerTextSchema,
        })
        .nullable(),
    }),
    z.object({
      kind: z.literal("reclaim-failed-withdrawal"),
      requestId: unsignedIntegerTextSchema,
      stakerPrincipal: z.string(),
      amountSats: unsignedIntegerTextSchema,
    }),
    z.object({
      kind: z.literal("settle-accepted-withdrawal"),
      requestId: unsignedIntegerTextSchema,
      stakerPrincipal: z.string(),
      liabilityReleasedSats: unsignedIntegerTextSchema,
    }),
    z.object({
      kind: z.literal("update-admin"),
      adminPrincipal: z.string().refine(validatePrincipal, "Invalid admin principal"),
      enabled: z.boolean(),
    }),
  ]),
});

const managerAdminUpdateRowSchema = z.object({
  admin_principal: z.string().refine(validatePrincipal, "Invalid admin principal"),
  enabled: z.union([z.literal(0), z.literal(1)]),
  transaction_index: z.number().int().nonnegative().nullable(),
  block_height: z.number().int().nonnegative(),
  event_index: z.number().int().nonnegative(),
});

const managerClaimRowSchema = z.object({
  tx_id: z.string(),
  event_index: z.number().int().nonnegative(),
  block_height: z.number().int().nonnegative(),
  staker_principal: z.string(),
  reward_cycle: z.string(),
  bond_index: z.string().nullable(),
  amount_sats: z.string(),
  request_id: z.string().nullable(),
});

const managerWithdrawalRowSchema = z.object({
  request_id: z.string(),
  staker_principal: z.string(),
  amount_sats: z.string(),
  max_fee_sats: z.string(),
  initiated_tx_id: z.string(),
  initiated_block_height: z.number().int().nonnegative(),
  resolution_kind: z.enum(["reclaim-failed-withdrawal", "settle-accepted-withdrawal"]).nullable(),
  resolved_tx_id: z.string().nullable(),
  resolved_block_height: z.number().int().nonnegative().nullable(),
});

const principalSchema = z.string().refine(validatePrincipal, "Invalid Stacks principal");
const signerCycleMembershipInputSchema = z
  .object({
    rewardCycle: z.bigint().nonnegative(),
    signerPrincipal: principalSchema,
    amountUstx: z.bigint().nonnegative(),
  })
  .strict();
const signerStakerPositionInputSchema = z
  .object({
    signerPrincipal: principalSchema,
    amountUstx: z.bigint().nonnegative(),
    firstRewardCycle: z.bigint().nonnegative(),
    // PoX-5 retains the original first cycle and accumulates lifetime num-cycles across updates.
    numCycles: z.bigint().min(1n),
    unlockBurnHeight: z.bigint().nonnegative().optional(),
    // The current frozen cycle plus at most 96 future cycles can be active at once.
    cycleMemberships: z.array(signerCycleMembershipInputSchema).max(97),
  })
  .strict();
const signerStakerBondSchema = z
  .object({
    bondIndex: z.bigint().nonnegative(),
    amountUstx: z.bigint().nonnegative(),
    amountSats: z.bigint().nonnegative(),
    isL1Lock: z.boolean(),
    signer: principalSchema,
  })
  .strict();
const signerStakerPageItemSchema = z
  .object({
    stakerPrincipal: principalSchema,
    hasStx: z.boolean(),
    hasBtc: z.boolean(),
    /** Anchored `get-bond-membership` result for the configured manager, or null when absent. */
    bond: signerStakerBondSchema.nullable().optional().default(null),
    active: z.boolean(),
    stxNodeVerified: z.boolean().nullable(),
    reconciliationComplete: z.boolean().optional().default(true),
    position: signerStakerPositionInputSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.hasStx && !value.hasBtc) {
      context.addIssue({
        code: "custom",
        message: "A discovery must include at least one staking type",
        path: ["hasStx"],
      });
    }
    if ((value.position !== null) !== (value.stxNodeVerified === true)) {
      context.addIssue({
        code: "custom",
        message: "A trusted position requires successful STX node verification",
        path: ["position"],
      });
    }
  });
const signerStakerApiCandidateSchema = z
  .object({
    stakerPrincipal: principalSchema,
    hasStx: z.boolean(),
    hasBtc: z.boolean(),
  })
  .strict()
  .refine((value) => value.hasStx || value.hasBtc, "A discovery must include a staking type");
const signerStakerApiPageInputSchema = z
  .object({
    runId: z.string().uuid(),
    sourceId: z.string().min(1),
    managerPrincipal: principalSchema,
    requestedCursor: principalSchema.nullable(),
    nextCursor: principalSchema.nullable(),
    items: z.array(signerStakerApiCandidateSchema),
    expectedTotal: z.number().int().nonnegative(),
    sealed: z.boolean(),
    anchorFenced: z.boolean(),
    chainAnchor: chainAnchorSchema.optional(),
    observedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.sealed !== (value.nextCursor === null)) {
      context.addIssue({
        code: "custom",
        message: "Only the final API page can seal the roster",
        path: ["sealed"],
      });
    }
    if (value.anchorFenced && !value.sealed) {
      context.addIssue({
        code: "custom",
        message: "The API anchor fence can only be recorded on a sealed roster",
        path: ["anchorFenced"],
      });
    }
  });
const signerStakerPageInputSchema = z
  .object({
    runId: z.string().uuid(),
    sourceId: z.string().min(1),
    nodeSourceId: z.string().min(1),
    managerPrincipal: principalSchema,
    nextCursor: principalSchema.nullable(),
    items: z.array(signerStakerPageItemSchema),
    apiItemsProcessed: z.number().int().nonnegative().optional(),
    recordApiPage: z.boolean().optional().default(true),
    authoritativeCompletion: z.boolean().optional(),
    chainAnchor: chainAnchorSchema.optional(),
    observedAt: z.iso.datetime(),
    burnBlockHeight: z.number().int().nonnegative(),
    stacksTipHeight: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.chainAnchor &&
      (value.chainAnchor.burnBlockHeight !== value.burnBlockHeight ||
        value.chainAnchor.stacksBlockHeight !== value.stacksTipHeight)
    ) {
      context.addIssue({
        code: "custom",
        message: "Stored heights must match the exact chain anchor",
        path: ["chainAnchor"],
      });
    }
    if (value.authoritativeCompletion && !value.chainAnchor) {
      context.addIssue({
        code: "custom",
        message: "An authoritative completion requires an exact chain anchor",
        path: ["authoritativeCompletion"],
      });
    }
  });

const ingestionRunRowSchema = z.object({
  run_id: z.string().uuid(),
  source_id: z.string(),
  stream: z.string(),
  manager_principal: z.string(),
  status: z.enum(["running", "completed"]),
  cursor_next: z.string().nullable(),
  pages_processed: z.number().int().nonnegative(),
  items_processed: z.number().int().nonnegative(),
  started_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
  authoritative: z.union([z.literal(0), z.literal(1)]),
  reconciliation_complete: z.union([z.literal(0), z.literal(1)]),
  anchor_stacks_block_height: z.number().int().nonnegative().nullable(),
  anchor_index_block_hash: hashSchema.nullable(),
  anchor_burn_block_height: z.number().int().nonnegative().nullable(),
  anchor_reward_cycle: z.number().int().nonnegative().nullable(),
  anchor_reward_cycle_length: z.number().int().positive().nullable(),
  anchor_prepare_cycle_length: z.number().int().nonnegative().nullable(),
  anchor_cycle_position: z.number().int().nonnegative().nullable(),
  anchor_phase: z.enum(["reward", "prepare"]).nullable(),
  anchor_checkpoint: z.enum(["first-half", "second-half"]).nullable(),
});

const storedSignerStakerRowSchema = z.object({
  manager_principal: z.string(),
  staker_principal: z.string(),
  has_stx: z.union([z.literal(0), z.literal(1)]),
  has_btc: z.union([z.literal(0), z.literal(1)]),
  stx_node_verified: z.union([z.literal(0), z.literal(1)]).nullable(),
  bond_node_verified: z.union([z.literal(0), z.literal(1)]).nullable(),
  bond_index: z.string().nullable(),
  bond_amount_ustx: z.string().nullable(),
  bond_amount_sats: z.string().nullable(),
  bond_is_l1_lock: z.union([z.literal(0), z.literal(1)]).nullable(),
  active: z.union([z.literal(0), z.literal(1)]),
  source_id: z.string(),
  verification_source_id: z.string().nullable(),
  last_seen_run_id: z.string(),
  first_seen_at: z.string(),
  last_seen_at: z.string(),
  signer_principal: z.string().nullable(),
  amount_ustx: z.string().nullable(),
  first_reward_cycle: z.string().nullable(),
  num_cycles: z.string().nullable(),
  unlock_cycle: z.string().nullable(),
  unlock_burn_height: z.string().nullable(),
  position_active: z.union([z.literal(0), z.literal(1)]).nullable(),
});

const cycleMembershipRowSchema = z.object({
  staker_principal: z.string(),
  reward_cycle: z.string(),
  signer_principal: z.string(),
  amount_ustx: z.string(),
  active: z.union([z.literal(0), z.literal(1)]),
});

const stakerPositionObservationRowSchema = z.object({
  manager_principal: z.string(),
  staker_principal: z.string(),
  observed_burn_block_height: z.number().int().nonnegative(),
  observed_stacks_tip_height: z.number().int().nonnegative(),
  observed_index_block_hash: hashSchema.nullable(),
  has_stx: z.union([z.literal(0), z.literal(1)]),
  has_btc: z.union([z.literal(0), z.literal(1)]),
  stx_node_verified: z.union([z.literal(0), z.literal(1)]).nullable(),
  position_present: z.union([z.literal(0), z.literal(1)]),
  signer_principal: z.string().nullable(),
  amount_ustx: z.string().nullable(),
  first_reward_cycle: z.string().nullable(),
  num_cycles: z.string().nullable(),
  unlock_cycle: z.string().nullable(),
  unlock_burn_height: z.string().nullable(),
  observed_at: z.string(),
});

const poolCycleSnapshotInputSchema = z
  .object({
    managerPrincipal: principalSchema,
    observedAt: z.iso.datetime(),
    burnBlockHeight: z.number().int().nonnegative(),
    stacksTipHeight: z.number().int().nonnegative(),
    chainAnchor: chainAnchorSchema.optional(),
    cycles: z.array(
      z
        .object({
          cycleId: z.number().int().nonnegative(),
          status: z.enum(["ready", "attention"]),
          rosterAvailable: z.boolean(),
          stakerCount: z.number().int().nonnegative().nullable(),
          enumeratedStxUstx: z.string().nullable(),
          enumerationDeltaUstx: z.string().nullable(),
          pendingStxUstx: unsignedIntegerTextSchema,
          eligibleStxSharesUstx: unsignedIntegerTextSchema,
          totalDelegatedUstx: unsignedIntegerTextSchema,
          nonStxDelegatedUstx: unsignedIntegerTextSchema.nullable(),
          inSignerSet: z.boolean(),
          thresholdUstx: unsignedIntegerTextSchema,
          thresholdMarginUstx: z.string().regex(/^-?\d+$/),
          provenance: z
            .object({
              classification: z.enum(["authoritative", "projected"]),
              contractSource: z.literal("pox5-read-only"),
              localRosterSource: z.enum(["api-indexed-node-verified", "unavailable"]),
            })
            .strict(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.chainAnchor === undefined) return;
    if (value.chainAnchor.burnBlockHeight !== value.burnBlockHeight) {
      context.addIssue({
        code: "custom",
        message: "chainAnchor burn height must match the snapshot burn height",
        path: ["chainAnchor", "burnBlockHeight"],
      });
    }
    if (value.chainAnchor.stacksBlockHeight !== value.stacksTipHeight) {
      context.addIssue({
        code: "custom",
        message: "chainAnchor Stacks height must match the snapshot Stacks height",
        path: ["chainAnchor", "stacksBlockHeight"],
      });
    }
  });

const poolCycleSnapshotRowSchema = z.object({
  manager_principal: z.string(),
  reward_cycle: z.number().int().nonnegative(),
  observed_burn_block_height: z.number().int().nonnegative(),
  observed_stacks_tip_height: z.number().int().nonnegative(),
  chain_anchor_json: z.string().nullable(),
  status: z.enum(["ready", "attention"]),
  roster_available: z.union([z.literal(0), z.literal(1)]),
  staker_count: z.number().int().nonnegative().nullable(),
  enumerated_stx_ustx: z.string().nullable(),
  enumeration_delta_ustx: z.string().nullable(),
  pending_stx_ustx: z.string(),
  eligible_stx_shares_ustx: z.string(),
  total_delegated_ustx: z.string(),
  non_stx_delegated_ustx: z.string().nullable(),
  in_signer_set: z.union([z.literal(0), z.literal(1)]),
  threshold_ustx: z.string(),
  threshold_margin_ustx: z.string(),
  value_classification: z.enum(["authoritative", "projected"]),
  contract_source: z.literal("pox5-read-only"),
  local_roster_source: z.enum(["api-indexed-node-verified", "unavailable"]),
  observed_at: z.string(),
});

const rewardCycleSnapshotInputSchema = z
  .object({
    managerPrincipal: principalSchema,
    rewardCycle: z.number().int().nonnegative(),
    status: z.enum(["ready", "attention"]),
    observedAt: z.iso.datetime(),
    burnBlockHeight: z.number().int().nonnegative(),
    stacksTipHeight: z.number().int().nonnegative(),
    chainAnchor: chainAnchorSchema.optional(),
    global: z
      .object({
        lastRewardComputeBurnHeight: unsignedIntegerTextSchema,
        lastComputedRewardCycle: unsignedIntegerTextSchema.nullable(),
        rewardsPerToken: unsignedIntegerTextSchema,
        signerEarnedBeforeManagerClaimSats: unsignedIntegerTextSchema,
        signerEarnedAcrossBucketsSats: unsignedIntegerTextSchema,
      })
      .strict(),
    manager: z
      .object({
        configuredFeeBips: unsignedIntegerTextSchema,
        feeSnapshotBips: unsignedIntegerTextSchema.nullable(),
        earnedFeesSats: unsignedIntegerTextSchema,
        withdrawalLiabilitySats: unsignedIntegerTextSchema,
        unclaimedStakerRewardsSats: unsignedIntegerTextSchema,
      })
      .strict(),
    totals: z
      .object({
        stakers: z.number().int().nonnegative(),
        grossSats: unsignedIntegerTextSchema,
        earnedSats: unsignedIntegerTextSchema,
        feeSats: unsignedIntegerTextSchema,
        actionableClaims: z.number().int().nonnegative(),
        l1ClaimsWaitingForFeeThreshold: z.number().int().nonnegative(),
      })
      .strict(),
    stakers: z.array(
      z
        .object({
          stakerPrincipal: principalSchema,
          payout: z.discriminatedUnion("kind", [
            z.object({
              kind: z.literal("direct-sbtc"),
              poxAddress: z.null(),
              maxFeeSats: z.null(),
            }),
            z.object({
              kind: z.literal("bitcoin-l1"),
              poxAddress: z.object({ versionHex: z.string(), hashbytesHex: z.string() }),
              maxFeeSats: unsignedIntegerTextSchema,
            }),
          ]),
          rewards: z
            .object({
              earnedSats: unsignedIntegerTextSchema,
              feeSats: unsignedIntegerTextSchema,
              grossSats: unsignedIntegerTextSchema,
            })
            .strict(),
          claimableByPolicy: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.chainAnchor === undefined) return;
    if (value.chainAnchor.burnBlockHeight !== value.burnBlockHeight) {
      context.addIssue({
        code: "custom",
        message: "chainAnchor burn height must match the snapshot burn height",
        path: ["chainAnchor", "burnBlockHeight"],
      });
    }
    if (value.chainAnchor.stacksBlockHeight !== value.stacksTipHeight) {
      context.addIssue({
        code: "custom",
        message: "chainAnchor Stacks height must match the snapshot Stacks height",
        path: ["chainAnchor", "stacksBlockHeight"],
      });
    }
  });

const rewardCycleSummaryRowSchema = z.object({
  manager_principal: z.string(),
  reward_cycle: z.number().int().nonnegative(),
  status: z.enum(["ready", "attention"]),
  observed_burn_block_height: z.number().int().nonnegative(),
  observed_stacks_tip_height: z.number().int().nonnegative(),
  chain_anchor_json: z.string().nullable(),
  staker_count: z.number().int().nonnegative(),
  gross_sats: z.string(),
  earned_sats: z.string(),
  fee_sats: z.string(),
  fee_snapshot_bips: z.string(),
  fee_snapshot_present: z.union([z.literal(0), z.literal(1)]),
  configured_fee_bips: z.string().nullable(),
  actionable_claims: z.number().int().nonnegative(),
  l1_claims_waiting_for_fee_threshold: z.number().int().nonnegative(),
  observed_at: z.string(),
});

export type ChainSourceInput = z.infer<typeof sourceInputSchema>;
export type ChainCursorInput = z.infer<typeof cursorInputSchema>;
export type ChainEventInput = z.infer<typeof eventInputSchema>;

export interface ChainCursor {
  sourceId: string;
  stream: string;
  cursor: string | null;
  lastBlockHeight: number | null;
  lastIndexBlockHash: string | null;
  updatedAt: string;
}

export interface StoredChainEvent extends Omit<ChainEventInput, "observedAt"> {
  firstSeenAt: string;
  updatedAt: string;
}

export type SignerStakerPositionInput = z.infer<typeof signerStakerPositionInputSchema>;
export type SignerStakerPageItem = z.infer<typeof signerStakerPageItemSchema>;
export type SignerStakerPageInput = z.infer<typeof signerStakerPageInputSchema>;
export type SignerStakerApiCandidate = z.infer<typeof signerStakerApiCandidateSchema>;
export type PoolCycleSnapshotInput = z.infer<typeof poolCycleSnapshotInputSchema>;
export type RewardCycleSnapshotInput = z.infer<typeof rewardCycleSnapshotInputSchema>;

export interface SignerStakerRun {
  runId: string;
  sourceId: string;
  managerPrincipal: string;
  status: "running" | "completed";
  authoritative: boolean;
  reconciliationComplete: boolean;
  chainAnchor: ChainAnchor | null;
  cursor: string | null;
  pagesProcessed: number;
  itemsProcessed: number;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface SignerStakerApiScan {
  sealed: boolean;
  anchorFenced: boolean;
  expectedTotal: number;
  items: SignerStakerApiCandidate[];
}

export interface StoredSignerStaker {
  managerPrincipal: string;
  stakerPrincipal: string;
  hasStx: boolean;
  hasBtc: boolean;
  /** Node-verified bond membership at the reconciliation anchor, not the API's `types` label. */
  bond: null | {
    bondIndex: bigint;
    amountUstx: bigint;
    amountSats: bigint;
    isL1Lock: boolean;
  };
  stxNodeVerified: boolean | null;
  active: boolean;
  sourceId: string;
  verificationSourceId: string | null;
  lastSeenRunId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  position: null | {
    signerPrincipal: string;
    amountUstx: bigint;
    firstRewardCycle: bigint;
    numCycles: bigint;
    unlockCycle: bigint;
    unlockBurnHeight: bigint | null;
    active: boolean;
  };
}

export interface StoredCycleMembership {
  stakerPrincipal: string;
  rewardCycle: bigint;
  signerPrincipal: string;
  amountUstx: bigint;
  active: boolean;
}

export interface StoredStakerPositionObservation {
  managerPrincipal: string;
  stakerPrincipal: string;
  observedBurnBlockHeight: number;
  observedStacksTipHeight: number;
  observedIndexBlockHash: string | null;
  hasStx: boolean;
  hasBtc: boolean;
  stxNodeVerified: boolean | null;
  position: null | {
    signerPrincipal: string;
    amountUstx: string;
    firstRewardCycle: string;
    numCycles: string;
    unlockCycle: string;
    unlockBurnHeight: string | null;
  };
  observedAt: string;
}

export interface StoredPoolCycleSnapshot {
  managerPrincipal: string;
  cycleId: number;
  observedBurnBlockHeight: number;
  observedStacksTipHeight: number;
  chainAnchor: ChainAnchor | null;
  status: "ready" | "attention";
  rosterAvailable: boolean;
  stakerCount: number | null;
  enumeratedStxUstx: string | null;
  enumerationDeltaUstx: string | null;
  pendingStxUstx: string;
  eligibleStxSharesUstx: string;
  totalDelegatedUstx: string;
  nonStxDelegatedUstx: string | null;
  inSignerSet: boolean;
  thresholdUstx: string;
  thresholdMarginUstx: string;
  provenance: {
    classification: "authoritative" | "projected";
    contractSource: "pox5-read-only";
    localRosterSource: "api-indexed-node-verified" | "unavailable";
  };
  observedAt: string;
}

export interface StoredRewardCycleSummary {
  managerPrincipal: string;
  rewardCycle: number;
  status: "ready" | "attention";
  observedBurnBlockHeight: number;
  observedStacksTipHeight: number;
  chainAnchor: ChainAnchor | null;
  stakerCount: number;
  grossSats: string;
  earnedSats: string;
  feeSats: string;
  configuredFeeBips: string | null;
  feeSnapshotBips: string | null;
  actionableClaims: number;
  l1ClaimsWaitingForFeeThreshold: number;
  observedAt: string;
}

export interface StoredRuntimeSettings {
  settings: unknown;
  apiKeySecret: string | null;
  revision: number;
  updatedAt: string;
}

export interface StoredDeploymentIdentity {
  schemaVersion: 1;
  network: SidekickNetwork;
  networkId: number;
  parentNetworkId: number | null;
  managerPrincipal: string;
  bindingSource: "new" | "legacy-evidence";
  boundAt: string;
  lastVerifiedAt: string;
  lastStacksTipHeight: number;
  lastBurnBlockHeight: number;
  lastPox5ContractId: string;
}

export interface LegacyDeploymentEvidence {
  networks: SidekickNetwork[];
  networkIds: number[];
  managerPrincipals: string[];
}

export interface StoredManagerClaim {
  txId: string;
  eventIndex: number;
  blockHeight: number;
  stakerPrincipal: string;
  rewardCycle: string;
  bondIndex: string | null;
  amountSats: string;
  destination: "direct-sbtc" | "bitcoin-l1";
  withdrawalRequestId: string | null;
}

export interface StoredManagerWithdrawal {
  requestId: string;
  stakerPrincipal: string;
  amountSats: string;
  maxFeeSats: string;
  initiatedTxId: string;
  initiatedBlockHeight: number;
  state: "pending" | "settled" | "reclaimed";
  resolvedTxId: string | null;
  resolvedBlockHeight: number | null;
}

export interface ManagerActivityPage<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface StoredManagerAdminUpdate {
  adminPrincipal: string;
  enabled: boolean;
  transactionIndex: number | null;
  blockHeight: number;
  eventIndex: number;
}

function toStoredChainEvent(row: unknown): StoredChainEvent {
  const value = eventRowSchema.parse(row);
  return {
    chainId: value.chain_id,
    txId: value.tx_id,
    eventIndex: value.event_index,
    blockHeight: value.block_height,
    blockHash: value.block_hash,
    indexBlockHash: value.index_block_hash,
    microblockHash: value.microblock_hash,
    microblockSequence: value.microblock_sequence,
    canonical: value.canonical === 1,
    microblockCanonical: value.microblock_canonical === 1,
    contractId: value.contract_id,
    topic: value.topic,
    rawPayload: JSON.parse(value.raw_payload_json) as unknown,
    decodedSchemaVersion: value.decoded_schema_version,
    decodedPayload: value.decoded_payload_json
      ? (JSON.parse(value.decoded_payload_json) as unknown)
      : null,
    sourceId: value.source_id,
    firstSeenAt: value.first_seen_at,
    updatedAt: value.updated_at,
  };
}

function migrationChecksum(migration: Migration): string {
  return createHash("sha256")
    .update(`${migration.version}\n${migration.name}\n${migration.sql}`)
    .digest("hex");
}

function serializeJson(value: unknown, field: string): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error(`${field} must be JSON-serializable: ${String(error)}`);
  }
  if (serialized === undefined) throw new Error(`${field} must be JSON-serializable`);
  return serialized;
}

function currentSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
  return z.number().int().nonnegative().parse(row?.user_version);
}

function applyMigrations(db: DatabaseSync, now: string): void {
  const current = currentSchemaVersion(db);
  const latest = migrations.at(-1)?.version ?? 0;
  if (current > latest) {
    throw new Error(`Database schema version ${current} is newer than supported version ${latest}`);
  }
  const migrationTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (current > 0 && !migrationTable) {
    throw new Error(`Database user_version is ${current}, but the migration ledger does not exist`);
  }
  if (!migrationTable) {
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  const appliedRows = db
    .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
    .all() as Array<{ version: number; name: string; checksum: string }>;
  const appliedByVersion = new Map(appliedRows.map((row) => [row.version, row] as const));
  for (const migration of migrations) {
    if (migration.version <= current && !appliedByVersion.has(migration.version)) {
      throw new Error(
        `Database user_version is ${current}, but migration ${migration.version} is not recorded`,
      );
    }
  }
  for (const row of appliedRows) {
    if (row.version > current) {
      throw new Error(
        `Migration ${row.version} is recorded beyond database user_version ${current}`,
      );
    }
    const migration = migrations.find(({ version }) => version === row.version);
    if (
      !migration ||
      migration.name !== row.name ||
      migrationChecksum(migration) !== row.checksum
    ) {
      throw new Error(`Applied migration ${row.version} does not match this Sidekick build`);
    }
  }

  const insertMigration = db.prepare(
    "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
  );
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      insertMigration.run(migration.version, migration.name, migrationChecksum(migration), now);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(`Failed to apply migration ${migration.version} (${migration.name})`, {
        cause: error,
      });
    }
  }
}

export interface OpenSidekickStoreResult {
  store: SidekickStore;
  backupPath: string | null;
}

export interface DatabaseBackupResult {
  sourcePath: string;
  destinationPath: string;
  sizeBytes: number;
  quickCheck: "ok";
}

export async function backupSidekickDatabase(
  sourcePath: string,
  destinationPath: string,
): Promise<DatabaseBackupResult> {
  if (sourcePath === ":memory:") throw new Error("An in-memory database cannot be backed up");
  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  if (source === destination) throw new Error("Backup destination must differ from the database");
  const sourceStat = await stat(source).catch(() => null);
  if (!sourceStat?.isFile() || sourceStat.size === 0) {
    throw new Error(`Sidekick database does not exist or is empty: ${source}`);
  }
  const destinationExists = await access(destination)
    .then(() => true)
    .catch(() => false);
  if (destinationExists) throw new Error(`Backup destination already exists: ${destination}`);

  await mkdir(dirname(destination), { recursive: true });
  const db = new DatabaseSync(source, { allowExtension: false, readOnly: true, timeout: 5_000 });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    await backup(db, destination);
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  } finally {
    db.close();
  }

  const verification = new DatabaseSync(destination, {
    allowExtension: false,
    readOnly: true,
    timeout: 5_000,
  });
  try {
    const quickCheck = verification.prepare("PRAGMA quick_check").get() as
      | { quick_check?: unknown }
      | undefined;
    if (quickCheck?.quick_check !== "ok") {
      throw new Error(`Backup integrity check failed: ${String(quickCheck?.quick_check)}`);
    }
    return {
      sourcePath: source,
      destinationPath: destination,
      sizeBytes: (await stat(destination)).size,
      quickCheck: "ok",
    };
  } finally {
    verification.close();
  }
}

export async function openSidekickStore(
  path: string,
  now = new Date().toISOString(),
): Promise<OpenSidekickStoreResult> {
  const isMemory = path === ":memory:";
  const databasePath = isMemory ? path : resolve(path);
  let existingSize = 0;
  if (!isMemory) {
    await mkdir(dirname(databasePath), { recursive: true });
    existingSize = await stat(databasePath)
      .then((value) => value.size)
      .catch(() => 0);
  }
  const db = new DatabaseSync(databasePath, { allowExtension: false, timeout: 5_000 });
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    if (isMemory) {
      db.exec("PRAGMA synchronous = NORMAL");
    } else {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = FULL");
      const synchronous = db.prepare("PRAGMA synchronous").get() as
        | { synchronous?: unknown }
        | undefined;
      if (synchronous?.synchronous !== 2) {
        throw new Error("File-backed Sidekick storage requires SQLite synchronous=FULL");
      }
    }

    const before = currentSchemaVersion(db);
    const latest = migrations.at(-1)?.version ?? 0;
    let backupPath: string | null = null;
    if (!isMemory && existingSize > 0 && before < latest) {
      const timestamp = now.replaceAll(":", "-");
      backupPath = `${databasePath}.v${before}.backup-${timestamp}`;
      await backup(db, backupPath);
    }
    applyMigrations(db, now);
    return { store: new SidekickStore(db), backupPath };
  } catch (error) {
    db.close();
    throw error;
  }
}

export function createChainSourceId(network: SidekickNetwork, baseUrl: string): string {
  const normalized = new URL(baseUrl).toString().replace(/\/$/, "");
  const digest = createHash("sha256").update(`${network}\n${normalized}`).digest("hex");
  return `api:${network}:${digest}`;
}

export function createNodeSourceId(network: SidekickNetwork, baseUrl: string): string {
  const normalized = new URL(baseUrl).toString().replace(/\/$/, "");
  const digest = createHash("sha256").update(`${network}\n${normalized}`).digest("hex");
  return `node:${network}:${digest}`;
}

const signerStakersStream = "signer-stakers";
const signerStakerRunColumns = `run_id, source_id, stream, manager_principal, status, cursor_next,
  pages_processed, items_processed, started_at, updated_at, completed_at, authoritative,
  reconciliation_complete,
  anchor_stacks_block_height, anchor_index_block_hash, anchor_burn_block_height,
  anchor_reward_cycle, anchor_reward_cycle_length, anchor_prepare_cycle_length,
  anchor_cycle_position, anchor_phase, anchor_checkpoint`;

function runChainAnchor(value: z.infer<typeof ingestionRunRowSchema>): ChainAnchor | null {
  const fields = [
    value.anchor_stacks_block_height,
    value.anchor_index_block_hash,
    value.anchor_burn_block_height,
    value.anchor_reward_cycle,
    value.anchor_reward_cycle_length,
    value.anchor_prepare_cycle_length,
    value.anchor_cycle_position,
    value.anchor_phase,
    value.anchor_checkpoint,
  ];
  if (fields.every((field) => field === null)) return null;
  if (fields.some((field) => field === null)) {
    throw new Error(`Signer-staker run ${value.run_id} has an incomplete chain anchor`);
  }
  return chainAnchorSchema.parse({
    stacksBlockHeight: value.anchor_stacks_block_height,
    indexBlockHash: value.anchor_index_block_hash,
    burnBlockHeight: value.anchor_burn_block_height,
    rewardCycle: value.anchor_reward_cycle,
    rewardCycleLength: value.anchor_reward_cycle_length,
    prepareCycleLength: value.anchor_prepare_cycle_length,
    cyclePosition: value.anchor_cycle_position,
    phase: value.anchor_phase,
    checkpoint: value.anchor_checkpoint,
  });
}

function sameChainAnchor(left: ChainAnchor | null, right: ChainAnchor | null): boolean {
  if (left === null || right === null) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

function toSignerStakerRun(row: unknown): SignerStakerRun {
  const value = ingestionRunRowSchema.parse(row);
  return {
    runId: value.run_id,
    sourceId: value.source_id,
    managerPrincipal: value.manager_principal,
    status: value.status,
    authoritative: value.authoritative === 1,
    reconciliationComplete: value.reconciliation_complete === 1,
    chainAnchor: runChainAnchor(value),
    cursor: value.cursor_next,
    pagesProcessed: value.pages_processed,
    itemsProcessed: value.items_processed,
    startedAt: value.started_at,
    updatedAt: value.updated_at,
    completedAt: value.completed_at,
  };
}

export class SidekickStore {
  readonly transactionEngine: TransactionEngineRepository;
  readonly walletIntents: WalletIntentRepository;

  constructor(private readonly db: DatabaseSync) {
    this.transactionEngine = new TransactionEngineRepository(db);
    this.walletIntents = new WalletIntentRepository(db);
  }

  close(): void {
    this.db.close();
  }

  schemaVersion(): number {
    return currentSchemaVersion(this.db);
  }

  databaseStatus(): {
    schemaVersion: number;
    journalMode: string;
    synchronous: number;
    foreignKeys: boolean;
  } {
    const journal = this.db.prepare("PRAGMA journal_mode").get() as
      | { journal_mode?: unknown }
      | undefined;
    const synchronous = this.db.prepare("PRAGMA synchronous").get() as
      | { synchronous?: unknown }
      | undefined;
    const foreignKeys = this.db.prepare("PRAGMA foreign_keys").get() as
      | { foreign_keys?: unknown }
      | undefined;
    return {
      schemaVersion: this.schemaVersion(),
      journalMode: z.string().parse(journal?.journal_mode),
      synchronous: z.number().int().min(0).max(3).parse(synchronous?.synchronous),
      foreignKeys: z.union([z.literal(0), z.literal(1)]).parse(foreignKeys?.foreign_keys) === 1,
    };
  }

  getDeploymentIdentity(): StoredDeploymentIdentity | null {
    const row = this.db
      .prepare(
        `SELECT schema_version, network, network_id, parent_network_id, manager_principal,
          binding_source, bound_at, last_verified_at, last_stacks_tip_height,
          last_burn_block_height, last_pox5_contract_id
         FROM deployment_identity WHERE singleton_id = 1`,
      )
      .get() as
      | {
          schema_version: number;
          network: string;
          network_id: number;
          parent_network_id: number | null;
          manager_principal: string;
          binding_source: string;
          bound_at: string;
          last_verified_at: string;
          last_stacks_tip_height: number;
          last_burn_block_height: number;
          last_pox5_contract_id: string;
        }
      | undefined;
    if (!row) return null;
    return {
      schemaVersion: z.literal(1).parse(row.schema_version),
      network: z.enum(["mainnet", "testnet", "devnet", "regtest"]).parse(row.network),
      networkId: z.number().int().nonnegative().max(0xffff_ffff).parse(row.network_id),
      parentNetworkId: z
        .number()
        .int()
        .nonnegative()
        .max(0xffff_ffff)
        .nullable()
        .parse(row.parent_network_id),
      managerPrincipal: principalSchema.parse(row.manager_principal),
      bindingSource: z.enum(["new", "legacy-evidence"]).parse(row.binding_source),
      boundAt: z.iso.datetime().parse(row.bound_at),
      lastVerifiedAt: z.iso.datetime().parse(row.last_verified_at),
      lastStacksTipHeight: z.number().int().nonnegative().parse(row.last_stacks_tip_height),
      lastBurnBlockHeight: z.number().int().nonnegative().parse(row.last_burn_block_height),
      lastPox5ContractId: principalSchema.parse(row.last_pox5_contract_id),
    };
  }

  inspectLegacyDeploymentEvidence(): LegacyDeploymentEvidence {
    const networks = this.db
      .prepare(
        `SELECT network FROM chain_sources
         UNION SELECT network FROM browser_wallet_intents
         ORDER BY network`,
      )
      .all()
      .map((row) =>
        z
          .enum(["mainnet", "testnet", "devnet", "regtest"])
          .parse((row as { network: unknown }).network),
      );
    const networkIds = this.db
      .prepare(
        `SELECT chain_id AS network_id FROM chain_events
         UNION SELECT chain_id AS network_id FROM manager_activity_events
         UNION SELECT chain_id AS network_id FROM browser_wallet_intents
         ORDER BY network_id`,
      )
      .all()
      .map((row) =>
        z
          .number()
          .int()
          .nonnegative()
          .max(0xffff_ffff)
          .parse((row as { network_id: unknown }).network_id),
      );
    const managerPrincipals = this.db
      .prepare(
        `SELECT manager_principal FROM ingestion_runs
         UNION SELECT manager_principal FROM stakers
         UNION SELECT manager_principal FROM stake_positions
         UNION SELECT manager_principal FROM cycle_memberships
         UNION SELECT manager_principal FROM staker_position_observations
         UNION SELECT manager_principal FROM pool_cycle_snapshots
         UNION SELECT manager_principal FROM reward_cycle_snapshots
         UNION SELECT manager_principal FROM staker_reward_cycle_snapshots
         UNION SELECT manager_principal FROM manager_activity_events
         UNION SELECT manager_principal FROM manager_trust_state
         UNION SELECT manager_principal FROM manager_trust_audit
         UNION SELECT manager_principal FROM transaction_jobs
         UNION SELECT json_extract(state_json, '$.managerPrincipal') AS manager_principal
           FROM onboarding_state
           WHERE json_type(state_json, '$.managerPrincipal') = 'text'
         ORDER BY manager_principal`,
      )
      .all()
      .map((row) =>
        z
          .string()
          .min(1)
          .parse((row as { manager_principal: unknown }).manager_principal),
      );
    const walletIntentManagers = this.db
      .prepare("SELECT DISTINCT scope FROM browser_wallet_intents ORDER BY scope")
      .all()
      .map((row) =>
        z
          .string()
          .min(1)
          .parse((row as { scope: unknown }).scope),
      )
      .filter((scope) => scope.includes(".") && validatePrincipal(scope));
    return {
      networks,
      networkIds,
      managerPrincipals: [...new Set([...managerPrincipals, ...walletIntentManagers])].sort(),
    };
  }

  bindDeploymentIdentity(input: {
    network: SidekickNetwork;
    networkId: number;
    parentNetworkId: number | null;
    managerPrincipal: string;
    bindingSource: "new" | "legacy-evidence";
    verifiedAt: string;
    stacksTipHeight: number;
    burnBlockHeight: number;
    pox5ContractId: string;
  }): StoredDeploymentIdentity {
    if (this.getDeploymentIdentity()) throw new Error("Deployment identity is already bound");
    const network = z.enum(["mainnet", "testnet", "devnet", "regtest"]).parse(input.network);
    const networkId = z.number().int().nonnegative().max(0xffff_ffff).parse(input.networkId);
    const parentNetworkId = z
      .number()
      .int()
      .nonnegative()
      .max(0xffff_ffff)
      .nullable()
      .parse(input.parentNetworkId);
    const managerPrincipal = principalSchema.parse(input.managerPrincipal);
    const bindingSource = z.enum(["new", "legacy-evidence"]).parse(input.bindingSource);
    const verifiedAt = z.iso.datetime().parse(input.verifiedAt);
    const stacksTipHeight = z.number().int().nonnegative().parse(input.stacksTipHeight);
    const burnBlockHeight = z.number().int().nonnegative().parse(input.burnBlockHeight);
    const pox5ContractId = principalSchema.parse(input.pox5ContractId);
    this.db
      .prepare(
        `INSERT INTO deployment_identity (
          singleton_id, schema_version, network, network_id, parent_network_id,
          manager_principal, binding_source, bound_at, last_verified_at,
          last_stacks_tip_height, last_burn_block_height, last_pox5_contract_id
        ) VALUES (1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        network,
        networkId,
        parentNetworkId,
        managerPrincipal,
        bindingSource,
        verifiedAt,
        verifiedAt,
        stacksTipHeight,
        burnBlockHeight,
        pox5ContractId,
      );
    const stored = this.getDeploymentIdentity();
    if (!stored) throw new Error("Deployment identity binding was not persisted");
    return stored;
  }

  recordDeploymentIdentityVerification(input: {
    network: SidekickNetwork;
    networkId: number;
    parentNetworkId: number | null;
    managerPrincipal: string;
    verifiedAt: string;
    stacksTipHeight: number;
    burnBlockHeight: number;
    pox5ContractId: string;
  }): StoredDeploymentIdentity {
    const verifiedAt = z.iso.datetime().parse(input.verifiedAt);
    const result = this.db
      .prepare(
        `UPDATE deployment_identity SET
          last_verified_at = ?, last_stacks_tip_height = ?, last_burn_block_height = ?,
          last_pox5_contract_id = ?
         WHERE singleton_id = 1 AND network = ? AND network_id = ?
           AND parent_network_id IS ? AND manager_principal = ?`,
      )
      .run(
        verifiedAt,
        z.number().int().nonnegative().parse(input.stacksTipHeight),
        z.number().int().nonnegative().parse(input.burnBlockHeight),
        principalSchema.parse(input.pox5ContractId),
        z.enum(["mainnet", "testnet", "devnet", "regtest"]).parse(input.network),
        z.number().int().nonnegative().max(0xffff_ffff).parse(input.networkId),
        z.number().int().nonnegative().max(0xffff_ffff).nullable().parse(input.parentNetworkId),
        principalSchema.parse(input.managerPrincipal),
      );
    if (result.changes !== 1) {
      throw new Error("Deployment identity does not match the verified connection");
    }
    const stored = this.getDeploymentIdentity();
    if (!stored) throw new Error("Deployment identity disappeared after verification");
    return stored;
  }

  getRuntimeSettings(): StoredRuntimeSettings | null {
    const row = this.db
      .prepare(
        `SELECT settings_json, api_key_secret, revision, updated_at
         FROM runtime_settings WHERE singleton_id = 1`,
      )
      .get() as
      | {
          settings_json: string;
          api_key_secret: string | null;
          revision: number;
          updated_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      settings: JSON.parse(row.settings_json) as unknown,
      apiKeySecret: row.api_key_secret,
      revision: z.number().int().positive().parse(row.revision),
      updatedAt: z.iso.datetime().parse(row.updated_at),
    };
  }

  putRuntimeSettings(input: {
    settings: unknown;
    apiKeySecret: string | null;
    changedFields: string[];
    observedAt: string;
  }): StoredRuntimeSettings {
    const observedAt = z.iso.datetime().parse(input.observedAt);
    const changedFields = z.array(z.string().min(1)).min(1).parse(input.changedFields);
    const settingsJson = serializeJson(input.settings, "runtime settings");
    const changedFieldsJson = serializeJson([...new Set(changedFields)].sort(), "changed fields");
    const existing = this.getRuntimeSettings();
    const revision = (existing?.revision ?? 0) + 1;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO runtime_settings (
            singleton_id, settings_json, api_key_secret, revision, updated_at
          ) VALUES (1, ?, ?, ?, ?)
          ON CONFLICT (singleton_id) DO UPDATE SET
            settings_json = excluded.settings_json,
            api_key_secret = excluded.api_key_secret,
            revision = excluded.revision,
            updated_at = excluded.updated_at`,
        )
        .run(settingsJson, input.apiKeySecret, revision, observedAt);
      this.db
        .prepare(
          `INSERT INTO settings_audit (
            audit_id, revision, changed_fields_json, changed_at
          ) VALUES (?, ?, ?, ?)`,
        )
        .run(randomUUID(), revision, changedFieldsJson, observedAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      settings: JSON.parse(settingsJson) as unknown,
      apiKeySecret: input.apiKeySecret,
      revision,
      updatedAt: observedAt,
    };
  }

  listSettingsAudit(limit = 20): Array<{
    revision: number;
    changedFields: string[];
    changedAt: string;
  }> {
    const parsedLimit = z.number().int().min(1).max(100).parse(limit);
    const rows = this.db
      .prepare(
        `SELECT revision, changed_fields_json, changed_at
         FROM settings_audit ORDER BY changed_at DESC, audit_id DESC LIMIT ?`,
      )
      .all(parsedLimit) as Array<{
      revision: number;
      changed_fields_json: string;
      changed_at: string;
    }>;
    return rows.map((row) => ({
      revision: z.number().int().positive().parse(row.revision),
      changedFields: z.array(z.string()).parse(JSON.parse(row.changed_fields_json)),
      changedAt: z.iso.datetime().parse(row.changed_at),
    }));
  }

  recordManagerTrustState(input: {
    managerPrincipal: string;
    recognitionTier: "reference-built-in" | "reference-render" | "custom-observe" | "unrecognized";
    profileId: string | null;
    profileOrigin: "built-in" | "operator-installed" | null;
    sourceSha256: string | null;
    canonicalSourceSha256: string | null;
    automationEligible: boolean;
    eligibilityReason: string;
    observedAt: string;
  }): {
    transition: "gained" | "lost" | "degraded";
    previousTier: string;
    currentTier: string;
    reason: string;
    changedAt: string;
  } | null {
    const managerPrincipal = z.string().min(1).parse(input.managerPrincipal);
    const recognitionTier = z
      .enum(["reference-built-in", "reference-render", "custom-observe", "unrecognized"])
      .parse(input.recognitionTier);
    const profileId = z.string().min(1).nullable().parse(input.profileId);
    const profileOrigin = z
      .enum(["built-in", "operator-installed"])
      .nullable()
      .parse(input.profileOrigin);
    const sourceSha256 = z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable()
      .parse(input.sourceSha256);
    const canonicalSourceSha256 = z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable()
      .parse(input.canonicalSourceSha256);
    const automationEligible = z.boolean().parse(input.automationEligible);
    const eligibilityReason = z.string().min(1).parse(input.eligibilityReason);
    const observedAt = z.iso.datetime().parse(input.observedAt);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db
        .prepare(
          `SELECT recognition_tier, profile_id, source_sha256, canonical_source_sha256,
                automation_eligible
         FROM manager_trust_state WHERE manager_principal = ?`,
        )
        .get(managerPrincipal) as
        | {
            recognition_tier: string;
            profile_id: string | null;
            source_sha256: string | null;
            canonical_source_sha256: string | null;
            automation_eligible: number;
          }
        | undefined;
      const tierRank = {
        "reference-built-in": 3,
        "reference-render": 3,
        "custom-observe": 1,
        unrecognized: 0,
      } as const;
      const previousTier = previous
        ? z
            .enum(["reference-built-in", "reference-render", "custom-observe", "unrecognized"])
            .parse(previous.recognition_tier)
        : null;
      const transition = !previous
        ? automationEligible
          ? "gained"
          : null
        : Boolean(previous.automation_eligible) !== automationEligible
          ? automationEligible
            ? "gained"
            : "lost"
          : previousTier && tierRank[recognitionTier] < tierRank[previousTier]
            ? "degraded"
            : null;
      this.db
        .prepare(
          `INSERT INTO manager_trust_state (
            manager_principal, recognition_tier, profile_id, profile_origin,
            source_sha256, canonical_source_sha256, automation_eligible,
            eligibility_reason, observed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (manager_principal) DO UPDATE SET
            recognition_tier = excluded.recognition_tier,
            profile_id = excluded.profile_id,
            profile_origin = excluded.profile_origin,
            source_sha256 = excluded.source_sha256,
            canonical_source_sha256 = excluded.canonical_source_sha256,
            automation_eligible = excluded.automation_eligible,
            eligibility_reason = excluded.eligibility_reason,
            observed_at = excluded.observed_at`,
        )
        .run(
          managerPrincipal,
          recognitionTier,
          profileId,
          profileOrigin,
          sourceSha256,
          canonicalSourceSha256,
          automationEligible ? 1 : 0,
          eligibilityReason,
          observedAt,
        );
      if (transition) {
        this.db
          .prepare(
            `INSERT INTO manager_trust_audit (
              event_id, manager_principal, transition, previous_tier, current_tier,
              previous_profile_id, current_profile_id,
              previous_source_sha256, current_source_sha256,
              previous_canonical_source_sha256, current_canonical_source_sha256,
              reason, changed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            managerPrincipal,
            transition,
            previous?.recognition_tier ?? "unobserved",
            recognitionTier,
            previous?.profile_id ?? null,
            profileId,
            previous?.source_sha256 ?? null,
            sourceSha256,
            previous?.canonical_source_sha256 ?? null,
            canonicalSourceSha256,
            eligibilityReason,
            observedAt,
          );
      }
      this.db.exec("COMMIT");
      return transition
        ? {
            transition,
            previousTier: previous?.recognition_tier ?? "unobserved",
            currentTier: recognitionTier,
            reason: eligibilityReason,
            changedAt: observedAt,
          }
        : null;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listManagerTrustAudit(
    managerPrincipal: string,
    limit = 20,
  ): Array<{
    transition: "gained" | "lost" | "degraded";
    previousTier: string;
    currentTier: string;
    previousProfileId: string | null;
    currentProfileId: string | null;
    previousSourceSha256: string | null;
    currentSourceSha256: string | null;
    previousCanonicalSourceSha256: string | null;
    currentCanonicalSourceSha256: string | null;
    reason: string;
    changedAt: string;
  }> {
    const principal = z.string().min(1).parse(managerPrincipal);
    const parsedLimit = z.number().int().min(1).max(100).parse(limit);
    const rows = this.db
      .prepare(
        `SELECT transition, previous_tier, current_tier, previous_profile_id,
                current_profile_id, previous_source_sha256, current_source_sha256,
                previous_canonical_source_sha256, current_canonical_source_sha256,
                reason, changed_at
         FROM manager_trust_audit
         WHERE manager_principal = ?
         ORDER BY changed_at DESC, event_id DESC LIMIT ?`,
      )
      .all(principal, parsedLimit) as Array<{
      transition: "gained" | "lost" | "degraded";
      previous_tier: string;
      current_tier: string;
      previous_profile_id: string | null;
      current_profile_id: string | null;
      previous_source_sha256: string | null;
      current_source_sha256: string | null;
      previous_canonical_source_sha256: string | null;
      current_canonical_source_sha256: string | null;
      reason: string;
      changed_at: string;
    }>;
    return rows.map((row) => ({
      transition: z.enum(["gained", "lost", "degraded"]).parse(row.transition),
      previousTier: z.string().parse(row.previous_tier),
      currentTier: z.string().parse(row.current_tier),
      previousProfileId: z.string().nullable().parse(row.previous_profile_id),
      currentProfileId: z.string().nullable().parse(row.current_profile_id),
      previousSourceSha256: z.string().nullable().parse(row.previous_source_sha256),
      currentSourceSha256: z.string().nullable().parse(row.current_source_sha256),
      previousCanonicalSourceSha256: z
        .string()
        .nullable()
        .parse(row.previous_canonical_source_sha256),
      currentCanonicalSourceSha256: z
        .string()
        .nullable()
        .parse(row.current_canonical_source_sha256),
      reason: z.string().min(1).parse(row.reason),
      changedAt: z.iso.datetime().parse(row.changed_at),
    }));
  }

  upsertChainSource(input: ChainSourceInput): void {
    const value = sourceInputSchema.parse(input);
    const result = this.db
      .prepare(
        `INSERT INTO chain_sources (
          source_id, kind, network, base_url, created_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (source_id) DO UPDATE SET
          last_seen_at = excluded.last_seen_at
        WHERE chain_sources.kind = excluded.kind
          AND chain_sources.network = excluded.network
          AND chain_sources.base_url = excluded.base_url`,
      )
      .run(
        value.sourceId,
        value.kind,
        value.network,
        value.baseUrl,
        value.observedAt,
        value.observedAt,
      );
    if (Number(result.changes) !== 1) {
      throw new Error(`Chain source ${value.sourceId} is already bound to different metadata`);
    }
  }

  putCursor(input: ChainCursorInput): void {
    const value = cursorInputSchema.parse(input);
    this.db
      .prepare(
        `INSERT INTO chain_cursors (
          source_id, stream, cursor, last_block_height, last_index_block_hash, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (source_id, stream) DO UPDATE SET
          cursor = excluded.cursor,
          last_block_height = excluded.last_block_height,
          last_index_block_hash = excluded.last_index_block_hash,
          updated_at = excluded.updated_at`,
      )
      .run(
        value.sourceId,
        value.stream,
        value.cursor,
        value.lastBlockHeight,
        value.lastIndexBlockHash,
        value.updatedAt,
      );
  }

  getCursor(sourceId: string, stream: string): ChainCursor | null {
    const row = this.db
      .prepare(
        `SELECT source_id, stream, cursor, last_block_height, last_index_block_hash, updated_at
         FROM chain_cursors WHERE source_id = ? AND stream = ?`,
      )
      .get(sourceId, stream);
    if (!row) return null;
    const value = cursorRowSchema.parse(row);
    return {
      sourceId: value.source_id,
      stream: value.stream,
      cursor: value.cursor,
      lastBlockHeight: value.last_block_height,
      lastIndexBlockHash: value.last_index_block_hash,
      updatedAt: value.updated_at,
    };
  }

  putChainEvent(input: ChainEventInput): void {
    const value = eventInputSchema.parse(input);
    const rawPayloadJson = serializeJson(value.rawPayload, "rawPayload");
    const decodedPayloadJson =
      value.decodedPayload === null ? null : serializeJson(value.decodedPayload, "decodedPayload");
    this.db.exec("SAVEPOINT put_chain_event");
    try {
      this.db
        .prepare(
          `INSERT INTO chain_events (
          chain_id, tx_id, event_index, block_height, block_hash, index_block_hash,
          microblock_hash, microblock_sequence, canonical, microblock_canonical,
          contract_id, topic, raw_payload_json, decoded_schema_version,
          decoded_payload_json, source_id, first_seen_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (chain_id, tx_id, event_index) DO UPDATE SET
          block_height = excluded.block_height,
          block_hash = excluded.block_hash,
          index_block_hash = excluded.index_block_hash,
          microblock_hash = excluded.microblock_hash,
          microblock_sequence = excluded.microblock_sequence,
          canonical = excluded.canonical,
          microblock_canonical = excluded.microblock_canonical,
          contract_id = excluded.contract_id,
          topic = excluded.topic,
          raw_payload_json = excluded.raw_payload_json,
          decoded_schema_version = excluded.decoded_schema_version,
          decoded_payload_json = excluded.decoded_payload_json,
          source_id = excluded.source_id,
          updated_at = excluded.updated_at`,
        )
        .run(
          value.chainId,
          value.txId,
          value.eventIndex,
          value.blockHeight,
          value.blockHash,
          value.indexBlockHash,
          value.microblockHash,
          value.microblockSequence,
          value.canonical ? 1 : 0,
          value.microblockCanonical ? 1 : 0,
          value.contractId,
          value.topic,
          rawPayloadJson,
          value.decodedSchemaVersion,
          decodedPayloadJson,
          value.sourceId,
          value.observedAt,
          value.observedAt,
        );
      this.putManagerActivityProjection(value);
      this.db.exec("RELEASE SAVEPOINT put_chain_event");
    } catch (error) {
      this.db.exec("ROLLBACK TO SAVEPOINT put_chain_event");
      this.db.exec("RELEASE SAVEPOINT put_chain_event");
      throw error;
    }
  }

  private putManagerActivityProjection(value: ChainEventInput): void {
    if (!value.contractId) return;
    // A replay may intentionally downgrade an event from a reviewed vocabulary to generic raw
    // storage. Remove any prior semantic projection before deciding whether the new observation
    // is eligible to recreate it.
    this.db
      .prepare(
        `DELETE FROM manager_activity_events
         WHERE chain_id = ? AND tx_id = ? AND event_index = ?`,
      )
      .run(value.chainId, value.txId, value.eventIndex);
    const parsed = managerActivityEnvelopeSchema.safeParse(value.decodedPayload);
    if (!parsed.success) return;
    const event = parsed.data.event;
    if (event.kind === "update-admin") return;
    const isClaim = event.kind === "claim-staker-rewards";
    const amountSats =
      event.kind === "settle-accepted-withdrawal" ? event.liabilityReleasedSats : event.amountSats;
    const requestId = isClaim ? event.l1Withdrawal?.requestId : event.requestId;
    this.db
      .prepare(
        `INSERT INTO manager_activity_events (
          chain_id, tx_id, event_index, manager_principal, block_height, canonical, kind,
          staker_principal, reward_cycle, bond_index, amount_sats, request_id,
          withdrawal_amount_sats, max_fee_sats, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (chain_id, tx_id, event_index) DO UPDATE SET
          manager_principal = excluded.manager_principal,
          block_height = excluded.block_height,
          canonical = excluded.canonical,
          kind = excluded.kind,
          staker_principal = excluded.staker_principal,
          reward_cycle = excluded.reward_cycle,
          bond_index = excluded.bond_index,
          amount_sats = excluded.amount_sats,
          request_id = excluded.request_id,
          withdrawal_amount_sats = excluded.withdrawal_amount_sats,
          max_fee_sats = excluded.max_fee_sats,
          updated_at = excluded.updated_at`,
      )
      .run(
        value.chainId,
        value.txId,
        value.eventIndex,
        value.contractId,
        value.blockHeight,
        value.canonical ? 1 : 0,
        event.kind,
        event.stakerPrincipal,
        isClaim ? event.rewardCycle : null,
        isClaim ? event.bondIndex : null,
        amountSats,
        requestId ?? null,
        isClaim ? (event.l1Withdrawal?.amountSats ?? null) : null,
        isClaim ? (event.l1Withdrawal?.maxFeeSats ?? null) : null,
        value.observedAt,
      );
  }

  putChainEventPage(events: readonly ChainEventInput[], cursor: ChainCursorInput): void {
    eventInputSchema.array().parse(events);
    cursorInputSchema.parse(cursor);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const event of events) this.putChainEvent(event);
      this.putCursor(cursor);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  hasChainEventsForContract(chainId: number, contractId: string): boolean {
    const parsedChainId = z.number().int().nonnegative().parse(chainId);
    const parsedContractId = principalSchema.parse(contractId);
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM chain_events
           WHERE chain_id = ? AND contract_id = ? AND canonical = 1
           LIMIT 1`,
        )
        .get(parsedChainId, parsedContractId),
    );
  }

  getChainEvent(chainId: number, txId: string, eventIndex: number): StoredChainEvent | null {
    const row = this.db
      .prepare(
        `SELECT chain_id, tx_id, event_index, block_height, block_hash, index_block_hash,
          microblock_hash, microblock_sequence, canonical, microblock_canonical,
          contract_id, topic, raw_payload_json, decoded_schema_version,
          decoded_payload_json, source_id, first_seen_at, updated_at
         FROM chain_events WHERE chain_id = ? AND tx_id = ? AND event_index = ?`,
      )
      .get(chainId, txId, eventIndex);
    if (!row) return null;
    return toStoredChainEvent(row);
  }

  listManagerClaims(
    chainId: number,
    managerPrincipal: string,
    options: {
      limit?: number;
      offset?: number;
      rewardCycle?: string | null;
      sort?: "cycle" | "staker" | "amount" | "destination" | "block" | "transaction";
      direction?: "asc" | "desc";
    } = {},
  ): ManagerActivityPage<StoredManagerClaim> {
    const parsedChainId = z.number().int().nonnegative().parse(chainId);
    const manager = principalSchema.parse(managerPrincipal);
    const limit = z
      .number()
      .int()
      .min(1)
      .max(200)
      .parse(options.limit ?? 50);
    const offset = z
      .number()
      .int()
      .nonnegative()
      .parse(options.offset ?? 0);
    const rewardCycle =
      options.rewardCycle === undefined || options.rewardCycle === null
        ? null
        : unsignedIntegerTextSchema.parse(options.rewardCycle);
    const direction = options.direction === "asc" ? "ASC" : "DESC";
    const claimOrder = {
      cycle: "CAST(reward_cycle AS INTEGER)",
      staker: "staker_principal",
      amount: "CAST(amount_sats AS INTEGER)",
      destination: "CASE WHEN request_id IS NULL THEN 'direct-sbtc' ELSE 'bitcoin-l1' END",
      block: "block_height",
      transaction: "tx_id",
    }[options.sort ?? "block"];
    const where = `chain_id = ? AND manager_principal = ? AND canonical = 1
      AND kind = 'claim-staker-rewards' AND (? IS NULL OR reward_cycle = ?)`;
    const totalRow = this.db
      .prepare(`SELECT count(*) AS count FROM manager_activity_events WHERE ${where}`)
      .get(parsedChainId, manager, rewardCycle, rewardCycle) as { count: number };
    const rows = this.db
      .prepare(
        `SELECT tx_id, event_index, block_height, staker_principal, reward_cycle,
          bond_index, amount_sats, request_id
         FROM manager_activity_events
         WHERE ${where}
         ORDER BY ${claimOrder} ${direction}, tx_id ${direction}, event_index ${direction}
         LIMIT ? OFFSET ?`,
      )
      .all(parsedChainId, manager, rewardCycle, rewardCycle, limit, offset);
    return {
      items: rows.map((row) => {
        const value = managerClaimRowSchema.parse(row);
        return {
          txId: value.tx_id,
          eventIndex: value.event_index,
          blockHeight: value.block_height,
          stakerPrincipal: value.staker_principal,
          rewardCycle: value.reward_cycle,
          bondIndex: value.bond_index,
          amountSats: value.amount_sats,
          destination: value.request_id === null ? "direct-sbtc" : "bitcoin-l1",
          withdrawalRequestId: value.request_id,
        };
      }),
      total: z.number().int().nonnegative().parse(totalRow.count),
      offset,
      limit,
    };
  }

  listManagerAdminUpdates(chainId: number, managerPrincipal: string): StoredManagerAdminUpdate[] {
    const manager = principalSchema.parse(managerPrincipal);
    const rows = this.db
      .prepare(
        `SELECT
           json_extract(decoded_payload_json, '$.event.adminPrincipal') AS admin_principal,
           json_extract(decoded_payload_json, '$.event.enabled') AS enabled,
           json_extract(raw_payload_json, '$.transactionIndex') AS transaction_index,
           block_height,
           event_index
         FROM chain_events
         WHERE chain_id = ?
           AND contract_id = ?
           AND canonical = 1
           AND json_extract(decoded_payload_json, '$.transactionStatus') = 'success'
           AND json_extract(decoded_payload_json, '$.event.kind') = 'update-admin'
         ORDER BY block_height ASC, transaction_index ASC, event_index ASC`,
      )
      .all(chainId, manager);
    return rows.map((row) => {
      const value = managerAdminUpdateRowSchema.parse(row);
      return {
        adminPrincipal: value.admin_principal,
        enabled: value.enabled === 1,
        transactionIndex: value.transaction_index,
        blockHeight: value.block_height,
        eventIndex: value.event_index,
      };
    });
  }

  listManagerWithdrawals(
    chainId: number,
    managerPrincipal: string,
    options: {
      limit?: number;
      offset?: number;
      state?: "pending" | "settled" | "reclaimed" | null;
      sort?: "request" | "staker" | "amount" | "max-fee" | "state" | "block";
      direction?: "asc" | "desc";
    } = {},
  ): ManagerActivityPage<StoredManagerWithdrawal> {
    const parsedChainId = z.number().int().nonnegative().parse(chainId);
    const manager = principalSchema.parse(managerPrincipal);
    const limit = z
      .number()
      .int()
      .min(1)
      .max(200)
      .parse(options.limit ?? 50);
    const offset = z
      .number()
      .int()
      .nonnegative()
      .parse(options.offset ?? 0);
    const state = z
      .enum(["pending", "settled", "reclaimed"])
      .nullable()
      .parse(options.state ?? null);
    const direction = options.direction === "asc" ? "ASC" : "DESC";
    const withdrawalOrder = {
      request: "CAST(request_id AS INTEGER)",
      staker: "staker_principal",
      amount: "CAST(amount_sats AS INTEGER)",
      "max-fee": "CAST(max_fee_sats AS INTEGER)",
      state: "state",
      block: "initiated_block_height",
    }[options.sort ?? "block"];
    const cte = `WITH withdrawal_state AS (
      SELECT
        initiation.request_id,
        initiation.staker_principal,
        initiation.withdrawal_amount_sats AS amount_sats,
        initiation.max_fee_sats,
        initiation.tx_id AS initiated_tx_id,
        initiation.block_height AS initiated_block_height,
        resolution.kind AS resolution_kind,
        resolution.tx_id AS resolved_tx_id,
        resolution.block_height AS resolved_block_height,
        CASE resolution.kind
          WHEN 'settle-accepted-withdrawal' THEN 'settled'
          WHEN 'reclaim-failed-withdrawal' THEN 'reclaimed'
          ELSE 'pending'
        END AS state
      FROM manager_activity_events AS initiation
      LEFT JOIN manager_activity_events AS resolution
        ON resolution.chain_id = initiation.chain_id
        AND resolution.manager_principal = initiation.manager_principal
        AND resolution.request_id = initiation.request_id
        AND resolution.canonical = 1
        AND resolution.kind IN ('settle-accepted-withdrawal', 'reclaim-failed-withdrawal')
        AND NOT EXISTS (
          SELECT 1 FROM manager_activity_events AS later
          WHERE later.chain_id = resolution.chain_id
            AND later.manager_principal = resolution.manager_principal
            AND later.request_id = resolution.request_id
            AND later.canonical = 1
            AND later.kind IN ('settle-accepted-withdrawal', 'reclaim-failed-withdrawal')
            AND (
              later.block_height > resolution.block_height
              OR (
                later.block_height = resolution.block_height
                AND (
                  later.tx_id > resolution.tx_id
                  OR (
                    later.tx_id = resolution.tx_id
                    AND later.event_index > resolution.event_index
                  )
                )
              )
            )
        )
      WHERE initiation.chain_id = ?
        AND initiation.manager_principal = ?
        AND initiation.canonical = 1
        AND initiation.kind = 'claim-staker-rewards'
        AND initiation.request_id IS NOT NULL
    )`;
    const totalRow = this.db
      .prepare(
        `${cte} SELECT count(*) AS count FROM withdrawal_state WHERE (? IS NULL OR state = ?)`,
      )
      .get(parsedChainId, manager, state, state) as { count: number };
    const rows = this.db
      .prepare(
        `${cte}
         SELECT request_id, staker_principal, amount_sats, max_fee_sats,
           initiated_tx_id, initiated_block_height, resolution_kind,
           resolved_tx_id, resolved_block_height
         FROM withdrawal_state
         WHERE (? IS NULL OR state = ?)
         ORDER BY ${withdrawalOrder} ${direction}, CAST(request_id AS INTEGER) ${direction}
         LIMIT ? OFFSET ?`,
      )
      .all(parsedChainId, manager, state, state, limit, offset);
    return {
      items: rows.map((row) => {
        const value = managerWithdrawalRowSchema.parse(row);
        return {
          requestId: value.request_id,
          stakerPrincipal: value.staker_principal,
          amountSats: value.amount_sats,
          maxFeeSats: value.max_fee_sats,
          initiatedTxId: value.initiated_tx_id,
          initiatedBlockHeight: value.initiated_block_height,
          state:
            value.resolution_kind === "settle-accepted-withdrawal"
              ? "settled"
              : value.resolution_kind === "reclaim-failed-withdrawal"
                ? "reclaimed"
                : "pending",
          resolvedTxId: value.resolved_tx_id,
          resolvedBlockHeight: value.resolved_block_height,
        };
      }),
      total: z.number().int().nonnegative().parse(totalRow.count),
      offset,
      limit,
    };
  }

  getManagerActivityMetadata(
    chainId: number,
    managerPrincipal: string,
  ): { eventCount: number; latestBlockHeight: number | null } {
    const parsedChainId = z.number().int().nonnegative().parse(chainId);
    const manager = principalSchema.parse(managerPrincipal);
    const row = this.db
      .prepare(
        `SELECT count(*) AS count, max(block_height) AS latest_block_height
         FROM manager_activity_events
         WHERE chain_id = ? AND manager_principal = ? AND canonical = 1`,
      )
      .get(parsedChainId, manager) as { count: number; latest_block_height: number | null };
    return {
      eventCount: z.number().int().nonnegative().parse(row.count),
      latestBlockHeight: z.number().int().nonnegative().nullable().parse(row.latest_block_height),
    };
  }

  markIndexBlockNonCanonical(chainId: number, indexBlockHash: string, updatedAt: string): number {
    const parsedChainId = z.number().int().nonnegative().parse(chainId);
    const parsedIndexBlockHash = hashSchema.parse(indexBlockHash);
    const parsedUpdatedAt = z.iso.datetime().parse(updatedAt);
    this.db.exec("SAVEPOINT mark_index_block_noncanonical");
    try {
      const result = this.db
        .prepare(
          `UPDATE chain_events SET canonical = 0, updated_at = ?
         WHERE chain_id = ? AND index_block_hash = ? AND canonical = 1`,
        )
        .run(parsedUpdatedAt, parsedChainId, parsedIndexBlockHash);
      this.db
        .prepare(
          `UPDATE manager_activity_events AS activity
         SET canonical = 0, updated_at = ?
         WHERE activity.chain_id = ? AND activity.canonical = 1
           AND EXISTS (
             SELECT 1 FROM chain_events AS event
             WHERE event.chain_id = activity.chain_id
               AND event.tx_id = activity.tx_id
               AND event.event_index = activity.event_index
               AND event.index_block_hash = ?
               AND event.canonical = 0
           )`,
        )
        .run(parsedUpdatedAt, parsedChainId, parsedIndexBlockHash);
      this.db.exec("RELEASE SAVEPOINT mark_index_block_noncanonical");
      return Number(result.changes);
    } catch (error) {
      this.db.exec("ROLLBACK TO SAVEPOINT mark_index_block_noncanonical");
      this.db.exec("RELEASE SAVEPOINT mark_index_block_noncanonical");
      throw error;
    }
  }

  markMissingCanonicalContractEvents(
    chainId: number,
    contractId: string,
    boundaryBlockHeight: number,
    includeBoundary: boolean,
    presentEventIds: ReadonlySet<string>,
    updatedAt: string,
  ): number {
    const parsedChainId = z.number().int().nonnegative().parse(chainId);
    const parsedContractId = principalSchema.parse(contractId);
    const parsedBoundary = z.number().int().nonnegative().parse(boundaryBlockHeight);
    const parsedUpdatedAt = z.iso.datetime().parse(updatedAt);
    const rows = this.db
      .prepare(
        `SELECT tx_id, event_index FROM chain_events
         WHERE chain_id = ? AND contract_id = ? AND canonical = 1
           AND block_height ${includeBoundary ? ">=" : ">"} ?`,
      )
      .all(parsedChainId, parsedContractId, parsedBoundary) as Array<{
      tx_id: string;
      event_index: number;
    }>;
    const update = this.db.prepare(
      `UPDATE chain_events SET canonical = 0, updated_at = ?
       WHERE chain_id = ? AND tx_id = ? AND event_index = ? AND canonical = 1`,
    );
    const updateProjection = this.db.prepare(
      `UPDATE manager_activity_events SET canonical = 0, updated_at = ?
       WHERE chain_id = ? AND tx_id = ? AND event_index = ? AND canonical = 1`,
    );
    let changed = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        if (presentEventIds.has(`${row.tx_id}:${row.event_index}`)) continue;
        changed += Number(
          update.run(parsedUpdatedAt, parsedChainId, row.tx_id, row.event_index).changes,
        );
        updateProjection.run(parsedUpdatedAt, parsedChainId, row.tx_id, row.event_index);
      }
      this.db.exec("COMMIT");
      return changed;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  startOrResumeSignerStakerRun(
    sourceId: string,
    managerPrincipal: string,
    now: string,
    chainAnchor?: ChainAnchor,
  ): SignerStakerRun {
    const parsedSourceId = z.string().min(1).parse(sourceId);
    const parsedManager = principalSchema.parse(managerPrincipal);
    const parsedNow = z.iso.datetime().parse(now);
    const parsedAnchor = chainAnchor ? chainAnchorSchema.parse(chainAnchor) : null;
    const selectRun = this.db.prepare(
      `SELECT ${signerStakerRunColumns}
       FROM ingestion_runs
       WHERE source_id = ? AND stream = ? AND manager_principal = ? AND status = 'running'`,
    );

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = selectRun.get(parsedSourceId, signerStakersStream, parsedManager);
      if (existing) {
        const result = toSignerStakerRun(existing);
        if (sameChainAnchor(result.chainAnchor, parsedAnchor)) {
          this.db.exec("COMMIT");
          return result;
        }
        this.db
          .prepare(
            `UPDATE ingestion_runs SET status = 'completed', authoritative = 0,
              updated_at = ?, completed_at = ? WHERE run_id = ?`,
          )
          .run(parsedNow, parsedNow, result.runId);
      }

      const runId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO ingestion_runs (
            run_id, source_id, stream, manager_principal, status, cursor_next,
            pages_processed, items_processed, started_at, updated_at, completed_at, authoritative,
            reconciliation_complete,
            anchor_stacks_block_height, anchor_index_block_hash, anchor_burn_block_height,
            anchor_reward_cycle, anchor_reward_cycle_length, anchor_prepare_cycle_length,
            anchor_cycle_position, anchor_phase, anchor_checkpoint
          ) VALUES (
            ?, ?, ?, ?, 'running', NULL, 0, 0, ?, ?, NULL, 0, 1,
            ?, ?, ?, ?, ?, ?, ?, ?, ?
          )`,
        )
        .run(
          runId,
          parsedSourceId,
          signerStakersStream,
          parsedManager,
          parsedNow,
          parsedNow,
          parsedAnchor?.stacksBlockHeight ?? null,
          parsedAnchor?.indexBlockHash ?? null,
          parsedAnchor?.burnBlockHeight ?? null,
          parsedAnchor?.rewardCycle ?? null,
          parsedAnchor?.rewardCycleLength ?? null,
          parsedAnchor?.prepareCycleLength ?? null,
          parsedAnchor?.cyclePosition ?? null,
          parsedAnchor?.phase ?? null,
          parsedAnchor?.checkpoint ?? null,
        );
      const created = selectRun.get(parsedSourceId, signerStakersStream, parsedManager);
      if (!created) throw new Error("Created signer-staker run could not be read back");
      const result = toSignerStakerRun(created);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getResumableSignerStakerRun(sourceId: string, managerPrincipal: string): SignerStakerRun | null {
    const parsedSourceId = z.string().min(1).parse(sourceId);
    const parsedManager = principalSchema.parse(managerPrincipal);
    const row = this.db
      .prepare(
        `SELECT ingestion_runs.*
         FROM ingestion_runs AS ingestion_runs
         JOIN signer_staker_api_scans AS scans ON scans.run_id = ingestion_runs.run_id
         WHERE ingestion_runs.source_id = ? AND ingestion_runs.stream = ?
           AND ingestion_runs.manager_principal = ? AND ingestion_runs.status = 'running'
           AND scans.sealed = 1 AND scans.anchor_fenced = 1`,
      )
      .get(parsedSourceId, signerStakersStream, parsedManager);
    return row ? toSignerStakerRun(row) : null;
  }

  abandonSealedSignerStakerRun(runId: string, now: string): void {
    const parsedRunId = z.string().uuid().parse(runId);
    const parsedNow = z.iso.datetime().parse(now);
    const result = this.db
      .prepare(
        `UPDATE ingestion_runs
         SET status = 'completed', authoritative = 0, reconciliation_complete = 0,
           updated_at = ?, completed_at = ?
         WHERE run_id = ? AND stream = ? AND status = 'running'
           AND EXISTS (
             SELECT 1 FROM signer_staker_api_scans
             WHERE signer_staker_api_scans.run_id = ingestion_runs.run_id
               AND sealed = 1 AND anchor_fenced = 1
           )`,
      )
      .run(parsedNow, parsedNow, parsedRunId, signerStakersStream);
    if (Number(result.changes) !== 1) {
      throw new Error(`Signer-staker run ${parsedRunId} is not active`);
    }
  }

  commitSignerStakerApiPage(
    input: z.input<typeof signerStakerApiPageInputSchema>,
  ): SignerStakerRun {
    const value = signerStakerApiPageInputSchema.parse(input);
    const uniqueStakers = new Set(value.items.map((item) => item.stakerPrincipal));
    if (uniqueStakers.size !== value.items.length) {
      throw new Error("Signer-staker API page contains duplicate staker principals");
    }

    const selectRun = this.db.prepare(
      `SELECT ${signerStakerRunColumns} FROM ingestion_runs WHERE run_id = ?`,
    );
    const selectScan = this.db.prepare(
      `SELECT expected_total, sealed, anchor_fenced
       FROM signer_staker_api_scans WHERE run_id = ?`,
    );
    const insertScan = this.db.prepare(
      `INSERT INTO signer_staker_api_scans (
        run_id, expected_total, sealed, anchor_fenced
      ) VALUES (?, ?, 0, 0)`,
    );
    const insertItem = this.db.prepare(
      `INSERT INTO signer_staker_api_scan_items (
        run_id, ordinal, staker_principal, has_stx, has_btc
      ) VALUES (?, ?, ?, ?, ?)`,
    );

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = toSignerStakerRun(selectRun.get(value.runId));
      if (
        current.status !== "running" ||
        current.sourceId !== value.sourceId ||
        current.managerPrincipal !== value.managerPrincipal ||
        !sameChainAnchor(current.chainAnchor, value.chainAnchor ?? null)
      ) {
        throw new Error(
          `Signer-staker run ${value.runId} is not active for this source and manager`,
        );
      }
      if (current.cursor !== value.requestedCursor) {
        throw new Error(
          `Signer-staker run ${value.runId} moved from cursor ${value.requestedCursor ?? "<initial>"}`,
        );
      }

      let scan = selectScan.get(value.runId) as
        | { expected_total: unknown; sealed: unknown; anchor_fenced: unknown }
        | undefined;
      if (!scan) {
        insertScan.run(value.runId, value.expectedTotal);
        scan = selectScan.get(value.runId) as {
          expected_total: unknown;
          sealed: unknown;
          anchor_fenced: unknown;
        };
      }
      const scanValue = z
        .object({
          expected_total: z.number().int().nonnegative(),
          sealed: z.union([z.literal(0), z.literal(1)]),
          anchor_fenced: z.union([z.literal(0), z.literal(1)]),
        })
        .parse(scan);
      if (scanValue.sealed === 1) {
        throw new Error(`Signer-staker API roster ${value.runId} is already sealed`);
      }
      if (scanValue.expected_total !== value.expectedTotal) {
        throw new Error(
          `Signer-staker API total changed from ${scanValue.expected_total} to ${value.expectedTotal}`,
        );
      }

      const itemsProcessed = current.itemsProcessed + value.items.length;
      if (itemsProcessed > value.expectedTotal) {
        throw new Error(
          `Signer-staker API returned ${itemsProcessed} items for total ${value.expectedTotal}`,
        );
      }
      if (value.sealed && itemsProcessed !== value.expectedTotal) {
        throw new Error(
          `Signer-staker API ended after ${itemsProcessed} of ${value.expectedTotal} items`,
        );
      }

      for (const [index, item] of value.items.entries()) {
        insertItem.run(
          value.runId,
          current.itemsProcessed + index,
          item.stakerPrincipal,
          item.hasStx ? 1 : 0,
          item.hasBtc ? 1 : 0,
        );
      }
      this.db
        .prepare(
          `UPDATE signer_staker_api_scans
           SET sealed = ?, anchor_fenced = ?
           WHERE run_id = ?`,
        )
        .run(value.sealed ? 1 : 0, value.anchorFenced ? 1 : 0, value.runId);
      this.db
        .prepare(
          `UPDATE ingestion_runs SET
            cursor_next = ?, pages_processed = pages_processed + 1,
            items_processed = items_processed + ?, updated_at = ?
           WHERE run_id = ?`,
        )
        .run(value.nextCursor, value.items.length, value.observedAt, value.runId);

      const updated = selectRun.get(value.runId);
      const result = toSignerStakerRun(updated);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getSignerStakerApiScan(runId: string): SignerStakerApiScan | null {
    const parsedRunId = z.string().uuid().parse(runId);
    const scan = this.db
      .prepare(
        `SELECT expected_total, sealed, anchor_fenced
         FROM signer_staker_api_scans WHERE run_id = ?`,
      )
      .get(parsedRunId);
    if (!scan) return null;
    const value = z
      .object({
        expected_total: z.number().int().nonnegative(),
        sealed: z.union([z.literal(0), z.literal(1)]),
        anchor_fenced: z.union([z.literal(0), z.literal(1)]),
      })
      .parse(scan);
    const rows = this.db
      .prepare(
        `SELECT staker_principal, has_stx, has_btc
         FROM signer_staker_api_scan_items
         WHERE run_id = ? ORDER BY ordinal`,
      )
      .all(parsedRunId);
    const items = rows.map((row) => {
      const item = z
        .object({
          staker_principal: principalSchema,
          has_stx: z.union([z.literal(0), z.literal(1)]),
          has_btc: z.union([z.literal(0), z.literal(1)]),
        })
        .parse(row);
      return signerStakerApiCandidateSchema.parse({
        stakerPrincipal: item.staker_principal,
        hasStx: item.has_stx === 1,
        hasBtc: item.has_btc === 1,
      });
    });
    if (items.length > value.expected_total) {
      throw new Error(`Signer-staker API roster ${parsedRunId} exceeds its expected total`);
    }
    if (value.sealed === 1 && items.length !== value.expected_total) {
      throw new Error(`Sealed signer-staker API roster ${parsedRunId} is incomplete`);
    }
    return {
      sealed: value.sealed === 1,
      anchorFenced: value.anchor_fenced === 1,
      expectedTotal: value.expected_total,
      items,
    };
  }

  commitSignerStakerPage(input: SignerStakerPageInput): SignerStakerRun {
    const value = signerStakerPageInputSchema.parse(input);
    const uniqueStakers = new Set(value.items.map((item) => item.stakerPrincipal));
    if (uniqueStakers.size !== value.items.length) {
      throw new Error("Signer-staker API page contains duplicate staker principals");
    }
    for (const item of value.items) {
      const position = item.position;
      if (position) {
        const cycles = position.cycleMemberships.map(({ rewardCycle }) => rewardCycle);
        if (new Set(cycles.map(String)).size !== cycles.length) {
          throw new Error(`Trusted position for ${item.stakerPrincipal} has duplicate cycles`);
        }
        if (
          position.cycleMemberships.some(
            ({ signerPrincipal }) => signerPrincipal !== value.managerPrincipal,
          )
        ) {
          throw new Error(
            `Trusted position for ${item.stakerPrincipal} has a cycle assigned to another signer`,
          );
        }
        const unlockCycle = position.firstRewardCycle + position.numCycles;
        if (
          position.cycleMemberships.some(
            ({ rewardCycle }) =>
              rewardCycle < position.firstRewardCycle || rewardCycle >= unlockCycle,
          )
        ) {
          throw new Error(`Trusted position for ${item.stakerPrincipal} has an out-of-range cycle`);
        }
      }
    }

    const selectRun = this.db.prepare(
      `SELECT ${signerStakerRunColumns} FROM ingestion_runs WHERE run_id = ?`,
    );
    const upsertStaker = this.db.prepare(
      `INSERT INTO stakers (
        manager_principal, staker_principal, has_stx, has_btc, stx_node_verified,
        bond_node_verified, bond_index, bond_amount_ustx, bond_amount_sats, bond_is_l1_lock,
        active, source_id, verification_source_id, last_seen_run_id, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (manager_principal, staker_principal) DO UPDATE SET
        has_stx = excluded.has_stx,
        has_btc = excluded.has_btc,
        stx_node_verified = excluded.stx_node_verified,
        bond_node_verified = excluded.bond_node_verified,
        bond_index = excluded.bond_index,
        bond_amount_ustx = excluded.bond_amount_ustx,
        bond_amount_sats = excluded.bond_amount_sats,
        bond_is_l1_lock = excluded.bond_is_l1_lock,
        active = excluded.active,
        source_id = excluded.source_id,
        verification_source_id = excluded.verification_source_id,
        last_seen_run_id = excluded.last_seen_run_id,
        last_seen_at = excluded.last_seen_at`,
    );
    const deactivatePosition = this.db.prepare(
      `UPDATE stake_positions SET active = 0, updated_at = ?
       WHERE manager_principal = ? AND staker_principal = ? AND active = 1`,
    );
    const deactivateMemberships = this.db.prepare(
      `UPDATE cycle_memberships SET active = 0, updated_at = ?
       WHERE manager_principal = ? AND staker_principal = ? AND active = 1`,
    );
    const upsertPosition = this.db.prepare(
      `INSERT INTO stake_positions (
        manager_principal, staker_principal, signer_principal, amount_ustx,
        first_reward_cycle, num_cycles, unlock_cycle, unlock_burn_height, active, discovery_source_id,
        verification_source_id, last_seen_run_id, observed_burn_block_height,
        observed_stacks_tip_height, observed_index_block_hash, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (manager_principal, staker_principal) DO UPDATE SET
        signer_principal = excluded.signer_principal,
        amount_ustx = excluded.amount_ustx,
        first_reward_cycle = excluded.first_reward_cycle,
        num_cycles = excluded.num_cycles,
        unlock_cycle = excluded.unlock_cycle,
        unlock_burn_height = excluded.unlock_burn_height,
        active = excluded.active,
        discovery_source_id = excluded.discovery_source_id,
        verification_source_id = excluded.verification_source_id,
        last_seen_run_id = excluded.last_seen_run_id,
        observed_burn_block_height = excluded.observed_burn_block_height,
        observed_stacks_tip_height = excluded.observed_stacks_tip_height,
        observed_index_block_hash = excluded.observed_index_block_hash,
        updated_at = excluded.updated_at`,
    );
    const upsertMembership = this.db.prepare(
      `INSERT INTO cycle_memberships (
        manager_principal, staker_principal, reward_cycle, signer_principal, amount_ustx, active,
        discovery_source_id, verification_source_id, last_seen_run_id, observed_burn_block_height,
        observed_stacks_tip_height, observed_index_block_hash, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (manager_principal, staker_principal, reward_cycle) DO UPDATE SET
        amount_ustx = excluded.amount_ustx,
        signer_principal = excluded.signer_principal,
        active = 1,
        discovery_source_id = excluded.discovery_source_id,
        verification_source_id = excluded.verification_source_id,
        last_seen_run_id = excluded.last_seen_run_id,
        observed_burn_block_height = excluded.observed_burn_block_height,
        observed_stacks_tip_height = excluded.observed_stacks_tip_height,
        observed_index_block_hash = excluded.observed_index_block_hash,
        updated_at = excluded.updated_at`,
    );
    const putPositionObservation = this.db.prepare(
      `INSERT INTO staker_position_observations (
        manager_principal, staker_principal, observed_burn_block_height,
        observed_stacks_tip_height, has_stx, has_btc, stx_node_verified,
        position_present, signer_principal, amount_ustx, first_reward_cycle,
        num_cycles, unlock_cycle, unlock_burn_height, source_id,
        verification_source_id, observed_index_block_hash, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (
        manager_principal, staker_principal,
        observed_burn_block_height, observed_stacks_tip_height
      ) DO UPDATE SET
        has_stx = excluded.has_stx,
        has_btc = excluded.has_btc,
        stx_node_verified = excluded.stx_node_verified,
        position_present = excluded.position_present,
        signer_principal = excluded.signer_principal,
        amount_ustx = excluded.amount_ustx,
        first_reward_cycle = excluded.first_reward_cycle,
        num_cycles = excluded.num_cycles,
        unlock_cycle = excluded.unlock_cycle,
        unlock_burn_height = excluded.unlock_burn_height,
        source_id = excluded.source_id,
        verification_source_id = excluded.verification_source_id,
        observed_index_block_hash = excluded.observed_index_block_hash,
        observed_at = excluded.observed_at`,
    );

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = toSignerStakerRun(selectRun.get(value.runId));
      if (
        current.status !== "running" ||
        current.sourceId !== value.sourceId ||
        current.managerPrincipal !== value.managerPrincipal ||
        !sameChainAnchor(current.chainAnchor, value.chainAnchor ?? null)
      ) {
        throw new Error(
          `Signer-staker run ${value.runId} is not active for this source and manager`,
        );
      }

      for (const item of value.items) {
        upsertStaker.run(
          value.managerPrincipal,
          item.stakerPrincipal,
          item.hasStx ? 1 : 0,
          item.hasBtc ? 1 : 0,
          item.stxNodeVerified === null ? null : item.stxNodeVerified ? 1 : 0,
          // Written on every anchored verification pass, so a bond that ends is cleared rather
          // than left behind as a stale membership.
          item.reconciliationComplete ? 1 : 0,
          item.bond === null ? null : item.bond.bondIndex.toString(),
          item.bond === null ? null : item.bond.amountUstx.toString(),
          item.bond === null ? null : item.bond.amountSats.toString(),
          item.bond === null ? null : item.bond.isL1Lock ? 1 : 0,
          item.active ? 1 : 0,
          value.sourceId,
          item.hasStx ? value.nodeSourceId : null,
          value.runId,
          value.observedAt,
          value.observedAt,
        );
        if (item.reconciliationComplete) {
          deactivatePosition.run(value.observedAt, value.managerPrincipal, item.stakerPrincipal);
          deactivateMemberships.run(value.observedAt, value.managerPrincipal, item.stakerPrincipal);
        }

        const observedPosition = item.position;
        putPositionObservation.run(
          value.managerPrincipal,
          item.stakerPrincipal,
          value.burnBlockHeight,
          value.stacksTipHeight,
          item.hasStx ? 1 : 0,
          item.hasBtc ? 1 : 0,
          item.stxNodeVerified === null ? null : item.stxNodeVerified ? 1 : 0,
          observedPosition ? 1 : 0,
          observedPosition?.signerPrincipal ?? null,
          observedPosition?.amountUstx.toString() ?? null,
          observedPosition?.firstRewardCycle.toString() ?? null,
          observedPosition?.numCycles.toString() ?? null,
          observedPosition
            ? (observedPosition.firstRewardCycle + observedPosition.numCycles).toString()
            : null,
          observedPosition?.unlockBurnHeight?.toString() ?? null,
          value.sourceId,
          item.hasStx ? value.nodeSourceId : null,
          value.chainAnchor?.indexBlockHash ?? null,
          value.observedAt,
        );

        if (!item.reconciliationComplete || !observedPosition) continue;
        const position = observedPosition;
        const unlockCycle = position.firstRewardCycle + position.numCycles;
        upsertPosition.run(
          value.managerPrincipal,
          item.stakerPrincipal,
          position.signerPrincipal,
          position.amountUstx.toString(),
          position.firstRewardCycle.toString(),
          position.numCycles.toString(),
          unlockCycle.toString(),
          position.unlockBurnHeight?.toString() ?? null,
          item.active ? 1 : 0,
          value.sourceId,
          value.nodeSourceId,
          value.runId,
          value.burnBlockHeight,
          value.stacksTipHeight,
          value.chainAnchor?.indexBlockHash ?? null,
          value.observedAt,
        );
        for (const membership of position.cycleMemberships) {
          upsertMembership.run(
            value.managerPrincipal,
            item.stakerPrincipal,
            membership.rewardCycle.toString(),
            membership.signerPrincipal,
            membership.amountUstx.toString(),
            value.sourceId,
            value.nodeSourceId,
            value.runId,
            value.burnBlockHeight,
            value.stacksTipHeight,
            value.chainAnchor?.indexBlockHash ?? null,
            value.observedAt,
          );
        }
      }

      const completed = value.nextCursor === null;
      const pageReconciliationComplete = value.items.every((item) => item.reconciliationComplete);
      const authoritative =
        completed &&
        current.reconciliationComplete &&
        pageReconciliationComplete &&
        (value.authoritativeCompletion ?? value.chainAnchor === undefined);
      if (authoritative) {
        this.db
          .prepare(
            `UPDATE stakers SET active = 0
             WHERE manager_principal = ? AND active = 1 AND last_seen_run_id <> ?`,
          )
          .run(value.managerPrincipal, value.runId);
        this.db
          .prepare(
            `UPDATE stake_positions SET active = 0, updated_at = ?
             WHERE manager_principal = ? AND active = 1 AND last_seen_run_id <> ?`,
          )
          .run(value.observedAt, value.managerPrincipal, value.runId);
        this.db
          .prepare(
            `UPDATE cycle_memberships SET active = 0, updated_at = ?
             WHERE manager_principal = ? AND active = 1 AND last_seen_run_id <> ?`,
          )
          .run(value.observedAt, value.managerPrincipal, value.runId);
      }
      this.db
        .prepare(
          `UPDATE ingestion_runs SET
            status = ?, cursor_next = ?, pages_processed = pages_processed + ?,
            items_processed = items_processed + ?, authoritative = ?,
            reconciliation_complete = reconciliation_complete AND ?,
            updated_at = ?, completed_at = ?
           WHERE run_id = ?`,
        )
        .run(
          completed ? "completed" : "running",
          value.nextCursor,
          value.recordApiPage ? 1 : 0,
          value.apiItemsProcessed ?? value.items.length,
          authoritative ? 1 : 0,
          pageReconciliationComplete ? 1 : 0,
          value.observedAt,
          completed ? value.observedAt : null,
          value.runId,
        );
      const updated = selectRun.get(value.runId);
      const result = toSignerStakerRun(updated);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listSignerStakers(
    managerPrincipal: string,
    activeOnly = true,
    sourceId: string | null = null,
  ): StoredSignerStaker[] {
    const manager = principalSchema.parse(managerPrincipal);
    const parsedSourceId = sourceId === null ? null : z.string().min(1).parse(sourceId);
    const rows = this.db
      .prepare(
        `SELECT s.manager_principal, s.staker_principal, s.has_stx, s.has_btc,
          s.stx_node_verified, s.bond_node_verified, s.bond_index, s.bond_amount_ustx,
          s.bond_amount_sats, s.bond_is_l1_lock, s.active, s.source_id, s.last_seen_run_id,
          s.verification_source_id, s.first_seen_at, s.last_seen_at,
          p.signer_principal, p.amount_ustx,
          p.first_reward_cycle, p.num_cycles, p.unlock_cycle, p.unlock_burn_height,
          p.active AS position_active
         FROM stakers s
         LEFT JOIN stake_positions p
           ON p.manager_principal = s.manager_principal
          AND p.staker_principal = s.staker_principal
         WHERE s.manager_principal = ?
           AND (? = 0 OR s.active = 1)
           AND (? IS NULL OR s.source_id = ?)
         ORDER BY s.staker_principal`,
      )
      .all(manager, activeOnly ? 1 : 0, parsedSourceId, parsedSourceId);
    return rows.map((row) => {
      const value = storedSignerStakerRowSchema.parse(row);
      return {
        managerPrincipal: value.manager_principal,
        stakerPrincipal: value.staker_principal,
        hasStx: value.has_stx === 1,
        hasBtc: value.has_btc === 1,
        stxNodeVerified: value.stx_node_verified === null ? null : value.stx_node_verified === 1,
        bond:
          value.bond_index === null
            ? null
            : {
                bondIndex: BigInt(value.bond_index),
                amountUstx: BigInt(value.bond_amount_ustx ?? "0"),
                amountSats: BigInt(value.bond_amount_sats ?? "0"),
                isL1Lock: value.bond_is_l1_lock === 1,
              },
        active: value.active === 1,
        sourceId: value.source_id,
        verificationSourceId: value.verification_source_id,
        lastSeenRunId: value.last_seen_run_id,
        firstSeenAt: value.first_seen_at,
        lastSeenAt: value.last_seen_at,
        position:
          value.signer_principal === null ||
          value.amount_ustx === null ||
          value.first_reward_cycle === null ||
          value.num_cycles === null ||
          value.unlock_cycle === null ||
          value.position_active === null
            ? null
            : {
                signerPrincipal: value.signer_principal,
                amountUstx: BigInt(value.amount_ustx),
                firstRewardCycle: BigInt(value.first_reward_cycle),
                numCycles: BigInt(value.num_cycles),
                unlockCycle: BigInt(value.unlock_cycle),
                unlockBurnHeight:
                  value.unlock_burn_height === null ? null : BigInt(value.unlock_burn_height),
                active: value.position_active === 1,
              },
      };
    });
  }

  listCycleMemberships(
    managerPrincipal: string,
    activeOnly = true,
    sourceId: string | null = null,
  ): StoredCycleMembership[] {
    const manager = principalSchema.parse(managerPrincipal);
    const parsedSourceId = sourceId === null ? null : z.string().min(1).parse(sourceId);
    const rows = this.db
      .prepare(
        `SELECT staker_principal, reward_cycle, signer_principal, amount_ustx, active
         FROM cycle_memberships
         WHERE manager_principal = ?
           AND (? = 0 OR active = 1)
           AND (? IS NULL OR discovery_source_id = ?)
         ORDER BY length(reward_cycle), reward_cycle, staker_principal`,
      )
      .all(manager, activeOnly ? 1 : 0, parsedSourceId, parsedSourceId);
    return rows.map((row) => {
      const value = cycleMembershipRowSchema.parse(row);
      return {
        stakerPrincipal: value.staker_principal,
        rewardCycle: BigInt(value.reward_cycle),
        signerPrincipal: value.signer_principal,
        amountUstx: BigInt(value.amount_ustx),
        active: value.active === 1,
      };
    });
  }

  listCycleMembershipsForCycle(
    managerPrincipal: string,
    rewardCycle: number,
    sourceId: string | null = null,
  ): StoredCycleMembership[] {
    const manager = principalSchema.parse(managerPrincipal);
    const cycle = z.number().int().nonnegative().parse(rewardCycle).toString();
    const parsedSourceId = sourceId === null ? null : z.string().min(1).parse(sourceId);
    const rows = this.db
      .prepare(
        `SELECT staker_principal, reward_cycle, signer_principal, amount_ustx, active
         FROM cycle_memberships
         WHERE manager_principal = ?
           AND reward_cycle = ?
           AND (? IS NULL OR discovery_source_id = ?)
         ORDER BY staker_principal`,
      )
      .all(manager, cycle, parsedSourceId, parsedSourceId);
    return rows.map((row) => {
      const value = cycleMembershipRowSchema.parse(row);
      return {
        stakerPrincipal: value.staker_principal,
        rewardCycle: BigInt(value.reward_cycle),
        signerPrincipal: value.signer_principal,
        amountUstx: BigInt(value.amount_ustx),
        active: value.active === 1,
      };
    });
  }

  listStakerPositionObservations(
    managerPrincipal: string,
    stakerPrincipal: string,
    limit = 100,
  ): StoredStakerPositionObservation[] {
    const manager = principalSchema.parse(managerPrincipal);
    const staker = principalSchema.parse(stakerPrincipal);
    const parsedLimit = z.number().int().min(1).max(500).parse(limit);
    const rows = this.db
      .prepare(
        `SELECT manager_principal, staker_principal, observed_burn_block_height,
          observed_stacks_tip_height, observed_index_block_hash,
          has_stx, has_btc, stx_node_verified,
          position_present, signer_principal, amount_ustx, first_reward_cycle,
          num_cycles, unlock_cycle, unlock_burn_height, observed_at
         FROM staker_position_observations
         WHERE manager_principal = ? AND staker_principal = ?
         ORDER BY observed_burn_block_height DESC, observed_stacks_tip_height DESC
         LIMIT ?`,
      )
      .all(manager, staker, parsedLimit);
    return rows.map((row) => {
      const value = stakerPositionObservationRowSchema.parse(row);
      const position =
        value.position_present === 1 &&
        value.signer_principal !== null &&
        value.amount_ustx !== null &&
        value.first_reward_cycle !== null &&
        value.num_cycles !== null &&
        value.unlock_cycle !== null
          ? {
              signerPrincipal: value.signer_principal,
              amountUstx: value.amount_ustx,
              firstRewardCycle: value.first_reward_cycle,
              numCycles: value.num_cycles,
              unlockCycle: value.unlock_cycle,
              unlockBurnHeight: value.unlock_burn_height,
            }
          : null;
      return {
        managerPrincipal: value.manager_principal,
        stakerPrincipal: value.staker_principal,
        observedBurnBlockHeight: value.observed_burn_block_height,
        observedStacksTipHeight: value.observed_stacks_tip_height,
        observedIndexBlockHash: value.observed_index_block_hash,
        hasStx: value.has_stx === 1,
        hasBtc: value.has_btc === 1,
        stxNodeVerified: value.stx_node_verified === null ? null : value.stx_node_verified === 1,
        position,
        observedAt: value.observed_at,
      };
    });
  }

  putPoolCycleSnapshots(input: PoolCycleSnapshotInput): void {
    const value = poolCycleSnapshotInputSchema.parse(input);
    const upsert = this.db.prepare(
      `INSERT INTO pool_cycle_snapshots (
        manager_principal, reward_cycle, observed_burn_block_height,
        observed_stacks_tip_height, chain_anchor_json, status, roster_available, staker_count,
        enumerated_stx_ustx, enumeration_delta_ustx, pending_stx_ustx,
        eligible_stx_shares_ustx, total_delegated_ustx, non_stx_delegated_ustx,
        in_signer_set, threshold_ustx, threshold_margin_ustx, value_classification,
        contract_source, local_roster_source, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (
        manager_principal, reward_cycle,
        observed_burn_block_height, observed_stacks_tip_height
      ) DO UPDATE SET
        status = excluded.status,
        roster_available = excluded.roster_available,
        staker_count = excluded.staker_count,
        enumerated_stx_ustx = excluded.enumerated_stx_ustx,
        enumeration_delta_ustx = excluded.enumeration_delta_ustx,
        pending_stx_ustx = excluded.pending_stx_ustx,
        eligible_stx_shares_ustx = excluded.eligible_stx_shares_ustx,
        total_delegated_ustx = excluded.total_delegated_ustx,
        non_stx_delegated_ustx = excluded.non_stx_delegated_ustx,
        in_signer_set = excluded.in_signer_set,
        threshold_ustx = excluded.threshold_ustx,
        threshold_margin_ustx = excluded.threshold_margin_ustx,
        value_classification = excluded.value_classification,
        contract_source = excluded.contract_source,
        local_roster_source = excluded.local_roster_source,
        chain_anchor_json = excluded.chain_anchor_json,
        observed_at = excluded.observed_at`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const cycle of value.cycles) {
        upsert.run(
          value.managerPrincipal,
          cycle.cycleId,
          value.burnBlockHeight,
          value.stacksTipHeight,
          value.chainAnchor === undefined ? null : JSON.stringify(value.chainAnchor),
          cycle.status,
          cycle.rosterAvailable ? 1 : 0,
          cycle.stakerCount,
          cycle.enumeratedStxUstx,
          cycle.enumerationDeltaUstx,
          cycle.pendingStxUstx,
          cycle.eligibleStxSharesUstx,
          cycle.totalDelegatedUstx,
          cycle.nonStxDelegatedUstx,
          cycle.inSignerSet ? 1 : 0,
          cycle.thresholdUstx,
          cycle.thresholdMarginUstx,
          cycle.provenance.classification,
          cycle.provenance.contractSource,
          cycle.provenance.localRosterSource,
          value.observedAt,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listLatestPoolCycleSnapshots(
    managerPrincipal: string,
    options: { limit?: number; offset?: number } = {},
  ): ManagerActivityPage<StoredPoolCycleSnapshot> {
    const manager = principalSchema.parse(managerPrincipal);
    const limit = z
      .number()
      .int()
      .min(1)
      .max(200)
      .parse(options.limit ?? 50);
    const offset = z
      .number()
      .int()
      .nonnegative()
      .parse(options.offset ?? 0);
    const totalRow = this.db
      .prepare(
        `SELECT count(DISTINCT reward_cycle) AS count
         FROM pool_cycle_snapshots WHERE manager_principal = ?`,
      )
      .get(manager) as { count: number };
    const rows = this.db
      .prepare(
        `WITH ranked AS (
          SELECT *, row_number() OVER (
            PARTITION BY reward_cycle
            ORDER BY observed_burn_block_height DESC, observed_stacks_tip_height DESC
          ) AS observation_rank
          FROM pool_cycle_snapshots
          WHERE manager_principal = ?
        )
        SELECT manager_principal, reward_cycle, observed_burn_block_height,
          observed_stacks_tip_height, chain_anchor_json, status, roster_available, staker_count,
          enumerated_stx_ustx, enumeration_delta_ustx, pending_stx_ustx,
          eligible_stx_shares_ustx, total_delegated_ustx, non_stx_delegated_ustx,
          in_signer_set, threshold_ustx, threshold_margin_ustx, value_classification,
          contract_source, local_roster_source, observed_at
        FROM ranked WHERE observation_rank = 1
        ORDER BY reward_cycle DESC LIMIT ? OFFSET ?`,
      )
      .all(manager, limit, offset);
    return {
      items: rows.map((row) => {
        const value = poolCycleSnapshotRowSchema.parse(row);
        return {
          managerPrincipal: value.manager_principal,
          cycleId: value.reward_cycle,
          observedBurnBlockHeight: value.observed_burn_block_height,
          observedStacksTipHeight: value.observed_stacks_tip_height,
          chainAnchor:
            value.chain_anchor_json === null
              ? null
              : chainAnchorSchema.parse(JSON.parse(value.chain_anchor_json) as unknown),
          status: value.status,
          rosterAvailable: value.roster_available === 1,
          stakerCount: value.staker_count,
          enumeratedStxUstx: value.enumerated_stx_ustx,
          enumerationDeltaUstx: value.enumeration_delta_ustx,
          pendingStxUstx: value.pending_stx_ustx,
          eligibleStxSharesUstx: value.eligible_stx_shares_ustx,
          totalDelegatedUstx: value.total_delegated_ustx,
          nonStxDelegatedUstx: value.non_stx_delegated_ustx,
          inSignerSet: value.in_signer_set === 1,
          thresholdUstx: value.threshold_ustx,
          thresholdMarginUstx: value.threshold_margin_ustx,
          provenance: {
            classification: value.value_classification,
            contractSource: value.contract_source,
            localRosterSource: value.local_roster_source,
          },
          observedAt: value.observed_at,
        };
      }),
      total: z.number().int().nonnegative().parse(totalRow.count),
      offset,
      limit,
    };
  }

  putRewardCycleSnapshot(input: RewardCycleSnapshotInput): void {
    const value = rewardCycleSnapshotInputSchema.parse(input);
    const upsertCycle = this.db.prepare(
      `INSERT INTO reward_cycle_snapshots (
        manager_principal, reward_cycle, status, observed_burn_block_height,
        observed_stacks_tip_height, chain_anchor_json, last_reward_compute_burn_height,
        last_computed_reward_cycle, rewards_per_token,
        signer_earned_before_manager_claim_sats, fee_snapshot_bips, fee_snapshot_present,
        configured_fee_bips,
        earned_fees_sats, withdrawal_liability_sats, unclaimed_staker_rewards_sats,
        staker_count, gross_sats, earned_sats, fee_sats, actionable_claims,
        l1_claims_waiting_for_fee_threshold, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (manager_principal, reward_cycle) DO UPDATE SET
        status = excluded.status,
        observed_burn_block_height = excluded.observed_burn_block_height,
        observed_stacks_tip_height = excluded.observed_stacks_tip_height,
        chain_anchor_json = excluded.chain_anchor_json,
        last_reward_compute_burn_height = excluded.last_reward_compute_burn_height,
        last_computed_reward_cycle = excluded.last_computed_reward_cycle,
        rewards_per_token = excluded.rewards_per_token,
        signer_earned_before_manager_claim_sats = excluded.signer_earned_before_manager_claim_sats,
        fee_snapshot_bips = excluded.fee_snapshot_bips,
        fee_snapshot_present = excluded.fee_snapshot_present,
        configured_fee_bips = excluded.configured_fee_bips,
        earned_fees_sats = excluded.earned_fees_sats,
        withdrawal_liability_sats = excluded.withdrawal_liability_sats,
        unclaimed_staker_rewards_sats = excluded.unclaimed_staker_rewards_sats,
        staker_count = excluded.staker_count,
        gross_sats = excluded.gross_sats,
        earned_sats = excluded.earned_sats,
        fee_sats = excluded.fee_sats,
        actionable_claims = excluded.actionable_claims,
        l1_claims_waiting_for_fee_threshold = excluded.l1_claims_waiting_for_fee_threshold,
        observed_at = excluded.observed_at`,
    );
    const insertStaker = this.db.prepare(
      `INSERT INTO staker_reward_cycle_snapshots (
        manager_principal, reward_cycle, staker_principal, payout_kind,
        pox_address_version_hex, pox_address_hashbytes_hex, max_fee_sats,
        earned_sats, fee_sats, gross_sats, claimable_by_policy, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      upsertCycle.run(
        value.managerPrincipal,
        value.rewardCycle,
        value.status,
        value.burnBlockHeight,
        value.stacksTipHeight,
        value.chainAnchor === undefined ? null : JSON.stringify(value.chainAnchor),
        value.global.lastRewardComputeBurnHeight,
        value.global.lastComputedRewardCycle,
        value.global.rewardsPerToken,
        value.global.signerEarnedBeforeManagerClaimSats,
        value.manager.feeSnapshotBips ?? "0",
        value.manager.feeSnapshotBips === null ? 0 : 1,
        value.manager.configuredFeeBips,
        value.manager.earnedFeesSats,
        value.manager.withdrawalLiabilitySats,
        value.manager.unclaimedStakerRewardsSats,
        value.totals.stakers,
        value.totals.grossSats,
        value.totals.earnedSats,
        value.totals.feeSats,
        value.totals.actionableClaims,
        value.totals.l1ClaimsWaitingForFeeThreshold,
        value.observedAt,
      );
      this.db
        .prepare(
          `DELETE FROM staker_reward_cycle_snapshots
           WHERE manager_principal = ? AND reward_cycle = ?`,
        )
        .run(value.managerPrincipal, value.rewardCycle);
      for (const staker of value.stakers) {
        insertStaker.run(
          value.managerPrincipal,
          value.rewardCycle,
          staker.stakerPrincipal,
          staker.payout.kind,
          staker.payout.poxAddress?.versionHex ?? null,
          staker.payout.poxAddress?.hashbytesHex ?? null,
          staker.payout.maxFeeSats,
          staker.rewards.earnedSats,
          staker.rewards.feeSats,
          staker.rewards.grossSats,
          staker.claimableByPolicy ? 1 : 0,
          value.observedAt,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listRewardCycleSummaries(
    managerPrincipal: string,
    options: {
      limit?: number;
      offset?: number;
      sort?:
        | "cycle"
        | "status"
        | "stakers"
        | "gross"
        | "net"
        | "fee"
        | "configured-fee"
        | "effective-fee"
        | "actionable"
        | "bitcoin-block";
      direction?: "asc" | "desc";
    } = {},
  ): ManagerActivityPage<StoredRewardCycleSummary> {
    const manager = principalSchema.parse(managerPrincipal);
    const limit = z
      .number()
      .int()
      .min(1)
      .max(200)
      .parse(options.limit ?? 50);
    const offset = z
      .number()
      .int()
      .nonnegative()
      .parse(options.offset ?? 0);
    const direction = options.direction === "asc" ? "ASC" : "DESC";
    const rewardOrder = {
      cycle: "reward_cycle",
      status: "status",
      stakers: "staker_count",
      gross: "CAST(gross_sats AS INTEGER)",
      net: "CAST(earned_sats AS INTEGER)",
      fee: "CAST(fee_sats AS INTEGER)",
      "configured-fee": "CAST(configured_fee_bips AS INTEGER)",
      "effective-fee": "CAST(fee_snapshot_bips AS INTEGER)",
      actionable: "actionable_claims",
      "bitcoin-block": "observed_burn_block_height",
    }[options.sort ?? "cycle"];
    const totalRow = this.db
      .prepare(`SELECT count(*) AS count FROM reward_cycle_snapshots WHERE manager_principal = ?`)
      .get(manager) as { count: number };
    const rows = this.db
      .prepare(
        `SELECT manager_principal, reward_cycle, status, observed_burn_block_height,
          observed_stacks_tip_height, chain_anchor_json, staker_count, gross_sats, earned_sats,
          fee_sats, fee_snapshot_bips, fee_snapshot_present, configured_fee_bips,
          actionable_claims, l1_claims_waiting_for_fee_threshold, observed_at
         FROM reward_cycle_snapshots WHERE manager_principal = ?
         ORDER BY ${rewardOrder} ${direction}, reward_cycle ${direction} LIMIT ? OFFSET ?`,
      )
      .all(manager, limit, offset);
    return {
      items: rows.map((row) => {
        const value = rewardCycleSummaryRowSchema.parse(row);
        return {
          managerPrincipal: value.manager_principal,
          rewardCycle: value.reward_cycle,
          status: value.status,
          observedBurnBlockHeight: value.observed_burn_block_height,
          observedStacksTipHeight: value.observed_stacks_tip_height,
          chainAnchor:
            value.chain_anchor_json === null
              ? null
              : chainAnchorSchema.parse(JSON.parse(value.chain_anchor_json) as unknown),
          stakerCount: value.staker_count,
          grossSats: value.gross_sats,
          earnedSats: value.earned_sats,
          feeSats: value.fee_sats,
          configuredFeeBips: value.configured_fee_bips,
          feeSnapshotBips: value.fee_snapshot_present === 1 ? value.fee_snapshot_bips : null,
          actionableClaims: value.actionable_claims,
          l1ClaimsWaitingForFeeThreshold: value.l1_claims_waiting_for_fee_threshold,
          observedAt: value.observed_at,
        };
      }),
      total: z.number().int().nonnegative().parse(totalRow.count),
      offset,
      limit,
    };
  }

  getLatestCompletedSignerStakerRun(
    sourceId: string,
    managerPrincipal: string,
  ): SignerStakerRun | null {
    const parsedSourceId = z.string().min(1).parse(sourceId);
    const manager = principalSchema.parse(managerPrincipal);
    const row = this.db
      .prepare(
        `SELECT ${signerStakerRunColumns}
         FROM ingestion_runs
         WHERE source_id = ? AND stream = ? AND manager_principal = ?
           AND status = 'completed' AND authoritative = 1
         ORDER BY completed_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(parsedSourceId, signerStakersStream, manager);
    return row ? toSignerStakerRun(row) : null;
  }
}
