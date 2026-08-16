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
  const latestBuckets = [...observations]
    .reverse()
    .map(select)
    .find((buckets) => buckets["+Inf"] !== undefined);
  if (!latestBuckets) return null;

  const bounds = Object.keys(latestBuckets)
    .filter((bound) => bound !== "+Inf")
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (bounds.length === 0 || new Set(bounds).size !== bounds.length) return null;

  interface HistogramSnapshot {
    counts: number[];
    total: number;
  }
  const readSnapshot = (buckets: Record<string, number>): HistogramSnapshot | null => {
    const finiteEntries = Object.entries(buckets)
      .filter(([bound]) => bound !== "+Inf")
      .map(([bound, value]) => ({ upper: Number(bound), value }))
      .filter(({ upper }) => Number.isFinite(upper))
      .sort((left, right) => left.upper - right.upper);
    if (
      finiteEntries.length !== bounds.length ||
      finiteEntries.some(({ upper }, index) => upper !== bounds[index])
    ) {
      return null;
    }
    const total = buckets["+Inf"];
    if (total === undefined || !Number.isFinite(total) || total < 0) return null;
    const counts = finiteEntries.map(({ value }) => value);
    if (
      counts.some((count) => !Number.isFinite(count) || count < 0) ||
      counts.some((count, index) => index > 0 && count < (counts[index - 1] ?? 0)) ||
      (counts.at(-1) ?? 0) > total
    ) {
      return null;
    }
    return { counts, total };
  };

  // Accumulate each cumulative bucket's windowed increase in lockstep, using the "+Inf" total as
  // the joint reset signal: when it drops the whole histogram restarted, so we re-baseline every
  // bucket together and skip that interval. A partial or non-monotonic scrape also breaks the
  // interval rather than letting different buckets accumulate over different sample pairs.
  const increase = bounds.map(() => 0);
  let totalIncrease = 0;
  let previous: HistogramSnapshot | null = null;
  for (const observation of observations) {
    const current = readSnapshot(select(observation));
    if (!current) {
      previous = null;
      continue;
    }
    if (previous !== null && current.total >= previous.total) {
      const deltas = current.counts.map((count, index) => count - (previous?.counts[index] ?? 0));
      const totalDelta = current.total - previous.total;
      const validInterval =
        deltas.every((delta) => delta >= 0) &&
        deltas.every((delta, index) => index === 0 || delta >= (deltas[index - 1] ?? 0)) &&
        (deltas.at(-1) ?? 0) <= totalDelta;
      if (!validInterval) {
        previous = null;
        continue;
      }
      for (const [index, delta] of deltas.entries()) {
        increase[index] = (increase[index] ?? 0) + delta;
      }
      totalIncrease += totalDelta;
    }
    previous = current;
  }

  if (totalIncrease < 1) return null;
  const target = totalIncrease * 0.95;

  // Linearly interpolate within the crossing bucket (Prometheus histogram_quantile), so a p95 that
  // falls partway through the [lower, upper] bucket is not rounded up to the bucket boundary.
  let lowerBound = 0;
  let lowerCount = 0;
  for (const [index, upperBound] of bounds.entries()) {
    const count = increase[index] ?? 0;
    if (count >= target) {
      const span = count - lowerCount;
      if (span <= 0) return upperBound;
      return lowerBound + (upperBound - lowerBound) * ((target - lowerCount) / span);
    }
    lowerBound = upperBound;
    lowerCount = count;
  }
  // The 95th percentile sits above the largest finite bucket; report it as a conservative floor.
  return bounds.at(-1) ?? null;
}

export function histogramP95(observations: readonly HealthObservation[]): number | null {
  return histogramP95For(
    observations,
    (observation) => observation.signerMetrics?.responseLatencyBuckets ?? {},
  );
}

interface TipPosition {
  stacks: number;
  burn: number;
}

function lastAdvanceAt(
  observations: readonly HealthObservation[],
  position: (observation: HealthObservation) => TipPosition | null,
  occurredAt: (observation: HealthObservation) => string = (observation) => observation.observedAt,
): string | null {
  let previous: TipPosition | null = null;
  let lastAdvance: string | null = null;
  for (const observation of observations) {
    const current = position(observation);
    if (
      previous &&
      current &&
      (current.stacks !== previous.stacks || current.burn !== previous.burn)
    ) {
      lastAdvance = occurredAt(observation);
    }
    previous = current;
  }
  return lastAdvance;
}

export function lastTipAdvanceAt(observations: readonly HealthObservation[]): string | null {
  return lastAdvanceAt(observations, (observation) =>
    observation.nodeInfo
      ? {
          stacks: observation.nodeInfo.stacks_tip_height,
          burn: observation.nodeInfo.burn_block_height,
        }
      : null,
  );
}

export function lastHiroTipAdvanceAt(observations: readonly HealthObservation[]): string | null {
  return lastAdvanceAt(observations, (observation) =>
    observation.hiro
      ? {
          stacks: observation.hiro.chain_tip.block_height,
          burn: observation.hiro.chain_tip.burn_block_height,
        }
      : null,
  );
}

export function lastConfiguredApiTipAdvanceAt(
  observations: readonly HealthObservation[],
): string | null {
  return lastAdvanceAt(
    observations,
    (observation) =>
      observation.configuredApi
        ? {
            stacks: observation.configuredApi.chain_tip.block_height,
            burn: observation.configuredApi.chain_tip.burn_block_height,
          }
        : null,
    (observation) => observation.configuredApiSource?.checkedAt ?? observation.observedAt,
  );
}

export function trimHealthObservations(
  observations: readonly HealthObservation[],
  observedAt: string,
  historyWindowMs: number,
): HealthObservation[] {
  const cutoff = Date.parse(observedAt) - historyWindowMs;
  return observations.filter((observation) => Date.parse(observation.observedAt) >= cutoff);
}
