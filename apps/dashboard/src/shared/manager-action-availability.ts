import type { DashboardSnapshot } from "@stx-labs/signer-sidekick-api-contracts";

type ManagerActionContext = Pick<DashboardSnapshot, "manager" | "preflight">;

export function managerActionAvailability(data: ManagerActionContext): {
  available: boolean;
  reason: string;
  warning: string | null;
} {
  const networkChecks = new Map(data.preflight.checks.map((check) => [check.id, check]));
  const failedNetworkCheck = ["node-network", "api-network"].find(
    (id) => networkChecks.get(id)?.status !== "pass",
  );
  if (failedNetworkCheck) {
    return {
      available: false,
      reason:
        networkChecks.get(failedNetworkCheck)?.message ??
        "Sidekick could not verify that the node and API use the configured network.",
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
    reason: "The configured manager exposes the required interface on this network.",
    warning: referenceVerified
      ? null
      : "Sidekick cannot attest this manager's behavior. Verify the contract, function, arguments, and postconditions in your wallet or signing tool before signing. Assist remains unavailable.",
  };
}
