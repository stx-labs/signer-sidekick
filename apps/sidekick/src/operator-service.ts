import type { DashboardSnapshot } from "@stx-labs/signer-sidekick-api-contracts";
import { type ChainAnchor, deriveRewardCalculationTarget } from "./chain-anchor.js";
import {
  captureChainAnchor,
  RateLimitedError,
  type RateLimitInfo,
  rateLimitInfo,
  type StacksApiClient,
  type StacksNodeClient,
} from "./chain-clients.js";
import { redactConfig, type SidekickConfig } from "./config.js";
import { syncCurrentMemberHistoryPass } from "./current-member-history-sync.js";
import type { HealthOperatorContext } from "./health-monitoring-types.js";
import { advanceLocalNodeAuthority } from "./local-node-authority.js";
import { readManagerActivity } from "./manager-activity.js";
import { managerActionCapability } from "./manager-capabilities.js";
import { type ManagerEventNodeTransactions, syncManagerEvents } from "./manager-event-sync.js";
import {
  type ManagerEventVocabulary,
  managerEventStream,
  managerEventVocabularyFor,
} from "./manager-event-vocabulary.js";
import {
  type inspectDeployedManager,
  inspectManagerOrReportMissing,
  invalidateManagerVerificationCache,
  type ManagerVerificationContext,
} from "./manager-verification.js";
import {
  type OperatorAnchorSnapshot,
  readOperatorAnchorSnapshot,
} from "./operator-anchor-snapshot.js";
import type { readOperatorReadiness } from "./operator-readiness.js";
import { readPoolForecast } from "./pool-forecast.js";
import { syncPox5PoolActivity } from "./pox5-pool-activity-sync.js";
import {
  indexedApiCompatible,
  indexedWorkflowsReady,
  type runOperatorPreflight,
} from "./preflight.js";
import { rewardRealizationStream, syncRewardRealizations } from "./reward-realization-sync.js";
import {
  discoverStakerClaims,
  readRewardOutlook,
  readStxRewardStatus,
  type StxRewardStatus,
} from "./reward-status.js";
import type { RuntimeSettingsController } from "./runtime-settings.js";
import {
  proveSignerStakerAnchorRemainsCanonical,
  SignerStakerAnchorError,
  syncSignerStakers,
} from "./signer-staker-sync.js";
import type { ManagerTrustTransition } from "./storage/manager-trust-repository.js";
import { createChainSourceId, createNodeSourceId, type SidekickStore } from "./storage/store.js";
import { OperatorWorkflowError } from "./workflow-error.js";

export interface OperatorAlert {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
}

export interface OperatorServiceOptions {
  config: SidekickConfig;
  managerPrincipal: string;
  store: SidekickStore;
  node: StacksNodeClient;
  api: StacksApiClient;
  cacheTtlMs?: number;
  now?(): number;
  runtimeSettings?: RuntimeSettingsController;
  managerVerification?: ManagerVerificationContext;
  transactionEngineObservation?: TransactionEngineObservationHook;
  nodeTransactions?: ManagerEventNodeTransactions;
}

export interface OperatorSynchronizationProgress {
  phase: "stakers-discovery" | "stakers-verification" | "events";
  completed: number;
  total: number | null;
  message?: string;
}

export interface OperatorSynchronizationOptions {
  signal?: AbortSignal;
  /** Do not consume an event trigger until the indexed source has reached its verified block. */
  minimumStacksHeight?: number | null;
  onProgress?(progress: OperatorSynchronizationProgress): void | Promise<void>;
}

export type ManagerActivitySynchronizationOptions = OperatorSynchronizationOptions;
export type RewardRealizationSynchronizationOptions = OperatorSynchronizationOptions;

export type SortDirection = "asc" | "desc";
export type PoolRosterSort =
  | "staker"
  | "amount"
  | "first-cycle"
  | "last-cycle"
  | "unlock-height"
  | "bond"
  | "status";
export type RewardStakerSort = "staker" | "gross" | "fee" | "net" | "destination" | "status";

function compareSortValues(
  left: bigint | number | string | null,
  right: bigint | number | string | null,
  direction: SortDirection,
): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  const compared = left < right ? -1 : left > right ? 1 : 0;
  return direction === "asc" ? compared : -compared;
}

function orderBy<T>(
  values: T[],
  direction: SortDirection,
  value: (item: T) => bigint | number | string | null,
  tieBreak: (item: T) => string,
): T[] {
  return [...values].sort(
    (left, right) =>
      compareSortValues(value(left), value(right), direction) ||
      tieBreak(left).localeCompare(tieBreak(right)),
  );
}

export function sortPoolRoster(
  roster: DashboardSnapshot["roster"],
  sort: PoolRosterSort = "staker",
  direction: SortDirection = "asc",
): DashboardSnapshot["roster"] {
  return orderBy(
    roster,
    direction,
    (entry) => {
      const position = entry.position;
      switch (sort) {
        case "amount":
          return position ? BigInt(position.amountUstx) : null;
        case "first-cycle":
          return position ? BigInt(position.firstRewardCycle) : null;
        case "last-cycle":
          return position ? BigInt(position.unlockCycle) - 1n : null;
        case "unlock-height":
          return position?.unlockBurnHeight === null || !position
            ? null
            : BigInt(position.unlockBurnHeight);
        case "bond":
          return entry.bond
            ? `${entry.bond.isL1Lock ? "1" : "0"}:${entry.bond.bondIndex.padStart(20, "0")}`
            : null;
        case "status":
          return entry.stxNodeVerified === false
            ? "not-node-verified"
            : entry.bond
              ? "bond-verified"
              : "verified";
        case "staker":
          return entry.stakerPrincipal;
      }
    },
    (entry) => entry.stakerPrincipal,
  );
}

