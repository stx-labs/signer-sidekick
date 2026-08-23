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
export function EarningCard({ model }: { model: EarningModel }) {
  return (
    <section
      className="card-standout rw-now rw-earning domain-section-anchor"
      id="rewards-calculation"
      aria-labelledby="rw-earning-title"
    >
      <div className="rw-earning-grid">
        <div className="rw-cycle-id">
          <div className="rw-eyebrow">
            Current cycle
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
          <p className="rw-cycle-when">{model.when}</p>
          {model.prepare ? <p className="rw-cycle-when muted">{model.prepare}</p> : null}
        </div>
        <dl className="rw-earning-facts">
          {model.facts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd title={fact.tooltip ?? undefined}>
                {fact.value}
                {fact.unit ? <span className="u"> {fact.unit}</span> : null}
                {fact.sub ? <small>{fact.sub}</small> : null}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="rw-timeline">
        {model.halves.map((half) => (
          <div
            className={`rw-half${half.percent >= 100 ? " done" : ""}${half.status.tone === "live" ? " live" : ""}`}
            key={half.index}
          >
            <div className="k">
              <span>{half.label}</span>
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
            {half.note ? <div className="s">{half.note}</div> : null}
          </div>
        ))}
      </div>
    </section>
  );
}
