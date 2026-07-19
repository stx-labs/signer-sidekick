import type { DashboardSnapshot } from "@stx-labs/signer-sidekick-api-contracts";

type ManagerActionNetwork = DashboardSnapshot["network"];

const standardPrincipalPattern = /^S[PMTN][0-9A-Z]{20,50}$/;
const contractPrincipalPattern = /^S[PMTN][0-9A-Z]{20,50}\.[a-zA-Z][a-zA-Z0-9-_]{0,39}$/;

function matchesAddressNamespace(value: string, network: ManagerActionNetwork): boolean {
  const address = value.split(".", 1)[0] ?? "";
  return network === "mainnet" ? /^S[PM]/.test(address) : /^S[TN]/.test(address);
}

export function standardManagerActionPrincipal(
  value: string,
  network: ManagerActionNetwork,
): boolean {
  const trimmed = value.trim();
  return standardPrincipalPattern.test(trimmed) && matchesAddressNamespace(trimmed, network);
}

export function managerActionRecipient(value: string, network: ManagerActionNetwork): boolean {
  const trimmed = value.trim();
  return (
    (standardPrincipalPattern.test(trimmed) || contractPrincipalPattern.test(trimmed)) &&
    matchesAddressNamespace(trimmed, network)
  );
}
