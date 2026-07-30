import { z } from "zod";
import { type ChainAnchor, deriveRewardCalculationTarget } from "./chain-anchor.js";
import type { StacksApiClient, StacksNodeClient } from "./chain-clients.js";
import { redactConfig, type SidekickConfig } from "./config.js";
import { createPoolEnrollmentDocument } from "./enrollment-info.js";
import { readManagerActivity } from "./manager-activity.js";
import { syncManagerEvents } from "./manager-event-sync.js";
import {
  type inspectDeployedManager,
  inspectManagerOrReportMissing,
  invalidateManagerVerificationCache,
  type ManagerVerificationContext,
} from "./manager-verification.js";
import { createPoolCardArtifact, type PoolCardMode } from "./pool-card.js";
import { readPoolForecast } from "./pool-forecast.js";
import type { runOperatorPreflight } from "./preflight.js";
import { readStxRewardStatus, type StxRewardStatus } from "./reward-status.js";
import type { RuntimeSettingsController } from "./runtime-settings.js";
import { readSetupSnapshot, type SetupSnapshot } from "./setup-snapshot.js";
import type { readPoolSetupStatus } from "./setup-status.js";
import {
  proveSignerStakerAnchorRemainsCanonical,
  SignerStakerAnchorError,
  syncSignerStakers,
} from "./signer-staker-sync.js";
import { createChainSourceId, createNodeSourceId, type SidekickStore } from "./storage/store.js";
import { OperatorWorkflowError } from "./workflow-error.js";

export interface OperatorAlert {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  action?:
    | { kind: "reconcile"; label: string }
    | {
        kind: "navigate";
        label: string;
        target: "setup" | "settings" | "pool" | "rewards" | "operations";
      }
    | {
        kind: "navigate";
        label: string;
        target: "manager";
        managerAction: "register-self";
      };
}

export interface OperatorServiceOptions {
  config: SidekickConfig;
  managerPrincipal: string;
  store: SidekickStore;
  node: StacksNodeClient;
  api: StacksApiClient;
  cacheTtlMs?: number;
  runtimeSettings?: RuntimeSettingsController;
  managerVerification?: ManagerVerificationContext;
  transactionEngineObservation?: TransactionEngineObservationHook;
}

export interface OperatorSynchronizationProgress {
  phase: "stakers-discovery" | "stakers-verification" | "events";
  completed: number;
  total: number | null;
  message?: string;
}

export interface OperatorSynchronizationOptions {
  signal?: AbortSignal;
  onProgress?(progress: OperatorSynchronizationProgress): void | Promise<void>;
}

export interface TransactionEngineObservationHook {
  observe(input: {
    setup: SetupSnapshot;
    rewards: StxRewardStatus | null;
    sourceId: string;
    observedAt: string;
  }): Promise<unknown>;
  onError?(error: unknown): void;
}

const pendingTransactionEngineObservations = new WeakMap<
  TransactionEngineObservationHook,
  Promise<void>
>();

