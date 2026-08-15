import type { VerifiedCompatibilityAttestation } from "@stx-labs/signer-sidekick-protocol/compatibility-attestation";
import {
  MANAGER_CLAIM_REWARDS_ADAPTER_ID,
  MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
  type ManagerClaimRewardsPlan,
} from "@stx-labs/signer-sidekick-protocol/manager-claim-rewards";
import { z } from "zod";
import { type ChainAnchor, deriveRewardCalculationTarget } from "../chain-anchor.js";
import {
  captureChainAnchor,
  type StacksApiClient,
  type StacksNodeClient,
} from "../chain-clients.js";
import type { SidekickConfig } from "../config.js";
import { managerActionCapability } from "../manager-capabilities.js";
import type { ManagerVerificationContext } from "../manager-verification.js";
import {
  type OperatorAnchorSnapshot,
  readOperatorAnchorSnapshot,
} from "../operator-anchor-snapshot.js";
import { readStxRewardStatus, type StxRewardStatus } from "../reward-status.js";
import { createChainSourceId, type SidekickStore } from "../storage/store.js";
import type { TransactionAdmissionInput } from "./admission.js";
import { RepositoryTransactionEngineApiService } from "./api-service.js";
import {
  CompatibilityAttestationController,
  type CompatibilityAttestationScope,
} from "./attestation-controller.js";
import { loadCompatibilityAttestationTrustKeys } from "./attestation-trust-store.js";
import {
  proveCanonicalAnchorRelationship,
  proveCanonicalInclusionRelationship,
} from "./canonical-anchor-proof.js";
import { GasPayerSigner } from "./gas-payer-signer.js";
import { LiveTransactionReader } from "./live-transaction-reader.js";
import {
  ManagerClaimAssistCoordinator,
  type ManagerClaimAssistExecutionResult,
  type ManagerClaimAssistRecoveryResult,
} from "./manager-claim-assist-coordinator.js";
import {
  type ManagerClaimApprovalRevalidationInput,
  type ManagerClaimApprovalRevalidationOutcome,
  type ManagerClaimObservationInput,
  type ManagerClaimObservationOutcome,
  ManagerClaimObservationService,
} from "./manager-claim-observation-service.js";
import {
  parseManagerClaimIntentRecord,
  parseManagerClaimPolicyRecord,
} from "./manager-claim-observer.js";
import {
  type ManagerClaimWalletAuthoritativeObservation,
  ManagerClaimWalletIntentError,
} from "./manager-claim-wallet-intent.js";
import type { StoredTransactionJob } from "./repository.js";
import {
  loadTransactionEngineRuntimeConfig,
  type TransactionEngineRuntimeConfig,
} from "./runtime-config.js";
import { NoRetryTransactionBroadcaster } from "./transaction-broadcaster.js";

export interface TransactionEngineRuntimeContext {
  config: SidekickConfig;
  node: StacksNodeClient;
  api: StacksApiClient;
}

export interface TransactionEngineObservationHookInput {
  setup: OperatorAnchorSnapshot;
  rewards: StxRewardStatus | null;
  sourceId: string;
  observedAt: string;
}

export interface RuntimeObservationService {
  observe(input: ManagerClaimObservationInput): Promise<ManagerClaimObservationOutcome>;
  revalidateApprovedJob(
    input: ManagerClaimApprovalRevalidationInput,
  ): Promise<ManagerClaimApprovalRevalidationOutcome>;
}

export interface RuntimeAssistCoordinator {
  execute(input: {
    jobId: string;
    admission: TransactionAdmissionInput;
  }): Promise<ManagerClaimAssistExecutionResult>;
  recover(input: {
    jobId: string;
    liveAnchor: ChainAnchor;
    observedAt: string;
  }): Promise<ManagerClaimAssistRecoveryResult>;
}

export interface SidekickTransactionEngineRuntimeComposition {
  runtimeConfig: TransactionEngineRuntimeConfig;
  store: SidekickStore;
  runtimeContext: () => TransactionEngineRuntimeContext;
  signer: GasPayerSigner | null;
  loadAttestation: (now: Date) => Promise<VerifiedCompatibilityAttestation | null>;
  createObservationService: (context: TransactionEngineRuntimeContext) => RuntimeObservationService;
  createCoordinator: (context: TransactionEngineRuntimeContext) => RuntimeAssistCoordinator;
  buildAdmission: typeof buildAdmission;
  readFreshObservation: (
    context: TransactionEngineRuntimeContext,
  ) => Promise<TransactionEngineObservationHookInput>;
  captureAnchor: (context: TransactionEngineRuntimeContext) => Promise<ChainAnchor>;
  now: () => Date;
  onError: (error: unknown) => void;
}

