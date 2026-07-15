import type { ReviewedManagerArtifact } from "./manager-adapter.js";
import type { ManagerProfile } from "./profile.js";

const mainnetProfile = {
  id: "stacks-4.0.0-mainnet-reference-manager",
  network: "mainnet",
  upstream: {
    tag: "4.0.0",
    commit: "5595f08a244362cefc316f95b398510a2b8cb791",
    sourceSha256: "f86819132e5c4e6f00d491b27f32ded4c3342c2be875ff90d1eba70fd5f0a5cf",
  },
  contracts: {
    pox5: "SP000000000000000000002Q6VF78.pox-5",
    sbtcDeployer: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4",
  },
  expectedReplacements: {
    pox5: 8,
    sbtcDeployer: 13,
  },
  productionApproved: false,
} as const satisfies ManagerProfile;

export const MAINNET_REFERENCE_MANAGER = {
  profile: mainnetProfile,
  sourceSha256: "c0a2cc8e83de2b1bc60e07c5e0f5da8991c6f79eb05d077bba8cb984eee226b3",
  canonicalSha256: "7fd58a7591ff0ae1643eb7e71ea2867385bcac237a3ea819f52301310c0d2e27",
} as const satisfies ReviewedManagerArtifact;

const regtestProfile = {
  id: "stacks-4.0.0-regtest-reference-manager",
  network: "regtest",
  upstream: {
    tag: "4.0.0",
    commit: "5595f08a244362cefc316f95b398510a2b8cb791",
    sourceSha256: "f86819132e5c4e6f00d491b27f32ded4c3342c2be875ff90d1eba70fd5f0a5cf",
  },
  contracts: {
    pox5: "ST000000000000000000002AMW42H.pox-5",
    sbtcDeployer: "ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT",
  },
  expectedReplacements: {
    pox5: 8,
    sbtcDeployer: 13,
  },
  productionApproved: false,
} as const satisfies ManagerProfile;

export const REGTEST_REFERENCE_MANAGER = {
  profile: regtestProfile,
  sourceSha256: "61db24eefbfe30ac778e0918d02019f2d33a831f376fbdb76e288fe16b070505",
  canonicalSha256: "ad8acf88b61617acec43dd3c0767ef58bfaea62e34fe2b5adb07521323d7f22b",
} as const satisfies ReviewedManagerArtifact;

export const KNOWN_MANAGER_ARTIFACTS: readonly ReviewedManagerArtifact[] = [
  MAINNET_REFERENCE_MANAGER,
  REGTEST_REFERENCE_MANAGER,
];

export function knownManagerArtifactsForNetwork(
  network: ManagerProfile["network"],
): readonly ReviewedManagerArtifact[] {
  return KNOWN_MANAGER_ARTIFACTS.filter((artifact) => artifact.profile.network === network);
}
