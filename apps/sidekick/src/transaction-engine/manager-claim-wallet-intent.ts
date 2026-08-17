import { createHash } from "node:crypto";
import {
  addressToString,
  ClarityType,
  cvToHex,
  deserializeTransaction,
  PayloadType,
  PostConditionMode,
  serializePostConditionWire,
  validateStacksAddress,
  wireToPostCondition,
} from "@stacks/transactions";
import type { BrowserWalletIntentNetwork } from "@stx-labs/signer-sidekick-api-contracts";
import {
  MANAGER_CLAIM_REWARDS_ADAPTER_ID,
  MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
  MANAGER_CLAIM_REWARDS_FUNCTION_NAME,
} from "@stx-labs/signer-sidekick-protocol/manager-claim-rewards";
import { MAX_BOND_PERIODS_PER_CYCLE } from "@stx-labs/signer-sidekick-protocol/pox5-bonds";
import { z } from "zod";
import { parseCanonicalInstant } from "../time.js";
import {
  parseManagerClaimIntentRecord,
  parseManagerClaimPolicyRecord,
} from "./manager-claim-observer.js";
import { type TransactionEngineRepository, transactionEngineDocumentSha256 } from "./repository.js";

const mainnetChainId = 1;
const pox5TestnetChainId = 0x8000_0005;
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const uintTextSchema = z.string().regex(/^(0|[1-9]\d*)$/);

const sealedPlanSchema = z
  .object({
    kind: z.literal("manager-claim-rewards"),
    intentHash: digestSchema,
    unsignedTransactionHex: z.string().regex(/^(?:[0-9a-f]{2})+$/),
    unsignedTransactionSha256: digestSchema,
    material: z
      .object({
        schemaVersion: z.literal(1),
        adapter: z
          .object({
            id: z.literal(MANAGER_CLAIM_REWARDS_ADAPTER_ID),
            revision: z.literal(MANAGER_CLAIM_REWARDS_ADAPTER_REVISION),
          })
          .strict(),
        network: z
          .object({
            kind: z.enum(["mainnet", "testnet"]),
            chainId: z.number().int().nonnegative().max(0xffff_ffff),
          })
          .strict(),
        attestationDigest: digestSchema,
        managerSourceFingerprint: digestSchema,
        rewardObservation: z
          .object({
            calculationCheckpoint: z.enum(["first-half", "second-half"]),
            lastRewardComputeBurnHeight: z.number().int().positive().safe(),
            rewardsPerToken: uintTextSchema,
          })
          .strict(),
        stxEarnedSats: uintTextSchema,
        bondBuckets: z
          .array(
            z
              .object({
                bondIndex: uintTextSchema,
                managerSharesSats: uintTextSchema,
                earnedSats: uintTextSchema,
                feeSnapshot: z
                  .object({
                    state: z.enum(["absent", "present"]),
                    effectiveFeeBips: uintTextSchema,
                  })
                  .strict(),
              })
              .strict(),
          )
          .max(MAX_BOND_PERIODS_PER_CYCLE),
        feeSnapshot: z
          .object({ state: z.enum(["absent", "present"]), effectiveFeeBips: uintTextSchema })
          .strict(),
        call: z
          .object({
            contract: z.string().min(1),
            functionName: z.literal(MANAGER_CLAIM_REWARDS_FUNCTION_NAME),
            bondPeriods: z.array(uintTextSchema).max(MAX_BOND_PERIODS_PER_CYCLE),
            rewardCycle: uintTextSchema,
          })
          .strict(),
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
            nonce: uintTextSchema,
            fee: uintTextSchema,
            unsignedTransactionSha256: digestSchema,
          })
          .strict(),
      })
      .passthrough(),
  })
  .strict();

type ClaimWalletRepository = Pick<
  TransactionEngineRepository,
  | "getLogicalJob"
  | "getActiveLogicalJobForScope"
  | "getDisabledAdapterControl"
  | "getForceObserveControl"
  | "getLatestApproval"
  | "getNonceReservationForJob"
  | "get"
  | "listAttempts"
  | "listReconciliationObservations"
>;

