export interface BackgroundRefreshLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
}

export interface BackgroundRefreshLoop {
  stop(): void;
}

export interface BackgroundRefreshLoopOptions<Result> {
  run(): Promise<Result>;
  logger: BackgroundRefreshLogger;
  intervalMs: number;
  initialDelayMs: number;
  failureDelayMs: number;
  maxBackoffMs: number;
  enabledMessage: string;
  recoveredMessage: string;
  failureMessage: string;
  retryAfterMs?(error: unknown): number | null;
  onAttempt?(): void;
  onSuccess?(result: Result): void;
  onFailure?(retryInMs: number): void;
  onSchedule?(delayMs: number): void;
  setTimeout?: typeof globalThis.setTimeout | undefined;
  clearTimeout?: typeof globalThis.clearTimeout | undefined;
}

export function positiveRefreshInterval(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function nonNegativeRefreshDelay(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

/** Runs one non-overlapping background task with bounded exponential backoff. */
export function startBackgroundRefreshLoop<Result>(
  options: BackgroundRefreshLoopOptions<Result>,
): BackgroundRefreshLoop {
  const scheduleTimeout = options.setTimeout ?? globalThis.setTimeout;
  const cancelTimeout = options.clearTimeout ?? globalThis.clearTimeout;
  let stopped = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (delayMs: number) => {
    options.onSchedule?.(delayMs);
    timer = scheduleTimeout(() => void refresh(), delayMs);
    timer.unref?.();
  };

  const refresh = async () => {
    if (stopped) return;
    options.onAttempt?.();
    try {
      const result = await options.run();
      if (stopped) return;
      options.onSuccess?.(result);
      const recoveredFailures = failures;
      failures = 0;
      if (recoveredFailures > 0) {
        options.logger.info(
          { recoveredAfterFailures: recoveredFailures },
          options.recoveredMessage,
        );
      }
      schedule(options.intervalMs);
    } catch (error) {
      if (stopped) return;
      failures += 1;
      const requestedDelay = options.retryAfterMs?.(error) ?? null;
      const delayMs =
        requestedDelay === null
          ? Math.min(options.maxBackoffMs, options.failureDelayMs * 2 ** Math.max(0, failures - 1))
          : Math.min(options.maxBackoffMs, Math.max(1_000, requestedDelay));
      options.onFailure?.(delayMs);
      options.logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
          failures,
          retryInMs: delayMs,
        },
        options.failureMessage,
      );
      schedule(delayMs);
    }
  };

  options.logger.info(
    { intervalMs: options.intervalMs, initialDelayMs: options.initialDelayMs },
    options.enabledMessage,
  );
  schedule(options.initialDelayMs);

  return {
    stop() {
      stopped = true;
      if (timer) cancelTimeout(timer);
    },
  };
}
