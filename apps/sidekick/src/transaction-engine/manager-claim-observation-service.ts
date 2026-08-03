import type { ClarityValue } from "@stacks/transactions";
import { decodeBoolean } from "@stx-labs/signer-sidekick-protocol/clarity-codecs";
import {
  compatibilityAttestationPayloadSha256,
  type VerifiedCompatibilityAttestation,
} from "@stx-labs/signer-sidekick-protocol/compatibility-attestation";
import {
  MANAGER_CLAIM_REWARDS_ADAPTER_ID,
  MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
  planManagerClaimRewards,
} from "@stx-labs/signer-sidekick-protocol/manager-claim-rewards";
import { z } from "zod";
import {
  type ChainAnchor,
  chainAnchorsEqual,
  deriveRewardCalculationTarget,
  type RewardCalculationCheckpoint,
} from "../chain-anchor.js";
import type { StxRewardStatus } from "../reward-status.js";
import type { SetupSnapshot } from "../setup-snapshot.js";
import type { SignerStakerRun, StoredSignerStaker } from "../storage/store.js";
import {
  type CanonicalAnchorProof,
  type CanonicalAnchorProofApi,
  proveCanonicalAnchorRelationship,
} from "./canonical-anchor-proof.js";
import type {
  LiveObservation,
  LiveTransactionReader,
  TransactionFeeObservation,
} from "./live-transaction-reader.js";
import {
  type ManagerClaimObserveResult,
  managerClaimOperationScopeKey,
  ObserveManagerClaimPlanner,
  parseManagerClaimIntentRecord,
  parseManagerClaimPolicyRecord,
  storedManagerClaimRecords,
} from "./manager-claim-observer.js";
import {
  type StoredTransactionApproval,
  type StoredTransactionJob,
  type TransactionEngineRepository,
  transactionEngineDocumentSha256,
} from "./repository.js";

export type ManagerClaimObservationBlockCode =
  | "adapter-disabled"
  | "unsupported-network"
  | "network-fingerprint-mismatch"
  | "manager-ineligible"
  | "assist-not-approved"
  | "manager-fingerprint-mismatch"
  | "reward-status-unavailable"
  | "reward-checkpoint-mismatch"
  | "roster-proof-incomplete"
  | "bond-participation-present"
  | "attestation-unavailable"
  | "attestation-fingerprint-mismatch"
  | "gas-payer-unavailable"
  | "rewards-paused"
  | "node-read-unavailable"
  | "fee-estimate-unavailable"
  | "fee-cap-exceeded"
  | "gas-balance-insufficient";

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
        | "external-completion-without-local-work"
        | "no-matching-active-work"
        | "effect-still-remaining";
    }
  | {
      status: "blocked";
      blocks: readonly ManagerClaimObservationBlock[];
    };

export interface ManagerClaimEvidenceStore {
  getLatestCompletedSignerStakerRun(
    sourceId: string,
    managerPrincipal: string,
  ): SignerStakerRun | null;
  listSignerStakers(
    managerPrincipal: string,
    activeOnly?: boolean,
    sourceId?: string | null,
  ): StoredSignerStaker[];
}

export interface ManagerClaimObservationNode {
  getDataVar(
    principal: string,
    variableName: string,
    options: { tip: string },
  ): Promise<ClarityValue>;
}

export interface ManagerClaimPublicGasPayer {
  principal: string;
  publicKey: string;
}

export interface ManagerClaimObservationInput {
  setup: SetupSnapshot;
  rewards: StxRewardStatus | null;
  sourceId: string;
  requestedMode: "observe" | "assist";
  gasPayer: ManagerClaimPublicGasPayer | null;
  maximumFeeUstx: bigint;
  attestation: VerifiedCompatibilityAttestation | null;
  observedAt: string;
  /** Jobs whose local successful inclusion was re-proven by recovery in this exact pass. */
  samePassConfirmedJobIds?: readonly string[];
  /** Existing-work maintenance only; never creates or supersedes a logical job. */
  reconcileOnly?: boolean;
}

export type ManagerClaimApprovalRevalidationCode =
  | "approval-binding-changed"
  | "planned-anchor-noncanonical"
  | "canonical-proof-unavailable"
  | "runtime-mode-changed"
  | "adapter-disabled"
  | "network-identity-changed"
  | "contract-identity-changed"
  | "manager-identity-changed"
  | "attestation-unavailable"
  | "attestation-changed"
  | "attestation-expired"
  | "reward-status-unavailable"
  | "reward-checkpoint-changed"
  | "claim-amount-changed"
  | "fee-snapshot-changed"
  | "rewards-paused"
  | "node-read-unavailable"
  | "gas-payer-changed"
  | "gas-nonce-changed"
  | "gas-balance-insufficient"
  | "fee-policy-changed";