export class ManagerClaimWalletIntentError extends Error {
  constructor(
    readonly code: "unavailable" | "invalid" | "superseded",
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ManagerClaimWalletIntentError";
  }
}

export interface ManagerClaimWalletLiveIdentity {
  requestedMode: "observe" | "assist";
  network: {
    name: BrowserWalletIntentNetwork;
    kind: "mainnet" | "testnet";
    chainId: number;
  };
  manager: { principal: string; profileId: string; sourceSha256: string };
}

export interface ManagerClaimWalletAuthoritativeObservation {
  observedAt: string;
  job: {
    jobId: string;
    operationScopeKey: string;
    intentSha256: string;
    policySha256: string;
    stateVersion: number;
    attestation: {
      issuer: string;
      revision: number;
      payloadSha256: string;
    };
  };
}

export interface ManagerClaimWalletJobBinding {
  jobId: string;
  operationScopeKey: string;
  intentSha256: string;
  policySha256: string;
  sealedPlanIntentHash: string;
  unsignedTransactionSha256: string;
  reconciliationSha256: string;
}

export interface ManagerClaimWalletIntentFacts {
  scope: string;
  facts: {
    schemaVersion: 1;
    kind: "reference-manager-claim-rewards-wallet";
    actorPrincipal: string;
    job: ManagerClaimWalletJobBinding;
    managerPrincipal: string;
    network: BrowserWalletIntentNetwork;
    chainId: number;
    call: {
      contract: string;
      functionName: typeof MANAGER_CLAIM_REWARDS_FUNCTION_NAME;
      functionArgs: string[];
    };
    expectedEffect: {
      asset: string;
      sender: string;
      recipient: string;
      amountSats: string;
      postCondition: string;
    };
  };
  requiredSender: string;
  network: BrowserWalletIntentNetwork;
  chainId: number;
  transaction: {
    method: "stx_callContract";
    params: {
      contract: string;
      functionName: typeof MANAGER_CLAIM_REWARDS_FUNCTION_NAME;
      functionArgs: string[];
      network: BrowserWalletIntentNetwork;
      address: string;
      sponsored: false;
      postConditionMode: "deny";
      postConditions: [string];
    };
  };
  review: {
    title: string;
    summary: string;
    expectedPostState: string;
    fields: Array<{ label: string; value: string }>;
  };
}

export type ManagerClaimWalletJobStatus =
  | "prepared"
  | "awaiting-reconciliation"
  | "complete"
  | "superseded";

function unavailable(message: string): never {
  throw new ManagerClaimWalletIntentError("unavailable", message);
}

function invalid(message: string): never {
  throw new ManagerClaimWalletIntentError("invalid", message);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "hex")).digest("hex");
}

function publicNetwork(input: ManagerClaimWalletLiveIdentity["network"]): {
  network: BrowserWalletIntentNetwork;
  chainId: number;
  transactionVersion: 0 | 0x80;
} {
  if (!Number.isInteger(input.chainId) || input.chainId < 0 || input.chainId > 0xffff_ffff) {
    return unavailable("The claim transaction has an invalid chain ID");
  }
  if (input.name === "mainnet" && input.kind === "mainnet" && input.chainId === mainnetChainId) {
    return { network: "mainnet", chainId: mainnetChainId, transactionVersion: 0 };
  }
  if (
    input.name === "pox5-testnet" &&
    input.kind === "testnet" &&
    input.chainId === pox5TestnetChainId
  ) {
    return {
      network: "pox5-testnet",
      chainId: pox5TestnetChainId,
      transactionVersion: 0x80,
    };
  }
  if ((input.name === "devnet" || input.name === "regtest") && input.kind === "testnet") {
    return { network: input.name, chainId: input.chainId, transactionVersion: 0x80 };
  }
  return unavailable("The claim job does not match Sidekick's configured network");
}

function assertActorNetwork(actorPrincipal: string, network: BrowserWalletIntentNetwork): void {
  if (!validateStacksAddress(actorPrincipal)) {
    invalid("Connect a valid Stacks account to pay for this claim");
  }
  const isMainnet = actorPrincipal.startsWith("SP") || actorPrincipal.startsWith("SM");
  if (isMainnet !== (network === "mainnet")) {
    invalid("The connected account is for a different network");
  }
}

