import { describe, expect, it } from "vitest";
import {
  managerActionRecipient,
  standardManagerActionPrincipal,
} from "./manager-action-principal.js";

const mainnet = "SP000000000000000000002Q6VF78";
const testnet = "ST000000000000000000002AMW42H";

describe("manager action principal validation", () => {
  it.each([
    "testnet",
    "devnet",
    "regtest",
  ] as const)("uses the testnet address namespace on %s", (network) => {
    expect(standardManagerActionPrincipal(testnet, network)).toBe(true);
    expect(standardManagerActionPrincipal(mainnet, network)).toBe(false);
    expect(managerActionRecipient(`${testnet}.recipient`, network)).toBe(true);
    expect(managerActionRecipient(`${mainnet}.recipient`, network)).toBe(false);
  });

  it("uses only the mainnet address namespace on mainnet", () => {
    expect(standardManagerActionPrincipal(mainnet, "mainnet")).toBe(true);
    expect(standardManagerActionPrincipal(testnet, "mainnet")).toBe(false);
    expect(managerActionRecipient(`${mainnet}.recipient`, "mainnet")).toBe(true);
    expect(managerActionRecipient(`${testnet}.recipient`, "mainnet")).toBe(false);
  });

  it("keeps structural validation while checking the namespace", () => {
    expect(standardManagerActionPrincipal(`${mainnet}.contract`, "mainnet")).toBe(false);
    expect(managerActionRecipient("SP123", "mainnet")).toBe(false);
    expect(managerActionRecipient(`${mainnet}.1-invalid`, "mainnet")).toBe(false);
  });
});
