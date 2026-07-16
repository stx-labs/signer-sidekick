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

export const PRIVATE_1_COMPATIBILITY = {
  schemaVersion: 1,
  id: "hiro-private-1-pox5-c744bf5",
  revision: 1,
  publishedAt: "2026-07-16T00:00:00.000Z",
  label: "Hiro private-1 PoX-5 test network",
  network: "testnet",
  networkId: 256,
  pox5: {
    contractId: "ST000000000000000000002AMW42H.pox-5",
    sourceSha256: "bc3f6467f14eaac1f79299f2e7389194d172a75b784b9808d6e783ced672fa69",
    activationBurnHeight: 202,
    firstRewardCycleId: 11,
  },
  sbtc: {
    tokenContract: "SN3R84XZYA63QS28932XQF3G1J8R9PC3W76P9CSQS.sbtc-token",
    registryContract: "SN3R84XZYA63QS28932XQF3G1J8R9PC3W76P9CSQS.sbtc-registry",
  },
  referenceManager: {
    profileId: "hiro-private-1-pox5-c744bf5-reference-manager",
    upstream: {
      tag: "4.0.0",
      commit: "5595f08a244362cefc316f95b398510a2b8cb791",
      sourceSha256: "f86819132e5c4e6f00d491b27f32ded4c3342c2be875ff90d1eba70fd5f0a5cf",
    },
    expectedReplacements: { pox5: 8, sbtcDeployer: 13 },
    sourceSha256: "920ec2b61853bd112f8b5470cc91ea94a00ffec7ca389bbab9705807054d94b9",
    canonicalSha256: "9cc7192fb6ede0b355d0bff113a681980e4c489d1f9840be824d78b8f8da40cd",
  },
  capabilities: { pox5SbtcContractFields: true },
  provenance: {
    stacksCoreTag: "4.0.0-private-1",
    stacksCoreCommit: "c744bf5",
    notes: "Pinned to the live private-1 deployment; this is not the stacks-core 4.0.0 tag source.",
  },
  testedNodeBuilds: ["stacks-node 4.0.0.0.0 (c744bf5, release build, linux [x86_64])"],
} as const satisfies NetworkCompatibilityProfile;

export const BUILT_IN_NETWORK_COMPATIBILITY_PROFILES: readonly NetworkCompatibilityProfile[] = [
  MAINNET_4_0_1_COMPATIBILITY,
  PRIVATE_1_COMPATIBILITY,
];
