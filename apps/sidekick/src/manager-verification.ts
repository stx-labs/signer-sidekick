import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ManagerCapabilities } from "@stx-labs/signer-sidekick-api-contracts";
import { parseManagerProfile } from "@stx-labs/signer-sidekick-protocol";
import { KNOWN_MANAGER_ARTIFACTS } from "@stx-labs/signer-sidekick-protocol/known-managers";
import {
  canonicalizeClaritySource,
  claritySourceSha256,
  createManagerAdapterFromHashes,
  managerProfileAllowsAssist,
  type ReviewedManagerArtifact,
  type SourceMatch,
} from "@stx-labs/signer-sidekick-protocol/manager-adapter";
import { generateManagerArtifact } from "@stx-labs/signer-sidekick-protocol/manager-artifact";
import { managerArtifactFromNetworkProfile } from "@stx-labs/signer-sidekick-protocol/network-manager-artifact";
import { parseContractPrincipal } from "@stx-labs/signer-sidekick-protocol/principals";
import {
  type ChainReadOptions,
  type ContractInterface,
  type ContractSource,
  type StacksNodeClient,
  UpstreamHttpError,
} from "./chain-clients.js";
import type { SidekickNetwork } from "./config.js";
import {
  inspectManagerCapabilities,
  missingReferenceManagerFunctions,
} from "./manager-capabilities.js";
import {
  type InstalledManagerProfileStore,
  loadInstalledManagerProfileStore,
} from "./manager-profile-store.js";
import { loadNetworkCompatibilityProfiles } from "./network-compatibility-store.js";

export type ManagerRecognitionTier =
  | "reference-built-in"
  | "reference-render"
  | "custom-observe"
  | "unrecognized";

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
    tier: ManagerRecognitionTier;
    origin: "built-in" | "operator-installed" | null;
  };
  provenance: {
    status: "built-in" | "verified" | "not-applicable" | "failed";
    upstreamProfileId: string | null;
    reason: string;
  };
  interface: {
    compatible: boolean;
    missingFunctions: string[];
  };
  capabilities: ManagerCapabilities;
  installedProfiles: {
    directory: string | null;
    loaded: number;
    issues: Array<{ fileName: string | null; code: string; message: string }>;
  };
  attachAllowed: boolean;
  automationEligible: boolean;
  automationEligibilityReason: string;
  recommendedMode: "observe";
  reasons: string[];
}

interface CachedManagerContract {
  contractSource: ContractSource;
  contractInterface: ContractInterface;
}

export interface ManagerVerificationContext {
  installedProfiles: InstalledManagerProfileStore;
  upstreamSource: string | null;
  upstreamSourceError: string | null;
  managerArtifacts: readonly ReviewedManagerArtifact[];
  operatorProvidedManagerProfileIds: ReadonlySet<string>;
  expectedNetworkId?: number;
  sourceCache: Map<string, CachedManagerContract>;
}

