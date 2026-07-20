import { describe, expect, it } from "vitest";
import { parseInstalledManagerProfile } from "../src/installed-manager-profile.js";

const base = {
  schemaVersion: 1,
  id: "private-1-reference-manager",
  managerPrincipal: "ST3PF13W7Z0RRM42A8VZRVFQ75SV1K26RXEP8YGKJ.signer-manager",
  network: "testnet",
  networkId: 256,
  sourceSha256: "a".repeat(64),
  canonicalSha256: "b".repeat(64),
  createdAt: "2026-07-16T12:00:00.000Z",
  proofVersion: 1,
} as const;

describe("installed manager profile schema", () => {
  it("accepts strict reference-render and custom-observe profiles", () => {
    expect(
      parseInstalledManagerProfile({
        ...base,
        tier: "reference-render",
        reference: {
          upstreamProfileId: "stacks-4.0.0-mainnet-reference-manager",
          upstream: {
            tag: "4.0.0",
            commit: "5".repeat(40),
            sourceSha256: "c".repeat(64),
          },
          pox5: "ST000000000000000000002AMW42H.pox-5",
          sbtcDeployer: "ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT",
        },
      }).tier,
    ).toBe("reference-render");
    expect(parseInstalledManagerProfile({ ...base, tier: "custom-observe" }).tier).toBe(
      "custom-observe",
    );
  });

  it("rejects unknown fields and attempts to self-declare automation", () => {
    expect(() =>
      parseInstalledManagerProfile({
        ...base,
        tier: "custom-observe",
        productionApproved: true,
        automationEligible: true,
      }),
    ).toThrow();
  });

  it("rejects wrong-network principals and noncanonical PoX-5 contracts", () => {
    expect(() =>
      parseInstalledManagerProfile({
        ...base,
        managerPrincipal: "SP000000000000000000002Q6VF78.signer-manager",
        tier: "custom-observe",
      }),
    ).toThrow("does not match");
    expect(() =>
      parseInstalledManagerProfile({
        ...base,
        tier: "reference-render",
        reference: {
          upstreamProfileId: "stacks-4.0.0-mainnet-reference-manager",
          upstream: {
            tag: "4.0.0",
            commit: "5".repeat(40),
            sourceSha256: "c".repeat(64),
          },
          pox5: "ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT.pox-5",
          sbtcDeployer: "ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT",
        },
      }),
    ).toThrow("canonical");
  });

  it("rejects private network IDs on mainnet and cross-network sBTC deployers", () => {
    expect(() =>
      parseInstalledManagerProfile({
        ...base,
        managerPrincipal: "SP000000000000000000002Q6VF78.signer-manager",
        network: "mainnet",
        networkId: 1,
        tier: "custom-observe",
      }),
    ).toThrow("private network ID");
    expect(() =>
      parseInstalledManagerProfile({
        ...base,
        tier: "reference-render",
        reference: {
          upstreamProfileId: "stacks-4.0.0-mainnet-reference-manager",
          upstream: {
            tag: "4.0.0",
            commit: "5".repeat(40),
            sourceSha256: "c".repeat(64),
          },
          pox5: "ST000000000000000000002AMW42H.pox-5",
          sbtcDeployer: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4",
        },
      }),
    ).toThrow("sBTC deployer principal does not match");
  });
});