export function sortRewardStakers(
  stakers: NonNullable<DashboardSnapshot["rewards"]>["stakers"],
  sort: RewardStakerSort = "staker",
  direction: SortDirection = "asc",
): NonNullable<DashboardSnapshot["rewards"]>["stakers"] {
  return orderBy(
    stakers,
    direction,
    (entry) => {
      switch (sort) {
        case "gross":
          return BigInt(entry.rewards.grossSats);
        case "fee":
          return BigInt(entry.rewards.feeSats);
        case "net":
          return BigInt(entry.rewards.earnedSats);
        case "destination":
          return entry.payout.kind;
        case "status":
          return entry.claimableByPolicy ? "claimable" : "no-action";
        case "staker":
          return entry.stakerPrincipal;
      }
    },
    (entry) => entry.stakerPrincipal,
  );
}

export interface TransactionEngineObservationHook {
  observe(input: {
    setup: OperatorAnchorSnapshot;
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
  indexedApiAvailable?: boolean;
}): Promise<ChainAnchor> {
  const run = options.store.getLatestCompletedSignerStakerRun(
    options.sourceId,
    options.managerPrincipal,
  );
  if (!run?.chainAnchor || options.indexedApiAvailable === false) return options.liveAnchor;
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

function rosterJson(store: SidekickStore, managerPrincipal: string, sourceId: string) {
  return store.listSignerStakers(managerPrincipal, true, sourceId).map((staker) => ({
    ...staker,
    bond: staker.bond
      ? {
          bondIndex: staker.bond.bondIndex.toString(),
          amountUstx: staker.bond.amountUstx.toString(),
          amountSats: staker.bond.amountSats.toString(),
          isL1Lock: staker.bond.isL1Lock,
        }
      : null,
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
  readiness: Awaited<ReturnType<typeof readOperatorReadiness>> | null;
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
    });
  }
  if (!snapshot.manager.attachAllowed) {
    const incompatibility =
      snapshot.manager.reasons[0] ??
      "The manager network or required interface is incompatible with this deployment.";
    alerts.push({
      id: "manager:unsupported",
      severity: "critical",
      title: "Manager Trait Check Failed",
      detail: asSentence(incompatibility),
    });
  } else if (snapshot.manager.source.tier === "unrecognized") {
    alerts.push({
      id: "manager:custom-capabilities",
      severity: "info",
      title: "Custom Manager Attached",
      detail:
        "PoX-5 baseline state remains available. Each manager action is enabled only when its deployed byte-exact source matches a reviewed capability fingerprint.",
    });
  } else if (snapshot.manager.source.tier === "custom-observe") {
    alerts.push({
      id: "manager:custom-capabilities",
      severity: "info",
      title: "Custom Manager Attached",
      detail:
        "PoX-5 baseline state remains available. Executable manager actions require a reviewed capability fingerprint.",
    });
  }
  const profileIssueCount = snapshot.manager.installedProfiles.issues.length;
  if (profileIssueCount > 0) {
    alerts.push({
      id: "manager:profile-load-issues",
      severity: "warning",
      title: "Installed Manager Profile Needs Attention",
      detail: `${profileIssueCount} manager profile${profileIssueCount === 1 ? "" : "s"} could not be loaded.`,
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
    });
  }
  if (snapshot.readiness?.status === "blocked") {
    const failedCheck = snapshot.readiness.checks.find(({ status }) => status === "fail");
    const blockedReason = failedCheck?.message ?? "A required operator readiness check failed";
    alerts.push({
      id: "readiness:blocked",
      severity: "critical",
      title: "Operator Readiness Is Blocked",
      detail: asSentence(blockedReason),
    });
  }
  // A delegation only affects the next signer set while its enrollment window is open. Once the
  // prepare phase (or its final pre-execution block) begins, that cycle is fixed; presenting its
  // threshold as a required action would send an operator after an outcome they cannot change.
  const enrollmentClosed =
    snapshot.preflight.cycle.isPreparePhase === true ||
    (snapshot.preflight.cycle.blocksUntilPreparePhase !== null &&
      snapshot.preflight.cycle.blocksUntilPreparePhase <= 1);
  const actionableCycleId =
    snapshot.preflight.cycle.nextId === null
      ? null
      : snapshot.preflight.cycle.nextId + (enrollmentClosed ? 1 : 0);
  const affectedCycles =
    snapshot.forecast?.status === "attention" && actionableCycleId !== null
      ? snapshot.forecast.cycles.filter(
          ({ cycleId, status }) => cycleId === actionableCycleId && status === "attention",
        )
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
    });
  }
  if (snapshot.rewards?.status === "attention") {
    alerts.push({
      id: "rewards:incomplete",
      severity: "warning",
      title: "Reward Roster Is Incomplete",
      detail: "The individual staker roster has not been synced.",
    });
  }
  if (snapshot.activity.pendingWithdrawalTotal > 0) {
    alerts.push({
      id: "withdrawals:pending",
      severity: "info",
      title: "Bitcoin Withdrawals Await Resolution",
      detail: `${snapshot.activity.pendingWithdrawalTotal} Bitcoin withdrawal ${snapshot.activity.pendingWithdrawalTotal === 1 ? "request remains" : "requests remain"} pending.`,
    });
  }
  return alerts;
}

