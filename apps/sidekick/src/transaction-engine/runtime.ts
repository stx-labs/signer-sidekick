import type { RewardOperationPlan } from "@stx-labs/signer-sidekick-protocol/reward-operation-plan";
import { z } from "zod";
import { type ChainAnchor, deriveRewardCalculationTarget } from "../chain-anchor.js";
import {
  captureChainAnchor,
  type StacksApiClient,
  type StacksNodeClient,
} from "../chain-clients.js";
import type { SidekickConfig } from "../config.js";
import type { GasWalletSweepPlan } from "../gas-wallet-sweep.js";
import { managerActionCapability } from "../manager-capabilities.js";
import type { ManagerVerificationContext } from "../manager-verification.js";
import {
  type OperatorAnchorSnapshot,
  readOperatorAnchorSnapshot,
} from "../operator-anchor-snapshot.js";
import { indexedApiCompatible } from "../preflight.js";
import {
  anchorSetupToRewardEvidence,
  resolveRosterProjectionAnchor,
} from "../reward-observation-anchor.js";
import { readStxRewardStatus, type StxRewardStatus } from "../reward-status.js";
import { createChainSourceId, type SidekickStore } from "../storage/store.js";
import { copyValidDate, parseCanonicalInstant } from "../time.js";
import { RepositoryTransactionEngineApiService } from "./api-service.js";
import {
  GasPayerSigner,
  type SignedGasWalletSweepTransaction,
  type SignedRewardOperationTransaction,
} from "./gas-payer-signer.js";
import {
  type ManagerClaimObservationInput,
  type ManagerClaimObservationOutcome,
  ManagerClaimObservationService,
} from "./manager-claim-observation-service.js";
import {
  loadTransactionEngineRuntimeConfig,
  type TransactionEngineMode,
  type TransactionEngineRuntimeConfig,
} from "./runtime-config.js";

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
}

