import { stx } from "../../shared/format.js";
import { formatSignedPercent, type PoolForecastView } from "./pool-forecast-view.js";

const CHART_SIZE = 1_000;
const PLOT_TOP = 80;
const PLOT_HEIGHT = 840;

function signedStx(value: bigint): string {
  if (value === 0n) return "0 STX";
  const sign = value > 0n ? "+" : "−";
  return `${sign}${stx((value < 0n ? -value : value).toString())} STX`;
}

function compactStx(value: bigint): string {
  const wholeStx = Number(value) / 1_000_000;
  if (Math.abs(wholeStx) >= 1_000_000) {
    return `${(wholeStx / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 })}M STX`;
  }
  if (Math.abs(wholeStx) >= 1_000) {
    return `${(wholeStx / 1_000).toLocaleString("en-US", { maximumFractionDigits: 1 })}K STX`;
  }
  return `${wholeStx.toLocaleString("en-US", { maximumFractionDigits: 0 })} STX`;
}

function uniqueTicks(values: bigint[]): bigint[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

export function PoolForecastChart({ view }: { view: PoolForecastView }) {
  if (view.points.length === 0) {
    return <div className="empty-table">No pool forecast is available yet.</div>;
  }

  const totals = view.points.map(({ totalUstx }) => totalUstx);
  const minimum = totals.reduce((value, total) => (total < value ? total : value));
  const maximum = totals.reduce((value, total) => (total > value ? total : value));
  const span = maximum - minimum;
  const x = (index: number) =>
    view.points.length === 1 ? CHART_SIZE / 2 : (index / (view.points.length - 1)) * CHART_SIZE;
  const y = (total: bigint) => {
    if (span === 0n) return CHART_SIZE / 2;
    const relative = Number(((maximum - total) * 100_000n) / span) / 100_000;
    return PLOT_TOP + relative * PLOT_HEIGHT;
  };
  const path = view.points.reduce(
    (value, point, index) =>
      index === 0
        ? `M ${x(index)} ${y(point.totalUstx)}`
        : `${value} H ${x(index)} V ${y(point.totalUstx)}`,
    "",
  );
  const ticks = span === 0n ? [maximum] : uniqueTicks([maximum, minimum + span / 2n, minimum]);
  const nextChangeIndex = view.nextChange
    ? view.points.findIndex(({ cycle }) => cycle.cycleId === view.nextChange?.cycleId)
    : -1;
  const nextChangeAnchor =
    nextChangeIndex <= 1 ? "start" : nextChangeIndex >= view.points.length - 2 ? "end" : "middle";
  const endingPoint = view.points.at(-1) ?? null;
  const endingDelta =
    view.currentTotalUstx === null || endingPoint === null
      ? null
      : endingPoint.totalUstx - view.currentTotalUstx;
  const endingDirection =
    endingDelta === null || endingDelta === 0n
      ? undefined
      : endingDelta < 0n
        ? "negative"
        : "positive";
  const summary = view.nextChange
    ? `The pool starts at ${stx(view.currentTotalUstx?.toString())} STX and next changes by ${signedStx(view.nextChange.deltaUstx)} in cycle ${view.nextChange.cycleId}.`
    : `The pool remains at ${stx(view.currentTotalUstx?.toString())} STX throughout the displayed cycles.`;

  return (
    <>
      <section className="forecast-summary" aria-label="Pool forecast summary">
        <div>
          <span>Current total</span>
          <strong>{stx(view.currentTotalUstx?.toString())} STX</strong>
          <small>confirmed</small>
        </div>
        <div>
          <span>Next change</span>
          <strong>{view.nextChange ? `Cycle ${view.nextChange.cycleId}` : "None shown"}</strong>
          <small
            className={
              view.nextChange && view.nextChange.deltaUstx !== 0n
                ? view.nextChange.deltaUstx < 0n
                  ? "negative"
                  : "positive"
                : undefined
            }
          >
            {view.nextChange ? signedStx(view.nextChange.deltaUstx) : "No projected change"}
          </small>
        </div>
        <div>
          <span>
            {view.endingCycleId === null ? "End of forecast" : `By cycle ${view.endingCycleId}`}
          </span>
          <strong>{stx(endingPoint?.totalUstx.toString())} STX</strong>
          <small className={endingDirection}>
            {endingDelta === null
              ? "—"
              : `${signedStx(endingDelta)} · ${formatSignedPercent(view.endingRelativePercent)}`}
          </small>
        </div>
      </section>
      <div
        className="forecast-chart-shell"
        role="img"
        aria-labelledby="pool-forecast-chart-title pool-forecast-chart-description"
      >
        <span id="pool-forecast-chart-title" className="sr-only">
          Pool total forecast
        </span>
        <span id="pool-forecast-chart-description" className="sr-only">
          {summary}
        </span>
        <div className="forecast-plot">
          <svg
            className="forecast-chart-lines"
            viewBox={`0 0 ${CHART_SIZE} ${CHART_SIZE}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {ticks.map((tick) => (
              <line
                key={tick.toString()}
                className={
                  tick === view.currentTotalUstx ? "forecast-reference-line" : "forecast-grid-line"
                }
                x1="0"
                x2={CHART_SIZE}
                y1={y(tick)}
                y2={y(tick)}
              />
            ))}
            <path className="forecast-step-line" d={path} />
          </svg>
          {ticks.map((tick) => (
            <span
              className="forecast-axis-label"
              key={tick.toString()}
              style={{ top: `${(y(tick) / CHART_SIZE) * 100}%` }}
            >
              {compactStx(tick)}
            </span>
          ))}
          {view.points.map((point, index) => {
            const sourceLabel =
              point.cycle.provenance.classification === "authoritative" ? "confirmed" : "projected";
            const pointClass = !point.cycle.threshold.meetsThreshold
              ? "under"
              : index === 0
                ? "current"
                : "projected";
            return (
              <span key={point.cycle.cycleId}>
                <span
                  className={`forecast-point ${pointClass}`}
                  style={{
                    left: `${(x(index) / CHART_SIZE) * 100}%`,
                    top: `${(y(point.totalUstx) / CHART_SIZE) * 100}%`,
                  }}
                  title={`Cycle ${point.cycle.cycleId}: ${stx(point.totalUstx.toString())} STX, ${formatSignedPercent(point.relativePercent)} from current, ${sourceLabel}${point.cycle.threshold.meetsThreshold ? "" : ", below threshold"}`}
                />
                <span
                  className={`forecast-cycle-label${index === 0 ? " first" : ""}${index === view.points.length - 1 ? " last" : ""}`}
                  style={{ left: `${(x(index) / CHART_SIZE) * 100}%` }}
                >
                  {point.cycle.cycleId}
                </span>
              </span>
            );
          })}
          {view.nextChange && nextChangeIndex >= 0 ? (
            <span
              className={`forecast-change-badge ${nextChangeAnchor} ${view.nextChange.deltaUstx < 0n ? "negative" : "positive"}`}
              style={{
                left: `${(x(nextChangeIndex) / CHART_SIZE) * 100}%`,
                top: `${(y(view.points[nextChangeIndex]?.totalUstx ?? 0n) / CHART_SIZE) * 100}%`,
              }}
            >
              {signedStx(view.nextChange.deltaUstx)}
            </span>
          ) : null}
        </div>
      </div>
      <div className="forecast-legend" aria-hidden="true">
        <span className="confirmed">current</span>
        <span className="projected">projected</span>
      </div>
    </>
  );
}
