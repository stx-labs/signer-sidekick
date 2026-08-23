import { DownloadSimple } from "@phosphor-icons/react";
import type {
  RewardLedgerDistribution,
  RewardLedgerPayment,
} from "@stx-labs/signer-sidekick-api-contracts";
import { useEffect, useState } from "react";
import { operatorErrorSentence } from "../../shared/operator-error.js";
import {
  DistributionHistoryDetails,
  type DistributionPaymentsState,
} from "./reward-distribution-history.js";
import type { PastCyclesExportQuery } from "./reward-past-cycles.js";
import { distributionName } from "./reward-state.js";

/** Current-cycle evidence opened from a completed half in the Earning card. */
export function CurrentDistributionDetails({
  cycle,
  distribution,
  refreshKey,
  loadPayments,
  onExport,
  exportBusy,
  onClose,
}: {
  cycle: number;
  distribution: RewardLedgerDistribution;
  refreshKey: string;
  loadPayments: (cycle: number, distribution: 1 | 2) => Promise<RewardLedgerPayment[]>;
  onExport: (query: PastCyclesExportQuery) => void;
  exportBusy: boolean;
  onClose: () => void;
}) {
  const [state, setState] = useState<DistributionPaymentsState>({ rows: null, error: null });

  useEffect(() => {
    void refreshKey;
    let current = true;
    setState({ rows: null, error: null });
    loadPayments(cycle, distribution.distribution)
      .then((rows) => {
        if (current) setState({ rows, error: null });
      })
      .catch((cause: unknown) => {
        if (current) setState({ rows: null, error: operatorErrorSentence(cause) });
      });
    return () => {
      current = false;
    };
  }, [cycle, distribution.distribution, loadPayments, refreshKey]);

  const title = `${distributionName(distribution.distribution)} details`;
  return (
    <section
      className="card rw-current-distribution"
      id={`rewards-current-distribution-${cycle}-${distribution.distribution}`}
      aria-labelledby="rw-current-distribution-title"
    >
      <div className="rw-current-distribution-head">
        <div>
          <div className="rw-eyebrow">Cycle {cycle} · completed this cycle</div>
          <h2 id="rw-current-distribution-title">{title}</h2>
        </div>
        <button className="btn btn-tertiary sm" type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <DistributionHistoryDetails
        distribution={distribution}
        state={state}
        toolbarRight={
          <div className="rw-export-inline">
            <span className="muted">Export</span>
            <button
              className="btn btn-tertiary sm"
              type="button"
              disabled={exportBusy}
              onClick={() => onExport({ cycle, distribution: distribution.distribution })}
            >
              <DownloadSimple className="rw-ico" aria-hidden="true" />
              This distribution
            </button>
            <button
              className="btn btn-tertiary sm"
              type="button"
              disabled={exportBusy}
              onClick={() => onExport({ cycle })}
            >
              <DownloadSimple className="rw-ico" aria-hidden="true" />
              Cycle {cycle}
            </button>
          </div>
        }
      />
    </section>
  );
}