export async function createManagerVerificationContext(options: {
  trustedProfilesDirectory?: string;
  contractsDirectory: string;
  expectedNetworkId?: number;
  compatibilityProfilesDirectory?: string;
}): Promise<ManagerVerificationContext> {
  const [installedProfiles, compatibilityProfiles] = await Promise.all([
    loadInstalledManagerProfileStore(options.trustedProfilesDirectory),
    loadNetworkCompatibilityProfiles({
      ...(options.compatibilityProfilesDirectory
        ? { directory: options.compatibilityProfilesDirectory }
        : {}),
    }),
  ]);
  const upstreamPath = resolve(
    options.contractsDirectory,
    "reference-manager/upstream/signer-manager.clar",
  );
  let upstreamSource: string | null = null;
  let upstreamSourceError: string | null = null;
  try {
    upstreamSource = await readFile(upstreamPath, "utf8");
  } catch (error) {
    const errorCode =
      typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;
    upstreamSourceError = errorCode
      ? `Pinned reference-manager source is unavailable (${errorCode})`
      : "Pinned reference-manager source is unavailable";
  }
  const managerArtifactsById = new Map(
    KNOWN_MANAGER_ARTIFACTS.map((artifact) => [artifact.profile.id, artifact]),
  );
  const operatorProvidedManagerProfileIds = new Set<string>();
  for (const loaded of compatibilityProfiles.profiles) {
    const artifact = managerArtifactFromNetworkProfile(loaded.profile);
    const existing = managerArtifactsById.get(artifact.profile.id);
    if (existing && existing.profile.network !== artifact.profile.network) {
      // Manager profile IDs are global identifiers. Never let an operator-provided network
      // profile reinterpret an existing manager ID for the other address namespace.
      continue;
    }
    if (loaded.origin === "operator-provided") {
      if (!upstreamSource) continue;
      try {
        const generated = generateManagerArtifact(upstreamSource, artifact.profile);
        if (
          generated.metadata.outputSha256 !== artifact.sourceSha256 ||
          generated.metadata.canonicalOutputSha256 !== artifact.canonicalSha256
        ) {
          continue;
        }
      } catch {
        continue;
      }
      operatorProvidedManagerProfileIds.add(artifact.profile.id);
    }
    managerArtifactsById.set(artifact.profile.id, artifact);
  }
  return {
    installedProfiles,
    upstreamSource,
    upstreamSourceError,
    managerArtifacts: [...managerArtifactsById.values()],
    operatorProvidedManagerProfileIds,
    ...(options.expectedNetworkId !== undefined
      ? { expectedNetworkId: options.expectedNetworkId }
      : {}),
    sourceCache: new Map(),
  };
}

export function invalidateManagerVerificationCache(
  context: ManagerVerificationContext,
  managerPrincipal?: string,
): void {
  if (!managerPrincipal) {
    context.sourceCache.clear();
    return;
  }
  for (const key of context.sourceCache.keys()) {
    if (key.endsWith(`:${managerPrincipal}`)) context.sourceCache.delete(key);
  }
}

function isExpectedNetwork(network: SidekickNetwork, principalNetwork: "mainnet" | "testnet") {
  return network === "mainnet" ? principalNetwork === "mainnet" : principalNetwork === "testnet";
}

function emptyProfileStore(): InstalledManagerProfileStore {
  return { directory: null, profiles: [], issues: [] };
}

function matchForHashes(
  sourceSha256: string,
  canonicalSha256: string,
  expectedSourceSha256: string,
  expectedCanonicalSha256: string,
): SourceMatch {
  if (sourceSha256 === expectedSourceSha256) return "exact";
  if (canonicalSha256 === expectedCanonicalSha256) return "canonical";
  return "unknown";
}

