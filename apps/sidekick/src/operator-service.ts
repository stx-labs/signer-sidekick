import { z } from "zod";
import { deriveRewardCalculationTarget } from "./chain-anchor.js";
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
import { SignerStakerAnchorError, syncSignerStakers } from "./signer-staker-sync.js";
import { createChainSourceId, createNodeSourceId, type SidekickStore } from "./storage/store.js";

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

export interface TransactionEngineObservationHook {
  observe(input: {
    setup: SetupSnapshot;
    rewards: StxRewardStatus | null;
    sourceId: string;
    observedAt: string;
  }): Promise<unknown>;
  onError?(error: unknown): void;
}

export async function observeTransactionEngineSafely(
  hook: TransactionEngineObservationHook | undefined,
  input: Parameters<TransactionEngineObservationHook["observe"]>[0],
): Promise<void> {
  if (!hook) return;
  try {
    await hook.observe(input);
  } catch (error) {
    hook.onError?.(error);
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
      detail: `${asSentence(check.message)} Open Settings to verify the configured node and API data sources.`,
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
      detail: `${asSentence(incompatibility)} Open Initial Setup to review network compatibility and manager interface requirements.`,
      action: { kind: "navigate", label: "Open Initial Setup", target: "setup" },
    });
  } else if (snapshot.manager.source.tier === "unrecognized") {
    alerts.push({
      id: "manager:not-recognized-read-only",
      severity: "warning",
      title: "Manager Not Recognized — Read-only",
      detail: `Attach, display, reconciliation, and monitoring work normally. Reference-manager Assist remains disabled: ${snapshot.manager.automationEligibilityReason}. Open Settings to install a provenance-verified profile if this is a reference render.`,
      action: { kind: "navigate", label: "Review manager profiles", target: "settings" },
    });
  } else if (snapshot.manager.source.tier === "custom-observe") {
    alerts.push({
      id: "manager:custom-read-only",
      severity: "info",
      title: "Custom Manager — Read-only",
      detail:
        "This operator-installed custom profile supports attach and monitoring only. It cannot use reference-manager Assist. No action is required unless you intend to enable Assist for a reference manager.",
    });
  }
  if (snapshot.manager.installedProfiles.issues.length > 0) {
    alerts.push({
      id: "manager:profile-load-issues",
      severity: "warning",
      title: "Installed Manager Profile Needs Attention",
      detail: `${snapshot.manager.installedProfiles.issues.length} profile issue(s) were ignored safely. Open Settings to review the rejected profile files and reasons.`,
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
          : "Manager Degraded to Read-only",
      detail: gained
        ? `${asSentence(snapshot.trustTransition.reason)} No action is required.`
        : `${asSentence(snapshot.trustTransition.reason)} Review the installed manager profile before enabling Assist.`,
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
    const blockedReason =
      snapshot.setup.checks.find(({ status }) => status === "fail")?.message ??
      "A required manager setup check failed";
    alerts.push({
      id: "setup:blocked",
      severity: "critical",
      title: "Pool Setup Is Blocked",
      detail: `${asSentence(blockedReason)} Open Initial Setup to review and resolve the blocked step.`,
      action: { kind: "navigate", label: "Open Initial Setup", target: "setup" },
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
        ? `The pool is below the ${thresholdStx} signer-set threshold in reward cycle(s) ${belowThreshold}. Open Pool positions to review the delegated total and roster changes.`
        : `Open Pool positions to review the roster changes affecting reward cycle(s) ${affected}.`,
      action: { kind: "navigate", label: "Review pool positions", target: "pool" },
    });
  }
  if (snapshot.rewards?.status === "attention") {
    alerts.push({
      id: "rewards:incomplete",
      severity: "warning",
      title: "Reward Roster Is Incomplete",
      detail:
        "Sidekick has not synchronized the individual staker roster. Run Reconcile now before relying on payout totals.",
      action: { kind: "reconcile", label: "Reconcile now" },
    });
  }
  if (snapshot.activity.pendingWithdrawalTotal > 0) {
    alerts.push({
      id: "withdrawals:pending",
      severity: "info",
      title: "L1 Withdrawals Await Resolution",
      detail: `${snapshot.activity.pendingWithdrawalTotal} withdrawal request(s) remain pending or require registry reconciliation. Open Rewards → L1 withdrawals to review each request's current state.`,
      action: { kind: "navigate", label: "Review L1 withdrawals", target: "rewards" },
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

  async synchronize() {
    if (this.synchronization) return this.synchronization;
    this.synchronization = this.runSynchronization().finally(() => {
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

  async summary() {
    const snapshot = await this.snapshot();
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
    const snapshot = await this.snapshot();
    return readManagerActivity(
      this.options.store,
      snapshot.preflight.node.networkId,
      this.options.managerPrincipal,
      options,
    );
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

  async poolCard(mode: PoolCardMode) {
    if (!this.options.runtimeSettings) throw new Error("Runtime settings are unavailable");
    const snapshot = await this.snapshot(true);
    if (!snapshot.setup) throw new Error("Pool card generation requires completed manager setup");
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
    );
    return createPoolCardArtifact(enrollment, mode, settings.embed.publicApiUrl);
  }

  private async runSynchronization() {
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
        throw new Error(
          "Synchronization requires healthy sources, active PoX-5, and a recognized manager",
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
    const events = await syncManagerEvents({
      store,
      api,
      sourceId,
      chainId: synchronized.chainId,
      managerPrincipal,
      observedAt: synchronized.observedAt,
      pageLimit: config.eventPageLimit,
    });
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
    const rewardCalculation = deriveRewardCalculationTarget(chainAnchor);
    const [forecast, rewards] =
      manager.attachAllowed && pox5ContractId
        ? await Promise.all([
            readPoolForecast({
              store,
              node,
              sourceId,
              managerPrincipal,
              pox5ContractId,
              currentRewardCycle: chainAnchor.rewardCycle,
              horizonCycles: config.forecastHorizonCycles,
              observedAt: generatedAt,
              burnBlockHeight: chainAnchor.burnBlockHeight,
              stacksTipHeight: chainAnchor.stacksBlockHeight,
              chainAnchor,
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
                  burnBlockHeight: chainAnchor.burnBlockHeight,
                  stacksTipHeight: chainAnchor.stacksBlockHeight,
                  chainAnchor,
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
