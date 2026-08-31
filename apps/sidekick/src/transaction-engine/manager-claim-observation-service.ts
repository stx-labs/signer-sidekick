import { z } from "zod";
import type { ChainAnchor } from "../chain-anchor.js";
import type { OperatorAnchorSnapshot } from "../operator-anchor-snapshot.js";
import type { StxRewardStatus } from "../reward-status.js";
import {
  type CanonicalAnchorProofApi,
  proveCanonicalAnchorRelationship,
} from "./canonical-anchor-proof.js";
import {
  type ManagerClaimObserveResult,
  managerClaimOperationScopeKey,
  ObserveManagerClaimPlanner,
  parseManagerClaimIntentRecord,
  parseManagerClaimPolicyRecord,
  storedManagerClaimRecords,
} from "./manager-claim-observer.js";
import {
  type ManagerClaimBondBucket,
  managerClaimCheckpoint,
  managerClaimNetworkKind,
} from "./manager-claim-proposal.js";
import {
  type StoredTransactionJob,
  type TransactionEngineRepository,
  transactionEngineDocumentSha256,
} from "./repository.js";

export type { ManagerClaimBondBucket } from "./manager-claim-proposal.js";

export type ManagerClaimObservationBlockCode =
  | "unsupported-network"
  | "network-fingerprint-mismatch"
  | "manager-ineligible"
  | "manager-fingerprint-mismatch"
  | "reward-status-unavailable"
  | "reward-checkpoint-mismatch"
  | "reward-calculation-pending";

export interface ManagerClaimObservationBlock {
  code: ManagerClaimObservationBlockCode;
  message: string;
}

export type ManagerClaimObservationOutcome =
  | {
      status: "planned" | "reconciled";
      blocks: readonly [];
      result: ManagerClaimObserveResult;
    }
  | {
      status: "idle";
      blocks: readonly [];
      reason:
        | "no-claimable-effect"
        | "buckets-present-nothing-claimable"
        | "external-completion-without-local-work"
        | "no-matching-active-work"
        | "manual-wallet-available";
    }
  | {
      status: "blocked";
      blocks: readonly ManagerClaimObservationBlock[];
    };

export interface ManagerClaimObservationInput {
  setup: OperatorAnchorSnapshot;
  rewards: StxRewardStatus | null;
  observedAt: string;
  /** Jobs whose local successful inclusion was re-proven by recovery in this exact pass. */
  samePassConfirmedJobIds?: readonly string[];
  /** Existing-work maintenance only; never creates or supersedes a logical job. */
  reconcileOnly?: boolean;
}

interface ManagerClaimObservationServiceOptions {
  repository: TransactionEngineRepository;
  api: CanonicalAnchorProofApi;
  finalityDepth?: number;
}

