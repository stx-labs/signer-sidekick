import type { BurnBlockPage } from "./chain-clients.js";
import type {
  BurnBlockTiming,
  HealthObservation,
  HealthSourceKey,
  HealthSourceState,
} from "./health-monitoring-types.js";

export function calculateBurnBlockTiming(
  page: Pick<BurnBlockPage, "results">,
): BurnBlockTiming | null {
  const blocks = [...page.results]
    .filter(({ burn_block_time }) => burn_block_time > 0)
    .sort((left, right) => right.burn_block_height - left.burn_block_height)
    .filter(
      (block, index, values) =>
        index === 0 || block.burn_block_height !== values[index - 1]?.burn_block_height,
    );
  const latest = blocks[0];
  if (!latest) return null;

  for (const windowHours of [24, 12] as const) {
    const cutoff = latest.burn_block_time - windowHours * 60 * 60;
    const inWindow = blocks.filter(
      ({ burn_block_time }) =>
        burn_block_time >= cutoff && burn_block_time <= latest.burn_block_time,
    );
    const oldest = inWindow.at(-1);
    if (!oldest) continue;
    const sampleBlocks = latest.burn_block_height - oldest.burn_block_height;
    const elapsedSeconds = latest.burn_block_time - oldest.burn_block_time;
    if (sampleBlocks < 6 || elapsedSeconds < windowHours * 60 * 60 * 0.75) continue;
    const averageSeconds = Math.round(elapsedSeconds / sampleBlocks);
    if (averageSeconds <= 0) continue;
    return {
      averageSeconds,
      windowHours,
      sampleBlocks,
      sampledAt: new Date(latest.burn_block_time * 1_000).toISOString(),
    };
  }
  return null;
}

function countConsecutiveFailures(
  observations: readonly HealthObservation[],
  key: HealthSourceKey,
): number {
  let failures = 0;
  let lastCheckedAt: string | null = null;
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const source = observations[index]?.[key];
    if (!source || source.reachable) break;
    if (source.checkedAt === lastCheckedAt) continue;
    lastCheckedAt = source.checkedAt;
    failures += 1;
  }
  return failures;
}

export function healthSourceState(
  observations: readonly HealthObservation[],
  key: HealthSourceKey,
  configured: boolean,
): HealthSourceState {
  if (!configured) {
    return {
      configured: false,
      status: "not-configured",
      checkedAt: null,
      lastSuccessAt: null,
      latencyMs: null,
      consecutiveFailures: 0,
      errorCode: null,
    };
  }
  const latest = observations.at(-1);
  const source = latest?.[key] ?? null;
  const lastSuccess = [...observations]
    .reverse()
    .find((observation) => observation[key]?.reachable);
  return {
    configured: true,
    status: source?.reachable ? "healthy" : "unavailable",
    checkedAt: source?.checkedAt ?? latest?.observedAt ?? null,
    lastSuccessAt: lastSuccess?.[key]?.checkedAt ?? lastSuccess?.observedAt ?? null,
    latencyMs: source?.latencyMs ?? null,
    consecutiveFailures: countConsecutiveFailures(observations, key),
    errorCode: source?.errorCode ?? null,
  };
}

export function counterIncrease<T>(
  items: readonly T[],
  select: (item: T) => number | null,
): number | null {
  let previous: number | null = null;
  let increase = 0;
  let transitions = 0;
  for (const item of items) {
    const value = select(item);
    if (value === null) continue;
    if (previous !== null) {
      increase += value >= previous ? value - previous : value;
      transitions += 1;
    }
    previous = value;
  }
  return transitions > 0 ? increase : null;
}

export function histogramP95For(
  observations: readonly HealthObservation[],
  select: (observation: HealthObservation) => Record<string, number>,
): number | null {
  const bounds = new Set<string>();
  for (const observation of observations) {
    for (const bound of Object.keys(select(observation))) {
      bounds.add(bound);
    }
  }
  const deltas = [...bounds].map((bound) => ({
    bound,
    value: counterIncrease(observations, (observation) => select(observation)[bound] ?? null),
  }));
  const total = deltas.find(({ bound }) => bound === "+Inf")?.value ?? null;
  if (total === null || total < 1) return null;
  const target = total * 0.95;
  for (const bucket of deltas
    .filter(({ bound }) => bound !== "+Inf")
    .sort((left, right) => Number(left.bound) - Number(right.bound))) {
    if (bucket.value !== null && bucket.value >= target) return Number(bucket.bound);
  }
  return null;
}

export function histogramP95(observations: readonly HealthObservation[]): number | null {
  return histogramP95For(
    observations,
    (observation) => observation.signerMetrics?.responseLatencyBuckets ?? {},
  );
}

export function lastTipAdvanceAt(observations: readonly HealthObservation[]): string | null {
  let previous: HealthObservation | null = null;
  let lastAdvance: string | null = null;
  for (const observation of observations) {
    if (
      previous?.nodeInfo &&
      observation.nodeInfo &&
      (observation.nodeInfo.stacks_tip_height !== previous.nodeInfo.stacks_tip_height ||
        observation.nodeInfo.burn_block_height !== previous.nodeInfo.burn_block_height)
    ) {
      lastAdvance = observation.observedAt;
    }
    previous = observation;
  }
  return lastAdvance;
}

export function lastHiroTipAdvanceAt(observations: readonly HealthObservation[]): string | null {
  let previous: HealthObservation | null = null;
  let lastAdvance: string | null = null;
  for (const observation of observations) {
    if (
      previous?.hiro &&
      observation.hiro &&
      (observation.hiro.chain_tip.block_height !== previous.hiro.chain_tip.block_height ||
        observation.hiro.chain_tip.burn_block_height !== previous.hiro.chain_tip.burn_block_height)
    ) {
      lastAdvance = observation.observedAt;
    }
    previous = observation;
  }
  return lastAdvance;
}

export function lastConfiguredApiTipAdvanceAt(
  observations: readonly HealthObservation[],
): string | null {
  let previous: HealthObservation | null = null;
  let lastAdvance: string | null = null;
  for (const observation of observations) {
    if (
      previous?.configuredApi &&
      observation.configuredApi &&
      (observation.configuredApi.chain_tip.block_height !==
        previous.configuredApi.chain_tip.block_height ||
        observation.configuredApi.chain_tip.burn_block_height !==
          previous.configuredApi.chain_tip.burn_block_height)
    ) {
      lastAdvance = observation.configuredApiSource?.checkedAt ?? observation.observedAt;
    }
    previous = observation;
  }
  return lastAdvance;
}

export function trimHealthObservations(
  observations: readonly HealthObservation[],
  observedAt: string,
  historyWindowMs: number,
): HealthObservation[] {
  const cutoff = Date.parse(observedAt) - historyWindowMs;
  return observations.filter((observation) => Date.parse(observation.observedAt) >= cutoff);
}
