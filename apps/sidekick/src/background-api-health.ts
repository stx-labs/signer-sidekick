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
  rateLimited: boolean;
  status: Promise<{ value: ApiStatus; checkedAt: string }>;
  observation?: Promise<Observation>;
}
const observations = new WeakMap<HealthApi, Entry>();
export const BACKGROUND_API_HEALTH_MAX_AGE_MS = 30_000;
const MAX_RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;
const SOURCE_READ_TIMEOUT_MS = 10_000;

function entryFor(api: HealthApi): Entry {
  const now = Date.now();
  const retained = observations.get(api);
  if (
    retained &&
    now < retained.expiresAt &&
    now >= retained.expiresAt - MAX_RATE_LIMIT_COOLDOWN_MS
  )
    return retained;
  // Shared advisory work has its own bounded lifetime, not a browser caller's cancellation.
  // Canonical fences and all transaction preparation keep using uncached client methods.
  const checkedAt = new Date(now).toISOString();
  const entry: Entry = {
    expiresAt: now + BACKGROUND_API_HEALTH_MAX_AGE_MS,
    rateLimited: false,
    status: withOperatorRequestSignal(AbortSignal.timeout(SOURCE_READ_TIMEOUT_MS), async () => ({
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
    entry.rateLimited = true;
    const hint = error.retryAfterMs;
    entry.expiresAt = Math.max(
      entry.expiresAt,
      Date.now() +
        Math.min(
          MAX_RATE_LIMIT_COOLDOWN_MS,
          Math.max(
            BACKGROUND_API_HEALTH_MAX_AGE_MS,
            hint !== null && Number.isFinite(hint) ? hint : 60_000,
          ),
        ),
    );
  } else if (!entry.rateLimited) {
    // Expire ordinary failures without dropping this generation: another source still in
    // flight may establish a cooldown. A normal failure cannot clear an existing 429.
    entry.expiresAt = Date.now();
  }
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
      AbortSignal.timeout(SOURCE_READ_TIMEOUT_MS),
      async () =>
        await Promise.all([
          // Each actual source read owns its failure. Consuming the retained status promise
          // here must not extend that request's cooldown a second time.
          api.getNodeInfo({ retry: false }).catch((error: unknown) => {
            retainFailure(api, entry, error);
            throw error;
          }),
          entry.status.then(({ value }) => value),
        ]),
    );
  }
  return entry.observation;
}