export interface CreateTransactionEngineRuntimeOptions {
  env: NodeJS.ProcessEnv;
  store: SidekickStore;
  managerPrincipal: string;
  managerVerification: ManagerVerificationContext | undefined;
  runtimeContext: () => TransactionEngineRuntimeContext;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

const maximumRecoveryJobsPerPass = 8;
const recoverableJobStates = [
  "nonce_reserved",
  "broadcast",
  "ambiguous",
  "confirmed",
  "noncanonical_reobserve",
] as const;
const defaultMaintenanceIntervalMs = 15_000;

function exactNow(clock: () => Date): Date {
  const now = clock();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Transaction engine clock returned an invalid instant");
  }
  return new Date(now.getTime());
}

function runtimeFailureReason(error: unknown): string {
  const kind = error instanceof Error && error.name ? error.name : "unknown-error";
  return `Transaction engine observation failed safely (${kind})`;
}

function observationAvailability(outcome: ManagerClaimObservationOutcome): {
  available: boolean;
  reason: string | null;
} {
  if (outcome.status !== "blocked") return { available: true, reason: null };
  return {
    available: false,
    reason:
      outcome.blocks.map(({ message }) => message).join("; ") ||
      "Live adapter prerequisites are not satisfied",
  };
}

function publicGasPayer(config: TransactionEngineRuntimeConfig) {
  return config.gasPayer
    ? { principal: config.gasPayer.principal, publicKey: config.gasPayer.publicKey }
    : null;
}

function configuredAttestationScope(config: SidekickConfig): CompatibilityAttestationScope {
  const networkId =
    config.expectedNetworkId ??
    (config.network === "mainnet" ? 1 : config.network === "testnet" ? 0x8000_0005 : null);
  if (networkId === null) {
    throw new Error(`Compatibility attestations require SIDEKICK_NETWORK_ID for ${config.network}`);
  }
  return { network: config.network, networkId };
}

function buildAdmission(
  job: StoredTransactionJob,
  approval: NonNullable<ReturnType<SidekickStore["transactionEngine"]["getActiveApproval"]>>,
  signer: GasPayerSigner,
  attestation: VerifiedCompatibilityAttestation,
  liveAnchor: ChainAnchor,
  now: Date,
  store: SidekickStore,
  revalidation: Extract<ManagerClaimApprovalRevalidationOutcome, { status: "valid" }>["admission"],
): TransactionAdmissionInput {
  const intent = parseManagerClaimIntentRecord(job.intent);
  const policy = parseManagerClaimPolicyRecord(job.policy);
  const plan = intent.sealedPlan;
  const attempts = store.transactionEngine.listAttempts(job.jobId);
  const reservation = store.transactionEngine.getNonceReservationForJob(job.jobId);
  const attestationCurrent =
    attestation.payloadSha256 === job.attestation.payloadSha256 &&
    Date.parse(attestation.document.payload.expiresAt) > now.getTime();
  return {
    mode: "assist",
    intentHash: job.intentSha256,
    policyHash: job.policySha256,
    attestation: {
      current: attestationCurrent,
      payloadSha256: attestation.payloadSha256,
    },
    expectedAttestationSha256: job.attestation.payloadSha256,
    liveFingerprintMatches: revalidation.liveFingerprintMatches,
    adapter: {
      id: MANAGER_CLAIM_REWARDS_ADAPTER_ID,
      revision: MANAGER_CLAIM_REWARDS_ADAPTER_REVISION,
    },
    expectedAdapter: { id: job.adapterId, revision: job.adapterRevision },
    plannedAnchor: job.chainAnchor,
    liveAnchor,
    anchorCanonical: revalidation.anchorCanonical,
    anchorDescendant: revalidation.anchorDescendant,
    prerequisitesComplete: revalidation.prerequisitesComplete,
    fee: {
      stateMatches: revalidation.feeStateMatches,
      transactionFeeUstx: BigInt(plan.material.transaction.fee),
      maximumFeeUstx: BigInt(policy.maximumFeeUstx),
    },
    approval: {
      intentHash: approval.intentSha256,
      policyHash: approval.policySha256,
      expiresAt: approval.expiresAt,
      invalidatedAt: approval.invalidatedAt,
    },
    signer: {
      available: true,
      principal: signer.principal,
      expectedPrincipal: plan.material.sender.principal,
    },
    nonce: {
      owned: reservation === null || reservation.jobId === job.jobId,
      unresolvedAttempt: attempts.some(
        ({ state }) => !["confirmed", "rejected", "reconciled"].includes(state),
      ),
      foreignActivity: reservation?.foreignActivity ?? false,
    },
    authoritativeBlockers: [],
    now,
  };
}

