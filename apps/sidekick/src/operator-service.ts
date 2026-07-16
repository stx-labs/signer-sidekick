import { z } from "zod";
import type { StacksApiClient, StacksNodeClient } from "./chain-clients.js";
import { redactConfig, type SidekickConfig } from "./config.js";
import { createPoolEnrollmentDocument } from "./enrollment-info.js";
import { readManagerActivity } from "./manager-activity.js";
import { syncManagerEvents } from "./manager-event-sync.js";
import { inspectDeployedManager, inspectManagerOrReportMissing } from "./manager-verification.js";
import { createPoolCardArtifact, type PoolCardMode } from "./pool-card.js";
import { readPoolForecast } from "./pool-forecast.js";
import { runOperatorPreflight } from "./preflight.js";
import { verifyManagerRegistration } from "./registration-verification.js";
import { readStxRewardStatus } from "./reward-status.js";
import type { RuntimeSettingsController } from "./runtime-settings.js";
import { readPoolSetupStatus } from "./setup-status.js";
import { syncSignerStakers } from "./signer-staker-sync.js";
import { createChainSourceId, createNodeSourceId, type SidekickStore } from "./storage/store.js";

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
  runtimeSettings?: RuntimeSettingsController;
}

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
}): OperatorAlert[] {
  const alerts: OperatorAlert[] = [];
  for (const check of snapshot.preflight.checks.filter(({ status }) => status !== "pass")) {
    alerts.push({
      id: `preflight:${check.id}`,
      severity: check.status === "fail" ? "critical" : "warning",
      title: check.status === "fail" ? "Connection Check Failed" : "Connection Needs Attention",
      detail: check.message,
    });
  }
  if (!snapshot.manager.attachAllowed) {
    alerts.push({
      id: "manager:unsupported",
      severity: "critical",
      title: "Manager Is Not Supported",
      detail: "The deployed manager source is not recognized for operator automation.",
    });
  }
  if (snapshot.setup?.status === "blocked") {
    alerts.push({
      id: "setup:blocked",
      severity: "critical",
      title: "Pool Setup Is Blocked",
      detail:
        snapshot.setup.checks.find(({ status }) => status === "fail")?.message ??
        "Complete the required manager setup checks.",
    });
  }
  if (snapshot.forecast?.status === "attention") {
    const affectedCycles = snapshot.forecast.cycles.filter(({ status }) => status === "attention");
    const affected = affectedCycles.map(({ cycleId }) => cycleId).join(", ");
    const belowThreshold = affectedCycles
      .filter(({ threshold }) => !threshold.meetsThreshold)
      .map(({ cycleId }) => cycleId)
      .join(", ");
    const thresholdUstx = affectedCycles.find(({ threshold }) => !threshold.meetsThreshold)
      ?.threshold.thresholdUstx;
    const thresholdStx = thresholdUstx
      ? `${(BigInt(thresholdUstx) / 1_000_000n).toLocaleString("en-US")} STX`
      : "the signer-set";
    alerts.push({
      id: "pool:forecast-attention",
      severity: "warning",
      title: belowThreshold ? "Pool Below Signer-Set Threshold" : "Pool Forecast Needs Attention",
      detail: belowThreshold
        ? `The pool is below the ${thresholdStx} signer-set threshold in reward cycle(s) ${belowThreshold}.`
        : affected
          ? `Review reward cycle(s) ${affected}.`
          : "Pool roster evidence is incomplete.",
    });
  }
  if (snapshot.rewards?.status === "attention") {
    alerts.push({
      id: "rewards:incomplete",
      severity: "warning",
      title: "Reward Roster Is Incomplete",
      detail: "Complete a signer-staker synchronization before relying on payout totals.",
    });
  }
  if (snapshot.activity.pendingWithdrawalTotal > 0) {
    alerts.push({
      id: "withdrawals:pending",
      severity: "info",
      title: "L1 Withdrawals Await Resolution",
      detail: `${snapshot.activity.pendingWithdrawalTotal} withdrawal request(s) remain pending or require registry reconciliation.`,
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
    const observedAt = new Date().toISOString();
    const [preflight, manager] = await Promise.all([
      runOperatorPreflight(config, node, api),
      inspectDeployedManager(node, config.network, managerPrincipal),
    ]);
    if (preflight.status === "fail" || !preflight.pox.pox5ContractId || !manager.attachAllowed) {
      throw new Error(
        "Synchronization requires healthy sources, active PoX-5, and a recognized manager",
      );
    }
    const sourceId = createChainSourceId(config.network, config.apiUrl);
    const nodeSourceId = createNodeSourceId(config.network, config.nodeRpcUrl);
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
    const stakers = await syncSignerStakers({
      store,
      api,
      node,
      sourceId,
      nodeSourceId,
      managerPrincipal,
      pox5ContractId: preflight.pox.pox5ContractId,
      observedAt,
      burnBlockHeight: preflight.node.burnBlockHeight,
      stacksTipHeight: preflight.node.stacksTipHeight,
      currentRewardCycle: preflight.cycle.currentId,
      pageLimit: config.stakerPageLimit,
    });
    const events = await syncManagerEvents({
      store,
      api,
      sourceId,
      chainId: preflight.node.networkId,
      managerPrincipal,
      observedAt,
      pageLimit: config.eventPageLimit,
    });
    this.cached = null;
    return { observedAt, stakers, events };
  }

  private async load() {
    const { managerPrincipal, store } = this.options;
    const { config, node, api } = this.runtimeContext();
    const generatedAt = new Date().toISOString();
    const sourceId = createChainSourceId(config.network, config.apiUrl);
    const [preflight, manager] = await Promise.all([
      runOperatorPreflight(config, node, api),
      inspectManagerOrReportMissing(node, config.network, managerPrincipal),
    ]);
    const pox5ContractId = preflight.pox.pox5ContractId;
    const registration =
      manager.attachAllowed && pox5ContractId
        ? await verifyManagerRegistration(node, pox5ContractId, managerPrincipal)
        : null;
    const setup = registration
      ? await readPoolSetupStatus(node, preflight, manager, registration)
      : null;
    const [forecast, rewards] =
      manager.attachAllowed && pox5ContractId
        ? await Promise.all([
            readPoolForecast({
              store,
              node,
              sourceId,
              managerPrincipal,
              pox5ContractId,
              currentRewardCycle: preflight.cycle.currentId,
              horizonCycles: config.forecastHorizonCycles,
              observedAt: generatedAt,
              burnBlockHeight: preflight.node.burnBlockHeight,
              stacksTipHeight: preflight.node.stacksTipHeight,
            }),
            readStxRewardStatus({
              store,
              node,
              sourceId,
              managerPrincipal,
              pox5ContractId,
              rewardCycle: preflight.cycle.currentId,
              observedAt: generatedAt,
              burnBlockHeight: preflight.node.burnBlockHeight,
              stacksTipHeight: preflight.node.stacksTipHeight,
            }),
          ])
        : [null, null];
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
}