export interface SidekickTransactionEngineRuntimeComposition {
  runtimeConfig: TransactionEngineRuntimeConfig;
  store: SidekickStore;
  runtimeContext: () => TransactionEngineRuntimeContext;
  /** Mutable holder so the gas wallet can be activated on a running engine (plan S2). */
  signerHolder: GasPayerSignerHolder;
  createObservationService: (context: TransactionEngineRuntimeContext) => RuntimeObservationService;
  readFreshObservation: (
    context: TransactionEngineRuntimeContext,
  ) => Promise<TransactionEngineObservationHookInput>;
  /**
   * Fresh anchored setup without the reward-status read. Reward runs only need the setup
   * (contract identities, fingerprints, capabilities); skipping the per-member reward reads keeps
   * preparation and per-child materialization fast. Falls back to `readFreshObservation`.
   */
  readFreshSetup?: (
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

const defaultMaintenanceIntervalMs = 15_000;

function exactNow(clock: () => Date): Date {
  const now = copyValidDate(clock());
  if (!now) {
    throw new Error("Transaction engine clock returned an invalid instant");
  }
  return now;
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

export interface GasPayerIdentity {
  principal: string;
  publicKey: string;
}

export interface GasPayerSignerHolder {
  current: GasPayerSigner | null;
  identity: GasPayerIdentity | null;
}

function publicGasPayer(holder: GasPayerSignerHolder): GasPayerIdentity | null {
  return holder.identity ? { ...holder.identity } : null;
}

/**
 * Owns the small amount of mutable orchestration around the durable transaction engine.
 * Legacy evidence maintenance and recipe-run signing are serialized so durable state transitions
 * cannot race inside one Sidekick process.
 */
export class SidekickTransactionEngineRuntime {
  readonly api: RepositoryTransactionEngineApiService;
  readonly requestedMode: TransactionEngineMode;

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
  #closed = false;

  constructor(composition: SidekickTransactionEngineRuntimeComposition) {
    this.#composition = composition;
    this.requestedMode = composition.runtimeConfig.requestedMode;
    this.api = new RepositoryTransactionEngineApiService({
      repository: composition.store.transactionEngine,
      requestedMode: composition.runtimeConfig.requestedMode,
      finalityDepth: composition.runtimeConfig.finalityDepth,
      now: () => exactNow(composition.now),
      adapterAvailability: () => this.#adapterAvailability(),
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

  async #observeWithContext(
    context: TransactionEngineRuntimeContext,
    input: TransactionEngineObservationHookInput,
    maintenanceOnly = false,
  ): Promise<ManagerClaimObservationOutcome> {
    const expectedSourceId = createChainSourceId(context.config.network, context.config.apiUrl);
    if (input.sourceId !== expectedSourceId) {
      throw new Error("Transaction engine observation source changed before evaluation");
    }

    const observedAt = parseCanonicalInstant(input.observedAt);
    if (!observedAt) {
      throw new Error("Transaction engine observation time is invalid");
    }
    void observedAt;
    const service = this.#composition.createObservationService(context);
    const outcome = await service.observe({
      setup: input.setup,
      rewards: input.rewards,
      observedAt: input.observedAt,
      samePassConfirmedJobIds: [],
      ...(maintenanceOnly ? { reconcileOnly: true } : {}),
    });
    this.#latest = outcome;
    this.#runtimeBlockReason = null;
    return outcome;
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
    this.#composition.signerHolder.current?.destroy();
    this.#composition.signerHolder.current = null;
  }

  /** Absolute per-attempt fee cap; the gas wallet's "≈ N transactions" estimate uses it. */
  get maximumFeeUstx(): bigint {
    return this.#composition.runtimeConfig.maximumFeeUstx;
  }

  get runStartWindowMinutes(): number {
    return this.#composition.runtimeConfig.runStartWindowMinutes;
  }

  get maximumRunHours(): number {
    return this.#composition.runtimeConfig.maximumRunHours;
  }

  get maximumRunTransactions(): number {
    return this.#composition.runtimeConfig.maximumRunTransactions;
  }

  /** Whether a gas-wallet signer is currently loaded in this process. */
  gasWalletSignerReady(): boolean {
    return this.#composition.signerHolder.current !== null;
  }

  /** Public identity of the active gas payer (configured or activated), if any. */
  gasPayerIdentity(): GasPayerIdentity | null {
    return publicGasPayer(this.#composition.signerHolder);
  }

  /** One current, anchor-fenced reward observation for S3/S4 recipe derivation and revalidation. */
  async readRewardRunObservation(): Promise<TransactionEngineObservationHookInput> {
    const context = this.#composition.runtimeContext();
    // Setup-only reads touch no engine state, so they need not queue behind an observe pass.
    if (this.#composition.readFreshSetup) return await this.#composition.readFreshSetup(context);
    return await this.#exclusive(async () => await this.#composition.readFreshObservation(context));
  }

  /**
   * Loads the gas wallet secret into the running engine (plan S2). Serialized with observations so
   * no approval can execute against a half-swapped signer. Fails closed: on any error the previous
   * signer is left untouched and the error is rethrown.
   */
  async activateGasWallet(input: {
    principal: string;
    publicKey: string;
    secretFilePath: string;
    network: "mainnet" | "testnet";
  }): Promise<void> {
    if (this.#composition.runtimeConfig.requestedMode !== "operator-run") {
      throw new Error("Gas wallet activation requires SIDEKICK_ENGINE_MODE=operator-run");
    }
    if (this.#closed) throw new Error("Transaction engine runtime is closed");
    await this.#exclusive(async () => {
      const signer = await GasPayerSigner.fromSecretFile({
        secretFilePath: input.secretFilePath,
        expectedPrincipal: input.principal,
        network: input.network,
      });
      if (signer.publicKey !== input.publicKey.toLowerCase()) {
        signer.destroy();
        throw new Error("Gas wallet secret does not match the recorded public key");
      }
      const previous = this.#composition.signerHolder.current;
      this.#composition.signerHolder.current = signer;
      this.#composition.signerHolder.identity = {
        principal: input.principal,
        publicKey: signer.publicKey,
      };
      previous?.destroy();
    });
  }

  /**
   * Signs a sealed gas-wallet sweep (plan §7.6) under the same mutex that serializes reward
   * execution, so a sweep and a reward run can never sign concurrently.
   */
  async signGasWalletSweep(plan: GasWalletSweepPlan): Promise<SignedGasWalletSweepTransaction> {
    if (this.#closed) throw new Error("Transaction engine runtime is closed");
    return await this.#exclusive(async () => {
      const signer = this.#composition.signerHolder.current;
      if (signer === null) throw new Error("No gas wallet signer is loaded");
      return await signer.signGasWalletSweepPlan(plan);
    });
  }

  async #signRewardOperation(
    operation: (signer: GasPayerSigner) => Promise<SignedRewardOperationTransaction>,
  ): Promise<SignedRewardOperationTransaction> {
    if (this.#closed) throw new Error("Transaction engine runtime is closed");
    return await this.#exclusive(async () => {
      const signer = this.#composition.signerHolder.current;
      if (signer === null) throw new Error("No gas wallet signer is loaded");
      return await operation(signer);
    });
  }

  signPox5CalculateRewardsPlan(
    plan: RewardOperationPlan,
  ): Promise<SignedRewardOperationTransaction> {
    return this.#signRewardOperation((signer) => signer.signPox5CalculateRewardsPlan(plan));
  }

  signManagerClaimRewardsRunPlan(
    plan: RewardOperationPlan,
  ): Promise<SignedRewardOperationTransaction> {
    return this.#signRewardOperation((signer) => signer.signManagerClaimRewardsRunPlan(plan));
  }

  signClaimStakerRewardsPlan(plan: RewardOperationPlan): Promise<SignedRewardOperationTransaction> {
    return this.#signRewardOperation((signer) => signer.signClaimStakerRewardsPlan(plan));
  }

  signSettleAcceptedWithdrawalPlan(
    plan: RewardOperationPlan,
  ): Promise<SignedRewardOperationTransaction> {
    return this.#signRewardOperation((signer) => signer.signSettleAcceptedWithdrawalPlan(plan));
  }

  signReclaimFailedWithdrawalPlan(
    plan: RewardOperationPlan,
  ): Promise<SignedRewardOperationTransaction> {
    return this.#signRewardOperation((signer) => signer.signReclaimFailedWithdrawalPlan(plan));
  }

  /** Legacy engine jobs that are executing or ambiguous; sweeps refuse while any exist. */
  activeJobCount(): number {
    const status = this.api.status();
    return status.jobs.active + status.jobs.ambiguous;
  }

  /** Drops the loaded gas-wallet signer; the public identity stays for recovery/observation. */
  async deactivateGasWallet(): Promise<void> {
    await this.#exclusive(async () => {
      const previous = this.#composition.signerHolder.current;
      this.#composition.signerHolder.current = null;
      previous?.destroy();
    });
  }
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
  const signerHolder: GasPayerSignerHolder = {
    current: null,
    identity: runtimeConfig.gasPayer
      ? { principal: runtimeConfig.gasPayer.principal, publicKey: runtimeConfig.gasPayer.publicKey }
      : null,
  };

