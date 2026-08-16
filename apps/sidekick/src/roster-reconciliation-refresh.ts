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

export type RosterReconciliationLoop = BackgroundRefreshLoop;

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
  const intervalMs = positiveRefreshInterval(
    options.intervalMs ?? DEFAULT_ROSTER_RECONCILIATION_INTERVAL_MS,
    "intervalMs",
  );
  const initialDelayMs = nonNegativeRefreshDelay(
    options.initialDelayMs ?? DEFAULT_ROSTER_RECONCILIATION_INITIAL_DELAY_MS,
    "initialDelayMs",
  );
  const failureDelayMs = positiveRefreshInterval(
    options.failureDelayMs ?? DEFAULT_ROSTER_RECONCILIATION_FAILURE_DELAY_MS,
    "failureDelayMs",
  );
  const maxBackoffMs = positiveRefreshInterval(
    options.maxBackoffMs ?? DEFAULT_ROSTER_RECONCILIATION_MAX_BACKOFF_MS,
    "maxBackoffMs",
  );
  const metrics = options.metrics;

  return startBackgroundRefreshLoop({
    run: () => service.reconcileRoster(),
    logger,
    intervalMs,
    initialDelayMs,
    failureDelayMs,
    maxBackoffMs,
    enabledMessage: "Automatic roster reconciliation is enabled",
    recoveredMessage: "Automatic roster reconciliation recovered",
    failureMessage: "Automatic roster reconciliation failed; retaining the last verified roster",
    retryAfterMs: (error) =>
      error instanceof RosterReconciliationRetryError ? error.retryAfterMs : null,
    onAttempt: () => metrics?.recordAttempt(),
    onSuccess: (result) => {
      if (result === "synchronized") {
        metrics?.recordSuccess();
        logger.info({}, "Automatic roster reconciliation completed");
      } else {
        metrics?.recordSkip();
      }
    },
    onFailure: (delayMs) => metrics?.recordFailure(delayMs),
    onSchedule: (delayMs) => metrics?.recordSchedule(delayMs),
    setTimeout: options.setTimeout,
    clearTimeout: options.clearTimeout,
  });
}

import {
  type BackgroundRefreshLoop,
  nonNegativeRefreshDelay,
  positiveRefreshInterval,
  startBackgroundRefreshLoop,
} from "./background-refresh-loop.js";
