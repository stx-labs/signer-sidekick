import { validateStacksAddress } from "@stacks/transactions";

const contractNamePattern = /^[a-zA-Z][a-zA-Z0-9-_]{0,127}$/;

export interface ContractPrincipalParts {
  address: string;
  contractName: string;
  network: "mainnet" | "testnet";
}

export function validatePrincipal(principal: string): boolean {
  if (!principal.includes(".")) return validateStacksAddress(principal);
  try {
    parseContractPrincipal(principal);
    return true;
  } catch {
    return false;
  }
}

export function parseContractPrincipal(principal: string): ContractPrincipalParts {
  const separator = principal.indexOf(".");
  if (separator <= 0 || principal.indexOf(".", separator + 1) !== -1) {
    throw new Error("Expected a contract principal in the form ADDRESS.contract-name");
  }

  const address = principal.slice(0, separator);
  const contractName = principal.slice(separator + 1);
  if (!validateStacksAddress(address)) throw new Error("Contract principal has an invalid address");
  if (!contractNamePattern.test(contractName)) {
    throw new Error("Contract principal has an invalid contract name");
  }

  const prefix = address.slice(0, 2);
  const network = prefix === "SP" || prefix === "SM" ? "mainnet" : "testnet";
  return { address, contractName, network };
}
