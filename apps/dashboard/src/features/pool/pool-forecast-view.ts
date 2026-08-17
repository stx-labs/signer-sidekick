import type { ForecastCycle } from "@stx-labs/signer-sidekick-api-contracts";

const PERCENT_PRECISION = 100_000n;

export interface PoolForecastPoint {
  cycle: ForecastCycle;
  totalUstx: bigint;
  relativePercent: number | null;
}

export interface PoolForecastChange {
  cycleId: number;
  deltaUstx: bigint;
  relativePercent: number | null;
}

export interface PoolForecastView {
  points: PoolForecastPoint[];
  currentTotalUstx: bigint | null;
  endingCycleId: number | null;
  endingRelativePercent: number | null;
  nextChange: PoolForecastChange | null;
  relativeScaleAvailable: boolean;
}

function percentFromCurrent(total: bigint, current: bigint): number | null {
  if (current === 0n) return total === 0n ? 0 : null;
  return Number(((total - current) * PERCENT_PRECISION) / current) / 1_000;
}

export function buildPoolForecastView(cycles: ForecastCycle[]): PoolForecastView {
  const currentTotalUstx = cycles[0] ? BigInt(cycles[0].contract.pendingStxUstx) : null;
  const points = cycles.map((cycle) => {
    const totalUstx = BigInt(cycle.contract.pendingStxUstx);
    return {
      cycle,
      totalUstx,
      relativePercent:
        currentTotalUstx === null ? null : percentFromCurrent(totalUstx, currentTotalUstx),
    };
  });
  const nextChangeIndex = points.findIndex(
    (point, index) => index > 0 && point.totalUstx !== points[index - 1]?.totalUstx,
  );
  const nextChangePoint = nextChangeIndex >= 0 ? points[nextChangeIndex] : null;
  const previousPoint = nextChangeIndex > 0 ? points[nextChangeIndex - 1] : null;
  const endingPoint = points.at(-1) ?? null;

  return {
    points,
    currentTotalUstx,
    endingCycleId: endingPoint?.cycle.cycleId ?? null,
    endingRelativePercent: endingPoint?.relativePercent ?? null,
    nextChange:
      nextChangePoint && previousPoint
        ? {
            cycleId: nextChangePoint.cycle.cycleId,
            deltaUstx: nextChangePoint.totalUstx - previousPoint.totalUstx,
            relativePercent: nextChangePoint.relativePercent,
          }
        : null,
    relativeScaleAvailable: points.every(({ relativePercent }) => relativePercent !== null),
  };
}

export function formatSignedPercent(value: number | null): string {
  if (value === null) return "—";
  if (Math.abs(value) < 0.05) return "0%";
  const sign = value > 0 ? "+" : "−";
  return `${sign}${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
}