function exactJob(
  repository: ClaimWalletRepository,
  jobId: string,
  binding?: ManagerClaimWalletJobBinding,
) {
  const job = repository.getLogicalJob(jobId);
  if (job === null) invalid("This claim job no longer exists. Refresh Operations");
  if (
    job.adapterId !== MANAGER_CLAIM_REWARDS_ADAPTER_ID ||
    job.adapterRevision !== MANAGER_CLAIM_REWARDS_ADAPTER_REVISION ||
    transactionEngineDocumentSha256(job.intent) !== job.intentSha256 ||
    transactionEngineDocumentSha256(job.policy) !== job.policySha256
  ) {
    invalid("This claim job failed its integrity check. Do not sign it");
  }
  if (
    binding &&
    (job.jobId !== binding.jobId ||
      job.operationScopeKey !== binding.operationScopeKey ||
      job.intentSha256 !== binding.intentSha256 ||
      job.policySha256 !== binding.policySha256)
  ) {
    invalid("This claim job changed. Prepare the transaction again");
  }
  return job;
}

async function assertCurrentEligibility(input: {
  repository: ClaimWalletRepository;
  jobId: string;
  observation: ManagerClaimWalletAuthoritativeObservation;
}): Promise<void> {
  const job = exactJob(input.repository, input.jobId);
  const observedAt = parseCanonicalInstant(input.observation.observedAt);
  if (
    !observedAt ||
    input.observation.job.jobId !== job.jobId ||
    input.observation.job.operationScopeKey !== job.operationScopeKey ||
    input.observation.job.intentSha256 !== job.intentSha256 ||
    input.observation.job.policySha256 !== job.policySha256 ||
    input.observation.job.stateVersion !== job.stateVersion ||
    input.observation.job.attestation.issuer !== job.attestation.issuer ||
    input.observation.job.attestation.revision !== job.attestation.revision ||
    input.observation.job.attestation.payloadSha256 !== job.attestation.payloadSha256
  ) {
    unavailable("This claim job changed. Sync chain data and select the current job");
  }
  const accepted = await input.repository.get(job.attestation.issuer);
  if (
    accepted === null ||
    accepted.acceptedState.revision !== job.attestation.revision ||
    accepted.acceptedState.payloadSha256 !== job.attestation.payloadSha256 ||
    Date.parse(accepted.document.payload.expiresAt) <= observedAt.getTime()
  ) {
    unavailable("This claim job's compatibility attestation expired or changed. Sync chain data");
  }
  if (input.repository.getDisabledAdapterControl(MANAGER_CLAIM_REWARDS_ADAPTER_ID) !== null) {
    unavailable("The manager-claim adapter is disabled");
  }
  if (input.repository.getForceObserveControl() !== null) {
    unavailable("Emergency Observe mode blocks new browser-wallet claims");
  }
}

/**
 * Convert an existing immutable Observe job into a browser-wallet request without replanning it.
 * The exact contract call, arguments, and postcondition are extracted from the sealed unsigned
 * transaction. The browser wallet remains responsible only for its own sender, nonce, fee, and
 * signature.
 */
