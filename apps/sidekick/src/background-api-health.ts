import {
  type ApiStatus,
  type NodeInfo,
  RateLimitedError,
  type StacksApiClient,
} from "./chain-clients.js";
import { withOperatorRequestSignal } from "./request-context.js";

type HealthApi = Pick<StacksApiClient, "getNodeInfo" | "getStatus">;
type Observation = [NodeInfo, ApiStatus];
interface Entry {
  expiresAt: number;
  status: Promise<{ value: ApiStatus; checkedAt: string }>;
  observation?: Promise<Observation>;
}
const observations = new WeakMap<HealthApi, Entry>();
export const BACKGROUND_API_HEALTH_MAX_AGE_MS = 30_000;

function entryFor(api: HealthApi): Entry {
  const now = Date.now();
  const retained = observations.get(api);
  if (retained && now < retained.expiresAt && now >= retained.expiresAt - 300_000) return retained;
  // Shared advisory work has its own bounded lifetime, not a browser caller's cancellation.
  // Canonical fences and all transaction preparation keep using uncached client methods.
  const checkedAt = new Date(now).toISOString();
  const entry: Entry = {
    expiresAt: now + BACKGROUND_API_HEALTH_MAX_AGE_MS,
    status: withOperatorRequestSignal(AbortSignal.timeout(10_000), async () => ({
      value: await api.getStatus({ retry: false }),
      checkedAt,
    })),
  };
  observations.set(api, entry);
  void entry.status.catch((error: unknown) => retainFailure(api, entry, error));
  return entry;
}

function retainFailure(api: HealthApi, entry: Entry, error: unknown): void {
  if (observations.get(api) !== entry) return;
  if (error instanceof RateLimitedError) {
    const hint = error.retryAfterMs;
    entry.expiresAt =
      Date.now() +
      Math.min(300_000, Math.max(30_000, hint !== null && Number.isFinite(hint) ? hint : 60_000));
  } else observations.delete(api);
}

/** Shared status only; health collection must not add an unnecessary node-info request. */
export function readBackgroundApiStatus(api: HealthApi) {
  return entryFor(api).status;
}

export function readBackgroundApiHealth(api: HealthApi, signal: AbortSignal): Promise<Observation> {
  signal.throwIfAborted();
  const entry = entryFor(api);
  if (!entry.observation) {
    entry.observation = withOperatorRequestSignal(
      AbortSignal.timeout(10_000),
      async () =>
        await Promise.all([
          api.getNodeInfo({ retry: false }),
          entry.status.then(({ value }) => value),
        ]),
    );
    // Record a cooldown only on the actual read, never extend it on a cache hit.
    void entry.observation.catch((error: unknown) => retainFailure(api, entry, error));
  }
  return entry.observation;
}