export async function observeTransactionEngineSafely(
  hook: TransactionEngineObservationHook | undefined,
  input: Parameters<TransactionEngineObservationHook["observe"]>[0],
  timeoutMs = 2_000,
): Promise<void> {
  if (!hook) return;
  let observation = pendingTransactionEngineObservations.get(hook);
  if (observation) return;
  if (!observation) {
    observation = Promise.resolve()
      .then(() => hook.observe(input))
      .then(() => undefined)
      .catch((error) => {
        try {
          hook.onError?.(error);
        } catch {
          // The optional error reporter cannot make operator status unavailable.
        }
      })
      .finally(() => {
        pendingTransactionEngineObservations.delete(hook);
      });
    pendingTransactionEngineObservations.set(hook, observation);
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      observation,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function resolveRosterProjectionAnchor(options: {
  store: Pick<SidekickStore, "getLatestCompletedSignerStakerRun">;
  api: Pick<StacksApiClient, "getStatus" | "getBlock">;
  sourceId: string;
  managerPrincipal: string;
  liveAnchor: ChainAnchor;
}): Promise<ChainAnchor> {
  const run = options.store.getLatestCompletedSignerStakerRun(
    options.sourceId,
    options.managerPrincipal,
  );
  if (!run?.chainAnchor) return options.liveAnchor;
  try {
    await proveSignerStakerAnchorRemainsCanonical(options.api, run.chainAnchor);
    return run.chainAnchor;
  } catch (error) {
    if (!(error instanceof SignerStakerAnchorError)) throw error;
    return options.liveAnchor;
  }
}

function asSentence(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

type ManagerTrustTransition = NonNullable<ReturnType<SidekickStore["recordManagerTrustState"]>>;

function rosterJson(store: SidekickStore, managerPrincipal: string, sourceId: string) {
  return store.listSignerStakers(managerPrincipal, true, sourceId).map((staker) => ({
    ...staker,
    position: staker.position
      ? {
          ...staker.position,
          amountUstx: staker.position.amountUstx.toString(),
          firstRewardCycle: staker.position.firstRewardCycle.toString(),
          numCycles: staker.position.numCycles.toString(),
          unlockCycle: staker.position.unlockCycle.toString(),
          unlockBurnHeight: staker.position.unlockBurnHeight?.toString() ?? null,
        }
      : null,
  }));
}

export function buildAlerts(snapshot: {
  preflight: Awaited<ReturnType<typeof runOperatorPreflight>>;
  manager: Awaited<ReturnType<typeof inspectDeployedManager>>;
  setup: Awaited<ReturnType<typeof readPoolSetupStatus>> | null;
  forecast: Awaited<ReturnType<typeof readPoolForecast>> | null;
  rewards: Awaited<ReturnType<typeof readStxRewardStatus>> | null;
  activity: ReturnType<typeof readManagerActivity>;
  trustTransition?: {
    transition: "gained" | "lost" | "degraded";
    reason: string;
    changedAt: string;
  } | null;
}): OperatorAlert[] {
  const alerts: OperatorAlert[] = [];
  for (const check of snapshot.preflight.checks.filter(({ status }) => status !== "pass")) {
    alerts.push({
      id: `preflight:${check.id}`,
      severity: check.status === "fail" ? "critical" : "warning",
      title: check.status === "fail" ? "Connection Check Failed" : "Connection Needs Attention",
      detail: asSentence(check.message),
      action: { kind: "navigate", label: "Open Settings", target: "settings" },
    });
  }
  if (!snapshot.manager.attachAllowed) {
    const incompatibility =
      snapshot.manager.reasons[0] ??
      "The manager network or required interface is incompatible with this deployment.";
    alerts.push({
      id: "manager:unsupported",
      severity: "critical",
      title: "Manager Cannot Be Attached",
      detail: asSentence(incompatibility),
      action: { kind: "navigate", label: "Open Initial Setup", target: "setup" },
    });
  } else if (snapshot.manager.source.tier === "unrecognized") {
    alerts.push({
      id: "manager:not-recognized-read-only",
      severity: "warning",
      title: "Manager Source Not Recognized",
      detail: `Manager transactions can still be prepared for wallet or manual signing. Assist is unavailable: ${snapshot.manager.automationEligibilityReason}.`,
      action: { kind: "navigate", label: "Review manager profiles", target: "settings" },
    });
  } else if (snapshot.manager.source.tier === "custom-observe") {
    alerts.push({
      id: "manager:custom-read-only",
      severity: "info",
      title: "Custom Manager",
      detail:
        "Manager transactions can still be prepared for wallet or manual signing. Assist is unavailable.",
    });
  }
  const profileIssueCount = snapshot.manager.installedProfiles.issues.length;
  if (profileIssueCount > 0) {
    alerts.push({
      id: "manager:profile-load-issues",
      severity: "warning",
      title: "Installed Manager Profile Needs Attention",
      detail: `${profileIssueCount} manager profile${profileIssueCount === 1 ? "" : "s"} could not be loaded.`,
      action: { kind: "navigate", label: "Review profile issues", target: "settings" },
    });
  }
  if (snapshot.trustTransition) {
    const { transition } = snapshot.trustTransition;
    const gained = transition === "gained";
    const degraded = transition === "degraded";
    alerts.push({
      id: `manager:trust-transition-${transition}:${snapshot.trustTransition.changedAt}`,
      severity: gained ? "info" : degraded ? "warning" : "critical",
      title: gained
        ? "Manager Assist Eligibility Gained"
        : degraded
          ? "Manager Recognition Degraded"
          : "Manager Assist Eligibility Lost",
      detail: gained
        ? `${asSentence(snapshot.trustTransition.reason)} No action is required.`
        : asSentence(snapshot.trustTransition.reason),
      ...(gained
        ? {}
        : {
            action: {
              kind: "navigate" as const,
              label: "Review manager profiles",
              target: "settings" as const,
            },
          }),
    });
  }
  if (snapshot.setup?.status === "blocked") {
    const failedCheck = snapshot.setup.checks.find(({ status }) => status === "fail");
    const blockedReason = failedCheck?.message ?? "A required manager setup check failed";
    const signerRepair =
      failedCheck !== undefined && ["signer-registration", "signer-grant"].includes(failedCheck.id);
    alerts.push({
      id: "setup:blocked",
      severity: "critical",
      title: "Pool Setup Is Blocked",
      detail: asSentence(blockedReason),
      action: signerRepair
        ? {
            kind: "navigate",
            label: "Repair signer authorization",
            target: "manager",
            managerAction: "register-self",
          }
        : { kind: "navigate", label: "Open Initial Setup", target: "setup" },
    });
  }
  const affectedCycles =
    snapshot.forecast?.status === "attention"
      ? snapshot.forecast.cycles.slice(0, 2).filter(({ status }) => status === "attention")
      : [];
  if (affectedCycles.length > 0) {
    const affected = affectedCycles.map(({ cycleId }) => cycleId).join(", ");
    const belowThresholdCycles = affectedCycles.filter(
      ({ threshold }) => !threshold.meetsThreshold,
    );
    const belowThreshold = belowThresholdCycles.map(({ cycleId }) => cycleId).join(", ");
    const thresholdUstx = belowThresholdCycles[0]?.threshold.thresholdUstx;
    const thresholdStx = thresholdUstx
      ? `${(BigInt(thresholdUstx) / 1_000_000n).toLocaleString("en-US")} STX`
      : "the signer-set";
    alerts.push({
      id: "pool:forecast-attention",
      severity: "warning",
      title: belowThreshold ? "Pool Below Signer-Set Threshold" : "Pool Forecast Needs Attention",
      detail: belowThreshold
        ? `The pool is below the ${thresholdStx} signer-set threshold in ${belowThresholdCycles.length === 1 ? "reward cycle" : "reward cycles"} ${belowThreshold}.`
        : `Pool checks need attention for ${affectedCycles.length === 1 ? "reward cycle" : "reward cycles"} ${affected}.`,
      action: { kind: "navigate", label: "Review pool positions", target: "pool" },
    });
  }
  if (snapshot.rewards?.status === "attention") {
    alerts.push({
      id: "rewards:incomplete",
      severity: "warning",
      title: "Reward Roster Is Incomplete",
      detail: "The individual staker roster has not been synced.",
      action: { kind: "reconcile", label: "Sync now" },
    });
  }
  if (snapshot.activity.pendingWithdrawalTotal > 0) {
    alerts.push({
      id: "withdrawals:pending",
      severity: "info",
      title: "Bitcoin Withdrawals Await Resolution",
      detail: `${snapshot.activity.pendingWithdrawalTotal} Bitcoin withdrawal ${snapshot.activity.pendingWithdrawalTotal === 1 ? "request remains" : "requests remain"} pending.`,
      action: { kind: "navigate", label: "Review Bitcoin withdrawals", target: "rewards" },
    });
  }
  return alerts;
}

export function classifySupportContact(
  value: string,
): { email: string } | { url: string } | undefined {
  if (!value) return undefined;
  return z.email().safeParse(value).success ? { email: value } : { url: value };
}

export class OperatorService {
  private cached: {
    expiresAt: number;
    value: Awaited<ReturnType<OperatorService["load"]>>;
  } | null = null;
  private loading: Promise<Awaited<ReturnType<OperatorService["load"]>>> | null = null;
  private synchronization: Promise<
    Awaited<ReturnType<OperatorService["runSynchronization"]>>
  > | null = null;
  private pendingTrustTransition: ManagerTrustTransition | null = null;

  constructor(private readonly options: OperatorServiceOptions) {}

  async snapshot(force = false) {
    if (force && this.loading) {
      try {
        await this.loading;
      } catch {
        // A forced read must start after any older in-flight read, even if that read failed.
      }
    }
    const now = Date.now();
    if (!force && this.cached && this.cached.expiresAt > now) return this.cached.value;
    if (this.loading) return this.loading;
    this.loading = this.load()
      .then((value) => {
        this.cached = {
          expiresAt: Date.now() + (this.options.cacheTtlMs ?? 15_000),
          value,
        };
        return value;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  async synchronize(options: OperatorSynchronizationOptions = {}) {
    if (this.synchronization) return this.synchronization;
    this.synchronization = this.runSynchronization(options).finally(() => {
      this.synchronization = null;
    });
    return this.synchronization;
  }

  async observeManagerTrustState() {
    const { managerPrincipal } = this.options;
    const { config, node } = this.runtimeContext();
    const observedAt = new Date().toISOString();
    const manager = await inspectManagerOrReportMissing(
      node,
      config.network,
      managerPrincipal,
      this.options.managerVerification,
    );
    const transition = this.recordManagerTrustState(manager, observedAt);
    if (transition) this.pendingTrustTransition = transition;
    return { manager, transition };
  }

  async summary(force = false) {
    let snapshot: Awaited<ReturnType<OperatorService["load"]>>;
    let stale = false;
    try {
      snapshot = await this.snapshot(force);
    } catch (error) {
      if (!this.cached) throw error;
      snapshot = this.cached.value;
      stale = true;
    }
    const servedAt = new Date().toISOString();
    return {
      ...snapshot,
      freshness: {
        status: stale ? ("stale" as const) : ("current" as const),
        snapshotGeneratedAt: snapshot.generatedAt,
        servedAt,
        reason: stale ? ("refresh-failed" as const) : null,
      },
      rosterTotal: snapshot.roster.length,
      rosterStats: {
        deferredUnlocks: snapshot.roster.filter(({ position }) => position?.unlockBurnHeight)
          .length,
      },
      roster: [],
      rewards: snapshot.rewards ? { ...snapshot.rewards, stakers: [] } : null,
      activity: { ...snapshot.activity, withdrawals: [] },
    };
  }

  async poolPage(options: { offset?: number; limit?: number; query?: string } = {}) {
    const snapshot = await this.snapshot();
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;
    const query = options.query?.trim().toLowerCase() ?? "";
    const roster = query
      ? snapshot.roster.filter(({ stakerPrincipal }) =>
          stakerPrincipal.toLowerCase().includes(query),
        )
      : snapshot.roster;
    return {
      generatedAt: snapshot.generatedAt,
      forecast: snapshot.forecast,
      roster: roster.slice(offset, offset + limit),
      total: roster.length,
      offset,
      limit,
    };
  }

  async poolHistory(options: { offset?: number; limit?: number } = {}) {
    return this.options.store.listLatestPoolCycleSnapshots(this.options.managerPrincipal, options);
  }

  async rewardsPage(options: { offset?: number; limit?: number } = {}) {
    const snapshot = await this.snapshot();
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;
    const stakers = snapshot.rewards?.stakers ?? [];
    return {
      generatedAt: snapshot.generatedAt,
      rewards: snapshot.rewards
        ? { ...snapshot.rewards, stakers: stakers.slice(offset, offset + limit) }
        : null,
      total: stakers.length,
      offset,
      limit,
    };
  }

  async rewardsHistory(options: { offset?: number; limit?: number } = {}) {
    return this.options.store.listRewardCycleSummaries(this.options.managerPrincipal, options);
  }

  async activity(options: Parameters<typeof readManagerActivity>[3] = {}) {
    const config = this.runtimeContext().config;
    const chainId =
      config.expectedNetworkId ??
      (config.network === "mainnet" ? 1 : config.network === "testnet" ? 0x80000005 : 0x80000000);
    return readManagerActivity(this.options.store, chainId, this.options.managerPrincipal, options);
  }

  settings() {
    if (!this.options.runtimeSettings) throw new Error("Runtime settings are unavailable");
    return this.options.runtimeSettings.publicSettings();
  }

  async updateSettings(input: unknown) {
    if (!this.options.runtimeSettings) throw new Error("Runtime settings are unavailable");
    const result = await this.options.runtimeSettings.update(input);
    if (this.options.managerVerification) {
      invalidateManagerVerificationCache(this.options.managerVerification);
    }
    this.cached = null;
    return result;
  }

  async poolCard(
    mode: PoolCardMode,
    staking: { includeStakingForm: boolean; l1MaxFeeSats: number | null } = {
      includeStakingForm: false,
      l1MaxFeeSats: null,
    },
  ) {
    if (!this.options.runtimeSettings) throw new Error("Runtime settings are unavailable");
    const snapshot = await this.snapshot(true);
    if (!snapshot.setup) {
      throw new OperatorWorkflowError(
        409,
        "pool_setup_not_complete",
        "Pool information is unavailable until setup completes. Finish Initial Setup, then retry",
      );
    }
    const settings = this.options.runtimeSettings.publicSettings();
    const support = classifySupportContact(settings.pool.supportContact);
    const enrollment = createPoolEnrollmentDocument(
      {
        schemaVersion: 1,
        displayName: settings.pool.displayName,
        ...(settings.pool.websiteUrl ? { websiteUrl: settings.pool.websiteUrl } : {}),
        ...(support ? { support } : {}),
        currentFeeBips: Number(snapshot.rewards?.manager.configuredFeeBips ?? 0),
        rewardDestinations: { directSbtc: true, bitcoinL1: true },
        durationPolicy: { minimumCycles: 1, maximumCycles: 96 },
        officialPlatforms: [
          { id: "leather", label: "Leather Stacking", url: settings.pool.leatherUrl },
        ],
      },
      snapshot.preflight,
      snapshot.manager,
      snapshot.registration,
      snapshot.setup,
      {
        enabled: staking.includeStakingForm,
        l1MaxFeeSats: staking.l1MaxFeeSats === null ? null : BigInt(staking.l1MaxFeeSats),
      },
    );
    return createPoolCardArtifact(enrollment, mode, settings.embed.publicApiUrl);
  }

  private async runSynchronization(options: OperatorSynchronizationOptions) {
    const { managerPrincipal, store } = this.options;
    const { config, node, api } = this.runtimeContext();
    const sourceId = createChainSourceId(config.network, config.apiUrl);
    const nodeSourceId = createNodeSourceId(config.network, config.nodeRpcUrl);
    let synchronized: {
      observedAt: string;
      chainId: number;
      stakers: Awaited<ReturnType<typeof syncSignerStakers>>;
    } | null = null;
    const maxAnchorAttempts = 3;
    for (let attempt = 1; attempt <= maxAnchorAttempts; attempt += 1) {
      options.signal?.throwIfAborted();
      const observedAt = new Date().toISOString();
      const { chainAnchor, preflight, manager } = await readSetupSnapshot({
        config,
        node,
        api,
        managerPrincipal,
        managerVerification: this.options.managerVerification,
      });
      const trustTransition = this.recordManagerTrustState(manager, observedAt);
      if (trustTransition) this.pendingTrustTransition = trustTransition;
      if (preflight.status === "fail" || !preflight.pox.pox5ContractId || !manager.attachAllowed) {
        throw new OperatorWorkflowError(
          422,
          "synchronization_sources_incompatible",
          "Sync is blocked by node, API, PoX-5, or manager compatibility checks. Review preflight and manager verification, then retry",
        );
      }
      store.upsertChainSource({
        sourceId,
        kind: "api",
        network: config.network,
        baseUrl: config.apiUrl,
        observedAt,
      });
      store.upsertChainSource({
        sourceId: nodeSourceId,
        kind: "node",
        network: config.network,
        baseUrl: config.nodeRpcUrl,
        observedAt,
      });
      try {
        const stakers = await syncSignerStakers({
          store,
          api,
          node,
          sourceId,
          nodeSourceId,
          managerPrincipal,
          pox5ContractId: preflight.pox.pox5ContractId,
          observedAt,
          burnBlockHeight: chainAnchor.burnBlockHeight,
          stacksTipHeight: chainAnchor.stacksBlockHeight,
          currentRewardCycle: chainAnchor.rewardCycle,
          chainAnchor,
          pageLimit: config.stakerPageLimit,
          ...(options.signal ? { signal: options.signal } : {}),
          onProgress: async (progress) => {
            options.signal?.throwIfAborted();
            await options.onProgress?.({
              phase:
                progress.phase === "discovering" ? "stakers-discovery" : "stakers-verification",
              completed: progress.completed,
              total: progress.total,
            });
          },
        });
        synchronized = { observedAt, chainId: preflight.node.networkId, stakers };
        break;
      } catch (error) {
        if (!(error instanceof SignerStakerAnchorError) || attempt === maxAnchorAttempts) {
          throw error;
        }
      }
    }
    if (!synchronized) throw new Error("Unable to synchronize at a stable chain anchor");
    options.signal?.throwIfAborted();
    await options.onProgress?.({
      phase: "events",
      completed: 0,
      total: null,
      message: "Syncing manager events",
    });
    const events = await syncManagerEvents({
      store,
      api,
      sourceId,
      chainId: synchronized.chainId,
      managerPrincipal,
      observedAt: synchronized.observedAt,
      pageLimit: config.eventPageLimit,
      ...(options.signal ? { signal: options.signal } : {}),
      onProgress: async (progress) => {
        options.signal?.throwIfAborted();
        await options.onProgress?.({
          phase: "events",
          completed: progress.completed,
          total: progress.total,
          message: `Synced ${progress.eventsProcessed} manager events`,
        });
      },
    });
    options.signal?.throwIfAborted();
    if (events.reorgedEvents > 0 && this.options.managerVerification) {
      invalidateManagerVerificationCache(this.options.managerVerification, managerPrincipal);
    }
    this.cached = null;
    return { observedAt: synchronized.observedAt, stakers: synchronized.stakers, events };
  }

  private async load() {
    const { managerPrincipal, store } = this.options;
    const { config, node, api } = this.runtimeContext();
    const generatedAt = new Date().toISOString();
    const sourceId = createChainSourceId(config.network, config.apiUrl);
    const setupSnapshot = await readSetupSnapshot({
      config,
      node,
      api,
      managerPrincipal,
      managerVerification: this.options.managerVerification,
      reportMissingManager: true,
    });
    const { chainAnchor, preflight, manager, registration, setup } = setupSnapshot;
    const pox5ContractId = preflight.pox.pox5ContractId;
    const recordedTrustTransition = this.recordManagerTrustState(manager, generatedAt);
    const trustAudit = store.listManagerTrustAudit(managerPrincipal);
    const latestTrustTransition = trustAudit[0] ?? null;
    const pendingTrustTransition = this.pendingTrustTransition;
    this.pendingTrustTransition = null;
    const trustTransition =
      recordedTrustTransition ??
      pendingTrustTransition ??
      (latestTrustTransition &&
      latestTrustTransition.transition !== "gained" &&
      latestTrustTransition.currentTier === manager.source.tier
        ? latestTrustTransition
        : null);
    const projectionAnchor = await resolveRosterProjectionAnchor({
      store,
      api,
      sourceId,
      managerPrincipal,
      liveAnchor: chainAnchor,
    });
    const rewardCalculation = deriveRewardCalculationTarget(projectionAnchor);
    const [forecast, rewards] =
      manager.attachAllowed && pox5ContractId
        ? await Promise.all([
            readPoolForecast({
              store,
              node,
              sourceId,
              managerPrincipal,
              pox5ContractId,
              currentRewardCycle: projectionAnchor.rewardCycle,
              horizonCycles: config.forecastHorizonCycles,
              observedAt: generatedAt,
              burnBlockHeight: projectionAnchor.burnBlockHeight,
              stacksTipHeight: projectionAnchor.stacksBlockHeight,
              chainAnchor: projectionAnchor,
            }),
            rewardCalculation.status === "ready"
              ? readStxRewardStatus({
                  store,
                  node,
                  sourceId,
                  managerPrincipal,
                  pox5ContractId,
                  rewardCycle: rewardCalculation.rewardCycle,
                  observedAt: generatedAt,
                  burnBlockHeight: projectionAnchor.burnBlockHeight,
                  stacksTipHeight: projectionAnchor.stacksBlockHeight,
                  chainAnchor: projectionAnchor,
                })
              : null,
          ])
        : [null, null];
    await observeTransactionEngineSafely(this.options.transactionEngineObservation, {
      setup: setupSnapshot,
      rewards,
      sourceId,
      observedAt: generatedAt,
    });
    const activity = readManagerActivity(store, preflight.node.networkId, managerPrincipal, {
      claimLimit: 4,
      withdrawalLimit: 50,
    });
    const roster = rosterJson(store, managerPrincipal, sourceId);
    const partial = {
      preflight,
      manager,
      registration,
      setup,
      forecast,
      rewards,
      activity,
      roster,
      trustTransition,
    };
    return {
      schemaVersion: 1,
      generatedAt,
      network: config.network,
      config: redactConfig(config),
      ...(this.options.runtimeSettings
        ? { runtimeSettings: this.options.runtimeSettings.publicSettings() }
        : {}),
      managerPrincipal,
      ...partial,
      trustAudit,
      alerts: buildAlerts(partial),
    };
  }

  private runtimeContext(): {
    config: SidekickConfig;
    node: StacksNodeClient;
    api: StacksApiClient;
  } {
    return (
      this.options.runtimeSettings?.clients() ?? {
        config: this.options.config,
        node: this.options.node,
        api: this.options.api,
      }
    );
  }

  private recordManagerTrustState(
    manager: Awaited<ReturnType<typeof inspectDeployedManager>>,
    observedAt: string,
  ): ManagerTrustTransition | null {
    return this.options.store.recordManagerTrustState({
      managerPrincipal: this.options.managerPrincipal,
      recognitionTier: manager.source.tier,
      profileId: manager.source.profileId,
      profileOrigin: manager.source.origin,
      sourceSha256: manager.source.sha256 || null,
      canonicalSourceSha256: manager.source.canonicalSha256 || null,
      automationEligible: manager.automationEligible,
      eligibilityReason: manager.automationEligibilityReason,
      observedAt,
    });
  }
}
