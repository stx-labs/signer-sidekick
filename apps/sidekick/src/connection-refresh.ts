import {
  type BackgroundRefreshLogger,
  startBackgroundRefreshLoop,
} from "./background-refresh-loop.js";
import type { ConnectionAssessmentService } from "./connection-assessment.js";

export const CONNECTION_REFRESH_INTERVAL_MS = 30_000;
export const CONNECTION_REFRESH_MAX_BACKOFF_MS = 5 * 60_000;

/** Reuse the existing assessor/cache and refresh loop; the browser is not a recovery trigger. */
export function startConnectionRefreshLoop(
  connection: Pick<ConnectionAssessmentService, "check">,
  startOperationalRuntime: () => Promise<void>,
  logger: BackgroundRefreshLogger,
): { stop(): Promise<void> } {
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  const check = async () => {
    const result = await connection.check();
    if (stopped) return;
    // Deadlines resolve to an unavailable assessment; they are not successful refreshes.
    if (result.status === "unavailable") {
      throw new Error(`Connection reassessment unavailable: ${result.outcomeCode}`);
    }
    // A positive identity/network refusal is not permission to start any operational worker.
    if (result.status === "connected") await startOperationalRuntime();
  };
  const loop = startBackgroundRefreshLoop({
    run: () => {
      inFlight = check().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    logger,
    intervalMs: CONNECTION_REFRESH_INTERVAL_MS,
    initialDelayMs: 0,
    failureDelayMs: CONNECTION_REFRESH_INTERVAL_MS,
    maxBackoffMs: CONNECTION_REFRESH_MAX_BACKOFF_MS,
    enabledMessage: "Background connection reassessment is enabled",
    recoveredMessage: "Background connection reassessment recovered",
    failureMessage: "Connection reassessment or worker startup failed; retrying in the background",
  });
  return {
    async stop() {
      stopped = true;
      loop.stop();
      // Let the bounded assessment/startup finish before its store and workers are closed.
      await inFlight?.catch(() => undefined);
    },
  };
}
