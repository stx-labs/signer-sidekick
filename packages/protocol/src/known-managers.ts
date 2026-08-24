import { POX5_TESTNET_COMPATIBILITY } from "./known-network-compatibility.js";
import type { ReviewedManagerArtifact } from "./manager-adapter.js";
import { managerArtifactFromNetworkProfile } from "./network-manager-artifact.js";
import type { ManagerProfile } from "./profile.js";

const mainnetProfile = {
  id: "stacks-4.0.0-mainnet-reference-manager",
  network: "mainnet",
  upstream: {
    tag: "main",
    commit: "efc34a07a225c4b950ab9404a1652aa5e14affaf",
    sourceSha256: "ac552739b668226930e679b6b13fcf1af411b30688d8b258cfae7ff7bf0b8695",
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
  sourceSha256: "05aaf409ed285f02d8b6d5d540f94feb8baea139a14263b7e7de7ba9f054d3c5",
  canonicalSha256: "004da6bde5f91b9cdf555a020494cab73d29cc75733ad0c05e4f4b32a94e251b",
  clarityVersion: "Clarity6",
  epoch: "Epoch40",
} as const satisfies ReviewedManagerArtifact;

const devnetProfile = {
  id: "stacks-4.0.0-devnet-reference-manager",
  network: "devnet",
  upstream: {
    tag: "main",
    commit: "efc34a07a225c4b950ab9404a1652aa5e14affaf",
    sourceSha256: "ac552739b668226930e679b6b13fcf1af411b30688d8b258cfae7ff7bf0b8695",
  },
  contracts: {
    pox5: "ST000000000000000000002AMW42H.pox-5",
    sbtcDeployer: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
  },
  expectedReplacements: {
    pox5: 8,
    sbtcDeployer: 13,
  },
  // Production approval is a mainnet-only gate. Non-mainnet reviewed execution still requires
  // every source, approval, and runtime admission check.
  productionApproved: false,
} as const satisfies ManagerProfile;

export const DEVNET_REFERENCE_MANAGER = {
  profile: devnetProfile,
  sourceSha256: "403254a3ce0a65a32b2aeb64a3c116a1a3ce5ee339f36d99edab3e4a605d7f38",
  canonicalSha256: "f7d1e21949b04a4c825b50d3df9539d3db27043717f0b98ab676784380a358a1",
  clarityVersion: "Clarity6",
  epoch: "Epoch40",
} as const satisfies ReviewedManagerArtifact;

const regtestProfile = {
  id: "stacks-4.0.0-regtest-reference-manager",
  network: "regtest",
  upstream: {
    tag: "main",
    commit: "efc34a07a225c4b950ab9404a1652aa5e14affaf",
    sourceSha256: "ac552739b668226930e679b6b13fcf1af411b30688d8b258cfae7ff7bf0b8695",
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
  sourceSha256: "d5dfb736a5d464fac49ccfe38f77c100fe03464fb084a711c2ec21d2d0cc8045",
  canonicalSha256: "b365887e3706a2486c688e85651c082c78f80984e87b6325d7cb358a5b73bdf1",
  clarityVersion: "Clarity6",
  epoch: "Epoch40",
} as const satisfies ReviewedManagerArtifact;

export const POX5_TESTNET_REFERENCE_MANAGER = {
  ...managerArtifactFromNetworkProfile(POX5_TESTNET_COMPATIBILITY),
  clarityVersion: "Clarity6",
  epoch: "Epoch40",
} as const satisfies ReviewedManagerArtifact;

export const KNOWN_MANAGER_ARTIFACTS: readonly ReviewedManagerArtifact[] = [
  MAINNET_REFERENCE_MANAGER,
  POX5_TESTNET_REFERENCE_MANAGER,
  DEVNET_REFERENCE_MANAGER,
  REGTEST_REFERENCE_MANAGER,
];

export function knownManagerArtifactsForNetwork(
  network: ManagerProfile["network"],
): readonly ReviewedManagerArtifact[] {
  return KNOWN_MANAGER_ARTIFACTS.filter((artifact) => artifact.profile.network === network);
}
