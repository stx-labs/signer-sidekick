import type { NetworkCompatibilityProfile } from "./network-compatibility.js";

/**
 * Built-in profiles are bootstrap data. Operator-provided profiles can be installed without
 * rebuilding Sidekick, so this list is not a catalogue of acceptable stacks-node versions.
 */
export const MAINNET_4_0_1_COMPATIBILITY = {
  schemaVersion: 1,
  id: "stacks-mainnet-pox5-launch-4.0.1",
  revision: 1,
  publishedAt: "2026-07-15T00:00:00.000Z",
  label: "Stacks mainnet PoX-5 launch",
  network: "mainnet",
  networkId: 1,
  pox5: {
    contractId: "SP000000000000000000002Q6VF78.pox-5",
    sourceSha256: "ffad35ad181d85832ebd7b998f445204c92d5cd19549166e644fb1f3988fa385",
    activationBurnHeight: 960_230,
  },
  sbtc: {
    tokenContract: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
    registryContract: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-registry",
  },
  referenceManager: {
    profileId: "stacks-4.0.0-mainnet-reference-manager",
    upstream: {
      tag: "main",
      commit: "efc34a07a225c4b950ab9404a1652aa5e14affaf",
      sourceSha256: "ac552739b668226930e679b6b13fcf1af411b30688d8b258cfae7ff7bf0b8695",
    },
    expectedReplacements: { pox5: 8, sbtcDeployer: 13 },
    sourceSha256: "05aaf409ed285f02d8b6d5d540f94feb8baea139a14263b7e7de7ba9f054d3c5",
    canonicalSha256: "004da6bde5f91b9cdf555a020494cab73d29cc75733ad0c05e4f4b32a94e251b",
  },
  capabilities: { pox5SbtcContractFields: true },
  provenance: {
    stacksCoreTag: "4.0.1",
    stacksCoreCommit: "62e03cc5551bfc574223c2b78ce04ceca30cec37",
    notes: "Deployment remains disabled until post-activation validation and explicit promotion.",
  },
  testedNodeBuilds: [],
} as const satisfies NetworkCompatibilityProfile;

export const TESTNET_COMPATIBILITY = {
  schemaVersion: 1,
  id: "stacks-testnet-4.0.1",
  revision: 1,
  publishedAt: "2026-07-17T00:00:00.000Z",
  label: "Testnet",
  network: "testnet",
  networkId: 0x80000000,
  pox5: {
    contractId: "ST000000000000000000002AMW42H.pox-5",
    sourceSha256: "44a424364cb3c115ec92d0a72ebd228645e65d8f92792d66695898904e14c734",
    activationBurnHeight: 4_065,
    firstRewardCycleId: 5,
  },
  sbtc: {
    tokenContract: "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token",
    registryContract: "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-registry",
  },
  referenceManager: {
    profileId: "stacks-testnet-4.0.1-reference-manager",
    upstream: {
      tag: "main",
      commit: "efc34a07a225c4b950ab9404a1652aa5e14affaf",
      sourceSha256: "ac552739b668226930e679b6b13fcf1af411b30688d8b258cfae7ff7bf0b8695",
    },
    expectedReplacements: { pox5: 8, sbtcDeployer: 13 },
    sourceSha256: "b9c49ce03453a734fed8cf0d9202adb807d53d585108cdf4839be86728693e76",
    canonicalSha256: "97e003554c90ff8cefe0a17ee7f52e47fd42464a464ff02f666b117740e84214",
  },
  capabilities: { pox5SbtcContractFields: true },
  provenance: {
    stacksCoreTag: "4.0.1",
    stacksCoreCommit: "62e03cc5551bfc574223c2b78ce04ceca30cec37",
    notes: "Pinned to the public Stacks testnet deployment.",
  },
  testedNodeBuilds: ["stacks-node 4.0.1 (62e03cc, release build, linux [x86_64])"],
} as const satisfies NetworkCompatibilityProfile;

export const BUILT_IN_NETWORK_COMPATIBILITY_PROFILES: readonly NetworkCompatibilityProfile[] = [
  MAINNET_4_0_1_COMPATIBILITY,
  TESTNET_COMPATIBILITY,
];
