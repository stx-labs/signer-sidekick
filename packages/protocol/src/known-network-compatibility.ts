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
      tag: "4.0.0",
      commit: "5595f08a244362cefc316f95b398510a2b8cb791",
      sourceSha256: "f86819132e5c4e6f00d491b27f32ded4c3342c2be875ff90d1eba70fd5f0a5cf",
    },
    expectedReplacements: { pox5: 8, sbtcDeployer: 13 },
    sourceSha256: "c0a2cc8e83de2b1bc60e07c5e0f5da8991c6f79eb05d077bba8cb984eee226b3",
    canonicalSha256: "7fd58a7591ff0ae1643eb7e71ea2867385bcac237a3ea819f52301310c0d2e27",
  },
  capabilities: { pox5SbtcContractFields: true },
  provenance: {
    stacksCoreTag: "4.0.1",
    stacksCoreCommit: "62e03cc5551bfc574223c2b78ce04ceca30cec37",
    notes: "Deployment remains disabled until post-activation validation and explicit promotion.",
  },
  testedNodeBuilds: [],
} as const satisfies NetworkCompatibilityProfile;

export const POX5_TESTNET_COMPATIBILITY = {
  schemaVersion: 1,
  id: "stacks-pox5-testnet-4.0.1",
  revision: 1,
  publishedAt: "2026-07-17T00:00:00.000Z",
  label: "PoX-5 Testnet",
  network: "testnet",
  networkId: 0x80000005,
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
    profileId: "stacks-pox5-testnet-4.0.1-reference-manager",
    upstream: {
      tag: "4.0.0",
      commit: "5595f08a244362cefc316f95b398510a2b8cb791",
      sourceSha256: "f86819132e5c4e6f00d491b27f32ded4c3342c2be875ff90d1eba70fd5f0a5cf",
    },
    expectedReplacements: { pox5: 8, sbtcDeployer: 13 },
    sourceSha256: "28fd9b3dcb89c165723f54b5e61bfaa9e960cd6adfb69f87f2830d4c809aceb4",
    canonicalSha256: "409e8cfa6a447e159062536aff677ca6df7e04e5c7ced92189b6dd90a4689c51",
  },
  capabilities: { pox5SbtcContractFields: true },
  provenance: {
    stacksCoreTag: "4.0.1",
    stacksCoreCommit: "62e03cc5551bfc574223c2b78ce04ceca30cec37",
    notes: "Pinned to the dedicated public PoX-5 testnet deployment.",
  },
  testedNodeBuilds: ["stacks-node 4.0.1 (62e03cc, release build, linux [x86_64])"],
} as const satisfies NetworkCompatibilityProfile;

export const BUILT_IN_NETWORK_COMPATIBILITY_PROFILES: readonly NetworkCompatibilityProfile[] = [
  MAINNET_4_0_1_COMPATIBILITY,
  POX5_TESTNET_COMPATIBILITY,
];