function resolveManagerClaimWalletIntent(input: {
  repository: ClaimWalletRepository;
  jobId: string;
  actorPrincipal: string;
  live: ManagerClaimWalletLiveIdentity;
  requirePrepared: boolean;
}): ManagerClaimWalletIntentFacts {
  if (input.requirePrepared && input.live.requestedMode !== "observe") {
    unavailable("Browser-wallet claims require Observe mode. Use Assist or switch modes");
  }
  const job = exactJob(input.repository, input.jobId);
  const intent = parseManagerClaimIntentRecord(job.intent);
  const policy = parseManagerClaimPolicyRecord(job.policy);
  if (
    policy.mode !== "observe" ||
    policy.approvalRequired ||
    policy.nonceReservationAllowed ||
    policy.signingAllowed ||
    policy.broadcastAllowed ||
    !policy.adapterEnabled ||
    policy.rewardsPaused
  ) {
    unavailable("This claim job is not ready for browser-wallet execution. Refresh Operations");
  }
  if (input.requirePrepared && job.state !== "preflighted") {
    throw new ManagerClaimWalletIntentError(
      "superseded",
      "This claim job is no longer ready for browser-wallet execution. Refresh Operations",
    );
  }
  if (
    input.requirePrepared &&
    ((job.state === "preflighted" &&
      input.repository.getActiveLogicalJobForScope(job.operationScopeKey)?.jobId !== job.jobId) ||
      input.repository.getLatestApproval(job.jobId) !== null ||
      input.repository.getNonceReservationForJob(job.jobId) !== null ||
      input.repository.listAttempts(job.jobId).length !== 0)
  ) {
    unavailable("This claim job already has Assist or transaction activity. Refresh Operations");
  }

  const planResult = sealedPlanSchema.safeParse(intent.sealedPlan);
  if (!planResult.success)
    invalid("This claim job failed its sealed-plan integrity check. Do not sign it");
  const plan = planResult.data;
  const network = publicNetwork(input.live.network);
  assertActorNetwork(input.actorPrincipal, network.network);
  if (
    job.managerPrincipal !== input.live.manager.principal ||
    intent.operationScopeKey !== job.operationScopeKey ||
    intent.managerProfile.id !== input.live.manager.profileId ||
    intent.managerProfile.expectedSourceSha256 !== input.live.manager.sourceSha256 ||
    intent.managerProfile.observedSourceSha256 !== input.live.manager.sourceSha256 ||
    !["reference-built-in", "reference-render"].includes(intent.managerProfile.recognitionTier) ||
    plan.material.managerSourceFingerprint !== input.live.manager.sourceSha256 ||
    plan.material.attestationDigest !== intent.acceptedAttestation.payloadSha256 ||
    plan.material.network.kind !== input.live.network.kind ||
    plan.material.network.chainId !== input.live.network.chainId ||
    plan.material.call.contract !== job.managerPrincipal ||
    plan.material.expectedEffect.recipient !== job.managerPrincipal
  ) {
    invalid("This claim job no longer matches the verified manager. Do not sign it");
  }
  if (
    plan.material.transaction.unsignedTransactionSha256 !== plan.unsignedTransactionSha256 ||
    sha256Hex(plan.unsignedTransactionHex) !== plan.unsignedTransactionSha256
  ) {
    invalid("The claim transaction failed its byte-integrity check. Do not sign it");
  }

  let transaction: ReturnType<typeof deserializeTransaction>;
  try {
    transaction = deserializeTransaction(plan.unsignedTransactionHex);
  } catch {
    return invalid("The claim transaction cannot be decoded. Do not sign it");
  }
  if (
    Buffer.from(transaction.serializeBytes()).toString("hex") !== plan.unsignedTransactionHex ||
    transaction.transactionVersion !== network.transactionVersion ||
    transaction.chainId !== network.chainId ||
    transaction.postConditionMode !== PostConditionMode.Deny ||
    transaction.postConditions.values.length !== 1 ||
    transaction.payload.payloadType !== PayloadType.ContractCall
  ) {
    invalid("The claim transaction failed its network or postcondition-mode check. Do not sign it");
  }
  const payload = transaction.payload;
  const contract = `${addressToString(payload.contractAddress)}.${payload.contractName.content}`;
  // Recompute the bucket digest from the sealed plan so the comparison below proves the intent
  // record still describes the readings this transaction was built from.
  const plannedBondBucketsSha256 = transactionEngineDocumentSha256({
    schemaVersion: 1,
    kind: "manager-claim-bond-buckets",
    stxEarnedSats: plan.material.stxEarnedSats,
    bondBuckets: plan.material.bondBuckets,
  });
  const functionArgs = payload.functionArgs.map(cvToHex);
  if (
    contract !== plan.material.call.contract ||
    payload.functionName.content !== MANAGER_CLAIM_REWARDS_FUNCTION_NAME ||
    payload.functionArgs.length !== 2 ||
    payload.functionArgs[0]?.type !== ClarityType.List ||
    payload.functionArgs[0].value.length !== 0 ||
    payload.functionArgs[1]?.type !== ClarityType.UInt ||
    payload.functionArgs[1].value.toString() !== plan.material.call.rewardCycle
  ) {
    invalid("The claim transaction does not match the sealed contract call. Do not sign it");
  }
  const condition = transaction.postConditions.values[0];
  if (condition === undefined)
    invalid("The claim transaction is missing its postcondition. Do not sign it");
  const decodedCondition = wireToPostCondition(condition);
  if (
    decodedCondition.type !== "ft-postcondition" ||
    decodedCondition.address !== plan.material.expectedEffect.sender ||
    decodedCondition.condition !== "eq" ||
    decodedCondition.amount !== plan.material.expectedEffect.amount ||
    decodedCondition.asset !== plan.material.expectedEffect.asset ||
    intent.reconciliation.managerContract !== job.managerPrincipal ||
    intent.reconciliation.rewardCycle !== plan.material.call.rewardCycle ||
    intent.reconciliation.rewardCheckpoint.calculationCheckpoint !==
      plan.material.rewardObservation.calculationCheckpoint ||
    intent.reconciliation.rewardCheckpoint.lastRewardComputeBurnHeight !==
      plan.material.rewardObservation.lastRewardComputeBurnHeight ||
    intent.reconciliation.rewardCheckpoint.rewardsPerToken !==
      plan.material.rewardObservation.rewardsPerToken ||
    intent.reconciliation.bondBucketsSha256 !== plannedBondBucketsSha256 ||
    intent.reconciliation.expectedFeeSnapshot.effectiveFeeBips !==
      plan.material.feeSnapshot.effectiveFeeBips ||
    intent.reconciliation.expectedEffect.asset !== decodedCondition.asset ||
    intent.reconciliation.expectedEffect.sender !== decodedCondition.address ||
    intent.reconciliation.expectedEffect.recipient !== plan.material.expectedEffect.recipient ||
    intent.reconciliation.expectedEffect.amountSats !== decodedCondition.amount
  ) {
    invalid("The claim transaction does not match the exact sBTC effect. Do not sign it");
  }
  const [assetContract, assetName, extraAssetPart] = decodedCondition.asset.split("::");
  if (
    extraAssetPart !== undefined ||
    assetName !== "sbtc-token" ||
    !assetContract?.endsWith(".sbtc-token") ||
    !decodedCondition.address.endsWith(".pox-5")
  ) {
    invalid("The claim postcondition does not match the PoX-5 sBTC asset effect. Do not sign it");
  }
  const postCondition = serializePostConditionWire(condition);
  const reconciliationSha256 = transactionEngineDocumentSha256(intent.reconciliation);
  const jobBinding: ManagerClaimWalletJobBinding = {
    jobId: job.jobId,
    operationScopeKey: job.operationScopeKey,
    intentSha256: job.intentSha256,
    policySha256: job.policySha256,
    sealedPlanIntentHash: plan.intentHash,
    unsignedTransactionSha256: plan.unsignedTransactionSha256,
    reconciliationSha256,
  };
  return {
    scope: `manager-claim-wallet:${job.jobId}`,
    requiredSender: input.actorPrincipal,
    network: network.network,
    chainId: network.chainId,
    facts: {
      schemaVersion: 1,
      kind: "reference-manager-claim-rewards-wallet",
      actorPrincipal: input.actorPrincipal,
      job: jobBinding,
      managerPrincipal: job.managerPrincipal,
      network: network.network,
      chainId: network.chainId,
      call: {
        contract,
        functionName: MANAGER_CLAIM_REWARDS_FUNCTION_NAME,
        functionArgs,
      },
      expectedEffect: {
        asset: decodedCondition.asset,
        sender: decodedCondition.address,
        recipient: plan.material.expectedEffect.recipient,
        amountSats: decodedCondition.amount,
        postCondition,
      },
    },
    transaction: {
      method: "stx_callContract",
      params: {
        contract,
        functionName: MANAGER_CLAIM_REWARDS_FUNCTION_NAME,
        functionArgs,
        network: network.network,
        address: input.actorPrincipal,
        sponsored: false,
        postConditionMode: "deny",
        postConditions: [postCondition],
      },
    },
    review: {
      title: "Claim signer rewards",
      summary: `Claim signer rewards for cycle ${plan.material.call.rewardCycle}.`,
      expectedPostState: "The claim is confirmed on-chain and the transaction job is updated.",
      fields: [
        { label: "Job ID", value: job.jobId },
        { label: "Manager", value: job.managerPrincipal },
        { label: "Wallet payer", value: input.actorPrincipal },
        { label: "Reward cycle", value: plan.material.call.rewardCycle },
        { label: "Expected sBTC (sats)", value: decodedCondition.amount },
        { label: "Intent SHA-256", value: job.intentSha256 },
      ],
    },
  };
}

