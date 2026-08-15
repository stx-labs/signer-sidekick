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
const unsupportedTelemetryProbeIntervalMs = 5 * 60_000;
const unavailableTelemetryRetryIntervalMs = 30_000;

export class HealthMonitoringService {
  private observations: HealthObservation[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<HealthSnapshot> | null = null;
  private burnBlockTiming: BurnBlockTiming | null = null;
  private burnBlockTimingAttemptedAt = 0;
  private referenceAttemptedAt = 0;
  private telemetryAttemptedAt = 0;
  private configFingerprint: string | null = null;

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

  async refresh(): Promise<HealthSnapshot> {
    this.refreshing ??= this.collect().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async testSource(
    kind: "node-metrics" | "signer-monitoring" | "hiro-reference",
    url: string,
  ): Promise<{ status: "connected"; signals: number }> {
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
      this.telemetryAttemptedAt = 0;
    }
    this.configFingerprint = configFingerprint;
    if (this.observations.length === 0) this.hydrate();

    const observedAt = (this.options.now ?? (() => new Date()))().toISOString();
    const observedAtMs = Date.parse(observedAt);
    const shouldRefreshBurnTiming =
      Boolean(this.options.getBurnBlocks) &&
      observedAtMs - this.burnBlockTimingAttemptedAt >= burnBlockTimingRefreshMs;
    if (shouldRefreshBurnTiming) this.burnBlockTimingAttemptedAt = observedAtMs;
    const shouldRefreshReferences =
      observedAtMs - this.referenceAttemptedAt >=
      (this.options.referencePollIntervalMs ?? defaultReferencePollIntervalMs);
    if (shouldRefreshReferences) this.referenceAttemptedAt = observedAtMs;
    const latestTelemetry = this.observations.at(-1)?.signerBlockTelemetry;
    const telemetryIntervalMs =
      latestTelemetry?.status === "unsupported"
        ? unsupportedTelemetryProbeIntervalMs
        : latestTelemetry?.status === "unavailable"
          ? unavailableTelemetryRetryIntervalMs
          : 0;
    const shouldRefreshSignerBlockTelemetry =
      Boolean(config.signerMonitoringUrl) &&
      (telemetryIntervalMs === 0 ||
        observedAtMs - this.telemetryAttemptedAt >= telemetryIntervalMs);
    if (shouldRefreshSignerBlockTelemetry) this.telemetryAttemptedAt = observedAtMs;

    const [observation, burnBlocks] = await Promise.all([
      collectHealthObservation(config, observedAt, {
        includeReferences: shouldRefreshReferences,
        includeSignerBlockTelemetry: shouldRefreshSignerBlockTelemetry,
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
    const preliminary = this.buildSnapshot();
    const episodes = this.options.store?.healthMonitoring.reconcileFindingEpisodes(
      configFingerprint,
      preliminary.findings,
      observedAt,
    );
    return this.buildSnapshot(episodes);
  }

  private buildSnapshot(
    reconciledEpisodes?: HealthSnapshot["history"]["recentEpisodes"],
  ): HealthSnapshot {
    const fingerprint =
      this.configFingerprint ?? healthConfigurationFingerprint(this.options.getConfig());
    const repository = this.options.store?.healthMonitoring;
    const summary = repository?.observationSummary(fingerprint) ?? {
      observationCount: this.observations.length,
      observedSince: this.observations.at(0)?.observedAt ?? null,
    };
    return buildHealthSnapshot({
      observations: this.observations,
      config: this.options.getConfig(),
      burnBlockTiming: this.burnBlockTiming,
      operator: this.options.getOperatorContext?.() ?? null,
      history: {
        ...summary,
        recentRollups: repository?.listRecentRollups(fingerprint, 288) ?? [],
        recentEpisodes:
          reconciledEpisodes ?? repository?.listFindingEpisodes(fingerprint, 50) ?? [],
      },
    });
  }
}