/**
 * Owns the small amount of mutable orchestration around the durable transaction engine.
 * Observations, approval execution, and recovery are serialized so compare-and-swap transitions
 * cannot race inside one Sidekick process.
 */
export class SidekickTransactionEngineRuntime {
  readonly api: RepositoryTransactionEngineApiService;
  readonly requestedMode: "observe" | "assist";

  readonly #composition: SidekickTransactionEngineRuntimeComposition;
  #latest: ManagerClaimObservationOutcome = {
    status: "blocked",
    blocks: [
      {
        code: "reward-status-unavailable",
        message: "No manager-claim observation has completed",
      },
    ],
  };
  #runtimeBlockReason: string | null = null;
  #operationTail: Promise<void> = Promise.resolve();
  #maintenanceTimer: NodeJS.Timeout | null = null;
  #maintenanceWork: Promise<void> | null = null;
  #recoveryCursor: string | null = null;
  #closed = false;

  constructor(composition: SidekickTransactionEngineRuntimeComposition) {
    this.#composition = composition;
    this.requestedMode = composition.runtimeConfig.requestedMode;
    this.api = new RepositoryTransactionEngineApiService({
      repository: composition.store.transactionEngine,
      requestedMode: composition.runtimeConfig.requestedMode,
      maximumApprovalMinutes: composition.runtimeConfig.maximumApprovalMinutes,
      finalityDepth: composition.runtimeConfig.finalityDepth,
      now: () => exactNow(composition.now),
      adapterAvailability: () => this.#adapterAvailability(),
      onApproved: async (jobId) => await this.refreshApprovedJob(jobId),
    });
  }

  #adapterAvailability(): { available: boolean; reason: string | null } {
    if (this.#runtimeBlockReason !== null) {
      return { available: false, reason: this.#runtimeBlockReason };
    }
    return observationAvailability(this.#latest);
  }

  async #exclusive<Value>(operation: () => Promise<Value>): Promise<Value> {
    if (this.#closed) throw new Error("Transaction engine runtime is closed");
    const previous = this.#operationTail;
    let release: (() => void) | undefined;
    this.#operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.#closed) throw new Error("Transaction engine runtime is closed");
      return await operation();
    } finally {
      release?.();
    }
  }

  async observe(
    input: TransactionEngineObservationHookInput,
  ): Promise<ManagerClaimObservationOutcome> {
    try {
      return await this.#exclusive(async () => {
        const context = this.#composition.runtimeContext();
        return await this.#observeWithContext(context, input);
      });
    } catch (error) {
      this.#runtimeBlockReason = runtimeFailureReason(error);
      throw error;
    }
  }

  /**
   * Refresh the normal engine observation and return the exact still-current Observe job binding.
   * This uses the existing planner and safety controls; it never constructs a wallet transaction.
   */
  async observeManagerClaimWalletJob(
    jobIdInput: string,
  ): Promise<ManagerClaimWalletAuthoritativeObservation> {
    const jobId = z.string().uuid().parse(jobIdInput);
    return await this.#exclusive(async () => {
      if (this.#composition.runtimeConfig.requestedMode !== "observe") {
        throw new ManagerClaimWalletIntentError(
          "unavailable",
          "Browser-wallet claims require Observe mode. Use Assist or switch modes",
        );
      }
      const context = this.#composition.runtimeContext();
      const fresh = await this.#composition.readFreshObservation(context);
      const outcome = await this.#observeWithContext(context, fresh);
      if (
        outcome.status !== "planned" ||
        outcome.result.job.jobId !== jobId ||
        outcome.result.job.state !== "preflighted" ||
        this.#composition.store.transactionEngine.getActiveLogicalJobForScope(
          outcome.result.job.operationScopeKey,
        )?.jobId !== jobId
      ) {
        throw new ManagerClaimWalletIntentError(
          "superseded",
          "This claim job changed. Refresh Operations and select the current job",
        );
      }
      const job = outcome.result.job;
      return {
        observedAt: fresh.observedAt,
        job: {
          jobId: job.jobId,
          operationScopeKey: job.operationScopeKey,
          intentSha256: job.intentSha256,
          policySha256: job.policySha256,
          stateVersion: job.stateVersion,
          attestation: { ...job.attestation },
        },
      };
    });
  }

  async #observeWithContext(
    context: TransactionEngineRuntimeContext,
    input: TransactionEngineObservationHookInput,
    maintenanceOnly = false,
  ): Promise<ManagerClaimObservationOutcome> {
    const expectedSourceId = createChainSourceId(context.config.network, context.config.apiUrl);
    if (input.sourceId !== expectedSourceId) {
      throw new Error("Transaction engine observation source changed before evaluation");
    }

    const recoveryResults = await this.#recoverActiveAt(
      context,
      input.setup.chainAnchor,
      input.observedAt,
    );
    const samePassConfirmedJobIds: string[] = [];
    for (const result of recoveryResults) {
      if (result.status !== "confirmed") continue;
      const attempt = this.#composition.store.transactionEngine.getAttempt(result.attemptId);
      const inclusion = attempt?.inclusion;
      if (
        inclusion === null ||
        inclusion === undefined ||
        !inclusion.canonical ||
        inclusion.executionStatus !== "success" ||
        inclusion.indexBlockHash !== result.indexBlockHash
      ) {
        continue;
      }
      const proof = await proveCanonicalInclusionRelationship(
        context.api,
        inclusion,
        input.setup.chainAnchor,
      );
      if (proof.status === "proven") samePassConfirmedJobIds.push(result.jobId);
    }
    const observedAt = new Date(input.observedAt);
    if (!Number.isFinite(observedAt.getTime()) || observedAt.toISOString() !== input.observedAt) {
      throw new Error("Transaction engine observation time is invalid");
    }
    const attestation = await this.#composition.loadAttestation(observedAt);
    const service = this.#composition.createObservationService(context);
    const outcome = await service.observe({
      setup: input.setup,
      rewards: input.rewards,
      sourceId: input.sourceId,
      requestedMode: this.#composition.runtimeConfig.requestedMode,
      gasPayer: publicGasPayer(this.#composition.runtimeConfig),
      maximumFeeUstx: this.#composition.runtimeConfig.maximumFeeUstx,
      attestation,
      observedAt: input.observedAt,
      samePassConfirmedJobIds,
      ...(maintenanceOnly ? { reconcileOnly: true } : {}),
    });
    this.#latest = outcome;
    this.#runtimeBlockReason = null;
    if (outcome.status === "reconciled") {
      await this.#composition.createCoordinator(context).recover({
        jobId: outcome.result.job.jobId,
        liveAnchor: input.setup.chainAnchor,
        observedAt: input.observedAt,
      });
    }
    return outcome;
  }

  async refreshApprovedJob(jobId: string): Promise<void> {
    try {
      await this.#exclusive(async () => {
        const context = this.#composition.runtimeContext();
        const lookupNow = exactNow(this.#composition.now);
        const signer = this.#composition.signer;
        if (signer === null || this.#composition.runtimeConfig.requestedMode !== "assist") return;
        const job = this.#composition.store.transactionEngine.getLogicalJob(jobId);
        const approval = this.#composition.store.transactionEngine.getActiveApproval(
          jobId,
          lookupNow.toISOString(),
        );
        if (job === null || approval === null) return;

        // Assemble a new fenced setup/reward snapshot. This path never calls the normal planner,
        // so a harmless descendant cannot create or supersede the approved immutable job.
        const fresh = await this.#composition.readFreshObservation(context);
        const expectedSourceId = createChainSourceId(context.config.network, context.config.apiUrl);
        if (fresh.sourceId !== expectedSourceId) {
          throw new Error("Transaction engine approval source changed before revalidation");
        }
        const observedAt = new Date(fresh.observedAt);
        if (
          !Number.isFinite(observedAt.getTime()) ||
          observedAt.toISOString() !== fresh.observedAt
        ) {
          throw new Error("Transaction engine approval observation time is invalid");
        }
        const attestation = await this.#composition.loadAttestation(observedAt);
        const anchorProof = await proveCanonicalAnchorRelationship(
          context.api,
          job.chainAnchor,
          fresh.setup.chainAnchor,
        );
        const service = this.#composition.createObservationService(context);
        const revalidation = await service.revalidateApprovedJob({
          ...fresh,
          job,
          approval,
          anchorProof,
          requestedMode: this.#composition.runtimeConfig.requestedMode,
          gasPayer: publicGasPayer(this.#composition.runtimeConfig),
          maximumFeeUstx: this.#composition.runtimeConfig.maximumFeeUstx,
          attestation,
          samePassConfirmedJobIds: [],
        });
        if (revalidation.status === "blocked") {
          this.#runtimeBlockReason = `Assist unavailable: ${revalidation.message} (${revalidation.code})`;
          return;
        }
        if (revalidation.status === "completed") {
          this.#latest = revalidation.outcome;
          this.#runtimeBlockReason = null;
          if (revalidation.outcome.status === "reconciled") {
            await this.#composition.createCoordinator(context).recover({
              jobId,
              liveAnchor: fresh.setup.chainAnchor,
              observedAt: fresh.observedAt,
            });
          }
          return;
        }
        // Re-prove ancestry after every pinned semantic/account read. This closes the approval
        // path's reorg window before the final clock/expiry check and admission construction.
        const executionAnchorProof = await proveCanonicalAnchorRelationship(
          context.api,
          job.chainAnchor,
          revalidation.liveAnchor,
        );
        if (executionAnchorProof.status !== "proven") {
          if (executionAnchorProof.status === "invalid") {
            this.#composition.store.transactionEngine.transitionLogicalJob({
              jobId: job.jobId,
              expectedState: job.state,
              expectedStateVersion: job.stateVersion,
              nextState: "blocked",
              blockReason: "approval-revalidation:planned-anchor-noncanonical",
              changedAt: exactNow(this.#composition.now).toISOString(),
            });
          }
          this.#runtimeBlockReason =
            executionAnchorProof.status === "invalid"
              ? "Assist unavailable: the approved chain anchor is no longer canonical. Sync chain data to prepare a new current job, then review and approve it"
              : `Assist unavailable: ${executionAnchorProof.reason}`;
          return;
        }
        const executionNow = exactNow(this.#composition.now);
        if (
          executionNow.getTime() >= Date.parse(approval.expiresAt) ||
          executionNow.getTime() >= Date.parse(revalidation.attestation.document.payload.expiresAt)
        ) {
          this.#composition.store.transactionEngine.transitionLogicalJob({
            jobId: job.jobId,
            expectedState: job.state,
            expectedStateVersion: job.stateVersion,
            nextState: "blocked",
            blockReason: "approval-revalidation:attestation-expired",
            changedAt: executionNow.toISOString(),
          });
          this.#runtimeBlockReason =
            "Assist unavailable: approval or compatibility attestation expired. Sync chain data to prepare a new current job, then review and approve it";
          return;
        }
        const admission = this.#composition.buildAdmission(
          job,
          approval,
          signer,
          revalidation.attestation,
          revalidation.liveAnchor,
          executionNow,
          this.#composition.store,
          revalidation.admission,
        );
        const result = await this.#composition.createCoordinator(context).execute({
          jobId,
          admission,
        });
        this.#runtimeBlockReason =
          result.status === "blocked"
            ? `Assist unavailable: ${result.message} (${result.code})`
            : null;
      });
    } catch (error) {
      // The approval is already durable. Keep it visible for inspection/retry and fail closed
      // instead of turning a post-persistence execution problem into a misleading API 500.
      this.#runtimeBlockReason = runtimeFailureReason(error);
      this.#composition.onError(error);
    }
  }

  async #recoverActiveAt(
    context: TransactionEngineRuntimeContext,
    liveAnchor: ChainAnchor,
    observedAt: string,
  ): Promise<ManagerClaimAssistRecoveryResult[]> {
    let page: ReturnType<SidekickStore["transactionEngine"]["listLogicalJobs"]>;
    try {
      page = this.#composition.store.transactionEngine.listLogicalJobs({
        limit: maximumRecoveryJobsPerPass,
        states: recoverableJobStates,
        ...(this.#recoveryCursor === null ? {} : { cursor: this.#recoveryCursor }),
      });
    } catch {
      // A changed state filter can invalidate a durable keyset cursor. Restart at the newest page;
      // the next completed pass will continue paging, so no job can starve indefinitely.
      this.#recoveryCursor = null;
      page = this.#composition.store.transactionEngine.listLogicalJobs({
        limit: maximumRecoveryJobsPerPass,
        states: recoverableJobStates,
      });
    }
    this.#recoveryCursor = page.nextCursor;
    if (page.items.length === 0) return [];
    const coordinator = this.#composition.createCoordinator(context);
    const results: ManagerClaimAssistRecoveryResult[] = [];
    for (const job of page.items.slice(0, maximumRecoveryJobsPerPass)) {
      try {
        results.push(
          await coordinator.recover({
            jobId: job.jobId,
            liveAnchor,
            observedAt,
          }),
        );
      } catch (error) {
        this.#runtimeBlockReason = runtimeFailureReason(error);
        this.#composition.onError(error);
      }
    }
    return results;
  }

  /** Run one bounded, read-before-transition recovery pass. It never calls a broadcast method. */
  async recoverActive(): Promise<ManagerClaimAssistRecoveryResult[]> {
    return await this.#exclusive(async () => {
      const context = this.#composition.runtimeContext();
      const anchor = await this.#composition.captureAnchor(context);
      return await this.#recoverActiveAt(
        context,
        anchor,
        exactNow(this.#composition.now).toISOString(),
      );
    });
  }

  start(intervalMs = defaultMaintenanceIntervalMs): void {
    if (this.#closed) throw new Error("Transaction engine runtime is closed");
    if (this.#maintenanceWork !== null || this.#maintenanceTimer !== null) return;
    const parsedInterval = z.number().int().min(1).max(300_000).parse(intervalMs);
    const schedule = () => {
      if (this.#closed) return;
      this.#maintenanceTimer = setTimeout(() => {
        this.#maintenanceTimer = null;
        const work = this.#exclusive(async () => {
          const context = this.#composition.runtimeContext();
          const fresh = await this.#composition.readFreshObservation(context);
          await this.#observeWithContext(context, fresh, true);
        })
          .catch((error: unknown) => {
            if (!this.#closed) {
              this.#runtimeBlockReason = runtimeFailureReason(error);
              this.#composition.onError(error);
            }
          })
          .finally(() => {
            if (this.#maintenanceWork === work) this.#maintenanceWork = null;
            schedule();
          });
        this.#maintenanceWork = work;
      }, parsedInterval);
      this.#maintenanceTimer.unref();
    };
    schedule();
  }

  async close(): Promise<void> {
    if (this.#closed) {
      await this.#maintenanceWork;
      await this.#operationTail;
      return;
    }
    this.#closed = true;
    if (this.#maintenanceTimer !== null) {
      clearTimeout(this.#maintenanceTimer);
      this.#maintenanceTimer = null;
    }
    await this.#maintenanceWork;
    await this.#operationTail;
    this.#composition.signer?.destroy();
  }
}

