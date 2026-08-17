import { hiroReferenceApiCredential, indexedApiCredential } from "./config.js";
import { buildHealthRollup, buildHealthSnapshot } from "./health-monitoring-presentation.js";
import {
  collectHealthObservation,
  healthConfigurationFingerprint,
  testHealthSource,
} from "./health-monitoring-sources.js";
import { calculateBurnBlockTiming, trimHealthObservations } from "./health-monitoring-state.js";
import type {
  BurnBlockTiming,
  HealthMonitoringOptions,
  HealthObservation,
  HealthSnapshot,
} from "./health-monitoring-types.js";
import type { HealthMonitoringRepository } from "./storage/health-monitoring-repository.js";

export { calculateBurnBlockTiming } from "./health-monitoring-state.js";
export type {
  BurnBlockTiming,
  HealthFinding,
  HealthMonitoringOptions,
  HealthSnapshot,
  HealthSourceState,
  HealthSourceStatus,
} from "./health-monitoring-types.js";

const burnBlockTimingRefreshMs = 5 * 60 * 1_000;
const defaultPollIntervalMs = 5_000;
const defaultReferencePollIntervalMs = 30_000;
const restartResolutionWarmupMs = 15 * 60_000;

export class HealthMonitoringService {
  private observations: HealthObservation[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<HealthSnapshot> | null = null;
  private burnBlockTiming: BurnBlockTiming | null = null;
  private burnBlockTimingAttemptedAt = 0;
  private referenceAttemptedAt = 0;
  private configFingerprint: string | null = null;
  private resolutionHoldUntil = 0;

  constructor(private readonly options: HealthMonitoringOptions) {}

  start(onError: (error: unknown) => void = () => undefined): void {
    if (this.interval) return;
    const refresh = () => void this.refresh().catch(onError);
    refresh();
    this.interval = setInterval(refresh, this.options.pollIntervalMs ?? defaultPollIntervalMs);
    this.interval.unref?.();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  async current(): Promise<HealthSnapshot> {
    if (this.observations.length === 0) this.hydrate();
    return this.observations.length > 0 ? this.buildSnapshot() : this.refresh();
  }

  /** Build a support/read-only snapshot from persisted evidence without collecting or reconciling. */
  storedSnapshot(): HealthSnapshot {
    if (this.observations.length === 0) this.hydrate();
    return this.buildSnapshot();
  }

  async refresh(): Promise<HealthSnapshot> {
    this.refreshing ??= this.collect().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async testSource(
    kind: "node-metrics" | "signer-monitoring" | "indexed-api" | "hiro-reference",
    url?: string,
  ): Promise<{ status: "connected"; signals: number }> {
    if (kind === "indexed-api" || kind === "hiro-reference") {
      const config = this.options.getConfig();
      const configuredUrl = kind === "indexed-api" ? config.apiUrl : config.hiroReferenceApiUrl;
      if (!configuredUrl) throw new Error(`${kind} is not configured`);
      const credential =
        kind === "indexed-api" ? indexedApiCredential(config) : hiroReferenceApiCredential(config);
      return testHealthSource(kind, configuredUrl, credential);
    }
    if (!url) throw new Error(`${kind} URL is required`);
    return testHealthSource(kind, url);
  }

  private hydrate(): void {
    const config = this.options.getConfig();
    const fingerprint = healthConfigurationFingerprint(config);
    if (this.configFingerprint === fingerprint && this.observations.length > 0) return;
    this.configFingerprint = fingerprint;
    const since = new Date(
      (this.options.now ?? (() => new Date()))().getTime() -
        (this.options.historyWindowMs ?? 2 * 60 * 60 * 1_000),
    ).toISOString();
    this.observations =
      this.options.store?.healthMonitoring.listObservations(fingerprint, {
        since,
        limit: 5_000,
      }) ?? [];
    const latestAt = Date.parse(this.observations.at(-1)?.observedAt ?? "");
    const now = (this.options.now ?? (() => new Date()))().getTime();
    const activeEpisodes =
      this.options.store?.healthMonitoring.listActiveFindingEpisodes(fingerprint) ?? [];
    if (
      activeEpisodes.length > 0 &&
      (!Number.isFinite(latestAt) ||
        now - latestAt > (this.options.pollIntervalMs ?? defaultPollIntervalMs) * 3)
    ) {
      this.resolutionHoldUntil = now + restartResolutionWarmupMs;
    }
  }

  private async collect(): Promise<HealthSnapshot> {
    const config = this.options.getConfig();
    const configFingerprint = healthConfigurationFingerprint(config);
    if (this.configFingerprint !== null && this.configFingerprint !== configFingerprint) {
      const resolvedAt = (this.options.now ?? (() => new Date()))().toISOString();
      this.options.store?.healthMonitoring.resolveActiveFindingEpisodes(
        this.configFingerprint,
        resolvedAt,
      );
      this.observations = [];
      this.burnBlockTiming = null;
      this.burnBlockTimingAttemptedAt = 0;
      this.referenceAttemptedAt = 0;
      this.resolutionHoldUntil = 0;
    }
    this.configFingerprint = configFingerprint;
    if (this.observations.length === 0) this.hydrate();

    const clockAtMs = (this.options.now ?? (() => new Date()))().getTime();
    const previousObservedAtMs = Date.parse(this.observations.at(-1)?.observedAt ?? "");
    const observedAtMs = Math.max(
      clockAtMs,
      Number.isFinite(previousObservedAtMs) ? previousObservedAtMs + 1 : clockAtMs,
    );
    const observedAt = new Date(observedAtMs).toISOString();
    const shouldRefreshBurnTiming =
      Boolean(this.options.getBurnBlocks) &&
      observedAtMs - this.burnBlockTimingAttemptedAt >= burnBlockTimingRefreshMs;
    if (shouldRefreshBurnTiming) this.burnBlockTimingAttemptedAt = observedAtMs;
    const latestObservation = this.observations.at(-1);
    const referencesRateLimited =
      latestObservation?.hiroSource?.errorCode === "rate-limited" ||
      latestObservation?.configuredApiSource?.errorCode === "rate-limited";
    const referenceIntervalMs = referencesRateLimited
      ? Math.max(60_000, this.options.referencePollIntervalMs ?? defaultReferencePollIntervalMs)
      : (this.options.referencePollIntervalMs ?? defaultReferencePollIntervalMs);
    const shouldRefreshReferences = observedAtMs - this.referenceAttemptedAt >= referenceIntervalMs;
    if (shouldRefreshReferences) this.referenceAttemptedAt = observedAtMs;

    const [observation, burnBlocks] = await Promise.all([
      collectHealthObservation(config, observedAt, {
        includeReferences: shouldRefreshReferences,
        previous: this.observations.at(-1) ?? null,
      }),
      shouldRefreshBurnTiming
        ? this.options.getBurnBlocks?.().catch(() => null)
        : Promise.resolve(undefined),
    ]);

    if (burnBlocks) this.burnBlockTiming = calculateBurnBlockTiming(burnBlocks);
    this.observations.push(observation);
    this.options.store?.healthMonitoring.recordObservation(configFingerprint, observation);
    this.observations = trimHealthObservations(
      this.observations,
      observedAt,
      this.options.historyWindowMs ?? 2 * 60 * 60 * 1_000,
    );
    const rollupCutoff = new Date(
      Math.floor(observedAtMs / (5 * 60 * 1_000)) * (5 * 60 * 1_000),
    ).toISOString();
    const rollup = buildHealthRollup(
      this.observations.filter(({ observedAt: value }) => value >= rollupCutoff),
    );
    if (rollup) {
      this.options.store?.healthMonitoring.upsertRollup(configFingerprint, rollup, observedAt);
    }
    this.options.store?.healthMonitoring.prune(observedAt);
    const retainDuringWarmup = observedAtMs < this.resolutionHoldUntil;
    const preliminary = this.buildSnapshot(undefined, retainDuringWarmup);
    const findings = retainDuringWarmup
      ? this.retainActiveFindings(preliminary.findings)
      : preliminary.findings;
    const episodes = this.options.store?.healthMonitoring.reconcileFindingEpisodes(
      configFingerprint,
      findings,
      observedAt,
    );
    return this.buildSnapshot(episodes, retainDuringWarmup);
  }

  private buildSnapshot(
    reconciledEpisodes?: HealthSnapshot["history"]["recentEpisodes"],
    retainActiveEpisodes = false,
  ): HealthSnapshot {
    const fingerprint =
      this.configFingerprint ?? healthConfigurationFingerprint(this.options.getConfig());
    const repository = this.options.store?.healthMonitoring;
    const summary = repository?.observationSummary(fingerprint) ?? {
      observationCount: this.observations.length,
      observedSince: this.observations.at(0)?.observedAt ?? null,
    };
    const recentEpisodes = reconciledEpisodes ?? this.recentEpisodes(repository, fingerprint);
    const recentRollups = repository?.listRecentRollups(fingerprint, 288) ?? [];
    const dataQuality = repository?.dataQualitySummary() ?? {
      skippedObservationRows: 0,
      skippedRollupRows: 0,
      skippedEpisodeRows: 0,
    };
    return buildHealthSnapshot({
      observations: this.observations,
      config: this.options.getConfig(),
      burnBlockTiming: this.burnBlockTiming,
      operator: this.options.getOperatorContext?.() ?? null,
      retainActiveEpisodes,
      history: {
        ...summary,
        recentRollups,
        recentEpisodes,
        ...dataQuality,
      },
    });
  }

  private recentEpisodes(
    repository: HealthMonitoringRepository | undefined,
    fingerprint: string,
  ): HealthSnapshot["history"]["recentEpisodes"] {
    if (!repository) return [];
    const recent = repository.listFindingEpisodes(fingerprint, 50);
    const active = repository.listActiveFindingEpisodes(fingerprint);
    const activeIds = new Set(active.map(({ episodeId }) => episodeId));
    return [
      ...active.sort((left, right) => right.firstObservedAt.localeCompare(left.firstObservedAt)),
      ...recent.filter(({ episodeId }) => !activeIds.has(episodeId)),
    ].slice(0, 50);
  }

  private retainActiveFindings(findings: HealthSnapshot["findings"]): HealthSnapshot["findings"] {
    const fingerprint =
      this.configFingerprint ?? healthConfigurationFingerprint(this.options.getConfig());
    const active =
      this.options.store?.healthMonitoring.listActiveFindingEpisodes(fingerprint) ?? [];
    const present = new Set(findings.map(({ id }) => id));
    return [
      ...findings,
      ...active
        .filter(({ id }) => !present.has(id))
        .map(
          ({ status: _status, resolvedAt: _resolvedAt, occurrences: _occurrences, ...finding }) =>
            finding,
        ),
    ];
  }
}
