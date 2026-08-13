export const DEFAULT_ROSTER_RECONCILIATION_INTERVAL_MS = 30 * 60_000;
export const DEFAULT_ROSTER_RECONCILIATION_INITIAL_DELAY_MS = 30_000;
export const DEFAULT_ROSTER_RECONCILIATION_FAILURE_DELAY_MS = 60_000;
export const DEFAULT_ROSTER_RECONCILIATION_MAX_BACKOFF_MS = 30 * 60_000;

export type RosterReconciliationRunResult = "synchronized" | "skipped";

export interface RosterReconciliationService {
  reconcileRoster(): Promise<RosterReconciliationRunResult>;
}

export interface RosterReconciliationLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
}

export interface RosterReconciliationLoopOptions {
  intervalMs?: number;
  initialDelayMs?: number;
  failureDelayMs?: number;
  maxBackoffMs?: number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  metrics?: RosterReconciliationMetricsTracker;
}

export interface RosterReconciliationLoop {
  stop(): void;
}

export interface RosterReconciliationMetricValues {
  attemptsTotal: number;
  successesTotal: number;
  skipsTotal: number;
  failuresTotal: number;
  consecutiveFailures: number;
  retryBackoffSeconds: number;
  lastSuccessTimestampSeconds: number;
  nextAttemptTimestampSeconds: number;
}

/** A classified automatic reconciliation failure whose upstream delay should be honored. */
export class RosterReconciliationRetryError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null = null,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "RosterReconciliationRetryError";
  }
}

/** Process-local metrics for the automatic roster loop; it never performs chain reads itself. */
export class RosterReconciliationMetricsTracker {
  private attemptsTotal = 0;
  private successesTotal = 0;
  private skipsTotal = 0;
  private failuresTotal = 0;
  private consecutiveFailures = 0;
  private retryBackoffSeconds = 0;
  private lastSuccessTimestampSeconds = 0;
  private nextAttemptTimestampSeconds = 0;

  constructor(private readonly now: () => number = Date.now) {}

  recordAttempt(): void {
    this.attemptsTotal += 1;
  }

  recordSuccess(): void {
    this.successesTotal += 1;
    this.consecutiveFailures = 0;
    this.retryBackoffSeconds = 0;
    this.lastSuccessTimestampSeconds = this.now() / 1_000;
  }

  recordSkip(): void {
    this.skipsTotal += 1;
    this.consecutiveFailures = 0;
    this.retryBackoffSeconds = 0;
  }

  recordFailure(retryInMs: number): void {
    this.failuresTotal += 1;
    this.consecutiveFailures += 1;
    this.retryBackoffSeconds = retryInMs / 1_000;
  }

  recordSchedule(delayMs: number): void {
    this.nextAttemptTimestampSeconds = (this.now() + delayMs) / 1_000;
  }

  snapshot(): RosterReconciliationMetricValues {
    return {
      attemptsTotal: this.attemptsTotal,
      successesTotal: this.successesTotal,
      skipsTotal: this.skipsTotal,
      failuresTotal: this.failuresTotal,
      consecutiveFailures: this.consecutiveFailures,
      retryBackoffSeconds: this.retryBackoffSeconds,
      lastSuccessTimestampSeconds: this.lastSuccessTimestampSeconds,
      nextAttemptTimestampSeconds: this.nextAttemptTimestampSeconds,
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
  if (error instanceof RosterReconciliationRetryError && error.retryAfterMs !== null) {
    return Math.min(maxBackoffMs, Math.max(1_000, error.retryAfterMs));
  }
  return Math.min(maxBackoffMs, failureDelayMs * 2 ** Math.max(0, failures - 1));
}

/**
 * Reconciles the authoritative signer roster independently of browser traffic. Runs never overlap:
 * the next attempt is scheduled only after the current one settles, and the server-level
 * reconciliation controller coalesces this with operator-triggered work.
 */
export function startRosterReconciliationLoop(
  service: RosterReconciliationService,
  logger: RosterReconciliationLogger,
  options: RosterReconciliationLoopOptions = {},
): RosterReconciliationLoop {
  const intervalMs = positiveInteger(
    options.intervalMs ?? DEFAULT_ROSTER_RECONCILIATION_INTERVAL_MS,
    "intervalMs",
  );
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_ROSTER_RECONCILIATION_INITIAL_DELAY_MS;
  if (!Number.isSafeInteger(initialDelayMs) || initialDelayMs < 0) {
    throw new Error("initialDelayMs must be a non-negative integer");
  }
  const failureDelayMs = positiveInteger(
    options.failureDelayMs ?? DEFAULT_ROSTER_RECONCILIATION_FAILURE_DELAY_MS,
    "failureDelayMs",
  );
  const maxBackoffMs = positiveInteger(
    options.maxBackoffMs ?? DEFAULT_ROSTER_RECONCILIATION_MAX_BACKOFF_MS,
    "maxBackoffMs",
  );
  const scheduleTimeout = options.setTimeout ?? globalThis.setTimeout;
  const cancelTimeout = options.clearTimeout ?? globalThis.clearTimeout;
  const metrics = options.metrics;

  let stopped = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (delayMs: number) => {
    metrics?.recordSchedule(delayMs);
    timer = scheduleTimeout(() => void reconcile(), delayMs);
    timer.unref?.();
  };

  const reconcile = async () => {
    if (stopped) return;
    metrics?.recordAttempt();
    try {
      const result = await service.reconcileRoster();
      if (stopped) return;
      const recoveredFailures = failures;
      failures = 0;
      if (result === "synchronized") {
        metrics?.recordSuccess();
        logger.info({}, "Automatic roster reconciliation completed");
      } else {
        metrics?.recordSkip();
      }
      if (recoveredFailures > 0) {
        logger.info(
          { recoveredAfterFailures: recoveredFailures },
          "Automatic roster reconciliation recovered",
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
        "Automatic roster reconciliation failed; retaining the last verified roster",
      );
      schedule(delayMs);
    }
  };

  logger.info({ intervalMs, initialDelayMs }, "Automatic roster reconciliation is enabled");
  schedule(initialDelayMs);

  return {
    stop() {
      stopped = true;
      if (timer) cancelTimeout(timer);
    },
  };
}
