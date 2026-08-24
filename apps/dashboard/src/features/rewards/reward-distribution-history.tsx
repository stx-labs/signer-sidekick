import type {
  RewardLedgerDistribution,
  RewardLedgerPayment,
} from "@stx-labs/signer-sidekick-api-contracts";
import type { ReactNode } from "react";
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
  state,
  toolbarRight,
}: {
  distribution: RewardLedgerDistribution;
  state: DistributionPaymentsState | undefined;
  toolbarRight?: ReactNode;
}) {
  return (
    <>
      <p className="rw-dist-summary">
        {distributionSummary(distribution)} <InfoTip text={distributionTooltip(distribution)} />
      </p>
      {!state || state.rows === null ? (
        <div className="tbl-wrap rw-pay-box rw-loading" role={state?.error ? "alert" : "status"}>
          {state?.error ? `Could not load payments: ${state.error}` : "Loading payments…"}
        </div>
      ) : (
        <div className="rw-pay-box-wrap">
          <PaymentsTable
            payments={state.rows}
            variant="history"
            emptyText="No payments recorded for this distribution."
            toolbarRight={toolbarRight}
          />
        </div>
      )}
    </>
  );
}
