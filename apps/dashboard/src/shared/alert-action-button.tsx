import { ArrowClockwise } from "@phosphor-icons/react";
import type { DashboardAlert } from "@stx-labs/signer-sidekick-api-contracts";
import { actionHash, activityHash, dashboardHash, settingsHash } from "../dashboard-route.js";

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
        <ArrowClockwise /> {syncing ? "Syncing" : alert.action.label}
      </button>
    );
  }
  const action = alert.action;
  return (
    <button
      type="button"
      className="btn btn-tertiary sm"
      onClick={() => {
        if ("managerAction" in action) {
          location.hash = actionHash(action.managerAction);
          return;
        }
        location.hash =
          action.target === "settings"
            ? settingsHash(action.settingsSection ?? null)
            : action.target === "activity"
              ? activityHash()
              : dashboardHash(action.target);
      }}
    >
      {action.label}
    </button>
  );
}
