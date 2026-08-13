import { RateLimitedError } from "./chain-clients.js";

export const DEFAULT_SNAPSHOT_REFRESH_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_SNAPSHOT_REFRESH_FAILURE_DELAY_MS = 30_000;
export const DEFAULT_SNAPSHOT_REFRESH_MAX_BACKOFF_MS = 5 * 60_000;

export interface SnapshotRefreshService {
  refreshSnapshot(): Promise<unknown>;
}

export interface SnapshotRefreshLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
}

export interface SnapshotRefreshLoopOptions {
  intervalMs?: number;
  failureDelayMs?: number;
  maxBackoffMs?: number;
  initialDelayMs?: number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  metrics?: SnapshotRefreshMetricsTracker;
}

export interface SnapshotRefreshLoop {
  stop(): void;
}

export interface SnapshotRefreshMetricValues {
  attemptsTotal: number;
  successesTotal: number;
  failuresTotal: number;
  consecutiveFailures: number;
  retryBackoffSeconds: number;
  lastSuccessTimestampSeconds: number;
  snapshotGeneratedTimestampSeconds: number;
  snapshotAgeSeconds: number;
  snapshotFresh: 0 | 1;
  sourcePositions: {
    nodeStacksHeight: number;
    apiStacksHeight: number;
    nodeBurnHeight: number;
    apiBurnHeight: number;
    poxBurnHeight: number;
    poxRewardCycle: number;
  } | null;
}

interface RefreshObservation {
  generatedAt?: unknown;
  preflight?: {
    node?: { stacksTipHeight?: unknown; burnBlockHeight?: unknown };
    api?: { stacksTipHeight?: unknown; burnBlockHeight?: unknown };
    pox?: { burnBlockHeight?: unknown; rewardCycleId?: unknown };
  };
}

