import {
  REFERENCE_MANAGER_PUBLIC_FUNCTIONS,
  REFERENCE_MANAGER_READ_ONLY_FUNCTIONS,
} from "@stx-labs/signer-sidekick-protocol";
import { knownManagerArtifactsForNetwork } from "@stx-labs/signer-sidekick-protocol/known-managers";
import {
  canonicalizeClaritySource,
  claritySourceSha256,
  createManagerAdapterFromHashes,
  type SourceMatch,
} from "@stx-labs/signer-sidekick-protocol/manager-adapter";
import { parseContractPrincipal } from "@stx-labs/signer-sidekick-protocol/principals";
import type { ContractInterface, ContractSource, StacksNodeClient } from "./chain-clients.js";
import type { SidekickNetwork } from "./config.js";

export interface ManagerVerificationReport {
  managerPrincipal: string;
  configuredNetwork: SidekickNetwork;
  principalNetwork: "mainnet" | "testnet";
  networkMatches: boolean;
  publishHeight: number;
  source: {
    match: SourceMatch;
    profileId: string | null;
    sha256: string;
    canonicalSha256: string;
    recognized: boolean;
  };
  interface: {
    compatible: boolean;
    missingFunctions: string[];
  };
  attachAllowed: boolean;
  automationEligible: boolean;
  recommendedMode: "observe";
  reasons: string[];
}

function isExpectedNetwork(network: SidekickNetwork, principalNetwork: "mainnet" | "testnet") {
  return network === "mainnet" ? principalNetwork === "mainnet" : principalNetwork === "testnet";
}

function missingManagerFunctions(contractInterface: ContractInterface): string[] {
  const functions = new Map(
    contractInterface.functions.map((entry) => [entry.name, entry.access] as const),
  );
  return [
    ...REFERENCE_MANAGER_PUBLIC_FUNCTIONS.filter((name) => functions.get(name) !== "public"),
    ...REFERENCE_MANAGER_READ_ONLY_FUNCTIONS.filter((name) => functions.get(name) !== "read_only"),
  ];
}

export function verifyManagerArtifact(
  configuredNetwork: SidekickNetwork,
  managerPrincipal: string,
  contractSource: ContractSource,
  contractInterface: ContractInterface,
): ManagerVerificationReport {
  const principal = parseContractPrincipal(managerPrincipal);
  const networkMatches = isExpectedNetwork(configuredNetwork, principal.network);
  const candidates = knownManagerArtifactsForNetwork(configuredNetwork);
  const recognitions = candidates.map((artifact) => ({
    artifact,
    recognition: createManagerAdapterFromHashes(artifact).recognizeSource(contractSource.source),
  }));
  const recognized =
    recognitions.find(({ recognition }) => recognition.match === "exact") ??
    recognitions.find(({ recognition }) => recognition.match === "canonical");
  const sourceSha256 = claritySourceSha256(contractSource.source);
  const canonicalSha256 = claritySourceSha256(canonicalizeClaritySource(contractSource.source));
  const missingFunctions = missingManagerFunctions(contractInterface);
  const interfaceCompatible = missingFunctions.length === 0;
  const automationEligible = Boolean(
    networkMatches && interfaceCompatible && recognized?.recognition.automationAllowed,
  );
  const reasons: string[] = [];

  if (!networkMatches) reasons.push("Manager principal does not match the configured network");
  if (!recognized) reasons.push("Manager source is not a reviewed artifact for this network");
  if (recognized && !recognized.artifact.profile.productionApproved) {
    reasons.push(`Profile ${recognized.artifact.profile.id} is not production-approved`);
  }
  if (!interfaceCompatible) {
    reasons.push(`Manager interface is missing ${missingFunctions.length} required function(s)`);
  }

  return {
    managerPrincipal,
    configuredNetwork,
    principalNetwork: principal.network,
    networkMatches,
    publishHeight: contractSource.publish_height,
    source: {
      match: recognized?.recognition.match ?? "unknown",
      profileId: recognized?.artifact.profile.id ?? null,
      sha256: sourceSha256,
      canonicalSha256,
      recognized: Boolean(recognized),
    },
    interface: {
      compatible: interfaceCompatible,
      missingFunctions,
    },
    attachAllowed: networkMatches && interfaceCompatible,
    automationEligible,
    recommendedMode: "observe",
    reasons,
  };
}

export async function inspectDeployedManager(
  node: StacksNodeClient,
  configuredNetwork: SidekickNetwork,
  managerPrincipal: string,
): Promise<ManagerVerificationReport> {
  const [contractSource, contractInterface] = await Promise.all([
    node.getContractSource(managerPrincipal),
    node.getContractInterface(managerPrincipal),
  ]);
  return verifyManagerArtifact(
    configuredNetwork,
    managerPrincipal,
    contractSource,
    contractInterface,
  );
}
