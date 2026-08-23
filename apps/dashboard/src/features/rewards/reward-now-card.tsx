import { ArrowRight, Warning } from "@phosphor-icons/react";
import type { RewardNowModel } from "./reward-state.js";
import { GasChip, InfoTip } from "./reward-ui.js";

export function RewardNowCard({
  model,
  onPrimary,
  onSecondary,
  onViewCycle,
  onRunControl,
  runControlBusy = null,
  busy = false,
}: {
  model: RewardNowModel;
  onPrimary: (action: NonNullable<RewardNowModel["primary"]>) => void;
  onSecondary: (action: NonNullable<RewardNowModel["secondary"]>) => void;
  onViewCycle: (cycle: number) => void;
  onRunControl?: ((runId: string, control: "pause" | "resume" | "cancel") => void) | undefined;
  runControlBusy?: "pause" | "resume" | "cancel" | null;
  busy?: boolean;
}) {
  const { execution } = model;
  const primaryDisabled = busy || !execution.available;
  return (
    <section
      className="card-standout rw-now domain-section-anchor"
      id="rewards-calculation"
      aria-labelledby="rw-now-title"
    >
      <div className="rw-now-head">
        <div>
          <div className="rw-eyebrow">
            {model.eyebrow}
            <span className={`badge b-${model.badge.tone}`}>
              {model.badge.live ? <span className="live-dot" /> : null}
              {model.badge.label}
            </span>
            {model.coverage === "historical-coverage-incomplete" ? (
              <span
                className="rw-coverage"
                title="Sidekick has not yet seen every payment for this distribution"
              >
                history incomplete
              </span>
            ) : null}
          </div>
          <h2 className="rw-status" id="rw-now-title">
            {model.headline}
          </h2>
          <p className="rw-status-sub">
            {model.sub} <InfoTip text={model.subTooltip} />
          </p>
        </div>
        <div className="rw-now-actions">
          {model.progress && onRunControl ? (
            <>
              {model.progress.canResume ? (
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={runControlBusy !== null}
                  onClick={() => {
                    if (model.progress) onRunControl(model.progress.runId, "resume");
                  }}
                >
                  {runControlBusy === "resume" ? "Resuming…" : "Resume"}
                </button>
              ) : null}
              {model.progress.canPause ? (
                <button
                  className="btn btn-tertiary"
                  type="button"
                  disabled={runControlBusy !== null}
                  onClick={() => {
                    if (model.progress) onRunControl(model.progress.runId, "pause");
                  }}
                >
                  {runControlBusy === "pause" ? "Pausing…" : "Pause after this transaction"}
                </button>
              ) : null}
              {model.progress.canCancel ? (
                <button
                  className="btn btn-tertiary"
                  type="button"
                  disabled={runControlBusy !== null}
                  onClick={() => {
                    if (model.progress) onRunControl(model.progress.runId, "cancel");
                  }}
                >
                  {runControlBusy === "cancel" ? "Cancelling…" : "Cancel run"}
                </button>
              ) : null}
            </>
          ) : null}
          {model.primary && !model.progress ? (
            <>
              <button
                className="btn btn-primary lg"
                type="button"
                disabled={primaryDisabled}
                title={execution.available ? undefined : (execution.reason ?? undefined)}
                onClick={() => {
                  if (model.primary) onPrimary(model.primary);
                }}
              >
                {model.primary.label}
                <ArrowRight className="rw-ico" aria-hidden="true" />
              </button>
              {!execution.available && execution.reason ? (
                <span className="rw-disabled-reason">{execution.reason}</span>
              ) : null}
            </>
          ) : null}
          {model.secondary && !model.primary ? (
            <button
              className="btn btn-secondary"
              type="button"
              disabled={busy || !execution.available}
              title={
                model.secondary.tooltip ??
                (execution.available ? undefined : (execution.reason ?? undefined))
              }
              onClick={() => {
                if (model.secondary) onSecondary(model.secondary);
              }}
            >
              {model.secondary.label}
            </button>
          ) : null}
          <GasChip execution={execution} />
        </div>
      </div>
      {model.attention ? (
        <div className="callout callout-critical" style={{ marginTop: 16 }} role="status">
          <Warning className="ic" aria-hidden="true" />
          <div className="body">
            <strong>{model.attention.title}.</strong> {model.attention.text}
          </div>
        </div>
      ) : null}
      {model.progress ? (
        <div className="rw-progress" aria-live="polite">
          <div className="meter">
            <div className="track">
              <div
                className="fill"
                style={{
                  width: `${Math.min(100, Math.round((model.progress.done / model.progress.total) * 100))}%`,
                }}
              />
            </div>
          </div>
          <div className="scale">
            <span>{model.progress.text}</span>
            <span>{model.progress.right}</span>
          </div>
        </div>
      ) : null}
      <div className="kpi rw-tiles">
        {model.tiles.map((tile) => (
          <div className={`tile${tile.hero ? " hero" : ""}`} key={tile.label}>
            <div className="l">
              {tile.label} <InfoTip text={tile.tooltip} />
            </div>
            <div className="v">
              {tile.value}
              {tile.unit ? <span className="u"> {tile.unit}</span> : null}
            </div>
            <div className="d">{tile.detail}</div>
          </div>
        ))}
      </div>
      {model.cycleLine ? (
        <p className="rw-cycle-line">
          <span>Cycle {model.cycleLine.cycle}</span>
          <strong className="mono">{model.cycleLine.amount}</strong>
          <span>{model.cycleLine.text}</span>
        </p>
      ) : null}
      {model.next ? (
        <p className="rw-cycle-line rw-next">
          <span>{model.next.text}</span>
        </p>
      ) : null}
      {model.previous ? (
        <div className="rw-prev">
          <span>{model.previous.text}</span>
          {model.previous.kind === "cycle-complete" ? (
            <button
              className="btn btn-tertiary sm"
              type="button"
              onClick={() => {
                if (model.previous?.kind === "cycle-complete") onViewCycle(model.previous.cycle);
              }}
            >
              View cycle {model.previous.cycle}
            </button>
          ) : model.secondary ? (
            <button
              className="btn btn-secondary sm"
              type="button"
              disabled={busy || !execution.available}
              title={execution.available ? undefined : (execution.reason ?? undefined)}
              onClick={() => {
                if (model.secondary) onSecondary(model.secondary);
              }}
            >
              {model.secondary.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
