import type { DashboardSnapshot } from "@stx-labs/signer-sidekick-api-contracts";

type ManagerActionContext = Pick<DashboardSnapshot, "freshness" | "manager" | "preflight">;

export function managerActionAvailability(
  data: ManagerActionContext,
  operatorStateStale = false,
): {
  available: boolean;
  reason: string;
  warning: string | null;
} {
  if (operatorStateStale || data.freshness?.status === "stale") {
    return {
      available: false,
      reason:
        "Manager actions are paused because the displayed data is stale. Refresh to continue.",
      warning: null,
    };
  }
  const networkChecks = new Map(data.preflight.checks.map((check) => [check.id, check]));
  const failedNetworkCheck = ["node-network", "node-sync"].find((id) => {
    const check = networkChecks.get(id);
    return check ? check.status !== "pass" : false;
  });
  if (failedNetworkCheck) {
    return {
      available: false,
      reason:
        networkChecks.get(failedNetworkCheck)?.message ??
        "Sidekick could not verify the local node's network and synchronization state.",
      warning: null,
    };
  }
  if (!data.manager.attachAllowed) {
    return {
      available: false,
      reason:
        data.manager.reasons[0] ??
        "The manager network or required interface is incompatible with this deployment.",
      warning: null,
    };
  }
  const referenceVerified =
    (data.manager.source.tier === "reference-built-in" &&
      data.manager.provenance.status === "built-in") ||
    (data.manager.source.tier === "reference-render" &&
      data.manager.provenance.status === "verified");
  return {
    available: true,
    reason: "Manager actions are available.",
    warning: referenceVerified
      ? null
      : "Manager transactions can still be prepared for wallet or manual signing. Assist is unavailable. Review each transaction carefully before signing.",
  };
}