export async function prepareManagerClaimWalletIntent(
  input: Omit<Parameters<typeof resolveManagerClaimWalletIntent>[0], "requirePrepared"> & {
    observation: ManagerClaimWalletAuthoritativeObservation;
  },
): Promise<ManagerClaimWalletIntentFacts> {
  await assertCurrentEligibility(input);
  return resolveManagerClaimWalletIntent({ ...input, requirePrepared: true });
}

/** Reconstruct the same immutable facts while an externally submitted job reconciles. */
export function readManagerClaimWalletIntent(
  input: Omit<Parameters<typeof resolveManagerClaimWalletIntent>[0], "requirePrepared">,
): ManagerClaimWalletIntentFacts {
  return resolveManagerClaimWalletIntent({ ...input, requirePrepared: false });
}

/**
 * Reconstruct an already-submitted claim from its immutable job identity. Capability and source
 * review are new-work gates; they must not make canonical observation disappear after broadcast.
 * Current network routing is still supplied and verified by the wallet-intent service.
 */
export function readBoundManagerClaimWalletIntent(input: {
  repository: ClaimWalletRepository;
  jobId: string;
  actorPrincipal: string;
  network: ManagerClaimWalletLiveIdentity["network"];
  managerPrincipal: string;
}): ManagerClaimWalletIntentFacts {
  const job = exactJob(input.repository, input.jobId);
  const intent = parseManagerClaimIntentRecord(job.intent);
  if (job.managerPrincipal !== input.managerPrincipal) {
    invalid("The submitted claim no longer matches its stored manager binding");
  }
  return resolveManagerClaimWalletIntent({
    repository: input.repository,
    jobId: input.jobId,
    actorPrincipal: input.actorPrincipal,
    live: {
      requestedMode: "observe",
      network: input.network,
      manager: {
        principal: job.managerPrincipal,
        profileId: intent.managerProfile.id,
        sourceSha256: intent.managerProfile.expectedSourceSha256,
      },
    },
    requirePrepared: false,
  });
}