  try {
    if (runtimeConfig.requestedMode === "operator-run") {
      // An environment-configured gas payer (with secret) is loaded at startup; the Settings-managed
      // gas wallet is activated later through `activateGasWallet` (plan S2).
      const gasPayer = runtimeConfig.gasPayer;
      if (gasPayer?.secretFilePath) {
        const signer = await GasPayerSigner.fromSecretFile({
          secretFilePath: gasPayer.secretFilePath,
          expectedPrincipal: gasPayer.principal,
          network: initialContext.config.network === "mainnet" ? "mainnet" : "testnet",
        });
        if (signer.publicKey !== gasPayer.publicKey) {
          signer.destroy();
          throw new Error("Gas-payer secret does not match the configured public key");
        }
        signerHolder.current = signer;
      }
    }

    return new SidekickTransactionEngineRuntime({
      runtimeConfig,
      store: options.store,
      runtimeContext: options.runtimeContext,
      signerHolder,
      createObservationService: (context) =>
        new ManagerClaimObservationService({
          repository: options.store.transactionEngine,
          api: context.api,
          finalityDepth: runtimeConfig.finalityDepth,
        }),
      readFreshSetup: async (context) => {
        const observedAt = exactNow(clock).toISOString();
        const setup = await readOperatorAnchorSnapshot({
          config: context.config,
          node: context.node,
          api: context.api,
          managerPrincipal: options.managerPrincipal,
          managerVerification: options.managerVerification,
          reportMissingManager: true,
        });
        const sourceId = createChainSourceId(context.config.network, context.config.apiUrl);
        const rewardAnchor = await resolveRosterProjectionAnchor({
          store: options.store,
          api: context.api,
          sourceId,
          managerPrincipal: options.managerPrincipal,
          liveAnchor: setup.chainAnchor,
          indexedApiAvailable: indexedApiCompatible(setup.preflight),
        });
        return {
          setup: anchorSetupToRewardEvidence(setup, rewardAnchor),
          rewards: null,
          sourceId,
          observedAt,
        };
      },
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
        const sourceId = createChainSourceId(context.config.network, context.config.apiUrl);
        const rewardAnchor = await resolveRosterProjectionAnchor({
          store: options.store,
          api: context.api,
          sourceId,
          managerPrincipal: options.managerPrincipal,
          liveAnchor: setup.chainAnchor,
          indexedApiAvailable: indexedApiCompatible(setup.preflight),
        });
        const pox5ContractId = setup.preflight.pox.pox5ContractId;
        const rewardCalculation = deriveRewardCalculationTarget(
          rewardAnchor,
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
                sourceId,
                managerPrincipal: options.managerPrincipal,
                pox5ContractId,
                rewardCycle: rewardCalculation.rewardCycle,
                observedAt,
                burnBlockHeight: rewardAnchor.burnBlockHeight,
                stacksTipHeight: rewardAnchor.stacksBlockHeight,
                chainAnchor: rewardAnchor,
                firstRewardCycleId: setup.preflight.pox.firstRewardCycleId,
              })
            : null;
        return {
          setup: anchorSetupToRewardEvidence(setup, rewardAnchor),
          rewards,
          sourceId,
          observedAt,
        };
      },
      captureAnchor: async (context) => await captureChainAnchor(context.node, context.api),
      now: clock,
      onError: options.onError ?? (() => undefined),
    });
  } catch (error) {
    signerHolder.current?.destroy();
    signerHolder.current = null;
    throw error;
  }
}
