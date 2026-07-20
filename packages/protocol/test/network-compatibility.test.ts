import { describe, expect, it } from "vitest";
import {
  MAINNET_4_0_1_COMPATIBILITY,
  POX5_TESTNET_COMPATIBILITY,
} from "../src/known-network-compatibility.js";
import { parseNetworkCompatibilityProfile } from "../src/network-compatibility.js";
import { managerArtifactFromNetworkProfile } from "../src/network-manager-artifact.js";

describe("network compatibility profiles", () => {
  it("rejects cross-network contract principals and unknown fields", () => {
    expect(() =>
      parseNetworkCompatibilityProfile({
        ...MAINNET_4_0_1_COMPATIBILITY,
        sbtc: {
          ...MAINNET_4_0_1_COMPATIBILITY.sbtc,
          tokenContract: "ST000000000000000000002AMW42H.sbtc-token",
        },
      }),
    ).toThrow();
    expect(() =>
      parseNetworkCompatibilityProfile({ ...MAINNET_4_0_1_COMPATIBILITY, executableAdapter: true }),
    ).toThrow();
  });

  it("derives immutable manager artifacts from network compatibility data", () => {
    expect(managerArtifactFromNetworkProfile(MAINNET_4_0_1_COMPATIBILITY)).toMatchObject({
      profile: {
        id: "stacks-4.0.0-mainnet-reference-manager",
        contracts: { sbtcDeployer: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4" },
      },
      sourceSha256: MAINNET_4_0_1_COMPATIBILITY.referenceManager.sourceSha256,
    });
    expect(POX5_TESTNET_COMPATIBILITY).toMatchObject({
      id: "stacks-pox5-testnet-4.0.1",
      label: "PoX-5 Testnet",
      network: "testnet",
      networkId: 0x80000005,
    });
    expect(managerArtifactFromNetworkProfile(POX5_TESTNET_COMPATIBILITY)).toMatchObject({
      profile: {
        id: "stacks-pox5-testnet-4.0.1-reference-manager",
        network: "testnet",
        contracts: { sbtcDeployer: "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1" },
      },
      sourceSha256: POX5_TESTNET_COMPATIBILITY.referenceManager.sourceSha256,
    });
  });
});