function proveReferenceRender(input: {
  profile: Extract<
    InstalledManagerProfileStore["profiles"][number]["profile"],
    { tier: "reference-render" }
  >;
  source: string;
  configuredNetwork: SidekickNetwork;
  expectedNetworkId?: number;
  upstreamSource: string | null;
  upstreamSourceError: string | null;
  managerArtifacts: readonly ReviewedManagerArtifact[];
}): {
  verified: boolean;
  automationEligible: boolean;
  reason: string;
  upstreamProfileId: string;
  sourceMatch?: SourceMatch;
} {
  const { profile } = input;
  const upstreamArtifact = input.managerArtifacts.find(
    ({ profile: candidate }) => candidate.id === profile.reference.upstreamProfileId,
  );
  if (!upstreamArtifact) {
    return {
      verified: false,
      automationEligible: false,
      reason: `Unknown built-in upstream profile ${profile.reference.upstreamProfileId}`,
      upstreamProfileId: profile.reference.upstreamProfileId,
    };
  }
  if (
    profile.reference.upstream.tag !== upstreamArtifact.profile.upstream.tag ||
    profile.reference.upstream.commit !== upstreamArtifact.profile.upstream.commit ||
    profile.reference.upstream.sourceSha256 !== upstreamArtifact.profile.upstream.sourceSha256
  ) {
    return {
      verified: false,
      automationEligible: false,
      reason: `Installed profile provenance does not match built-in profile ${upstreamArtifact.profile.id}`,
      upstreamProfileId: upstreamArtifact.profile.id,
    };
  }
  if (profile.network !== input.configuredNetwork) {
    return {
      verified: false,
      automationEligible: false,
      reason: `Installed profile targets ${profile.network}, not ${input.configuredNetwork}`,
      upstreamProfileId: upstreamArtifact.profile.id,
    };
  }
  if (profile.networkId !== undefined && profile.networkId !== input.expectedNetworkId) {
    return {
      verified: false,
      automationEligible: false,
      reason:
        input.expectedNetworkId === undefined
          ? `Installed profile requires private network ID ${profile.networkId}, but SIDEKICK_NETWORK_ID is not configured`
          : `Installed profile network ID ${profile.networkId} does not match configured network ID ${input.expectedNetworkId}`,
      upstreamProfileId: upstreamArtifact.profile.id,
    };
  }
  if (!input.upstreamSource) {
    return {
      verified: false,
      automationEligible: false,
      reason: input.upstreamSourceError ?? "Pinned reference-manager source is unavailable",
      upstreamProfileId: upstreamArtifact.profile.id,
    };
  }

  const productionApprovedNetworkArtifact = input.managerArtifacts.find(
    ({ profile: candidate }) =>
      candidate.network === profile.network &&
      candidate.upstream.tag === upstreamArtifact.profile.upstream.tag &&
      candidate.upstream.commit === upstreamArtifact.profile.upstream.commit &&
      candidate.upstream.sourceSha256 === upstreamArtifact.profile.upstream.sourceSha256 &&
      candidate.productionApproved,
  );

  if (profile.network === "mainnet") {
    const mainnetArtifact = input.managerArtifacts.find(
      ({ profile: candidate }) => candidate.network === "mainnet",
    );
    if (
      !mainnetArtifact ||
      profile.reference.pox5 !== mainnetArtifact.profile.contracts.pox5 ||
      profile.reference.sbtcDeployer !== mainnetArtifact.profile.contracts.sbtcDeployer
    ) {
      return {
        verified: false,
        automationEligible: false,
        reason:
          "Mainnet reference renders must use Sidekick's fixed canonical PoX-5 and sBTC principals",
        upstreamProfileId: upstreamArtifact.profile.id,
      };
    }
  }

  try {
    const renderProfile = parseManagerProfile({
      id: profile.id,
      network: profile.network,
      upstream: upstreamArtifact.profile.upstream,
      contracts: {
        pox5: profile.reference.pox5,
        sbtcDeployer: profile.reference.sbtcDeployer,
      },
      expectedReplacements: upstreamArtifact.profile.expectedReplacements,
      productionApproved: false,
    });
    const rendered = generateManagerArtifact(input.upstreamSource, renderProfile);
    const sourceSha256 = claritySourceSha256(input.source);
    const canonicalSha256 = claritySourceSha256(canonicalizeClaritySource(input.source));
    if (sourceSha256 !== profile.sourceSha256 || canonicalSha256 !== profile.canonicalSha256) {
      return {
        verified: false,
        automationEligible: false,
        reason: "Deployed source hashes do not match the installed profile",
        upstreamProfileId: upstreamArtifact.profile.id,
      };
    }
    const renderMatch = matchForHashes(
      sourceSha256,
      canonicalSha256,
      rendered.metadata.outputSha256,
      rendered.metadata.canonicalOutputSha256,
    );
    if (renderMatch === "unknown") {
      return {
        verified: false,
        automationEligible: false,
        reason: "Deployed source cannot be reproduced using the pinned reference generator",
        upstreamProfileId: upstreamArtifact.profile.id,
      };
    }
    const automationEligible = managerProfileAllowsAssist({
      network: profile.network,
      productionApproved: Boolean(productionApprovedNetworkArtifact),
    });
    return {
      verified: true,
      automationEligible,
      sourceMatch: renderMatch,
      reason:
        profile.network !== "mainnet"
          ? `Reference render is reproducible; production approval is not required for Assist on ${profile.network}`
          : automationEligible
            ? `Reference render is reproducible and ${productionApprovedNetworkArtifact?.profile.id} approves Assist for mainnet`
            : "Reference render is reproducible, but no matching mainnet built-in profile is production-approved",
      upstreamProfileId: upstreamArtifact.profile.id,
    };
  } catch (error) {
    return {
      verified: false,
      automationEligible: false,
      reason: `Reference-render proof failed: ${error instanceof Error ? error.message : String(error)}`,
      upstreamProfileId: upstreamArtifact.profile.id,
    };
  }
}

