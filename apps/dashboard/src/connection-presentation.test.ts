import type { ConnectionAssessment } from "@stx-labs/signer-sidekick-api-contracts";
import { describe, expect, it } from "vitest";
import { connectionNeedsRecoveryPage, connectionPresentation } from "./connection-presentation.js";

const base = {
  configured: {
    network: "mainnet",
    networkId: 1,
    nodeRpcUrl: "http://node:20443",
    managerPrincipal: "SP000000000000000000002Q6VF78.signer-manager",
  },
} as ConnectionAssessment;

describe("connection recovery copy", () => {
  it.each([
    ["manager-not-deployed", "Signer manager not found", true],
    ["node-unreachable", "Could not check the local node", false],
    ["node-network-mismatch", "Network configuration does not match", false],
    ["principal-network-mismatch", "Network configuration does not match", false],
    ["pox5-unavailable", "PoX-5 context is not available", false],
    ["manager-trait-mismatch", "This contract is not a PoX-5 signer manager", false],
    ["deployment-identity-mismatch", "This database belongs to another deployment", false],
  ] as const)("maps %s without inferring setup state", (outcomeCode, title, showZeroToSigning) => {
    expect(connectionPresentation({ ...base, outcomeCode })).toMatchObject({
      title,
      showZeroToSigning,
    });
  });

  it("keeps a previously connected deployment in the ordinary dashboard during an outage", () => {
    expect(
      connectionNeedsRecoveryPage({
        ...base,
        status: "unavailable",
        lastSuccessful: { managerPrincipal: base.configured.managerPrincipal },
      } as ConnectionAssessment),
    ).toBe(false);
  });

  it.each([
    [null, true],
    [{ ...base, status: "unavailable", lastSuccessful: null }, true],
    [{ ...base, status: "blocked", lastSuccessful: null }, true],
    [{ ...base, status: "connected", lastSuccessful: null }, false],
  ] as const)("selects the focused recovery page only when required", (assessment, expected) => {
    expect(connectionNeedsRecoveryPage(assessment as ConnectionAssessment | null)).toBe(expected);
  });
});
