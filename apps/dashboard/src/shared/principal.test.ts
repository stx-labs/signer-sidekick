import { describe, expect, it } from "vitest";
import {
  isStacksAddress,
  isStacksAddressForNetwork,
  isStacksContractPrincipalForNetwork,
} from "./principal.js";

const mainnetAddress = `SP${"A".repeat(20)}`;
const testnetAddress = `ST${"B".repeat(20)}`;

describe("Stacks principal validation", () => {
  it("validates address syntax and network namespace independently", () => {
    expect(isStacksAddress(mainnetAddress)).toBe(true);
    expect(isStacksAddressForNetwork(mainnetAddress, "mainnet")).toBe(true);
    expect(isStacksAddressForNetwork(mainnetAddress, "testnet")).toBe(false);
    expect(isStacksAddressForNetwork(testnetAddress, "mainnet")).toBe(false);
    expect(isStacksAddressForNetwork(testnetAddress, "pox5-testnet")).toBe(true);
  });

  it("preserves each caller's explicit contract-name length", () => {
    expect(isStacksContractPrincipalForNetwork(`${mainnetAddress}.pool`, "mainnet", 40)).toBe(true);
    expect(
      isStacksContractPrincipalForNetwork(`${mainnetAddress}.${"a".repeat(41)}`, "mainnet", 40),
    ).toBe(false);
    expect(
      isStacksContractPrincipalForNetwork(`${mainnetAddress}.${"a".repeat(128)}`, "mainnet", 128),
    ).toBe(true);
  });
});
