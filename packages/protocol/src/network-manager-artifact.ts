import type { ReviewedManagerArtifact } from "./manager-adapter.js";
import type { NetworkCompatibilityProfile } from "./network-compatibility.js";
import { parseContractPrincipal } from "./principals.js";
import { parseManagerProfile } from "./profile.js";

export function managerArtifactFromNetworkProfile(
  networkProfile: NetworkCompatibilityProfile,
): ReviewedManagerArtifact {
  const artifact = networkProfile.referenceManager;
  return {
    profile: parseManagerProfile({
      id: artifact.profileId,
      network: networkProfile.network,
      upstream: artifact.upstream,
      contracts: {
        pox5: networkProfile.pox5.contractId,
        sbtcDeployer: parseContractPrincipal(networkProfile.sbtc.tokenContract).address,
      },
      expectedReplacements: artifact.expectedReplacements,
      // Operator-provided data never grants mainnet production approval. Non-mainnet Assist still
      // requires reproduced reference source and every independent runtime gate.
      productionApproved: false,
    }),
    sourceSha256: artifact.sourceSha256,
    canonicalSha256: artifact.canonicalSha256,
  };
}
