const stacksAddressPattern = /^S[PMTN][0-9A-Z]{20,50}$/;

export function isStacksAddress(value: string): boolean {
  return stacksAddressPattern.test(value);
}

export function isStacksAddressForNetwork(value: string, network: string): boolean {
  if (!isStacksAddress(value)) return false;
  return network === "mainnet" ? /^S[PM]/.test(value) : /^S[TN]/.test(value);
}

export function isStacksContractPrincipalForNetwork(
  value: string,
  network: string,
  maximumContractNameLength: number,
): boolean {
  const separator = value.indexOf(".");
  if (separator <= 0 || separator === value.length - 1 || value.indexOf(".", separator + 1) >= 0) {
    return false;
  }
  const address = value.slice(0, separator);
  const contractName = value.slice(separator + 1);
  if (!isStacksAddressForNetwork(address, network)) return false;
  if (!Number.isSafeInteger(maximumContractNameLength) || maximumContractNameLength < 1) {
    return false;
  }
  return new RegExp(`^[a-zA-Z][a-zA-Z0-9-_]{0,${maximumContractNameLength - 1}}$`).test(
    contractName,
  );
}
