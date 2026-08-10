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
}

export interface SnapshotRefreshLoop {
  stop(): void;
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
    try {
      await service.refreshSnapshot();
      if (stopped) return;
      failures = 0;
      schedule(intervalMs);
    } catch (error) {
      if (stopped) return;
      failures += 1;
      const delayMs = retryDelay(error, failures, failureDelayMs, maxBackoffMs);
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
