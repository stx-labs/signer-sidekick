import type {
  RewardLedgerDistribution,
  RewardLedgerPayment,
} from "@stx-labs/signer-sidekick-api-contracts";
import { DistributionHistoryDetails } from "./reward-distribution-history.js";
import { DistributionExportControls } from "./reward-export-controls.js";
import type { PastCyclesExportQuery } from "./reward-past-cycles.js";
import { distributionName } from "./reward-state.js";

/** Current-cycle evidence opened from a completed half in the Earning card. */
export function CurrentDistributionDetails({
  cycle,
  distribution,
  loadPayments,
  onExport,
  exportBusy,
  onClose,
}: {
  cycle: number;
  distribution: RewardLedgerDistribution;
  loadPayments: (
    cycle: number,
    distribution: 1 | 2,
    signal?: AbortSignal,
  ) => Promise<RewardLedgerPayment[]>;
  onExport: (query: PastCyclesExportQuery) => void;
  exportBusy: boolean;
  onClose: () => void;
}) {
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
        key={`${cycle}:${distribution.distribution}`}
        distribution={distribution}
        loadPayments={loadPayments}
        toolbarRight={
          <DistributionExportControls
            cycle={cycle}
            distribution={distribution.distribution}
            busy={exportBusy}
            onExport={onExport}
          />
        }
      />
    </section>
  );
}