function readerFor(context: TransactionEngineRuntimeContext): LiveTransactionReader {
  return new LiveTransactionReader({ baseUrl: context.config.nodeRpcUrl });
}

function recoveryOnlySigner(config: TransactionEngineRuntimeConfig) {
  return {
    principal: config.gasPayer?.principal ?? "unavailable",
    publicKey: config.gasPayer?.publicKey ?? "unavailable",
    async signManagerClaimRewardsPlan(_plan: ManagerClaimRewardsPlan): Promise<never> {
      throw new Error("Observe mode cannot sign manager-claim plans");
    },
  };
}

export async function createSidekickTransactionEngineRuntime(
  options: CreateTransactionEngineRuntimeOptions,
): Promise<SidekickTransactionEngineRuntime> {
  const initialContext = options.runtimeContext();
  const runtimeConfig = loadTransactionEngineRuntimeConfig(
    options.env,
    initialContext.config.network,
  );
  const clock = options.now ?? (() => new Date());
  let signer: GasPayerSigner | null = null;

  const loadAttestation = async (now: Date) => {
    if (runtimeConfig.attestation === null) return null;
    const trustKeys = await loadCompatibilityAttestationTrustKeys(
      runtimeConfig.attestation.trustKeysFilePath,
    );
    return await new CompatibilityAttestationController(
      options.store.transactionEngine,
      trustKeys,
      configuredAttestationScope(initialContext.config),
    ).acceptFile(runtimeConfig.attestation.documentFilePath, now);
  };

  try {
    if (runtimeConfig.requestedMode === "assist") {
      const gasPayer = runtimeConfig.gasPayer;
      if (!gasPayer?.secretFilePath) {
        throw new Error("Assist gas-payer configuration disappeared after validation");
      }
      signer = await GasPayerSigner.fromSecretFile({
        secretFilePath: gasPayer.secretFilePath,
        expectedPrincipal: gasPayer.principal,
        network: initialContext.config.network === "mainnet" ? "mainnet" : "testnet",
      });
      if (signer.publicKey !== gasPayer.publicKey) {
        throw new Error("Gas-payer secret does not match the configured public key");
      }
      // Assist cannot start with an unreadable, expired, untrusted, or rollback attestation.
      await loadAttestation(exactNow(clock));
    }

    const createCoordinator = (context: TransactionEngineRuntimeContext) => {
      const reader = readerFor(context);
      return new ManagerClaimAssistCoordinator({
        repository: options.store.transactionEngine,
        signer: signer ?? recoveryOnlySigner(runtimeConfig),
        reader,
        api: context.api,
        broadcaster: new NoRetryTransactionBroadcaster({ baseUrl: context.config.nodeRpcUrl }),
        finalityDepth: runtimeConfig.finalityDepth,
      });
    };
    return new SidekickTransactionEngineRuntime({
      runtimeConfig,
      store: options.store,
      runtimeContext: options.runtimeContext,
      signer,
      loadAttestation,
      createObservationService: (context) =>
        new ManagerClaimObservationService({
          repository: options.store.transactionEngine,
          evidenceStore: options.store,
          node: context.node,
          api: context.api,
          liveReader: readerFor(context),
          finalityDepth: runtimeConfig.finalityDepth,
        }),
      createCoordinator,
      buildAdmission,
      readFreshObservation: async (context) => {
        const observedAt = exactNow(clock).toISOString();
        const setup = await readOperatorAnchorSnapshot({
          config: context.config,
          node: context.node,
          api: context.api,
          managerPrincipal: options.managerPrincipal,
          managerVerification: options.managerVerification,
          reportMissingManager: true,
        });
        const pox5ContractId = setup.preflight.pox.pox5ContractId;
        const rewardCalculation = deriveRewardCalculationTarget(
          setup.chainAnchor,
          setup.preflight.pox.firstRewardCycleId,
        );
        const rewards =
          setup.manager.attachAllowed &&
          pox5ContractId &&
          managerActionCapability(setup.manager.capabilities, "reference-reward-claims")
            .executionAvailable &&
          rewardCalculation.status === "ready"
            ? await readStxRewardStatus({
                store: options.store,
                node: context.node,
                sourceId: createChainSourceId(context.config.network, context.config.apiUrl),
                managerPrincipal: options.managerPrincipal,
                pox5ContractId,
                rewardCycle: rewardCalculation.rewardCycle,
                observedAt,
                burnBlockHeight: setup.chainAnchor.burnBlockHeight,
                stacksTipHeight: setup.chainAnchor.stacksBlockHeight,
                chainAnchor: setup.chainAnchor,
                firstRewardCycleId: setup.preflight.pox.firstRewardCycleId,
              })
            : null;
        return {
          setup,
          rewards,
          sourceId: createChainSourceId(context.config.network, context.config.apiUrl),
          observedAt,
        };
      },
      captureAnchor: async (context) => await captureChainAnchor(context.node, context.api),
      now: clock,
      onError: options.onError ?? (() => undefined),
    });
  } catch (error) {
    signer?.destroy();
    throw error;
  }
}