function safeHeight(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

/** Process-local metrics for the autonomous refresh loop; it never performs an upstream read. */
export class SnapshotRefreshMetricsTracker {
  private attemptsTotal = 0;
  private successesTotal = 0;
  private failuresTotal = 0;
  private consecutiveFailures = 0;
  private retryBackoffSeconds = 0;
  private lastSuccessTimestampSeconds = 0;
  private snapshotGeneratedTimestampSeconds = 0;
  private sourcePositions: SnapshotRefreshMetricValues["sourcePositions"] = null;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly freshForMs = DEFAULT_SNAPSHOT_REFRESH_INTERVAL_MS,
  ) {}

  recordAttempt(): void {
    this.attemptsTotal += 1;
  }

  recordSuccess(value: unknown): void {
    this.successesTotal += 1;
    this.consecutiveFailures = 0;
    this.retryBackoffSeconds = 0;
    this.lastSuccessTimestampSeconds = this.now() / 1_000;
    if (!value || typeof value !== "object") return;
    const observation = value as RefreshObservation;
    if (typeof observation.generatedAt === "string") {
      const generatedAt = Date.parse(observation.generatedAt);
      if (Number.isFinite(generatedAt))
        this.snapshotGeneratedTimestampSeconds = generatedAt / 1_000;
    }
    const nodeStacksHeight = safeHeight(observation.preflight?.node?.stacksTipHeight);
    const apiStacksHeight = safeHeight(observation.preflight?.api?.stacksTipHeight);
    const nodeBurnHeight = safeHeight(observation.preflight?.node?.burnBlockHeight);
    const apiBurnHeight = safeHeight(observation.preflight?.api?.burnBlockHeight);
    const poxBurnHeight = safeHeight(observation.preflight?.pox?.burnBlockHeight);
    const poxRewardCycle = safeHeight(observation.preflight?.pox?.rewardCycleId);
    if (
      nodeStacksHeight !== null &&
      apiStacksHeight !== null &&
      nodeBurnHeight !== null &&
      apiBurnHeight !== null &&
      poxBurnHeight !== null &&
      poxRewardCycle !== null
    ) {
      this.sourcePositions = {
        nodeStacksHeight,
        apiStacksHeight,
        nodeBurnHeight,
        apiBurnHeight,
        poxBurnHeight,
        poxRewardCycle,
      };
    }
  }

  recordFailure(retryInMs: number): void {
    this.failuresTotal += 1;
    this.consecutiveFailures += 1;
    this.retryBackoffSeconds = retryInMs / 1_000;
  }

  snapshot(): SnapshotRefreshMetricValues {
    const snapshotAgeSeconds =
      this.snapshotGeneratedTimestampSeconds > 0
        ? Math.max(0, this.now() / 1_000 - this.snapshotGeneratedTimestampSeconds)
        : 0;
    const snapshotFresh =
      this.lastSuccessTimestampSeconds > 0 &&
      this.consecutiveFailures === 0 &&
      this.now() - this.lastSuccessTimestampSeconds * 1_000 <= this.freshForMs
        ? 1
        : 0;
    return {
      attemptsTotal: this.attemptsTotal,
      successesTotal: this.successesTotal,
      failuresTotal: this.failuresTotal,
      consecutiveFailures: this.consecutiveFailures,
      retryBackoffSeconds: this.retryBackoffSeconds,
      lastSuccessTimestampSeconds: this.lastSuccessTimestampSeconds,
      snapshotGeneratedTimestampSeconds: this.snapshotGeneratedTimestampSeconds,
      snapshotAgeSeconds,
      snapshotFresh,
      sourcePositions: this.sourcePositions,
    };
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function retryDelay(
  error: unknown,
  failures: number,
  failureDelayMs: number,
  maxBackoffMs: number,
): number {
  if (error instanceof RateLimitedError && error.retryAfterMs !== null) {
    return Math.min(maxBackoffMs, Math.max(1_000, error.retryAfterMs));
  }
  return Math.min(maxBackoffMs, failureDelayMs * 2 ** Math.max(0, failures - 1));
}

/**
 * Keeps the in-memory operator snapshot warm when nobody has the dashboard open. Refreshes never
 * overlap: a following run is scheduled only after the previous one settles, and OperatorService
 * itself coalesces this work with an interactive refresh already in flight.
 */
export function startSnapshotRefreshLoop(
  service: SnapshotRefreshService,
  logger: SnapshotRefreshLogger,
  options: SnapshotRefreshLoopOptions = {},
): SnapshotRefreshLoop {
  const intervalMs = positiveInteger(
    options.intervalMs ?? DEFAULT_SNAPSHOT_REFRESH_INTERVAL_MS,
    "intervalMs",
  );
  const failureDelayMs = positiveInteger(
    options.failureDelayMs ?? DEFAULT_SNAPSHOT_REFRESH_FAILURE_DELAY_MS,
    "failureDelayMs",
  );
  const maxBackoffMs = positiveInteger(
    options.maxBackoffMs ?? DEFAULT_SNAPSHOT_REFRESH_MAX_BACKOFF_MS,
    "maxBackoffMs",
  );
  const initialDelayMs = options.initialDelayMs ?? 0;
  if (!Number.isSafeInteger(initialDelayMs) || initialDelayMs < 0) {
    throw new Error("initialDelayMs must be a non-negative integer");
  }
  const scheduleTimeout = options.setTimeout ?? globalThis.setTimeout;
  const cancelTimeout = options.clearTimeout ?? globalThis.clearTimeout;
  const metrics = options.metrics;

  let stopped = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (delayMs: number) => {
    timer = scheduleTimeout(() => {
      void refresh();
    }, delayMs);
    timer.unref?.();
  };

  const refresh = async () => {
    if (stopped) return;
    metrics?.recordAttempt();
    try {
      const snapshot = await service.refreshSnapshot();
      if (stopped) return;
      metrics?.recordSuccess(snapshot);
      const recoveredFailures = failures;
      failures = 0;
      if (recoveredFailures > 0) {
        logger.info(
          { recoveredAfterFailures: recoveredFailures },
          "Background operator snapshot refresh recovered",
        );
      }
      schedule(intervalMs);
    } catch (error) {
      if (stopped) return;
      failures += 1;
      const delayMs = retryDelay(error, failures, failureDelayMs, maxBackoffMs);
      metrics?.recordFailure(delayMs);
      logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
          failures,
          retryInMs: delayMs,
        },
        "Background operator snapshot refresh failed; retaining the last known snapshot",
      );
      schedule(delayMs);
    }
  };

  logger.info({ intervalMs, initialDelayMs }, "Background operator snapshot refresh is enabled");
  schedule(initialDelayMs);

  return {
    stop() {
      stopped = true;
      if (timer) cancelTimeout(timer);
    },
  };
}
