import { ArrowClockwise } from "@phosphor-icons/react";
import type { DashboardAlert } from "@stx-labs/signer-sidekick-api-contracts";

export function AlertActionButton({
  alert,
  sync,
  syncing,
}: {
  alert: DashboardAlert;
  sync: () => void;
  syncing: boolean;
}) {
  if (!alert.action) return null;
  if (alert.action.kind === "reconcile") {
    return (
      <button type="button" className="btn btn-tertiary sm" onClick={sync} disabled={syncing}>
        <ArrowClockwise /> {syncing ? "Reconciling" : alert.action.label}
      </button>
    );
  }
  return (
    <button
      type="button"
      className="btn btn-tertiary sm"
      onClick={() => {
        location.hash = alert.action?.kind === "navigate" ? alert.action.target : "overview";
      }}
    >
      {alert.action.label}
    </button>
  );
}
