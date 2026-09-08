import type {
  RewardLedgerDistribution,
  RewardLedgerPayment,
} from "@stx-labs/signer-sidekick-api-contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { operatorErrorSentence } from "../../shared/operator-error.js";
import { startVisibleRefresh } from "../../shared/visible-refresh.js";
import { PaymentsTable } from "./reward-payments.js";
import { distributionTooltip } from "./reward-state.js";
import { InfoTip } from "./reward-ui.js";

export type DistributionPaymentsState = {
  rows: RewardLedgerPayment[] | null;
  error: string | null;
};

function distributionSummary(distribution: RewardLedgerDistribution): string {
  const parts: string[] = [];
  if (distribution.calculation.state === "done") {
    parts.push("Calculation confirmed");
    if (distribution.status === "interpretation-unavailable") parts.push(distribution.statusDetail);
  } else {
    parts.push(distribution.statusDetail);
  }
  const collect = distribution.collects.at(-1);
  if (collect) parts.push("rewards collected");
  if (distribution.payments.rolledForward > 0) {
    parts.push(
      `${distribution.payments.rolledForward} rolled forward, paid with the Second Distribution`,
    );
  }
  if (distribution.payments.arriving > 0) {
    parts.push(`${distribution.payments.arriving} arriving over Bitcoin`);
  }
  return parts.join(" · ");
}

/** Payment evidence shared by current-cycle and historical distribution drill-downs. */
export function DistributionHistoryDetails({
  distribution,
  loadPayments,
  toolbarRight,
}: {
  distribution: RewardLedgerDistribution;
  loadPayments: (
    cycle: number,
    distribution: 1 | 2,
    signal?: AbortSignal,
  ) => Promise<RewardLedgerPayment[]>;
  toolbarRight?: ReactNode;
}) {
  const [state, setState] = useState<DistributionPaymentsState>({ rows: null, error: null });
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const refreshRef = useRef<ReturnType<typeof startVisibleRefresh> | null>(null);
  const evidenceKey = JSON.stringify(distribution);
  const previousEvidence = useRef(evidenceKey);
  useEffect(() => {
    const refresh = startVisibleRefresh(
      async (signal) => {
        const rows = await loadPayments(distribution.cycle, distribution.distribution, signal);
        if (signal.aborted) return;
        setState({ rows, error: null });
        setLoadedAt(new Date().toLocaleString());
      },
      (cause) => setState((current) => ({ ...current, error: operatorErrorSentence(cause) })),
    );
    refreshRef.current = refresh;
    return () => {
      refresh.stop();
      refreshRef.current = null;
    };
  }, [distribution.cycle, distribution.distribution, loadPayments]);
  useEffect(() => {
    if (previousEvidence.current === evidenceKey) return;
    previousEvidence.current = evidenceKey;
    void refreshRef.current?.refresh(true);
  }, [evidenceKey]);
  return (
    <>
      <p className="rw-dist-summary">
        {distributionSummary(distribution)} <InfoTip text={distributionTooltip(distribution)} />
      </p>
      {state.error ? (
        <div className="content-notice" role="alert">
          Could not refresh payments: {state.error}
          {loadedAt ? ` · showing payments loaded ${loadedAt}` : ""}{" "}
          <button
            type="button"
            className="btn btn-secondary sm"
            onClick={() => void refreshRef.current?.refresh(true)}
          >
            Retry payments
          </button>
        </div>
      ) : null}
      {state.rows === null ? (
        <div className="tbl-wrap rw-pay-box rw-loading" role={state?.error ? "alert" : "status"}>
          {state.error
            ? "Payment history is unavailable; retry or reopen this distribution."
            : "Loading payments…"}
        </div>
      ) : (
        <div className="rw-pay-box-wrap">
          <PaymentsTable
            payments={state.rows}
            variant="history"
            emptyText={
              distribution.status === "interpretation-unavailable"
                ? "Payment details are unavailable or still being recovered. This does not mean no payments were made."
                : "No payments recorded for this distribution."
            }
            toolbarRight={toolbarRight}
          />
        </div>
      )}
    </>
  );
}
