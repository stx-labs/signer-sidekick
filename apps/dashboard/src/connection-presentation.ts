import type { ConnectionAssessment } from "@stx-labs/signer-sidekick-api-contracts";

export interface ConnectionPresentation {
  title: string;
  detail: string;
  showZeroToSigning: boolean;
}

export function connectionNeedsRecoveryPage(assessment: ConnectionAssessment | null): boolean {
  if (!assessment) return true;
  if (assessment.status === "connected") return false;
  if (assessment.status === "blocked") return true;
  return assessment.lastSuccessful === null;
}

export function connectionPresentation(
  assessment: ConnectionAssessment | null,
): ConnectionPresentation {
  if (!assessment) {
    return {
      title: "Checking your signer connection",
      detail: "Reading the configured local node and signer-manager contract.",
      showZeroToSigning: false,
    };
  }
  const { configured, outcomeCode } = assessment;
  switch (outcomeCode) {
    case "manager-not-deployed":
      return {
        title: "Signer manager not found",
        detail: `No contract was found at ${configured.managerPrincipal} on ${configured.network}. If on-chain setup is incomplete, finish it in Zero to Signing. If this is the wrong principal, update SIDEKICK_MANAGER_PRINCIPAL and restart Sidekick.`,
        showZeroToSigning: true,
      };
    case "node-unreachable":
      return {
        title: "Could not check the local node",
        detail: `Sidekick could not reach ${configured.nodeRpcUrl}, so it cannot verify this deployment yet. Check the endpoint and node availability, then recheck.`,
        showZeroToSigning: false,
      };
    case "node-network-mismatch":
    case "principal-network-mismatch":
      return {
        title: "Network configuration does not match",
        detail: `Sidekick is configured for ${configured.network}, but the observed node or manager principal belongs to another network. Correct the deployment configuration and restart Sidekick.`,
        showZeroToSigning: false,
      };
    case "pox5-unavailable":
      return {
        title: "PoX-5 context is not available",
        detail: `The local node matches ${configured.network}, but it did not provide an active PoX-5 contract. Check the node version and chain state, then recheck.`,
        showZeroToSigning: false,
      };
    case "manager-trait-mismatch":
      return {
        title: "This contract is not a PoX-5 signer manager",
        detail: `A contract exists at ${configured.managerPrincipal}, but its deployed interface does not satisfy the PoX-5 signer-manager trait required for baseline monitoring. Sidekick has not changed anything.`,
        showZeroToSigning: false,
      };
    case "deployment-identity-mismatch":
      return {
        title: "This database belongs to another deployment",
        detail:
          "The configured network or signer manager differs from the durable identity stored with this database. Use the matching configuration, restore the matching database, or start the other manager with a new empty database path.",
        showZeroToSigning: false,
      };
    default:
      return {
        title: "Sidekick is connected",
        detail: `The local node and ${configured.managerPrincipal} provide the required PoX-5 baseline.`,
        showZeroToSigning: false,
      };
  }
}