export class OperatorService {
  private cached: {
    expiresAt: number;
    value: Awaited<ReturnType<OperatorService["load"]>>;
  } | null = null;
  private lastKnownHealthContext: HealthOperatorContext | null = null;
  private loading: Promise<Awaited<ReturnType<OperatorService["load"]>>> | null = null;
  private synchronization: Promise<
    Awaited<ReturnType<OperatorService["runSynchronization"]>>
  > | null = null;
  private managerActivitySynchronization: Promise<
    Awaited<ReturnType<OperatorService["runManagerActivitySynchronization"]>>
  > | null = null;
  private rewardRealizationSynchronization: Promise<
    Awaited<ReturnType<OperatorService["runRewardRealizationSynchronization"]>>
  > | null = null;
  private pendingTrustTransition: ManagerTrustTransition | null = null;
  private refreshBlockedUntil = 0;
  private lastRefreshFailure: "refresh-failed" | "rate-limited" | null = null;
  private lastRateLimit: RateLimitInfo | null = null;
  private lastRateLimitEndpoint: string | undefined;

  constructor(private readonly options: OperatorServiceOptions) {}

  async snapshot(force = false) {
    return (await this.snapshotWithFreshness(force)).value;
  }

  /** Last successful local chain context for deterministic Activity deadline ordering. */
  activityProjectionContext(): {
    burnBlockHeight: number;
    rewardCycleId: number;
    phase: "reward" | "prepare" | null;
  } | null {
    const snapshot = this.cached?.value;
    if (!snapshot) return null;
    return {
      burnBlockHeight: snapshot.preflight.node.burnBlockHeight,
      rewardCycleId: snapshot.preflight.cycle.currentId,
      phase:
        snapshot.chainAnchor?.phase ??
        (snapshot.preflight.cycle.isPreparePhase === true
          ? "prepare"
          : snapshot.preflight.cycle.isPreparePhase === false
            ? "reward"
            : null),
    };
  }

  /** Cached chain-authoritative identity and participation facts for Signer Health correlation. */
  healthMonitoringContext(): HealthOperatorContext | null {
    return this.lastKnownHealthContext;
  }

  private healthContextFromSnapshot(
    snapshot: Awaited<ReturnType<OperatorService["load"]>>,
  ): HealthOperatorContext | null {
    if (!snapshot.preflight?.cycle || !snapshot.generatedAt || !snapshot.network) return null;
    const currentCycle = snapshot.preflight.cycle.currentId;
    const nextCycle = snapshot.preflight.cycle.nextId;
    const current = snapshot.forecast?.cycles.find(({ cycleId }) => cycleId === currentCycle);
    const next = snapshot.forecast?.cycles.find(({ cycleId }) => cycleId === nextCycle);
    return {
      observedAt: snapshot.generatedAt,
      network: snapshot.network,
      managerPrincipal: snapshot.managerPrincipal,
      currentRewardCycle: currentCycle,
      registered: snapshot.registration?.registered ?? null,
      signerKeyHex: snapshot.registration?.signerKeyHex ?? null,
      signerKeyGrantValid: snapshot.registration?.signerKeyGrantValid ?? null,
      expectedCurrentParticipation: current?.contract.inSignerSet === true,
      expectedNextParticipation: next?.contract.inSignerSet === true,
    };
  }

  /** Refresh the retained operator snapshot without requiring a browser request. */
  async refreshSnapshot() {
    return await this.refresh();
  }

  private currentTime(): number {
    return this.options.now?.() ?? Date.now();
  }

