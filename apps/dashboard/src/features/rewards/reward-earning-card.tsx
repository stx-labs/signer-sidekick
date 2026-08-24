import type { EarningModel } from "./reward-state.js";

const statusClass: Record<EarningModel["halves"][number]["status"]["tone"], string> = {
  done: "ok",
  live: "live",
  ready: "ready",
  idle: "muted",
  attention: "attention",
};

/**
 * Orientation for the accruing cycle (plan §6 v2): the cycle's identity and timing on the left,
 * three facts on the right, and the two halves beneath with each distribution's status.
 */
export function EarningCard({
  model,
  openDistribution,
  onViewDistribution,
}: {
  model: EarningModel;
  openDistribution: 1 | 2 | null;
  onViewDistribution: (distribution: 1 | 2) => void;
}) {
  const mobileWhen = model.when
    .replace(/^First half/, "First Distribution")
    .replace(/^Second half/, "Second Distribution");
  return (
    <section
      className="card-standout rw-now rw-earning domain-section-anchor"
      id="rewards-calculation"
      aria-labelledby="rw-earning-title"
    >
      <div className="rw-earning-grid">
        <div className="rw-cycle-id">
          <div className="rw-eyebrow">
            <span className="rw-earning-cycle-label">Current cycle</span>
            <span className={`badge b-${model.badge.tone}`}>
              {model.badge.live ? <span className="live-dot" /> : null}
              {model.badge.label}
            </span>
            {model.coverage === "historical-coverage-incomplete" ? (
              <span
                className="rw-coverage"
                title="Sidekick has not yet seen every payment for this cycle"
              >
                history incomplete
              </span>
            ) : null}
          </div>
          <h2 className="rw-cycle-number" id="rw-earning-title">
            Cycle {model.cycle}
          </h2>
          <p className="rw-cycle-when rw-earning-desktop-only">{model.when}</p>
          <p className="rw-cycle-when rw-earning-mobile-only">{mobileWhen}</p>
          {model.prepare ? <p className="rw-cycle-when muted">{model.prepare}</p> : null}
        </div>
        <dl className="rw-earning-facts">
          {model.facts.map((fact) => (
            <div key={fact.key} data-earning-fact={fact.key}>
              <dt>
                <span className="rw-earning-desktop-only">{fact.label}</span>
                <span className="rw-earning-mobile-only">{fact.mobileLabel}</span>
              </dt>
              <dd title={fact.tooltip ?? undefined}>
                <span className="rw-earning-desktop-only">
                  {fact.value}
                  {fact.unit ? <span className="u"> {fact.unit}</span> : null}
                  {fact.sub ? <small>{fact.sub}</small> : null}
                </span>
                <span className="rw-earning-mobile-only rw-earning-mobile-value">
                  {fact.mobileValue}
                  {fact.mobileSub ? <small>{fact.mobileSub}</small> : null}
                </span>
              </dd>
            </div>
          ))}
          {model.mobileFee ? (
            <div className="rw-earning-mobile-only" data-earning-fact="fee">
              <dt>Your projected fee</dt>
              <dd className="rw-earning-mobile-value">{model.mobileFee}</dd>
            </div>
          ) : null}
        </dl>
      </div>
      <div className="rw-timeline">
        {model.halves.map((half) => {
          const mobileLabel = half.index === 1 ? "First Distribution" : "Second Distribution";
          return (
            <div
              className={`rw-half${half.percent >= 100 ? " done" : ""}${half.status.tone === "live" ? " live" : ""}`}
              key={half.index}
            >
              <div className="k">
                <span>
                  <span className="rw-earning-desktop-only">{half.label}</span>
                  <span className="rw-earning-mobile-only">{mobileLabel}</span>
                </span>
                <span className={`st ${statusClass[half.status.tone]}`}>{half.status.text}</span>
              </div>
              <div
                className="bar"
                role="progressbar"
                aria-label={`${half.label} progress`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={half.percent}
              >
                <i style={{ width: `${half.percent}%` }} />
              </div>
              {half.note || half.detailsAvailable ? (
                <div className="rw-half-foot">
                  {half.note ? <div className="s">{half.note}</div> : null}
                  {half.detailsAvailable ? (
                    <button
                      className="btn btn-tertiary sm rw-half-view"
                      id={`rewards-view-distribution-${model.cycle}-${half.index}`}
                      type="button"
                      aria-expanded={openDistribution === half.index}
                      aria-controls={`rewards-current-distribution-${model.cycle}-${half.index}`}
                      onClick={() => onViewDistribution(half.index)}
                    >
                      View payments
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