export interface ManagerClaimApprovalRevalidationInput extends ManagerClaimObservationInput {
  job: StoredTransactionJob;
  approval: StoredTransactionApproval;
  anchorProof: CanonicalAnchorProof;
}

export type ManagerClaimApprovalRevalidationOutcome =
  | {
      status: "valid";
      job: StoredTransactionJob;
      liveAnchor: ChainAnchor;
      attestation: VerifiedCompatibilityAttestation;
      admission: {
        liveFingerprintMatches: true;
        anchorCanonical: true;
        anchorDescendant: true;
        prerequisitesComplete: true;
        feeStateMatches: true;
      };
    }
  | {
      status: "completed";
      outcome: ManagerClaimObservationOutcome;
    }
  | {
      status: "blocked";
      disposition: "retained" | "invalidated";
      code: ManagerClaimApprovalRevalidationCode;
      message: string;
      job: StoredTransactionJob;
    };

interface ManagerClaimObservationServiceOptions {
  repository: TransactionEngineRepository;
  evidenceStore: ManagerClaimEvidenceStore;
  node: ManagerClaimObservationNode;
  api: CanonicalAnchorProofApi;
  liveReader: Pick<LiveTransactionReader, "readAnchoredAccount" | "estimateUnsignedTransactionFee">;
  finalityDepth?: number;
}