export function verifyManagerArtifact(
  configuredNetwork: SidekickNetwork,
  managerPrincipal: string,
  contractSource: ContractSource,
  contractInterface: ContractInterface,
  context?: ManagerVerificationContext,
): ManagerVerificationReport {
  const principal = parseContractPrincipal(managerPrincipal);
  const networkMatches = isExpectedNetwork(configuredNetwork, principal.network);
  const sourceSha256 = claritySourceSha256(contractSource.source);
  const canonicalSha256 = claritySourceSha256(canonicalizeClaritySource(contractSource.source));
  const managerArtifacts = context?.managerArtifacts ?? KNOWN_MANAGER_ARTIFACTS;
  const builtInRecognitions = managerArtifacts
    .filter(({ profile }) => profile.network === configuredNetwork)
    .map((artifact) => ({
      artifact,
      recognition: createManagerAdapterFromHashes(artifact).recognizeSource(contractSource.source),
    }));
  const builtIn =
    builtInRecognitions.find(({ recognition }) => recognition.match === "exact") ??
    builtInRecognitions.find(({ recognition }) => recognition.match === "canonical");
  const operatorProvidedArtifact = Boolean(
    builtIn && context?.operatorProvidedManagerProfileIds?.has(builtIn.artifact.profile.id),
  );
  const profileStore = context?.installedProfiles ?? emptyProfileStore();
  const installed = profileStore.profiles.find(
    ({ profile }) =>
      profile.managerPrincipal === managerPrincipal && profile.network === configuredNetwork,
  );
  const installedMatch = installed
    ? matchForHashes(
        sourceSha256,
        canonicalSha256,
        installed.profile.sourceSha256,
        installed.profile.canonicalSha256,
      )
    : "unknown";
  const installedNetworkIdFailure =
    installed?.profile.networkId !== undefined &&
    installed.profile.networkId !== context?.expectedNetworkId
      ? context?.expectedNetworkId === undefined
        ? `Installed profile requires private network ID ${installed.profile.networkId}, but SIDEKICK_NETWORK_ID is not configured`
        : `Installed profile network ID ${installed.profile.networkId} does not match configured network ID ${context.expectedNetworkId}`
      : null;
  const proof =
    installed?.profile.tier === "reference-render"
      ? proveReferenceRender({
          profile: installed.profile,
          source: contractSource.source,
          configuredNetwork,
          ...(context?.expectedNetworkId !== undefined
            ? { expectedNetworkId: context.expectedNetworkId }
            : {}),
          upstreamSource: context?.upstreamSource ?? null,
          upstreamSourceError: context?.upstreamSourceError ?? null,
          managerArtifacts,
        })
      : null;
  const installedRecognized = Boolean(
    installed &&
      ((installed.profile.tier === "custom-observe" && installedMatch !== "unknown") ||
        proof?.verified) &&
      !installedNetworkIdFailure,
  );
  const installedFailureReason =
    installedNetworkIdFailure ??
    (installed && installedMatch === "unknown"
      ? "Deployed source hashes do not match the installed profile"
      : null);
  const exactSourceReviewed = Boolean(
    (builtIn && builtIn.recognition.match === "exact" && !operatorProvidedArtifact) ||
      (proof?.verified && proof.sourceMatch === "exact" && installedMatch === "exact"),
  );
  const sourceReviewReason = exactSourceReviewed
    ? builtIn && !operatorProvidedArtifact
      ? `Deployed source exactly matches reviewed built-in profile ${builtIn.artifact.profile.id}`
      : `Deployed source exactly matches proven reference render ${installed?.profile.id}`
    : builtIn?.recognition.match === "canonical" ||
        installedMatch === "canonical" ||
        (proof?.verified && proof.sourceMatch === "canonical")
      ? "Source has only a canonical/format-insensitive match; executable capabilities require a reviewed byte-exact fingerprint"
      : operatorProvidedArtifact
        ? "Operator-provided network data cannot grant executable manager capabilities"
        : "No reviewed byte-exact capability fingerprint matches the deployed source";
  const capabilities = inspectManagerCapabilities({
    contractInterface,
    sourceSha256,
    exactSourceReviewed,
    sourceReviewReason,
  });
  const missingFunctions = capabilities.signerManagerTrait.compatible ? [] : ["validate-stake!"];
  const interfaceCompatible = capabilities.signerManagerTrait.compatible;
  const missingReferenceFunctions = missingReferenceManagerFunctions(contractInterface);
  const referenceInterfaceCompatible = missingReferenceFunctions.length === 0;
  const tier: ManagerRecognitionTier = builtIn
    ? operatorProvidedArtifact
      ? "reference-render"
      : "reference-built-in"
    : installedRecognized
      ? installed?.profile.tier === "reference-render"
        ? "reference-render"
        : "custom-observe"
      : "unrecognized";
  const recognized = Boolean(builtIn || installedRecognized);
  const automationEligible = Boolean(
    networkMatches &&
      interfaceCompatible &&
      referenceInterfaceCompatible &&
      exactSourceReviewed &&
      (builtIn?.recognition.automationAllowed ||
        (tier === "reference-render" && proof?.automationEligible)),
  );
  const missingFunctionReason = capabilities.signerManagerTrait.reason;
  const missingReferenceFunctionReason = `Reference-manager execution interface is missing ${missingReferenceFunctions.length} required ${missingReferenceFunctions.length === 1 ? "function" : "functions"}`;
  const profileIssueReason = `${profileStore.issues.length} installed trusted-manager profile ${profileStore.issues.length === 1 ? "issue was" : "issues were"} ignored`;
  const automationEligibilityReason = automationEligible
    ? (builtIn?.recognition.reason ?? proof?.reason ?? "Manager is eligible for Assist")
    : !networkMatches
      ? "Manager principal does not match the configured network"
      : !interfaceCompatible
        ? missingFunctionReason
        : !referenceInterfaceCompatible
          ? missingReferenceFunctionReason
          : !exactSourceReviewed
            ? proof?.verified
              ? sourceReviewReason
              : (proof?.reason ?? installedFailureReason ?? sourceReviewReason)
            : builtIn
              ? operatorProvidedArtifact
                ? "Operator-provided network profiles cannot authorize Assist broadcasts"
                : `Mainnet profile ${builtIn.artifact.profile.id} is not production-approved`
              : (proof?.reason ??
                installedFailureReason ??
                (tier === "custom-observe"
                  ? "Manager uses a custom contract"
                  : "Manager source is unverified"));
  const reasons: string[] = [];
  if (!networkMatches) reasons.push("Manager principal does not match the configured network");
  if (!interfaceCompatible) {
    reasons.push(missingFunctionReason);
  }
  if (!recognized) {
    reasons.push(proof?.reason ?? installedFailureReason ?? "Manager source is unverified");
  } else if (!automationEligible) {
    reasons.push(automationEligibilityReason);
  }
  if (profileStore.issues.length > 0) {
    reasons.push(profileIssueReason);
  }

  return {
    managerPrincipal,
    configuredNetwork,
    principalNetwork: principal.network,
    networkMatches,
    publishHeight: contractSource.publish_height,
    source: {
      match: builtIn?.recognition.match ?? (installedRecognized ? installedMatch : "unknown"),
      profileId:
        builtIn?.artifact.profile.id ??
        (installedRecognized ? (installed?.profile.id ?? null) : null),
      sha256: sourceSha256,
      canonicalSha256,
      recognized,
      tier,
      origin: builtIn
        ? operatorProvidedArtifact
          ? "operator-installed"
          : "built-in"
        : installedRecognized
          ? "operator-installed"
          : null,
    },
    provenance: builtIn
      ? {
          status: operatorProvidedArtifact ? "verified" : "built-in",
          upstreamProfileId: builtIn.artifact.profile.id,
          reason: operatorProvidedArtifact
            ? "Manager was independently reproduced from pinned upstream source using operator-provided network data"
            : builtIn.recognition.reason,
        }
      : proof
        ? {
            status: proof.verified ? "verified" : "failed",
            upstreamProfileId: proof.upstreamProfileId,
            reason: proof.reason,
          }
        : {
            status: installedFailureReason ? "failed" : "not-applicable",
            upstreamProfileId: null,
            reason: installedFailureReason
              ? installedFailureReason
              : tier === "custom-observe"
                ? "Operator-installed custom profile identifies source but does not authorize Assist"
                : "No installed reference-render profile matched this manager",
          },
    interface: {
      compatible: interfaceCompatible,
      missingFunctions,
    },
    capabilities,
    installedProfiles: {
      directory: profileStore.directory,
      loaded: profileStore.profiles.length,
      issues: profileStore.issues.map(({ fileName, code, message }) => ({
        fileName,
        code,
        message,
      })),
    },
    attachAllowed: networkMatches && interfaceCompatible,
    automationEligible,
    automationEligibilityReason,
    recommendedMode: "observe",
    reasons,
  };
}

