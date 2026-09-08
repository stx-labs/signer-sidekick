import type { ApiStatus, NodeInfo, StacksApiClient } from "./chain-clients.js";

type HealthApi = Pick<StacksApiClient, "getNodeInfo" | "getStatus">;
type Observation = [NodeInfo, ApiStatus];
const observations = new WeakMap<HealthApi, { startedAt: number; value: Promise<Observation> }>();
export const BACKGROUND_API_HEALTH_MAX_AGE_MS = 30_000;

/** Only advisory background health may reuse these reads. Canonicality fences and transaction
 * preparation continue to call the client's uncached methods directly. Keys are client instances,
 * which the runtime replaces whenever the endpoint or credentials change. */
export function readBackgroundApiHealth(api: HealthApi, signal: AbortSignal): Promise<Observation> {
  const now = Date.now();
  const retained = observations.get(api);
  if (
    retained &&
    now >= retained.startedAt &&
    now - retained.startedAt < BACKGROUND_API_HEALTH_MAX_AGE_MS
  ) {
    return retained.value;
  }
  const entry = {
    startedAt: now,
    value: Promise.all([api.getNodeInfo({ signal }), api.getStatus({ signal })]),
  };
  observations.set(api, entry);
  void entry.value.catch(() => {
    if (observations.get(api) === entry) observations.delete(api);
  });
  return entry.value;
}
