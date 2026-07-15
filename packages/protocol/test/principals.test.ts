import { describe, expect, it } from "vitest";
import { parseContractPrincipal, validatePrincipal } from "../src/principals.js";

describe("contract principals", () => {
  it("parses a checksummed mainnet contract principal", () => {
    expect(parseContractPrincipal("SP000000000000000000002Q6VF78.pox-5")).toEqual({
      address: "SP000000000000000000002Q6VF78",
      contractName: "pox-5",
      network: "mainnet",
    });
  });

  it("rejects invalid addresses and path-like contract names", () => {
    expect(() => parseContractPrincipal("SP000000000000000000002Q6VF79.manager")).toThrow(
      "invalid address",
    );
    expect(() => parseContractPrincipal("SP000000000000000000002Q6VF78../source")).toThrow(
      "form ADDRESS.contract-name",
    );
  });

  it("validates standard and contract principals", () => {
    expect(validatePrincipal("SP000000000000000000002Q6VF78")).toBe(true);
    expect(validatePrincipal("SP000000000000000000002Q6VF78.manager")).toBe(true);
    expect(validatePrincipal("not-a-principal")).toBe(false);
  });
});