/** Classify only the already-bound engine job; this function never plans or mutates work. */
export function managerClaimWalletJobStatus(input: {
  repository: ClaimWalletRepository;
  binding: ManagerClaimWalletJobBinding;
}): ManagerClaimWalletJobStatus {
  let job: ReturnType<typeof exactJob>;
  try {
    job = exactJob(input.repository, input.binding.jobId, input.binding);
  } catch {
    return "superseded";
  }
  const intent = parseManagerClaimIntentRecord(job.intent);
  const plan = sealedPlanSchema.safeParse(intent.sealedPlan);
  if (
    !plan.success ||
    plan.data.intentHash !== input.binding.sealedPlanIntentHash ||
    plan.data.unsignedTransactionSha256 !== input.binding.unsignedTransactionSha256 ||
    transactionEngineDocumentSha256(intent.reconciliation) !== input.binding.reconciliationSha256
  ) {
    return "superseded";
  }
  if (job.state === "preflighted") {
    return input.repository.getActiveLogicalJobForScope(job.operationScopeKey)?.jobId === job.jobId
      ? "prepared"
      : "superseded";
  }
  if (job.state === "confirmed") return "awaiting-reconciliation";
  if (job.state !== "reconciled") return "superseded";
  const complete = input.repository
    .listReconciliationObservations(job.jobId)
    .some(
      (observation) =>
        observation.predicateSha256 === input.binding.reconciliationSha256 &&
        observation.authoritative &&
        observation.canonical &&
        !observation.effectRemaining &&
        (observation.outcome === "external_success" || observation.outcome === "satisfied"),
    );
  return complete ? "complete" : "superseded";
}