export async function inspectDeployedManager(
  node: StacksNodeClient,
  configuredNetwork: SidekickNetwork,
  managerPrincipal: string,
  context?: ManagerVerificationContext,
  options?: ChainReadOptions,
): Promise<ManagerVerificationReport> {
  const cacheKey = `${configuredNetwork}:${options?.tip ?? "latest"}:${managerPrincipal}`;
  let contract = context?.sourceCache.get(cacheKey);
  if (!contract) {
    const [contractSource, contractInterface] = await Promise.all([
      node.getContractSource(managerPrincipal, options),
      node.getContractInterface(managerPrincipal, options),
    ]);
    contract = { contractSource, contractInterface };
    context?.sourceCache.set(cacheKey, contract);
  }
  return verifyManagerArtifact(
    configuredNetwork,
    managerPrincipal,
    contract.contractSource,
    contract.contractInterface,
    context,
  );
}

export async function inspectManagerOrReportMissing(
  node: StacksNodeClient,
  configuredNetwork: SidekickNetwork,
  managerPrincipal: string,
  context?: ManagerVerificationContext,
  options?: ChainReadOptions,
): Promise<ManagerVerificationReport> {
  try {
    return await inspectDeployedManager(
      node,
      configuredNetwork,
      managerPrincipal,
      context,
      options,
    );
  } catch (error) {
    if (!(error instanceof UpstreamHttpError) || error.status !== 404) throw error;
    const principal = parseContractPrincipal(managerPrincipal);
    const networkMatches = isExpectedNetwork(configuredNetwork, principal.network);
    const profileStore = context?.installedProfiles ?? emptyProfileStore();
    return {
      managerPrincipal,
      configuredNetwork,
      principalNetwork: principal.network,
      networkMatches,
      publishHeight: 0,
      source: {
        match: "unknown",
        profileId: null,
        sha256: "",
        canonicalSha256: "",
        recognized: false,
        tier: "unrecognized",
        origin: null,
      },
      provenance: {
        status: "not-applicable",
        upstreamProfileId: null,
        reason: "Manager contract is not deployed yet",
      },
      interface: {
        compatible: false,
        missingFunctions: ["validate-stake!"],
      },
      capabilities: inspectManagerCapabilities({
        contractInterface: { functions: [] },
        sourceSha256: "",
        exactSourceReviewed: false,
        sourceReviewReason: "Manager contract is not deployed yet",
      }),
      installedProfiles: {
        directory: profileStore.directory,
        loaded: profileStore.profiles.length,
        issues: profileStore.issues.map(({ fileName, code, message }) => ({
          fileName,
          code,
          message,
        })),
      },
      attachAllowed: false,
      automationEligible: false,
      automationEligibilityReason: "Manager contract is not deployed yet",
      recommendedMode: "observe",
      reasons: [
        ...(networkMatches ? [] : ["Manager principal does not match the configured network"]),
        "Manager contract is not deployed yet",
      ],
    };
  }
}