const storedPlanExecutionSchema = z
  .object({
    material: z
      .object({
        sender: z.object({ principal: z.string().min(1), publicKey: z.string().min(1) }).strict(),
        transaction: z.object({ nonce: z.string().regex(/^(0|[1-9]\d*)$/) }).passthrough(),
        stxEarnedSats: z.string().regex(/^(0|[1-9]\d*)$/),
        bondBuckets: z.array(
          z
            .object({
              bondIndex: z.string().regex(/^(0|[1-9]\d*)$/),
              managerSharesSats: z.string().regex(/^(0|[1-9]\d*)$/),
              earnedSats: z.string().regex(/^(0|[1-9]\d*)$/),
              feeSnapshot: z
                .object({
                  state: z.enum(["absent", "present"]),
                  effectiveFeeBips: z.string().regex(/^(0|[1-9]\d*)$/),
                })
                .strict(),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
  })
  .passthrough();

/** Bucket facts as they were sealed, for paths that must reproduce the original plan. */
function sealedBondBuckets(plan: z.output<typeof storedPlanExecutionSchema>): {
  stxEarnedSats: bigint;
  bondBuckets: ManagerClaimBondBucket[];
} {
  return {
    stxEarnedSats: BigInt(plan.material.stxEarnedSats),
    bondBuckets: plan.material.bondBuckets.map((bucket) => ({
      bondIndex: BigInt(bucket.bondIndex),
      managerSharesSats: BigInt(bucket.managerSharesSats),
      earnedSats: BigInt(bucket.earnedSats),
      feeSnapshot: {
        state: bucket.feeSnapshot.state,
        effectiveFeeBips: BigInt(bucket.feeSnapshot.effectiveFeeBips),
      },
    })),
  };
}

function block(
  blocks: ManagerClaimObservationBlock[],
  code: ManagerClaimObservationBlockCode,
  message: string,
): void {
  blocks.push({ code, message });
}

function staticBlocks(
  input: ManagerClaimObservationInput,
  checkpoint: ReturnType<typeof managerClaimCheckpoint>,
): ManagerClaimObservationBlock[] {
  const blocks: ManagerClaimObservationBlock[] = [];
  const kind = managerClaimNetworkKind(input.setup);
  if (!kind) {
    block(blocks, "unsupported-network", "This network is not supported for manager claims");
  }
  const { preflight, manager } = input.setup;
  if (
    preflight.compatibility.status !== "matched" ||
    !preflight.pox.pox5ContractId ||
    !preflight.pox.sbtcTokenContract ||
    preflight.node.networkId < 0
  ) {
    block(
      blocks,
      "network-fingerprint-mismatch",
      "PoX-5 and sBTC contracts do not match the active compatibility profile",
    );
  }
  const verifiedReferenceManager =
    (manager.source.tier === "reference-built-in" || manager.source.tier === "reference-render") &&
    manager.source.profileId !== null;
  if (!verifiedReferenceManager) {
    block(blocks, "manager-ineligible", "Reward collection requires a reviewed capability adapter");
  }
  if (!manager.source.sha256 || manager.source.match === "unknown") {
    block(blocks, "manager-fingerprint-mismatch", "Manager source could not be verified");
  }
  if (!input.rewards) {
    block(
      blocks,
      "reward-status-unavailable",
      "Reward data is unavailable. Sync chain data and try again",
    );
  } else if (!checkpoint) {
    // A pending global calculation is not stale local data, and telling an operator to sync would
    // send them after the wrong thing: `calculate-rewards` is permissionless and nobody has run it
    // for this distribution yet.
    if (input.rewards?.calculation.state === "pending") {
      block(
        blocks,
        "reward-calculation-pending",
        "The permissionless PoX-5 reward calculation has not run for this distribution yet. Nothing is claimable until it does",
      );
    } else {
      block(
        blocks,
        "reward-checkpoint-mismatch",
        "Reward data is not aligned with the current claim checkpoint. Sidekick will retry as the chain advances",
      );
    }
  }
  return blocks;
}

export class ManagerClaimObservationService {
  readonly #planner: ObserveManagerClaimPlanner;
  readonly #finalityDepth: number;
  #latest: ManagerClaimObservationOutcome = {
    status: "blocked",
    blocks: [
      {
        code: "reward-status-unavailable",
        message: "No manager-claim observation has completed",
      },
    ],
  };

  constructor(private readonly options: ManagerClaimObservationServiceOptions) {
    this.#finalityDepth = z
      .number()
      .int()
      .min(1)
      .max(144)
      .parse(options.finalityDepth ?? 1);
    this.#planner = new ObserveManagerClaimPlanner(options.repository, {
      finalityDepth: this.#finalityDepth,
    });
  }

  current(): ManagerClaimObservationOutcome {
    return this.#latest;
  }

  async observe(input: ManagerClaimObservationInput): Promise<ManagerClaimObservationOutcome> {
    const checkpoint = managerClaimCheckpoint(input.setup, input.rewards);
    const blocks = staticBlocks(input, checkpoint);
    if (blocks.length > 0 || !checkpoint) {
      this.#latest = { status: "blocked", blocks };
      return this.#latest;
    }

    const kind = managerClaimNetworkKind(input.setup);
    const pox5 = input.setup.preflight.pox.pox5ContractId;
    const sbtcToken = input.setup.preflight.pox.sbtcTokenContract;
    if (!kind || !pox5 || !sbtcToken)
      throw new Error("Validated manager-claim identity disappeared");
    const scopeKey = managerClaimOperationScopeKey({
      network: { kind, chainId: input.setup.preflight.node.networkId },
      managerContract: input.setup.manager.managerPrincipal,
      rewardCycle: checkpoint.rewardCycle,
      calculationCheckpoint: checkpoint.calculationCheckpoint,
      lastRewardComputeBurnHeight: checkpoint.lastRewardComputeBurnHeight,
      rewardsPerToken: checkpoint.rewardsPerToken,
    });

    if (checkpoint.effect === "none") {
      this.#latest = { status: "idle", blocks: [], reason: "no-claimable-effect" };
      return this.#latest;
    }

    if (checkpoint.effect === "buckets-idle") {
      this.#latest = {
        status: "idle",
        blocks: [],
        reason: "buckets-present-nothing-claimable",
      };
      return this.#latest;
    }

    if (checkpoint.effect === "remaining") {
      if (!input.reconcileOnly) {
        this.#latest = { status: "idle", blocks: [], reason: "manual-wallet-available" };
        return this.#latest;
      }
      const job = this.options.repository.getActiveLogicalJobForScope(scopeKey);
      if (job === null) {
        this.#latest = { status: "idle", blocks: [], reason: "no-matching-active-work" };
        return this.#latest;
      }
      const records = storedManagerClaimRecords(job);
      this.#latest = {
        status: "planned",
        blocks: [],
        result: {
          status: "planned",
          job,
          created: false,
          supersededJobId: null,
          blocks: [],
          plan: records.intent.sealedPlan,
          records,
        },
      };
      return this.#latest;
    }

    if (checkpoint.effect === "completed") {
      const job =
        this.options.repository.getActiveLogicalJobForScope(scopeKey) ??
        this.options.repository.getLatestLogicalJobForScope(scopeKey);
      if (!job) {
        this.#latest = {
          status: "idle",
          blocks: [],
          reason: "external-completion-without-local-work",
        };
        return this.#latest;
      }
      this.#latest = await this.reconcileCompleted(input, checkpoint, job, pox5, sbtcToken);
      return this.#latest;
    }
    throw new Error(`Unhandled manager-claim effect: ${checkpoint.effect satisfies never}`);
  }

  private async reconcileCompleted(
    input: ManagerClaimObservationInput,
    checkpoint: NonNullable<ReturnType<typeof managerClaimCheckpoint>>,
    job: StoredTransactionJob,
    pox5: string,
    sbtcToken: string,
  ): Promise<ManagerClaimObservationOutcome> {
    const intent = parseManagerClaimIntentRecord(job.intent);
    parseManagerClaimPolicyRecord(job.policy);
    const plan = storedPlanExecutionSchema.parse(intent.sealedPlan);
    const expectedOutflow = BigInt(intent.reconciliation.expectedEffect.amountSats);
    const estimatedFee = BigInt(intent.review.fee.estimatedFeeUstx);
    const maximumFee = BigInt(intent.review.fee.maximumFeeUstx);
    const completionEvidenceSha256 = transactionEngineDocumentSha256({
      schemaVersion: 1,
      kind: "manager-claim-completion",
      jobId: job.jobId,
      chainAnchor: input.setup.chainAnchor,
      feeSnapshot: {
        state: checkpoint.feeSnapshot.state,
        effectiveFeeBips: checkpoint.feeSnapshot.effectiveFeeBips.toString(),
      },
      checkpoint: {
        rewardCycle: checkpoint.rewardCycle.toString(),
        calculationCheckpoint: checkpoint.calculationCheckpoint,
        lastRewardComputeBurnHeight: checkpoint.lastRewardComputeBurnHeight,
        rewardsPerToken: checkpoint.rewardsPerToken.toString(),
      },
    });
    const finalityDepth = await this.completionFinalityDepth(
      job,
      input.setup.chainAnchor,
      new Set(input.samePassConfirmedJobIds ?? []),
    );
    const result = await this.#planner.observe({
      schemaVersion: 1,
      observedAt: input.observedAt,
      network: {
        kind: managerClaimNetworkKind(input.setup) ?? "testnet",
        chainId: input.setup.preflight.node.networkId,
      },
      manager: {
        contract: input.setup.manager.managerPrincipal,
        profile: {
          id: input.setup.manager.source.profileId ?? "unrecognized",
          recognitionTier: input.setup.manager.source.tier,
          sourceSha256: input.setup.manager.source.sha256,
        },
        observedSourceSha256: input.setup.manager.source.sha256,
      },
      chainAnchor: input.setup.chainAnchor,
      acceptedAttestation: {
        issuer: job.attestation.issuer,
        revision: job.attestation.revision,
        payloadSha256: job.attestation.payloadSha256,
        current: false,
      },
      contracts: { pox5, sbtcToken },
      rewardCheckpoint: {
        rewardCycle: checkpoint.rewardCycle,
        calculationCheckpoint: checkpoint.calculationCheckpoint,
        lastRewardComputeBurnHeight: checkpoint.lastRewardComputeBurnHeight,
        rewardsPerToken: checkpoint.rewardsPerToken,
      },
      // A completed claim has zeroed the very earnings it was planned from, so the facts here must
      // come from the sealed plan, exactly as `expectedOutflow` does.
      ...sealedBondBuckets(plan),
      observedSignerEarnedSats: checkpoint.observedSignerEarnedSats,
      feeSnapshot: checkpoint.feeSnapshot,
      expectedSignerOutflowSats: expectedOutflow,
      gasPayer: {
        principal: plan.material.sender.principal,
        publicKey: plan.material.sender.publicKey,
        observedNonce: BigInt(plan.material.transaction.nonce),
        estimatedFeeUstx: estimatedFee,
        maximumFeeUstx: maximumFee,
      },
      controls: { mode: "observe", adapterEnabled: true, rewardsPaused: false },
      effect: { remaining: false, completionEvidenceSha256 },
      authoritative: { complete: true, canonical: true, finalityDepth },
    });
    return {
      status: result.status === "reconciled" ? "reconciled" : "planned",
      blocks: [],
      result,
    };
  }

  private async completionFinalityDepth(
    job: StoredTransactionJob,
    currentAnchor: ChainAnchor,
    samePassConfirmedJobIds: ReadonlySet<string>,
  ): Promise<number> {
    const attempts = this.options.repository.listAttempts(job.jobId);
    const hasAnyLocalInclusion = attempts.some(({ inclusion }) => inclusion !== null);
    const localInclusion = attempts
      .map(({ inclusion }) => inclusion)
      .find((inclusion) => inclusion?.canonical && inclusion.executionStatus === "success");
    if (hasAnyLocalInclusion) {
      if (
        !samePassConfirmedJobIds.has(job.jobId) ||
        !localInclusion ||
        currentAnchor.stacksBlockHeight < localInclusion.stacksBlockHeight
      ) {
        return 0;
      }
      return currentAnchor.stacksBlockHeight - localInclusion.stacksBlockHeight;
    }
    const externalCompletionAnchors = this.options.repository
      .listReconciliationObservations(job.jobId)
      .filter(
        ({ authoritative, canonical, outcome, effectRemaining }) =>
          authoritative && canonical && outcome === "external_success" && !effectRemaining,
      )
      .map(({ chainAnchor }) => chainAnchor);
    for (const firstCompletionAnchor of externalCompletionAnchors) {
      const proof = await proveCanonicalAnchorRelationship(
        this.options.api,
        firstCompletionAnchor,
        currentAnchor,
      );
      if (proof.status === "unavailable") return 0;
      if (proof.status === "proven") {
        return currentAnchor.stacksBlockHeight - firstCompletionAnchor.stacksBlockHeight;
      }
    }
    // The current observation becomes a new durable baseline. It can count only after a later
    // observation proves this anchor remains a canonical ancestor.
    return 0;
  }
}