const storedPlanExecutionSchema = z
  .object({
    material: z
      .object({
        sender: z.object({ principal: z.string().min(1), publicKey: z.string().min(1) }).strict(),
        transaction: z.object({ nonce: z.string().regex(/^(0|[1-9]\d*)$/) }).passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

const storedApprovalPlanSchema = z
  .object({
    kind: z.literal("manager-claim-rewards"),
    unsignedTransactionHex: z.string().regex(/^[0-9a-f]+$/i),
    unsignedTransactionSha256: z.string().regex(/^[0-9a-f]{64}$/i),
    material: z
      .object({
        adapter: z
          .object({
            id: z.literal(MANAGER_CLAIM_REWARDS_ADAPTER_ID),
            revision: z.literal(MANAGER_CLAIM_REWARDS_ADAPTER_REVISION),
          })
          .strict(),
        network: z
          .object({ kind: z.enum(["mainnet", "testnet"]), chainId: z.number().int() })
          .strict(),
        attestationDigest: z.string().regex(/^[0-9a-f]{64}$/i),
        managerSourceFingerprint: z.string().regex(/^[0-9a-f]{64}$/i),
        rewardObservation: z
          .object({
            calculationCheckpoint: z.enum(["first-half", "second-half"]),
            lastRewardComputeBurnHeight: z.number().int().positive().safe(),
            rewardsPerToken: z.string().regex(/^(0|[1-9]\d*)$/),
          })
          .strict(),
        noBondParticipation: z
          .object({ proven: z.literal(true), evidenceDigest: z.string().regex(/^[0-9a-f]{64}$/i) })
          .strict(),
        feeSnapshot: z
          .object({
            state: z.enum(["absent", "present"]),
            effectiveFeeBips: z.string().regex(/^(0|[1-9]\d*)$/),
          })
          .strict(),
        sender: z.object({ principal: z.string().min(1), publicKey: z.string().min(1) }).strict(),
        call: z
          .object({ contract: z.string().min(1), rewardCycle: z.string().regex(/^(0|[1-9]\d*)$/) })
          .passthrough(),
        expectedEffect: z
          .object({
            asset: z.string().min(1),
            sender: z.string().min(1),
            recipient: z.string().min(1),
            amount: z.string().regex(/^[1-9]\d*$/),
            condition: z.literal("eq"),
            postConditionMode: z.literal("deny"),
          })
          .strict(),
        transaction: z
          .object({
            nonce: z.string().regex(/^(0|[1-9]\d*)$/),
            fee: z.string().regex(/^(0|[1-9]\d*)$/),
            unsignedTransactionSha256: z.string().regex(/^[0-9a-f]{64}$/i),
          })
          .strict(),
      })
      .passthrough(),
  })
  .passthrough();

function block(
  blocks: ManagerClaimObservationBlock[],
  code: ManagerClaimObservationBlockCode,
  message: string,
): void {
  blocks.push({ code, message });
}

function parsedUnsigned(value: string, label: string): bigint | null {
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    throw new Error(`${label} is not an unsigned integer`);
  }
}

function networkKind(setup: SetupSnapshot): "mainnet" | "testnet" | null {
  if (setup.preflight.network === "mainnet") return "mainnet";
  if (["testnet", "devnet", "regtest"].includes(setup.preflight.network)) return "testnet";
  return null;
}

function rewardCheckpoint(input: ManagerClaimObservationInput): {
  rewardCycle: bigint;
  calculationCheckpoint: RewardCalculationCheckpoint;
  lastRewardComputeBurnHeight: number;
  rewardsPerToken: bigint;
  observedSignerEarnedSats: bigint;
  expectedSignerOutflowSats: bigint;
  feeSnapshot: { state: "absent" | "present"; effectiveFeeBips: bigint };
  effect: "remaining" | "completed" | "none";
} | null {
  const { rewards, setup } = input;
  if (!rewards) return null;
  const target = deriveRewardCalculationTarget(setup.chainAnchor);
  if (target.status === "invalid") return null;
  const lastHeight = parsedUnsigned(
    rewards.global.lastRewardComputeBurnHeight,
    "last reward compute height",
  );
  const rewardsPerToken = parsedUnsigned(rewards.global.rewardsPerToken, "rewards per token");
  const signerEarned = parsedUnsigned(
    rewards.global.signerEarnedBeforeManagerClaimSats,
    "signer earned rewards",
  );
  const configuredFee = parsedUnsigned(rewards.manager.configuredFeeBips, "configured fee");
  const snapshottedFee =
    rewards.manager.feeSnapshotBips === null
      ? null
      : parsedUnsigned(rewards.manager.feeSnapshotBips, "snapshotted fee");
  if (
    lastHeight === null ||
    lastHeight < 1n ||
    lastHeight > BigInt(Number.MAX_SAFE_INTEGER) ||
    rewardsPerToken === null ||
    signerEarned === null ||
    configuredFee === null ||
    configuredFee > 9_999n ||
    (snapshottedFee !== null && snapshottedFee > 9_999n) ||
    rewards.status !== "ready" ||
    rewards.managerPrincipal !== setup.manager.managerPrincipal ||
    rewards.pox5ContractId !== setup.preflight.pox.pox5ContractId ||
    rewards.ingestion === null ||
    rewards.rewardCycle !== target.rewardCycle ||
    rewards.global.lastComputedRewardCycle !== String(target.rewardCycle) ||
    rewards.observedAt.burnBlockHeight !== setup.chainAnchor.burnBlockHeight ||
    rewards.observedAt.stacksTipHeight !== setup.chainAnchor.stacksBlockHeight ||
    lastHeight !== BigInt(target.expectedLastRewardComputeBurnHeight)
  ) {
    return null;
  }
  return {
    rewardCycle: BigInt(rewards.rewardCycle),
    calculationCheckpoint: target.calculationCheckpoint,
    lastRewardComputeBurnHeight: Number(lastHeight),
    rewardsPerToken,
    observedSignerEarnedSats: signerEarned,
    expectedSignerOutflowSats: signerEarned,
    feeSnapshot: {
      state: snapshottedFee === null ? "absent" : "present",
      effectiveFeeBips: snapshottedFee ?? configuredFee,
    },
    effect: signerEarned > 0n ? "remaining" : snapshottedFee !== null ? "completed" : "none",
  };
}

function currentRosterProof(
  store: ManagerClaimEvidenceStore,
  sourceId: string,
  managerPrincipal: string,
  chainAnchor: ChainAnchor,
  expectedRunId: string | null,
):
  | { status: "proven"; evidenceSha256: string }
  | { status: "incomplete" }
  | { status: "bond-present" } {
  const run = store.getLatestCompletedSignerStakerRun(sourceId, managerPrincipal);
  if (
    !run?.authoritative ||
    !run.reconciliationComplete ||
    !run.chainAnchor ||
    !chainAnchorsEqual(run.chainAnchor, chainAnchor) ||
    (expectedRunId !== null && run.runId !== expectedRunId)
  ) {
    return { status: "incomplete" };
  }
  const roster = store.listSignerStakers(managerPrincipal, true, sourceId);
  if (roster.length === 0 || roster.some((staker) => staker.lastSeenRunId !== run.runId)) {
    return { status: "incomplete" };
  }
  if (roster.some((staker) => staker.hasBtc)) return { status: "bond-present" };
  return {
    status: "proven",
    evidenceSha256: transactionEngineDocumentSha256({
      schemaVersion: 1,
      kind: "complete-manager-no-bond-participation",
      sourceId,
      runId: run.runId,
      managerPrincipal,
      chainAnchor,
      stakers: roster
        .map((staker) => ({
          stakerPrincipal: staker.stakerPrincipal,
          hasBtc: staker.hasBtc,
        }))
        .sort((left, right) => left.stakerPrincipal.localeCompare(right.stakerPrincipal)),
    }),
  };
}

function staticBlocks(
  input: ManagerClaimObservationInput,
  checkpoint: ReturnType<typeof rewardCheckpoint>,
  rosterProof: ReturnType<typeof currentRosterProof> | null,
  mode: "observe" | "assist",
): ManagerClaimObservationBlock[] {
  const blocks: ManagerClaimObservationBlock[] = [];
  const kind = networkKind(input.setup);
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
    block(blocks, "manager-ineligible", "Reward claims require a verified reference manager");
  } else if (mode === "assist" && !manager.automationEligible) {
    block(
      blocks,
      "assist-not-approved",
      "Assist is not enabled for this verified reference manager on mainnet",
    );
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
    block(
      blocks,
      "reward-checkpoint-mismatch",
      "Reward data is stale. Sync chain data and try again",
    );
  }
  if (rosterProof?.status === "incomplete") {
    block(
      blocks,
      "roster-proof-incomplete",
      "The staker roster is incomplete at the current chain tip. Sync chain data",
    );
  } else if (rosterProof?.status === "bond-present") {
    block(
      blocks,
      "bond-participation-present",
      "This claim path does not support pools with Bitcoin bond participation",
    );
  }
  return blocks;
}

function attestationMatches(input: ManagerClaimObservationInput): boolean {
  const { attestation, setup } = input;
  if (!attestation) return false;
  const profile = attestation.profile;
  return (
    compatibilityAttestationPayloadSha256(attestation.document.payload) ===
      attestation.payloadSha256 &&
    attestation.acceptedState.payloadSha256 === attestation.payloadSha256 &&
    Date.parse(attestation.document.payload.expiresAt) > Date.parse(input.observedAt) &&
    profile.network === setup.preflight.network &&
    profile.networkId === setup.preflight.node.networkId &&
    profile.pox5.contractId === setup.preflight.pox.pox5ContractId &&
    profile.pox5.sourceSha256 === setup.preflight.pox.sourceSha256 &&
    profile.sbtc.tokenContract === setup.preflight.pox.sbtcTokenContract &&
    profile.sbtc.registryContract === setup.preflight.pox.sbtcRegistryContract &&
    profile.referenceManager.profileId === setup.manager.source.profileId &&
    profile.referenceManager.sourceSha256 === setup.manager.source.sha256
  );
}

function observedFee(value: LiveObservation<TransactionFeeObservation>): bigint | null {
  return value.status === "observed" ? value.value.estimates.middle.feeUstx : null;
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

  private revalidationBlock(
    input: ManagerClaimApprovalRevalidationInput,
    disposition: "retained" | "invalidated",
    code: ManagerClaimApprovalRevalidationCode,
    message: string,
  ): ManagerClaimApprovalRevalidationOutcome {
    const operatorMessage =
      disposition === "invalidated"
        ? code === "adapter-disabled"
          ? "Assist or manager-claim transactions were disabled. This job cannot continue. If Assist becomes available later, sync chain data to prepare a new current job, then review and approve it"
          : `${message}. Sync chain data to prepare a new current job, then review and approve it`
        : message;
    let job = input.job;
    if (disposition === "invalidated" && job.state === "awaiting_approval") {
      job = this.options.repository.transitionLogicalJob({
        jobId: job.jobId,
        expectedState: job.state,
        expectedStateVersion: job.stateVersion,
        nextState: "blocked",
        blockReason: `approval-revalidation:${code}`,
        changedAt: input.observedAt,
      });
    }
    return { status: "blocked", disposition, code, message: operatorMessage, job };
  }

  /**
   * Revalidates one already-approved immutable job against a newer canonical descendant.
   *
   * This path deliberately does not call the normal planner: it may neither create nor supersede
   * work, refresh the roster, change the nonce/fee, nor rebuild transaction bytes. A transient
   * read failure retains the durable approval for a later retry; a proven semantic change blocks
   * the job, which atomically invalidates its approval in the repository.
   */
  async revalidateApprovedJob(
    input: ManagerClaimApprovalRevalidationInput,
  ): Promise<ManagerClaimApprovalRevalidationOutcome> {
    const { job, approval } = input;
    if (
      job.state !== "awaiting_approval" ||
      approval.jobId !== job.jobId ||
      approval.intentSha256 !== job.intentSha256 ||
      approval.policySha256 !== job.policySha256 ||
      approval.invalidatedAt !== null
    ) {
      return this.revalidationBlock(
        input,
        "invalidated",
        "approval-binding-changed",
        "Approval no longer matches this job",
      );
    }

    if (input.anchorProof.status === "unavailable") {
      return this.revalidationBlock(
        input,
        "retained",
        "canonical-proof-unavailable",
        "Canonical ancestry is temporarily unavailable. Wait for the Reference API and retry",
      );
    }
    if (
      input.anchorProof.status !== "proven" ||
      !chainAnchorsEqual(input.anchorProof.plannedAnchor, job.chainAnchor) ||
      !chainAnchorsEqual(input.anchorProof.liveAnchor, input.setup.chainAnchor)
    ) {
      return this.revalidationBlock(
        input,
        "invalidated",
        "planned-anchor-noncanonical",
        "The approved chain anchor is no longer canonical",
      );
    }

    const intent = parseManagerClaimIntentRecord(job.intent);
    const policy = parseManagerClaimPolicyRecord(job.policy);
    const plan = storedApprovalPlanSchema.parse(intent.sealedPlan);
    const kind = networkKind(input.setup);
    if (input.requestedMode !== "assist") {
      return this.revalidationBlock(
        input,
        "invalidated",
        "runtime-mode-changed",
        "The runtime is no longer in Assist mode; restore Assist first if intended",
      );
    }
    if (
      this.options.repository.getDisabledAdapterControl(MANAGER_CLAIM_REWARDS_ADAPTER_ID) !==
        null ||
      this.options.repository.getForceObserveControl() !== null ||
      job.adapterId !== MANAGER_CLAIM_REWARDS_ADAPTER_ID ||
      job.adapterRevision !== MANAGER_CLAIM_REWARDS_ADAPTER_REVISION
    ) {
      return this.revalidationBlock(
        input,
        "invalidated",
        "adapter-disabled",
        "Assist or manager-claim transactions were disabled",
      );
    }

    if (
      kind === null ||
      plan.material.network.kind !== kind ||
      plan.material.network.chainId !== input.setup.preflight.node.networkId
    ) {
      return this.revalidationBlock(
        input,
        "invalidated",
        "network-identity-changed",
        "The configured network changed",
      );
    }
    const pox5 = input.setup.preflight.pox.pox5ContractId;
    const sbtcToken = input.setup.preflight.pox.sbtcTokenContract;
    if (pox5 === null || sbtcToken === null) {
      return this.revalidationBlock(
        input,
        "retained",
        "reward-status-unavailable",
        "Live PoX-5 or sBTC identity is temporarily unavailable",
      );
    }
    if (
      plan.material.expectedEffect.sender !== pox5 ||
      plan.material.expectedEffect.asset !== `${sbtcToken}::sbtc-token` ||
      input.setup.preflight.compatibility.status !== "matched"
    ) {
      return this.revalidationBlock(
        input,
        "invalidated",
        "contract-identity-changed",
        "The PoX-5 or sBTC contract changed",
      );
    }
    const liveManager = input.setup.manager;
    if (!liveManager.source.sha256 || liveManager.source.match === "unknown") {
      return this.revalidationBlock(
        input,
        "retained",
        "reward-status-unavailable",
        "The deployed manager source is temporarily unavailable",
      );
    }
    if (
      liveManager.managerPrincipal !== job.managerPrincipal ||
      liveManager.managerPrincipal !== plan.material.call.contract ||
      liveManager.managerPrincipal !== plan.material.expectedEffect.recipient ||
      !liveManager.automationEligible ||
      liveManager.source.profileId !== intent.managerProfile.id ||
      liveManager.source.tier !== intent.managerProfile.recognitionTier ||
      liveManager.source.sha256 !== intent.managerProfile.expectedSourceSha256 ||
      liveManager.source.sha256 !== intent.managerProfile.observedSourceSha256 ||
      liveManager.source.sha256 !== plan.material.managerSourceFingerprint
    ) {
      return this.revalidationBlock(
        input,
        "invalidated",
        "manager-identity-changed",
        "The manager identity or source changed",
      );
    }

    const now = Date.parse(input.observedAt);
    if (input.attestation === null) {
      return this.revalidationBlock(
        input,
        "retained",
        "attestation-unavailable",
        "The signed compatibility attestation is temporarily unavailable",
      );
    }
    if (
      input.attestation.payloadSha256 !== job.attestation.payloadSha256 ||
      input.attestation.acceptedState.issuer !== job.attestation.issuer ||
      input.attestation.acceptedState.revision !== job.attestation.revision ||
      intent.acceptedAttestation.payloadSha256 !== job.attestation.payloadSha256 ||
      intent.acceptedAttestation.issuer !== job.attestation.issuer ||
      intent.acceptedAttestation.revision !== job.attestation.revision ||
      plan.material.attestationDigest !== job.attestation.payloadSha256
    ) {
      return this.revalidationBlock(
        input,
        "invalidated",
        "attestation-changed",
        "The compatibility attestation changed",
      );
    }
    if (
      !Number.isFinite(now) ||
      now >= Date.parse(input.attestation.document.payload.expiresAt) ||
      now >= Date.parse(approval.expiresAt)
    ) {
      return this.revalidationBlock(
        input,
        "invalidated",
        "attestation-expired",
        "The approval or compatibility attestation expired",
      );
    }
    if (!attestationMatches(input)) {
      return this.revalidationBlock(
        input,
        "invalidated",
        "attestation-changed",
        "The compatibility attestation changed",
      );
    }

    if (input.rewards === null || input.rewards.status !== "ready") {
      return this.revalidationBlock(
        input,
        "retained",
        "reward-status-unavailable",
        "Anchored reward status is temporarily unavailable",
      );
    }
    const checkpoint = rewardCheckpoint(input);
    if (checkpoint === null) {
      return this.revalidationBlock(
        input,
        "invalidated",
        "reward-checkpoint-changed",
        "The reward calculation changed",
      );
    }
    if (
      checkpoint.rewardCycle.toString() !== plan.material.call.rewardCycle ||
      checkpoint.rewardCycle.toString() !== intent.reconciliation.rewardCycle ||
      checkpoint.calculationCheckpoint !== plan.material.rewardObservation.calculationCheckpoint ||
      checkpoint.calculationCheckpoint !==
        intent.reconciliation.rewardCheckpoint.calculationCheckpoint ||
      checkpoint.lastRewardComputeBurnHeight !==
        plan.material.rewardObservation.lastRewardComputeBurnHeight ||
      checkpoint.lastRewardComputeBurnHeight !==
        intent.reconciliation.rewardCheckpoint.lastRewardComputeBurnHeight ||
      checkpoint.rewardsPerToken.toString() !== plan.material.rewardObservation.rewardsPerToken ||
      checkpoint.rewardsPerToken.toString() !==
        intent.reconciliation.rewardCheckpoint.rewardsPerToken
    ) {
      return this.revalidationBlock(
        input,
        "invalidated",
        "reward-checkpoint-changed",
        "The reward checkpoint changed",
      );
    }
    const feeSnapshotMatches =
      checkpoint.feeSnapshot.effectiveFeeBips.toString() ===
        plan.material.feeSnapshot.effectiveFeeBips &&
      (checkpoint.effect === "completed"
        ? checkpoint.feeSnapshot.state === "present"
        : checkpoint.feeSnapshot.state === plan.material.feeSnapshot.state);
    if (!feeSnapshotMatches) {
      return this.revalidationBlock(
        input,
        "invalidated",
        "fee-snapshot-changed",
        "The manager fee changed",
      );
    }

    if (checkpoint.effect === "completed") {
      const outcome = await this.reconcileCompleted(input, checkpoint, job, pox5, sbtcToken);
      this.#latest = outcome;
      return { status: "completed", outcome };
    }
    if (
      checkpoint.effect !== "remaining" ||
      checkpoint.observedSignerEarnedSats.toString() !== plan.material.expectedEffect.amount ||
      checkpoint.observedSignerEarnedSats.toString() !==
        intent.reconciliation.expectedEffect.amountSats ||
      plan.material.noBondParticipation.evidenceDigest !==
        intent.reconciliation.noBondEvidenceSha256
    ) {
      return this.revalidationBlock(
        input,
        "invalidated",
        "claim-amount-changed",
        "The claim amount or no-bond proof changed",
      );
    }

    let rewardsPaused: boolean;
    try {
      rewardsPaused = decodeBoolean(
        await this.options.node.getDataVar(pox5, "rewards-paused", {
          tip: input.setup.chainAnchor.indexBlockHash,
        }),
        "rewards-paused",
      );
    } catch {
      return this.revalidationBlock(
        input,
        "retained",
        "node-read-unavailable",
        "Anchored rewards-paused state is temporarily unavailable",
      );
    }
    if (rewardsPaused) {
      return this.revalidationBlock(
        input,
        "invalidated",
        "rewards-paused",
        "PoX-5 rewards were paused after approval; wait until rewards resume",
      );
    }

    if (
      input.gasPayer === null ||
      input.gasPayer.principal !== plan.material.sender.principal ||
      input.gasPayer.publicKey.toLowerCase() !== plan.material.sender.publicKey.toLowerCase()
    ) {
      return this.revalidationBlock(
        input,
        "invalidated",
        "gas-payer-changed",
        "The configured gas-payer identity changed; check Assist configuration first",
      );
    }
    const account = await this.options.liveReader.readAnchoredAccount(
      input.gasPayer.principal,
      input.setup.chainAnchor.indexBlockHash,
    );
    if (
      account.status !== "observed" ||
      account.value.indexBlockHash !== input.setup.chainAnchor.indexBlockHash
    ) {
      return this.revalidationBlock(
        input,
        "retained",
        "node-read-unavailable",
        "Anchored gas-payer account state is temporarily unavailable",
      );
    }
    if (account.value.nonce.toString() !== plan.material.transaction.nonce) {
      return this.revalidationBlock(
        input,
        "invalidated",
        "gas-nonce-changed",
        "The gas-payer nonce changed after approval",
      );
    }
    const sealedFee = BigInt(plan.material.transaction.fee);
    if (account.value.balanceUstx < sealedFee) {
      return this.revalidationBlock(
        input,
        "invalidated",
        "gas-balance-insufficient",
        "The gas-payer balance no longer covers the approved fee; fund the gas payer first",
      );
    }
    if (
      policy.mode !== "assist" ||
      BigInt(policy.estimatedFeeUstx) !== sealedFee ||
      BigInt(policy.maximumFeeUstx) !== input.maximumFeeUstx ||
      sealedFee > input.maximumFeeUstx
    ) {
      return this.revalidationBlock(
        input,
        "invalidated",
        "fee-policy-changed",
        "The Assist fee policy changed; review configuration first",
      );
    }

    return {
      status: "valid",
      job,
      liveAnchor: input.setup.chainAnchor,
      attestation: input.attestation,
      admission: {
        liveFingerprintMatches: true,
        anchorCanonical: true,
        anchorDescendant: true,
        prerequisitesComplete: true,
        feeStateMatches: true,
      },
    };
  }

  async observe(input: ManagerClaimObservationInput): Promise<ManagerClaimObservationOutcome> {
    const effectiveMode =
      this.options.repository.getForceObserveControl() === null ? input.requestedMode : "observe";
    const checkpoint = rewardCheckpoint(input);
    const rosterProof =
      checkpoint?.effect === "remaining" && !input.reconcileOnly
        ? currentRosterProof(
            this.options.evidenceStore,
            input.sourceId,
            input.setup.manager.managerPrincipal,
            input.setup.chainAnchor,
            input.rewards?.ingestion?.runId ?? null,
          )
        : null;
    const blocks = staticBlocks(input, checkpoint, rosterProof, effectiveMode);
    if (
      blocks.length > 0 ||
      !checkpoint ||
      (checkpoint.effect === "remaining" &&
        !input.reconcileOnly &&
        rosterProof?.status !== "proven")
    ) {
      this.#latest = { status: "blocked", blocks };
      return this.#latest;
    }

    const kind = networkKind(input.setup);
    const pox5 = input.setup.preflight.pox.pox5ContractId;
    const sbtcToken = input.setup.preflight.pox.sbtcTokenContract;
    if (!kind || !pox5 || !sbtcToken)
      throw new Error("Validated manager-claim identity disappeared");
    if (
      this.options.repository.getDisabledAdapterControl(MANAGER_CLAIM_REWARDS_ADAPTER_ID) !== null
    ) {
      block(blocks, "adapter-disabled", "Manager-claim transactions are disabled");
      this.#latest = { status: "blocked", blocks };
      return this.#latest;
    }
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

    if (checkpoint.effect === "remaining" && input.reconcileOnly) {
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

    if (!input.attestation) {
      block(
        blocks,
        "attestation-unavailable",
        "Assist requires a current compatibility attestation",
      );
    } else if (!attestationMatches(input)) {
      block(
        blocks,
        "attestation-fingerprint-mismatch",
        "The compatibility attestation does not match the current network and manager",
      );
    }
    if (!input.gasPayer) {
      block(blocks, "gas-payer-unavailable", "Assist requires a configured gas-payer identity");
    }
    if (input.maximumFeeUstx <= 0n) {
      block(blocks, "fee-cap-exceeded", "The manager-claim fee cap must be positive");
    }
    if (blocks.length > 0 || !input.attestation || !input.gasPayer) {
      this.#latest = { status: "blocked", blocks };
      return this.#latest;
    }
    if (rosterProof?.status !== "proven") {
      throw new Error("Validated manager-claim roster proof disappeared");
    }

    let rewardsPaused: boolean;
    try {
      rewardsPaused = decodeBoolean(
        await this.options.node.getDataVar(pox5, "rewards-paused", {
          tip: input.setup.chainAnchor.indexBlockHash,
        }),
        "rewards-paused",
      );
    } catch {
      block(
        blocks,
        "node-read-unavailable",
        "PoX-5 reward status could not be read. Check node connectivity and compatibility, then retry",
      );
      this.#latest = { status: "blocked", blocks };
      return this.#latest;
    }
    if (rewardsPaused) {
      block(blocks, "rewards-paused", "PoX-5 rewards are paused");
      this.#latest = { status: "blocked", blocks };
      return this.#latest;
    }

    const account = await this.options.liveReader.readAnchoredAccount(
      input.gasPayer.principal,
      input.setup.chainAnchor.indexBlockHash,
    );
    if (account.status !== "observed") {
      const message =
        account.status === "schema-invalid"
          ? "The gas-payer account response is incompatible with Sidekick. Check node compatibility"
          : account.reason === "http-error"
            ? "The node rejected the gas-payer account request. Check its URL and access settings"
            : "Gas-payer account state is unavailable. Check node connectivity and try again";
      block(blocks, "node-read-unavailable", message);
      this.#latest = { status: "blocked", blocks };
      return this.#latest;
    }

    const basePlan = await planManagerClaimRewards({
      schemaVersion: 1,
      adapterRevision: MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
      network: { kind, chainId: input.setup.preflight.node.networkId },
      managerContract: input.setup.manager.managerPrincipal,
      pox5Contract: pox5,
      sbtcTokenContract: sbtcToken,
      rewardCycle: checkpoint.rewardCycle,
      expectedSbtcOutflow: checkpoint.expectedSignerOutflowSats,
      chainAnchor: {
        ...input.setup.chainAnchor,
        rewardCycle: BigInt(input.setup.chainAnchor.rewardCycle),
      },
      attestationDigest: input.attestation.payloadSha256,
      managerSourceFingerprint: input.setup.manager.source.sha256,
      rewardObservation: {
        calculationCheckpoint: checkpoint.calculationCheckpoint,
        lastRewardComputeBurnHeight: checkpoint.lastRewardComputeBurnHeight,
        rewardsPerToken: checkpoint.rewardsPerToken,
      },
      noBondParticipation: { proven: true, evidenceDigest: rosterProof.evidenceSha256 },
      feeSnapshot: checkpoint.feeSnapshot,
      sender: input.gasPayer,
      nonce: account.value.nonce,
      fee: 1n,
    });
    const feeObservation = await this.options.liveReader.estimateUnsignedTransactionFee(
      basePlan.unsignedTransactionHex,
    );
    const estimate = observedFee(feeObservation);
    if (estimate === null || estimate <= 0n) {
      const message =
        feeObservation.status === "schema-invalid"
          ? "The claim fee response is incompatible with Sidekick. Check node compatibility"
          : feeObservation.status === "unavailable" && feeObservation.reason === "http-error"
            ? "The node rejected claim fee estimation. Check its URL and access settings"
            : feeObservation.status === "unavailable"
              ? "Claim fee estimation is unavailable. Check node connectivity and try again"
              : "The node returned no usable claim fee estimate. Check fee-estimation support";
      block(blocks, "fee-estimate-unavailable", message);
    } else if (estimate > input.maximumFeeUstx) {
      block(blocks, "fee-cap-exceeded", "Estimated claim fee exceeds the configured Assist cap");
    } else if (estimate > account.value.balanceUstx) {
      block(
        blocks,
        "gas-balance-insufficient",
        `Gas-payer balance cannot cover the estimated fee. Fund ${input.gasPayer.principal}`,
      );
    }
    if (blocks.length > 0 || estimate === null) {
      this.#latest = { status: "blocked", blocks };
      return this.#latest;
    }

    let result = await this.#planner.observe({
      schemaVersion: 1,
      observedAt: input.observedAt,
      network: { kind, chainId: input.setup.preflight.node.networkId },
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
        issuer: input.attestation.acceptedState.issuer,
        revision: input.attestation.acceptedState.revision,
        payloadSha256: input.attestation.payloadSha256,
        current: true,
      },
      contracts: { pox5, sbtcToken },
      rewardCheckpoint: {
        rewardCycle: checkpoint.rewardCycle,
        calculationCheckpoint: checkpoint.calculationCheckpoint,
        lastRewardComputeBurnHeight: checkpoint.lastRewardComputeBurnHeight,
        rewardsPerToken: checkpoint.rewardsPerToken,
      },
      noBondParticipation: { proven: true, evidenceSha256: rosterProof.evidenceSha256 },
      observedSignerEarnedSats: checkpoint.observedSignerEarnedSats,
      feeSnapshot: checkpoint.feeSnapshot,
      expectedSignerOutflowSats: checkpoint.expectedSignerOutflowSats,
      gasPayer: {
        ...input.gasPayer,
        observedNonce: account.value.nonce,
        estimatedFeeUstx: estimate,
        maximumFeeUstx: input.maximumFeeUstx,
      },
      controls: {
        mode: effectiveMode,
        adapterEnabled: true,
        rewardsPaused: false,
      },
      effect: { remaining: true, completionEvidenceSha256: null },
      authoritative: { complete: true, canonical: true, finalityDepth: 0 },
    });
    if (
      effectiveMode === "assist" &&
      result.status === "planned" &&
      result.job.state === "preflighted"
    ) {
      result = {
        ...result,
        job: this.options.repository.transitionLogicalJob({
          jobId: result.job.jobId,
          expectedState: "preflighted",
          expectedStateVersion: result.job.stateVersion,
          nextState: "awaiting_approval",
          changedAt: input.observedAt,
        }),
      };
    }
    this.#latest = {
      status: result.status === "reconciled" ? "reconciled" : "planned",
      blocks: [],
      result,
    };
    return this.#latest;
  }

  private async reconcileCompleted(
    input: ManagerClaimObservationInput,
    checkpoint: NonNullable<ReturnType<typeof rewardCheckpoint>>,
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
        kind: networkKind(input.setup) ?? "testnet",
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
      noBondParticipation: {
        proven: true,
        evidenceSha256: intent.reconciliation.noBondEvidenceSha256,
      },
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