  private refresh(): Promise<Awaited<ReturnType<OperatorService["load"]>>> {
    if (this.loading) return this.loading;
    const now = this.currentTime();
    if (this.refreshBlockedUntil > now) {
      return Promise.reject(
        new RateLimitedError(
          "A configured chain source is still rate limiting Sidekick",
          this.refreshBlockedUntil - now,
          this.lastRateLimitEndpoint,
        ),
      );
    }
    this.loading = this.load()
      .then((value) => {
        const loadedAt = this.currentTime();
        this.lastKnownHealthContext =
          this.healthContextFromSnapshot(value) ?? this.lastKnownHealthContext;
        this.cached = {
          // The dashboard polls every 15 seconds. Keep a successful observation fresh through the
          // next poll so normal status traffic does not create an upstream refresh per page view.
          expiresAt: loadedAt + (this.options.cacheTtlMs ?? 45_000),
          value,
        };
        this.refreshBlockedUntil = 0;
        this.lastRefreshFailure = null;
        this.lastRateLimit = null;
        this.lastRateLimitEndpoint = undefined;
        return value;
      })
      .catch((error: unknown) => {
        this.lastRefreshFailure =
          error instanceof RateLimitedError ? "rate-limited" : "refresh-failed";
        if (error instanceof RateLimitedError) {
          const { config } = this.runtimeContext();
          this.lastRateLimit = rateLimitInfo(error, {
            apiUrl: config.apiUrl,
            apiKeyConfigured: Boolean(config.apiKey),
          });
          this.lastRateLimitEndpoint = error.endpoint;
          // Hiro's unauthenticated quota is per minute. If it omits Retry-After, avoid repeatedly
          // probing it for the next minute while preserving the last known operator state.
          const cooldownMs = Math.min(60_000, Math.max(1_000, error.retryAfterMs ?? 60_000));
          this.refreshBlockedUntil = this.currentTime() + cooldownMs;
        }
        throw error;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  private refreshInBackground(): void {
    void this.refresh().catch(() => {
      // The stale snapshot remains the normal status response. A later refresh may recover.
    });
  }

  private staleSnapshot(): {
    value: Awaited<ReturnType<OperatorService["load"]>>;
    stale: true;
    reason: "refreshing" | "refresh-failed" | "rate-limited";
    rateLimit: RateLimitInfo | null;
  } | null {
    if (!this.cached) return null;
    return {
      value: this.cached.value,
      stale: true,
      reason: this.lastRefreshFailure ?? "refreshing",
      rateLimit: this.lastRefreshFailure === "rate-limited" ? this.lastRateLimit : null,
    };
  }

  private async snapshotWithFreshness(force = false): Promise<{
    value: Awaited<ReturnType<OperatorService["load"]>>;
    stale: boolean;
    reason: "refreshing" | "refresh-failed" | "rate-limited" | null;
    rateLimit: RateLimitInfo | null;
  }> {
    if (force && this.loading) {
      try {
        await this.loading;
      } catch {
        // A forced read must start after any older in-flight read, even if that read failed.
      }
    }
    if (force) {
      try {
        return { value: await this.refresh(), stale: false, reason: null, rateLimit: null };
      } catch (error) {
        const stale = this.staleSnapshot();
        if (stale) return stale;
        throw error;
      }
    }
    const now = this.currentTime();
    if (this.cached) {
      if (this.cached.expiresAt > now) {
        return { value: this.cached.value, stale: false, reason: null, rateLimit: null };
      }
      this.refreshInBackground();
      const stale = this.staleSnapshot();
      if (stale) return stale;
    }
    return { value: await this.refresh(), stale: false, reason: null, rateLimit: null };
  }

  async synchronize(options: OperatorSynchronizationOptions = {}) {
    if (this.synchronization) return this.synchronization;
    this.synchronization = (async () => {
      if (this.managerActivitySynchronization) {
        await this.managerActivitySynchronization;
      }
      return await this.runSynchronization(options);
    })().finally(() => {
      this.synchronization = null;
    });
    return this.synchronization;
  }

  /**
   * Reconcile manager activity without paying for a complete signer-staker roster scan. The
   * callback scheduler uses this independently from current-state refreshes so an indexed API
   * delay cannot hold up node-first operator health.
   */
  async synchronizeManagerActivity(options: ManagerActivitySynchronizationOptions = {}) {
    if (this.synchronization) {
      const synchronized = await this.synchronization;
      return { observedAt: synchronized.observedAt, events: synchronized.events };
    }
    if (this.managerActivitySynchronization) return this.managerActivitySynchronization;
    this.managerActivitySynchronization = this.runManagerActivitySynchronization(options).finally(
      () => {
        this.managerActivitySynchronization = null;
      },
    );
    return this.managerActivitySynchronization;
  }

  async synchronizeRewardRealizations(options: RewardRealizationSynchronizationOptions = {}) {
    if (this.rewardRealizationSynchronization) return this.rewardRealizationSynchronization;
    this.rewardRealizationSynchronization = this.runRewardRealizationSynchronization(
      options,
    ).finally(() => {
      this.rewardRealizationSynchronization = null;
    });
    return this.rewardRealizationSynchronization;
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
    const snapshot = await this.supportSnapshot(force);
    return {
      ...snapshot,
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

  /** Full public operator state for a support artifact, including freshness provenance. */
  async supportSnapshot(force = true) {
    const { value: snapshot, stale, reason, rateLimit } = await this.snapshotWithFreshness(force);
    const servedAt = new Date().toISOString();
    const rewardRealizations = snapshot.rewardOutlook
      ? this.options.store.listRewardCalculationRealizations(
          this.options.managerPrincipal,
          snapshot.rewardOutlook.pox5ContractId,
          { limit: 50, canonicalOnly: false },
        )
      : [];
    return {
      ...snapshot,
      rewardFeedback: {
        calibration: snapshot.rewardOutlook?.calibration ?? null,
        realizations: rewardRealizations,
      },
      freshness: {
        status: stale ? ("stale" as const) : ("current" as const),
        snapshotGeneratedAt: snapshot.generatedAt,
        servedAt,
        reason,
        ...(rateLimit ? { rateLimit } : {}),
      },
    };
  }

  async poolPage(
    options: {
      offset?: number;
      limit?: number;
      query?: string;
      sort?: PoolRosterSort;
      direction?: SortDirection;
    } = {},
  ) {
    const { value: snapshot, stale, reason, rateLimit } = await this.snapshotWithFreshness();
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;
    const query = options.query?.trim().toLowerCase() ?? "";
    const matchingRoster = query
      ? snapshot.roster.filter(({ stakerPrincipal }) =>
          stakerPrincipal.toLowerCase().includes(query),
        )
      : snapshot.roster;
    const roster = sortPoolRoster(matchingRoster, options.sort, options.direction);
    return {
      generatedAt: snapshot.generatedAt,
      freshness: {
        status: stale ? ("stale" as const) : ("current" as const),
        snapshotGeneratedAt: snapshot.generatedAt,
        servedAt: new Date().toISOString(),
        reason,
        ...(rateLimit ? { rateLimit } : {}),
      },
      forecast: snapshot.forecast,
      roster: roster.slice(offset, offset + limit),
      total: roster.length,
      offset,
      limit,
    };
  }

  async rewardsPage(
    options: {
      offset?: number;
      limit?: number;
      sort?: RewardStakerSort;
      direction?: SortDirection;
    } = {},
  ) {
    const { value: snapshot, stale, reason, rateLimit } = await this.snapshotWithFreshness();
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;
    const stakers = snapshot.rewards
      ? sortRewardStakers(snapshot.rewards.stakers, options.sort, options.direction)
      : [];
    return {
      generatedAt: snapshot.generatedAt,
      freshness: {
        status: stale ? ("stale" as const) : ("current" as const),
        snapshotGeneratedAt: snapshot.generatedAt,
        servedAt: new Date().toISOString(),
        reason,
        ...(rateLimit ? { rateLimit } : {}),
      },
      rewards: snapshot.rewards
        ? { ...snapshot.rewards, stakers: stakers.slice(offset, offset + limit) }
        : null,
      rewardOutlook: snapshot.rewardOutlook ?? null,
      rewardRealizations: snapshot.rewardOutlook
        ? this.options.store
            .listRewardCalculationRealizations(
              this.options.managerPrincipal,
              snapshot.rewardOutlook.pox5ContractId,
              { limit: 12, canonicalOnly: true },
            )
            .map((realization) => ({
              txId: realization.txId,
              eventIndex: realization.eventIndex,
              blockHeight: realization.blockHeight,
              indexBlockHash: realization.indexBlockHash,
              burnBlockHeight: realization.burnBlockHeight,
              targetRewardCycle: realization.targetRewardCycle,
              targetCheckpoint: realization.targetCheckpoint,
              calculationBurnHeight: realization.calculationBurnHeight,
              observedAt: realization.observedAt,
              global: {
                grossAccruedRewardsSats: realization.event.grossAccruedRewardsSats,
                totalBondRewardsSats: realization.event.totalBondRewardsSats,
                totalStxStakerRewardsSats: realization.event.totalStxStakerRewardsSats,
                reserveDepositSats: realization.event.reserveDepositSats,
              },
              poolSats: realization.poolEstimate?.grossSats ?? null,
              poolEstimateUnavailableReason: realization.poolEstimateUnavailableReason,
              evaluation: realization.evaluation
                ? {
                    modelRevision: realization.evaluation.modelRevision,
                    forecastObservedBurnHeight: realization.evaluation.forecastObservedBurnHeight,
                    leadBlocks: realization.evaluation.leadBlocks,
                    pointErrorSats: realization.evaluation.pointErrorSats,
                    pointErrorBips: realization.evaluation.pointErrorBips,
                    rangeContainsActual: realization.evaluation.rangeContainsActual,
                    rangeWidthBips: realization.evaluation.rangeWidthBips,
                  }
                : null,
            }))
        : [],
      total: stakers.length,
      offset,
      limit,
    };
  }

  /**
   * Per-bucket claim discovery for one page of the roster.
   *
   * Deliberately not part of the operator snapshot: this issues a `get-pox-addr` and a
   * `get-earned-staker-rewards` per staker per participating bucket, so on a large roster it would
   * multiply every refresh by the bucket count. The caller pages it, and the returned settlement
   * summary is what an operator sees before signing the first of N transactions.
   */
  async stakerClaims(options: { offset?: number; limit?: number } = {}) {
    const snapshot = await this.snapshot();
    const rewards = snapshot.rewards;
    if (!rewards) throw new Error("Reward status is unavailable");
    const offset = options.offset ?? 0;
    const limit = Math.min(options.limit ?? 25, 100);
    // The reconciled roster, not the STX cycle-membership list. A pure bond staker has no STX
    // membership, so sourcing candidates from reward status would silently never offer their
    // settlement transaction. Only reconciliation-complete entries are offered: an unexplained
    // roster entry is not something to build a payout from.
    const config = this.runtimeContext().config;
    const sourceId = createChainSourceId(config.network, config.apiUrl);
    const completedRun = this.options.store.getLatestCompletedSignerStakerRun(
      sourceId,
      this.options.managerPrincipal,
    );
    if (!completedRun?.reconciliationComplete) {
      throw new Error("Signer-staker reconciliation must complete before settling staker rewards");
    }
    const principals = this.options.store
      .listSignerStakers(this.options.managerPrincipal, true, sourceId)
      .filter(
        ({ lastSeenRunId, bond, position, stxNodeVerified }) =>
          lastSeenRunId === completedRun.runId &&
          (bond !== null || position !== null || stxNodeVerified === true),
      )
      .map(({ stakerPrincipal }) => stakerPrincipal);
    const page = principals.slice(offset, offset + limit);
    const bondIndices = rewards.buckets
      .filter(({ bondIndex, participating }) => bondIndex !== null && participating)
      .map(({ bondIndex }) => BigInt(bondIndex as string));
    const discovery = await discoverStakerClaims({
      node: this.options.node,
      managerPrincipal: this.options.managerPrincipal,
      rewardCycle: rewards.rewardCycle,
      stakerPrincipals: page,
      bondIndices,
    });
    return {
      generatedAt: snapshot.generatedAt,
      rewardCycle: discovery.rewardCycle,
      page: {
        stakerPrincipals: page,
        offset,
        limit,
        stakersTotal: principals.length,
        nextCursor: offset + limit < principals.length ? String(offset + limit) : null,
      },
      settlement: discovery.settlement,
      candidates: discovery.stakers.flatMap((staker) =>
        staker.claims.map((claim) => ({
          stakerPrincipal: staker.stakerPrincipal,
          bondIndex: claim.bondIndex,
          payout: { kind: staker.payout.kind, maxFeeSats: staker.payout.maxFeeSats },
          rewards: claim.rewards,
          claimable: claim.claimable,
          blockedReason: claim.blockedReason,
        })),
      ),
    };
  }

  async rewardsHistory(
    options: {
      offset?: number;
      limit?: number;
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
      direction?: SortDirection;
    } = {},
  ) {
    return this.options.store.listRewardCycleSummaries(this.options.managerPrincipal, options);
  }

  async activity(options: Parameters<typeof readManagerActivity>[3] = {}) {
    const config = this.runtimeContext().config;
    const chainId =
      config.expectedNetworkId ??
      (config.network === "mainnet" ? 1 : config.network === "testnet" ? 0x80000005 : 0x80000000);
    return readManagerActivity(this.options.store, chainId, this.options.managerPrincipal, {
      ...options,
      sourceId: createChainSourceId(config.network, config.apiUrl),
    });
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

  private async runSynchronization(options: OperatorSynchronizationOptions) {
    const { managerPrincipal, store } = this.options;
    const { config, node, api } = this.runtimeContext();
    const sourceId = createChainSourceId(config.network, config.apiUrl);
    const nodeSourceId = createNodeSourceId(config.network, config.nodeRpcUrl);
    let synchronized: {
      observedAt: string;
      chainId: number;
      eventVocabulary: ManagerEventVocabulary;
      pox5ContractId: string;
      stakers: Awaited<ReturnType<typeof syncSignerStakers>>;
    } | null = null;
    const maxAnchorAttempts = 3;
    for (let attempt = 1; attempt <= maxAnchorAttempts; attempt += 1) {
      options.signal?.throwIfAborted();
      const observedAt = new Date().toISOString();
      const { preflight, manager } = await readOperatorAnchorSnapshot({
        config,
        node,
        api,
        managerPrincipal,
        managerVerification: this.options.managerVerification,
      });
      const trustTransition = this.recordManagerTrustState(manager, observedAt);
      if (trustTransition) this.pendingTrustTransition = trustTransition;
      if (
        !indexedWorkflowsReady(preflight) ||
        !preflight.pox.pox5ContractId ||
        !manager.attachAllowed
      ) {
        throw new OperatorWorkflowError(
          422,
          "synchronization_sources_incompatible",
          "Sync is blocked by node, API, PoX-5, or manager compatibility checks. Review preflight and manager verification, then retry",
        );
      }
      if (
        options.minimumStacksHeight !== null &&
        options.minimumStacksHeight !== undefined &&
        preflight.api.stacksTipHeight < options.minimumStacksHeight
      ) {
        throw new Error(
          `Roster reconciliation is waiting for the indexed source to reach Stacks height ${options.minimumStacksHeight}`,
        );
      }
      const indexedAnchor = await captureChainAnchor(node, api);
      store.chainState.upsertSource({
        sourceId,
        kind: "api",
        network: config.network,
        baseUrl: config.apiUrl,
        observedAt,
      });
      store.chainState.upsertSource({
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
          burnBlockHeight: indexedAnchor.burnBlockHeight,
          stacksTipHeight: indexedAnchor.stacksBlockHeight,
          currentRewardCycle: indexedAnchor.rewardCycle,
          chainAnchor: indexedAnchor,
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
        synchronized = {
          observedAt,
          chainId: preflight.node.networkId,
          eventVocabulary: managerEventVocabularyFor(manager.capabilities),
          pox5ContractId: preflight.pox.pox5ContractId,
          stakers,
        };
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
      eventVocabulary: synchronized.eventVocabulary,
      ...(this.options.nodeTransactions ? { nodeTransactions: this.options.nodeTransactions } : {}),
      nodeBlocks: node,
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
    const poolActivity = this.options.nodeTransactions
      ? await syncPox5PoolActivity({
          store,
          api,
          nodeTransactions: this.options.nodeTransactions,
          nodeBlocks: node,
          sourceId,
          chainId: synchronized.chainId,
          managerPrincipal,
          pox5ContractId: synchronized.pox5ContractId,
          observedAt: synchronized.observedAt,
          pageLimit: config.eventPageLimit,
          ...(options.minimumStacksHeight !== undefined
            ? { minimumStacksHeight: options.minimumStacksHeight }
            : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        })
      : null;
    const currentMemberHistory = [];
    if (this.options.nodeTransactions && synchronized.stakers.authoritative) {
      const currentStakerPrincipals = store
        .listSignerStakers(managerPrincipal, true, sourceId)
        .map(({ stakerPrincipal }) => stakerPrincipal);
      // One bounded pass advances at most five principal pages. The persisted queue orders by
      // pages processed, so each current member gets a turn before a long-lived wallet gets a
      // second page.
      for (let page = 0; page < 5; page += 1) {
        options.signal?.throwIfAborted();
        const result = await syncCurrentMemberHistoryPass({
          store,
          api,
          nodeTransactions: this.options.nodeTransactions,
          nodeBlocks: node,
          sourceId,
          chainId: synchronized.chainId,
          managerPrincipal,
          pox5ContractId: synchronized.pox5ContractId,
          currentStakerPrincipals,
          observedAt: new Date(Date.parse(synchronized.observedAt) + page).toISOString(),
          pageLimit: Math.min(50, config.eventPageLimit),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        currentMemberHistory.push(result);
        if (result.memberProcessed === null) break;
      }
    }
    this.cached = null;
    return {
      observedAt: synchronized.observedAt,
      stakers: synchronized.stakers,
      events,
      poolActivity,
      currentMemberHistory,
    };
  }

  private async runManagerActivitySynchronization(options: ManagerActivitySynchronizationOptions) {
    options.signal?.throwIfAborted();
    if (!this.options.nodeTransactions) {
      throw new Error("Manager activity reconciliation requires the local node transaction index");
    }
    const { managerPrincipal, store } = this.options;
    const { config, node, api } = this.runtimeContext();
    const observedAt = new Date().toISOString();
    const { preflight, manager } = await readOperatorAnchorSnapshot({
      config,
      node,
      api,
      managerPrincipal,
      managerVerification: this.options.managerVerification,
    });
    const trustTransition = this.recordManagerTrustState(manager, observedAt);
    if (trustTransition) this.pendingTrustTransition = trustTransition;
    if (!indexedWorkflowsReady(preflight) || !manager.attachAllowed) {
      throw new OperatorWorkflowError(
        422,
        "manager_activity_sources_incompatible",
        "Manager activity sync is blocked by node, API, or manager compatibility checks",
      );
    }
    if (
      options.minimumStacksHeight !== null &&
      options.minimumStacksHeight !== undefined &&
      preflight.api.stacksTipHeight < options.minimumStacksHeight
    ) {
      throw new Error(
        `Manager activity is waiting for the indexed source to reach Stacks height ${options.minimumStacksHeight}`,
      );
    }
    const sourceId = createChainSourceId(config.network, config.apiUrl);
    store.chainState.upsertSource({
      sourceId,
      kind: "api",
      network: config.network,
      baseUrl: config.apiUrl,
      observedAt,
    });
    const events = await syncManagerEvents({
      store,
      api,
      sourceId,
      chainId: preflight.node.networkId,
      managerPrincipal,
      eventVocabulary: managerEventVocabularyFor(manager.capabilities),
      observedAt,
      pageLimit: config.eventPageLimit,
      nodeTransactions: this.options.nodeTransactions,
      nodeBlocks: node,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onProgress
        ? {
            onProgress: async (progress: {
              completed: number;
              total: number | null;
              eventsProcessed: number;
            }) => {
              options.signal?.throwIfAborted();
              await options.onProgress?.({
                phase: "events",
                completed: progress.completed,
                total: progress.total,
                message: `Synced ${progress.eventsProcessed} manager events`,
              });
            },
          }
        : {}),
    });
    if (events.reorgedEvents > 0 && this.options.managerVerification) {
      invalidateManagerVerificationCache(this.options.managerVerification, managerPrincipal);
    }
    this.cached = null;
    return { observedAt, events };
  }

  private async runRewardRealizationSynchronization(
    options: RewardRealizationSynchronizationOptions,
  ) {
    options.signal?.throwIfAborted();
    if (!this.options.nodeTransactions) {
      throw new Error(
        "Reward realization reconciliation requires the local node transaction index",
      );
    }
    const { managerPrincipal, store } = this.options;
    const { config, node, api } = this.runtimeContext();
    const observedAt = new Date().toISOString();
    const { preflight, manager } = await readOperatorAnchorSnapshot({
      config,
      node,
      api,
      managerPrincipal,
      managerVerification: this.options.managerVerification,
    });
    const trustTransition = this.recordManagerTrustState(manager, observedAt);
    if (trustTransition) this.pendingTrustTransition = trustTransition;
    if (
      !indexedWorkflowsReady(preflight) ||
      !manager.attachAllowed ||
      !preflight.pox.pox5ContractId
    ) {
      throw new OperatorWorkflowError(
        422,
        "reward_realization_sources_incompatible",
        "Reward realization sync is blocked by node, API, or manager compatibility checks",
      );
    }
    if (
      options.minimumStacksHeight !== null &&
      options.minimumStacksHeight !== undefined &&
      preflight.api.stacksTipHeight < options.minimumStacksHeight
    ) {
      throw new Error(
        `Reward realization sync is waiting for the indexed source to reach Stacks height ${options.minimumStacksHeight}`,
      );
    }
    const sourceId = createChainSourceId(config.network, config.apiUrl);
    store.chainState.upsertSource({
      sourceId,
      kind: "api",
      network: config.network,
      baseUrl: config.apiUrl,
      observedAt,
    });
    const result = await syncRewardRealizations({
      store,
      api,
      node,
      nodeTransactions: this.options.nodeTransactions,
      nodeBlocks: node,
      sourceId,
      chainId: preflight.node.networkId,
      managerPrincipal,
      pox5ContractId: preflight.pox.pox5ContractId,
      observedAt,
      pageLimit: config.eventPageLimit,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    this.cached = null;
    return { observedAt, result };
  }

  private async load() {
    const { managerPrincipal, store } = this.options;
    const { config, node, api } = this.runtimeContext();
    const generatedAt = new Date().toISOString();
    const sourceId = createChainSourceId(config.network, config.apiUrl);
    const operatorSnapshot = await readOperatorAnchorSnapshot({
      config,
      node,
      api,
      managerPrincipal,
      managerVerification: this.options.managerVerification,
      reportMissingManager: true,
    });
    const { chainAnchor, preflight, manager, registration, readiness } = operatorSnapshot;
    const nodeAuthority = store.deploymentIdentity.putLocalNodeAuthority(
      managerPrincipal,
      advanceLocalNodeAuthority(store.deploymentIdentity.getLocalNodeAuthority(managerPrincipal), {
        observedAt: generatedAt,
        stacksTipHeight: preflight.node.stacksTipHeight,
        isFullySynced: preflight.node.isFullySynced ?? null,
        peerHeightDifference: preflight.node.peerHeightDifference ?? null,
      }),
    );
    const pox5ContractId = preflight.pox.pox5ContractId;
    const recordedTrustTransition = this.recordManagerTrustState(manager, generatedAt);
    const trustAudit = store.managerTrust.listAudit(managerPrincipal);
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
      indexedApiAvailable: indexedApiCompatible(preflight),
    });
    const rewardCalculation = deriveRewardCalculationTarget(
      projectionAnchor,
      preflight.pox.firstRewardCycleId,
    );
    const forecast =
      manager.attachAllowed && pox5ContractId
        ? await readPoolForecast({
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
          })
        : null;
    const rewardCapability = managerActionCapability(
      manager.capabilities,
      "reference-reward-claims",
    );
    const rewardOutlook =
      manager.attachAllowed && pox5ContractId
        ? await readRewardOutlook({
            store,
            node,
            managerPrincipal,
            pox5ContractId,
            observedAt: generatedAt,
            chainAnchor: projectionAnchor,
            firstRewardCycleId: preflight.pox.firstRewardCycleId,
            sourceId,
            feeCapability: rewardCapability,
          })
        : null;
    const rewards =
      rewardOutlook && rewardCapability.executionAvailable && rewardCalculation.status === "ready"
        ? await readStxRewardStatus({
            store,
            node,
            sourceId,
            managerPrincipal,
            pox5ContractId: rewardOutlook.pox5ContractId,
            rewardCycle: rewardCalculation.rewardCycle,
            observedAt: generatedAt,
            burnBlockHeight: projectionAnchor.burnBlockHeight,
            stacksTipHeight: projectionAnchor.stacksBlockHeight,
            chainAnchor: projectionAnchor,
            firstRewardCycleId: preflight.pox.firstRewardCycleId,
            rewardOutlook,
          })
        : null;
    await observeTransactionEngineSafely(this.options.transactionEngineObservation, {
      setup: operatorSnapshot,
      rewards,
      sourceId,
      observedAt: generatedAt,
    });
    const activity = readManagerActivity(store, preflight.node.networkId, managerPrincipal, {
      claimLimit: 4,
      withdrawalLimit: 50,
      sourceId,
      eventVocabulary: managerEventVocabularyFor(manager.capabilities),
    });
    const roster = rosterJson(store, managerPrincipal, sourceId);
    const managerCursor = store.chainState.getCursor(
      sourceId,
      managerEventStream(managerPrincipal, managerEventVocabularyFor(manager.capabilities)),
    );
    const rewardCursor = pox5ContractId
      ? store.chainState.getCursor(sourceId, rewardRealizationStream(pox5ContractId))
      : null;
    const completedRosterRun = store.getLatestCompletedSignerStakerRun(sourceId, managerPrincipal);
    const memberCoverage = pox5ContractId
      ? store.currentMemberHistoryCoverage(sourceId, managerPrincipal, pox5ContractId)
      : {
          currentMembers: 0,
          membersComplete: 0,
          pagesProcessed: 0,
          transactionsInspected: 0,
          relevantEvents: 0,
          updatedAt: null,
        };
    const currentMemberHistoryStatus = !completedRosterRun?.authoritative
      ? "not-started"
      : memberCoverage.currentMembers === memberCoverage.membersComplete
        ? "complete"
        : memberCoverage.pagesProcessed > 0 || memberCoverage.currentMembers > 0
          ? "reconstructing"
          : "not-started";
    const monitoringStartedAt = store.deploymentIdentity.get()?.boundAt ?? null;
    const historyRecovery = {
      schemaVersion: 1 as const,
      monitoringStartedAt,
      managerHistory: {
        status: managerCursor
          ? managerCursor.cursor === null
            ? ("complete" as const)
            : ("reconstructing" as const)
          : ("not-started" as const),
        updatedAt: managerCursor?.updatedAt ?? null,
        recoveryBoundaryStacksHeight: managerCursor?.lastBlockHeight ?? null,
      },
      currentMemberHistory: {
        status: currentMemberHistoryStatus,
        ...memberCoverage,
      },
      rewardHistory: {
        status: rewardCursor
          ? rewardCursor.cursor === null
            ? ("complete" as const)
            : ("reconstructing" as const)
          : ("not-started" as const),
        updatedAt: rewardCursor?.updatedAt ?? null,
        recoveryBoundaryStacksHeight: rewardCursor?.lastBlockHeight ?? null,
      },
      signerHealthHistory: {
        status: "monitoring-since-install" as const,
        monitoringStartedAt,
      },
    };
    const partial = {
      preflight,
      manager,
      registration,
      readiness,
      setup: readiness,
      forecast,
      rewardOutlook,
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
      chainAnchor,
      nodeAuthority,
      historyRecovery,
      ...partial,
      readiness,
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
    return this.options.store.managerTrust.record({
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
