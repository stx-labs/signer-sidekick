import { buildHealthSnapshot } from "./health-monitoring-presentation.js";
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

export class HealthMonitoringService {
  private observations: HealthObservation[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<HealthSnapshot> | null = null;
  private burnBlockTiming: BurnBlockTiming | null = null;
  private burnBlockTimingAttemptedAt = 0;
  private configFingerprint: string | null = null;

  constructor(private readonly options: HealthMonitoringOptions) {}

  start(): void {
    if (this.interval) return;
    void this.refresh();
    this.interval = setInterval(() => void this.refresh(), this.options.pollIntervalMs ?? 30_000);
    this.interval.unref?.();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  async current(): Promise<HealthSnapshot> {
    return this.observations.length > 0 ? this.buildSnapshot() : this.refresh();
  }

  async refresh(): Promise<HealthSnapshot> {
    this.refreshing ??= this.collect()
      .then(() => this.buildSnapshot())
      .finally(() => {
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

  private async collect(): Promise<void> {
    const config = this.options.getConfig();
    const configFingerprint = healthConfigurationFingerprint(config);
    if (this.configFingerprint !== null && this.configFingerprint !== configFingerprint) {
      this.observations = [];
      this.burnBlockTiming = null;
      this.burnBlockTimingAttemptedAt = 0;
    }
    this.configFingerprint = configFingerprint;

    const observedAt = (this.options.now ?? (() => new Date()))().toISOString();
    const observedAtMs = Date.parse(observedAt);
    const shouldRefreshBurnTiming =
      Boolean(this.options.getBurnBlocks) &&
      observedAtMs - this.burnBlockTimingAttemptedAt >= burnBlockTimingRefreshMs;
    if (shouldRefreshBurnTiming) this.burnBlockTimingAttemptedAt = observedAtMs;

    const [observation, burnBlocks] = await Promise.all([
      collectHealthObservation(config, observedAt),
      shouldRefreshBurnTiming
        ? this.options.getBurnBlocks?.().catch(() => null)
        : Promise.resolve(undefined),
    ]);

    if (burnBlocks) this.burnBlockTiming = calculateBurnBlockTiming(burnBlocks);
    this.observations.push(observation);
    this.observations = trimHealthObservations(
      this.observations,
      observedAt,
      this.options.historyWindowMs ?? 2 * 60 * 60 * 1_000,
    );
  }

  private buildSnapshot(): HealthSnapshot {
    return buildHealthSnapshot({
      observations: this.observations,
      config: this.options.getConfig(),
      burnBlockTiming: this.burnBlockTiming,
    });
  }
}
