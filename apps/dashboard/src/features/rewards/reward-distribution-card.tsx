import { ArrowRight, Warning } from "@phosphor-icons/react";
import type { RewardLedgerPayment } from "@stx-labs/signer-sidekick-api-contracts";
import { PaymentsTable } from "./reward-payments.js";
import type { DistributionCardModel, RewardPrimaryAction } from "./reward-state.js";
import { GasChip, InfoTip } from "./reward-ui.js";

/**
 * One distribution that still needs the operator: status, the single next action, the four
 * figures, an in-flight run's progress, and the distribution's payments (ten per page).
 */
export function DistributionCard({
  model,
  payments,
  paymentsError = null,
  onAction,
  onRunControl,
  runControlBusy = null,
  busy = false,
}: {
  model: DistributionCardModel;
  /** Null while the distribution's payments are still loading. */
  payments: readonly RewardLedgerPayment[] | null;
  paymentsError?: string | null;
  onAction: (action: RewardPrimaryAction) => void;
  onRunControl?: ((runId: string, control: "pause" | "resume" | "cancel") => void) | undefined;
  runControlBusy?: "pause" | "resume" | "cancel" | null;
  busy?: boolean;
}) {
  const { execution } = model;
  const actionDisabled = busy || !execution.available || model.queued !== null;
  const disabledReason = model.queued ?? (execution.available ? null : execution.reason);
  return (
    <section
      className="card-standout rw-now rw-pending"
      id={`rewards-distribution-${model.cycle}-${model.distribution}`}
      aria-labelledby={`rw-pending-${model.cycle}-${model.distribution}`}
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
          <h2 className="rw-status" id={`rw-pending-${model.cycle}-${model.distribution}`}>
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
                disabled={actionDisabled}
                title={disabledReason ?? undefined}
                onClick={() => {
                  if (model.primary) onAction(model.primary);
                }}
              >
                {model.primary.label}
                <ArrowRight className="rw-ico" aria-hidden="true" />
              </button>
              {disabledReason ? <span className="rw-disabled-reason">{disabledReason}</span> : null}
            </>
          ) : null}
          {model.secondary && !model.primary && !model.progress ? (
            <button
              className="btn btn-secondary"
              type="button"
              disabled={actionDisabled}
              title={model.secondary.tooltip ?? disabledReason ?? undefined}
              onClick={() => {
                if (model.secondary) onAction(model.secondary.action);
              }}
            >
              {model.secondary.action.label}
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
      {model.tiles.length > 0 ? (
        <div className="kpi rw-tiles">
          {model.tiles.map((tile) => (
            <div className="tile" key={tile.label}>
              <div className="l">
                {tile.label} <InfoTip text={tile.tooltip} />
              </div>
              <div className="v">
                {tile.value}
                {tile.unit ? <span className="u"> {tile.unit}</span> : null}
              </div>
              {tile.detail ? <div className="d">{tile.detail}</div> : null}
            </div>
          ))}
        </div>
      ) : null}
      {model.calculated ? (
        <div className="rw-pending-payments">
          {payments === null ? (
            <div className="tbl-wrap rw-loading" role="status">
              {paymentsError ? `Could not load payments: ${paymentsError}` : "Loading payments…"}
            </div>
          ) : (
            <PaymentsTable
              payments={payments}
              variant="pending"
              emptyText="No payments recorded for this distribution."
            />
          )}
        </div>
      ) : null}
    </section>
  );
}
