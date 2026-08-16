import type { DashboardSnapshot } from "@stx-labs/signer-sidekick-api-contracts";
import {
  isStacksAddressForNetwork,
  isStacksContractPrincipalForNetwork,
} from "../../shared/principal.js";

type ManagerActionNetwork = DashboardSnapshot["network"];

export function standardManagerActionPrincipal(
  value: string,
  network: ManagerActionNetwork,
): boolean {
  const trimmed = value.trim();
  return isStacksAddressForNetwork(trimmed, network);
}

export function managerActionRecipient(value: string, network: ManagerActionNetwork): boolean {
  const trimmed = value.trim();
  return (
    isStacksAddressForNetwork(trimmed, network) ||
    isStacksContractPrincipalForNetwork(trimmed, network, 40)
  );
}
