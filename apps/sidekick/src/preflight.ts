import { STACKS_CORE_4_0_1 } from "@stx-labs/signer-sidekick-protocol";
import { claritySourceSha256 } from "@stx-labs/signer-sidekick-protocol/manager-adapter";
import type {
  ApiStatus,
  ContractSource,
  NodeInfo,
  PoxInfo,
  StacksApiClient,
  StacksNodeClient,
} from "./chain-clients.js";
import type { SidekickConfig } from "./config.js";
import {
  type LoadedNetworkCompatibilityProfile,
  loadNetworkCompatibilityProfiles,
  type NetworkCompatibilityLoadIssue,
  type NetworkCompatibilityStore,
} from "./network-compatibility-store.js";

export type PreflightCheckStatus = "pass" | "warn" | "fail";

export interface PreflightCheck {
  id: string;
  status: PreflightCheckStatus;
  message: string;
}

export type Pox5ActivationState = "active" | "scheduled" | "unavailable";
export type NetworkCompatibilityStatus = "matched" | "unrecognized" | "inconsistent";

export interface PreflightResult {
  status: PreflightCheckStatus;
  network: SidekickConfig["network"];
  node: {
    networkId: number;
    parentNetworkId: number | null;
    serverVersion: string | null;
    version: string | null;
    commit: string | null;
    burnBlockHeight: number;
    stacksTipHeight: number;
  };
  api: {
    serverVersion: string;
    burnBlockHeight: number;
    stacksTipHeight: number;
    burnBlockLag: number;
  };
  pox: {
    activeContractId: string;
    rewardCycleId: number;
    rewardCycleLength: number;
    prepareCycleLength: number;
    activationState: Pox5ActivationState;
    pox5Available: boolean;
    pox5ContractId: string | null;
    scheduledPox5ContractId: string | null;
    activationBurnHeight: number | null;
    firstRewardCycleId: number | null;
    blocksUntilActivation: number | null;
    /** @deprecated Retained for API compatibility; use blocksUntilActivation. */
    blocksUntilEpoch4: number | null;
    sourceSha256: string | null;
    sbtcTokenContract: string | null;
    sbtcRegistryContract: string | null;
  };
  compatibility: {
    status: NetworkCompatibilityStatus;
    profileId: string | null;
    profileRevision: number | null;
    profileLabel: string | null;
    origin: LoadedNetworkCompatibilityProfile["origin"] | null;
    managerProfileId: string | null;
    managerSourceSha256: string | null;
    nodeBuildPreviouslyTested: boolean;
    reason: string;
    loadIssues: NetworkCompatibilityLoadIssue[];
  };
  cycle: {
    currentId: number;
    currentMinThresholdUstx: string | null;
    currentStackedUstx: string | null;
    nextId: number | null;
    nextMinThresholdUstx: string | null;
    nextStackedUstx: string | null;
    preparePhaseStartBurnHeight: number | null;
    blocksUntilPreparePhase: number | null;
    rewardPhaseStartBurnHeight: number | null;
    blocksUntilRewardPhase: number | null;
    isPreparePhase: boolean | null;
  };
  checks: PreflightCheck[];
}

export interface PreflightSources {
  nodeInfo: NodeInfo;
  nodePoxInfo: PoxInfo;
  apiNodeInfo: NodeInfo;
  apiStatus: ApiStatus;
  pox5Source?: ContractSource | null;
  pox5SourceError?: string | null;
  compatibilityStore?: NetworkCompatibilityStore;
}

function pox5VersionFrom(info: PoxInfo) {
  return info.contract_versions.find((version) => version.contract_id.endsWith(".pox-5"));
}

function bitcoinBlockCount(count: number): string {
  return `${count} Bitcoin ${count === 1 ? "block" : "blocks"}`;
}

export async function runOperatorPreflight(
  config: SidekickConfig,
  node: StacksNodeClient,
  api: StacksApiClient,
): Promise<PreflightResult> {
  const [nodeInfo, nodePoxInfo, apiNodeInfo, apiStatus, compatibilityStore] = await Promise.all([
    node.getInfo(),
    node.getPoxInfo(),
    api.getNodeInfo(),
    api.getStatus(),
    loadNetworkCompatibilityProfiles({
      ...(config.compatibilityProfilesDirectory
        ? { directory: config.compatibilityProfilesDirectory }
        : {}),
    }),
  ]);
  const pox5Version = pox5VersionFrom(nodePoxInfo);
  const pox5Active =
    nodePoxInfo.contract_id.endsWith(".pox-5") ||
    Boolean(
      pox5Version &&
        pox5Version.activation_burnchain_block_height <= nodePoxInfo.current_burnchain_block_height,
    );
  let pox5Source: ContractSource | null = null;
  let pox5SourceError: string | null = null;
  const pox5SourceContractId =
    pox5Version?.contract_id ??
    (nodePoxInfo.contract_id.endsWith(".pox-5") ? nodePoxInfo.contract_id : null);
  if (pox5Active && pox5SourceContractId) {
    try {
      pox5Source = await node.getContractSource(pox5SourceContractId);
    } catch (error) {
      pox5SourceError = error instanceof Error ? error.message : String(error);
    }
  }
  return evaluatePreflight(config, {
    nodeInfo,
    nodePoxInfo,
    apiNodeInfo,
    apiStatus,
    pox5Source,
    pox5SourceError,
    compatibilityStore,
  });
}

const networkIds: Record<SidekickConfig["network"], number> = {
  mainnet: 1,
  testnet: 0x80000005,
  devnet: 0x80000000,
  regtest: 0x80000000,
};

function overallStatus(checks: readonly PreflightCheck[]): PreflightCheckStatus {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "warn")) return "warn";
  return "pass";
}

function nodeBuild(serverVersion: string | undefined): {
  version: string | null;
  commit: string | null;
} {
  if (!serverVersion) return { version: null, commit: null };
  const match = /^stacks-node\s+(\S+)(?:\s+\(([0-9a-f]{7,40})\b)?/i.exec(serverVersion);
  return { version: match?.[1] ?? null, commit: match?.[2]?.toLowerCase() ?? null };
}

function selectCompatibilityProfile(
  config: SidekickConfig,
  sources: PreflightSources,
  pox5ContractId: string | null,
  pox5SourceSha256: string | null,
): {
  status: NetworkCompatibilityStatus;
  selected: LoadedNetworkCompatibilityProfile | null;
  reason: string;
} {
  const profiles = sources.compatibilityStore?.profiles ?? [];
  const networkCandidates = profiles.filter(
    ({ profile }) =>
      profile.network === config.network && profile.networkId === sources.nodeInfo.network_id,
  );
  if (networkCandidates.length === 0) {
    return {
      status: "unrecognized",
      selected: null,
      reason: "No compatibility profile is installed for this network fingerprint",
    };
  }
  if (!pox5ContractId) {
    return {
      status: "unrecognized",
      selected: null,
      reason: "A compatibility profile exists, but the node does not advertise PoX-5 yet",
    };
  }
  const contractCandidates = pox5ContractId
    ? networkCandidates.filter(({ profile }) => profile.pox5.contractId === pox5ContractId)
    : networkCandidates;
  if (contractCandidates.length === 0) {
    return {
      status: "inconsistent",
      selected: null,
      reason: "The network ID is known, but its PoX-5 contract differs from the installed profile",
    };
  }
  const sbtcToken = sources.nodePoxInfo.pox_5_sbtc_contract;
  const sbtcRegistry = sources.nodePoxInfo.pox_5_sbtc_registry_contract;
  const identityCandidates = contractCandidates.filter(
    ({ profile }) =>
      (!pox5SourceSha256 || profile.pox5.sourceSha256 === pox5SourceSha256) &&
      (!sbtcToken || profile.sbtc.tokenContract === sbtcToken) &&
      (!sbtcRegistry || profile.sbtc.registryContract === sbtcRegistry),
  );
  if (identityCandidates.length !== 1) {
    return {
      status: "inconsistent",
      selected: null,
      reason:
        identityCandidates.length > 1
          ? "Multiple compatibility profiles match this network fingerprint"
          : "Live PoX-5 source or sBTC contracts differ from the installed network profile",
    };
  }
  const selected = identityCandidates[0] ?? null;
  return {
    status: "matched",
    selected,
    reason: selected
      ? `Live network fingerprint matches ${selected.profile.label}`
      : "Live network fingerprint matched",
  };
}

function profileCheckStatus(
  config: SidekickConfig,
  status: NetworkCompatibilityStatus,
): PreflightCheckStatus {
  if (status === "matched") return "pass";
  if (status === "inconsistent") return "fail";
  return config.network === "devnet" || config.network === "regtest" ? "pass" : "warn";
}

export function evaluatePreflight(
  config: SidekickConfig,
  sources: PreflightSources,
): PreflightResult {
  const { nodeInfo, nodePoxInfo, apiNodeInfo, apiStatus } = sources;
  const checks: PreflightCheck[] = [];
  const expectedNetworkId = config.expectedNetworkId ?? networkIds[config.network];

  checks.push({
    id: "node-network",
    status: nodeInfo.network_id === expectedNetworkId ? "pass" : "fail",
    message:
      nodeInfo.network_id === expectedNetworkId
        ? `Node network ID matches ${config.network}`
        : `Node network ID ${nodeInfo.network_id} does not match ${config.network}`,
  });
  checks.push({
    id: "api-network",
    status:
      apiNodeInfo.network_id === expectedNetworkId && apiNodeInfo.network_id === nodeInfo.network_id
        ? "pass"
        : "fail",
    message:
      apiNodeInfo.network_id === expectedNetworkId && apiNodeInfo.network_id === nodeInfo.network_id
        ? "API and node network IDs agree"
        : `API network ID ${apiNodeInfo.network_id} disagrees with configured/node network`,
  });

  const build = nodeBuild(nodeInfo.server_version);
  checks.push({
    id: "node-build",
    status: nodeInfo.server_version ? "pass" : "warn",
    message: nodeInfo.server_version
      ? `Node build recorded as ${nodeInfo.server_version}; compatibility is determined from live capabilities and contracts`
      : "Node did not report its build; compatibility is determined from live capabilities and contracts",
  });

  const apiMajorMatch = /stacks-blockchain-api v(\d+)\./.exec(apiStatus.server_version);
  const apiMajor = apiMajorMatch?.[1] ? Number(apiMajorMatch[1]) : null;
  checks.push({
    id: "api-version",
    status: apiMajor !== null && apiMajor >= 9 ? "pass" : "fail",
    message:
      apiMajor !== null && apiMajor >= 9
        ? `Stacks API major version ${apiMajor} is supported`
        : `Unable to confirm Stacks API v9+ from ${apiStatus.server_version}`,
  });
  checks.push({
    id: "api-status",
    status: apiStatus.status === "ready" ? "pass" : "fail",
    message: `Stacks API status is ${apiStatus.status}`,
  });

  const burnBlockDifference = nodeInfo.burn_block_height - apiStatus.chain_tip.burn_block_height;
  const burnBlockLag = Math.abs(burnBlockDifference);
  const apiTipPosition =
    burnBlockDifference === 0 ? "at the node tip" : burnBlockDifference > 0 ? "behind" : "ahead of";
  checks.push({
    id: "api-lag",
    status: burnBlockLag <= config.maxApiBurnBlockLag ? "pass" : "warn",
    message:
      burnBlockDifference === 0
        ? "API Bitcoin tip is at the node Bitcoin tip"
        : `API Bitcoin tip is ${bitcoinBlockCount(burnBlockLag)} ${apiTipPosition} the node`,
  });

  const pox5Version = pox5VersionFrom(nodePoxInfo);
  const activationBurnHeight =
    pox5Version?.activation_burnchain_block_height ??
    (config.network === "mainnet" ? STACKS_CORE_4_0_1.mainnetEpoch4ActivationBurnHeight : null);
  const blocksUntilActivation =
    activationBurnHeight === null
      ? null
      : Math.max(0, activationBurnHeight - nodePoxInfo.current_burnchain_block_height);
  const isPox5Active =
    nodePoxInfo.contract_id.endsWith(".pox-5") ||
    Boolean(pox5Version && blocksUntilActivation === 0);
  const activationState: Pox5ActivationState = isPox5Active
    ? "active"
    : pox5Version
      ? "scheduled"
      : "unavailable";
  const pox5ContractId = isPox5Active
    ? nodePoxInfo.contract_id.endsWith(".pox-5")
      ? nodePoxInfo.contract_id
      : (pox5Version?.contract_id ?? null)
    : null;
  const scheduledPox5ContractId = pox5Version?.contract_id ?? null;
  checks.push({
    id: "pox5",
    status:
      activationState === "active" ? "pass" : activationState === "scheduled" ? "warn" : "fail",
    message:
      activationState === "active"
        ? "PoX-5 is active on the connected node"
        : activationState === "scheduled"
          ? `PoX-5 is scheduled at Bitcoin block ${activationBurnHeight}; ${bitcoinBlockCount(blocksUntilActivation ?? 0)} remain`
          : "The connected node does not advertise a PoX-5 contract or activation",
  });

  const sbtcFieldsPresent = Boolean(
    nodePoxInfo.pox_5_sbtc_contract && nodePoxInfo.pox_5_sbtc_registry_contract,
  );
  checks.push({
    id: "pox5-sbtc-contracts",
    status: sbtcFieldsPresent ? "pass" : activationState === "active" ? "fail" : "warn",
    message: sbtcFieldsPresent
      ? "Node reports the PoX-5 sBTC token and registry contracts"
      : "Node does not yet report both PoX-5 sBTC contract fields",
  });

  const pox5SourceSha256 = sources.pox5Source
    ? claritySourceSha256(sources.pox5Source.source)
    : null;
  if (activationState === "active") {
    checks.push({
      id: "pox5-source",
      status: pox5SourceSha256 ? "pass" : "fail",
      message: pox5SourceSha256
        ? `Read active PoX-5 source from the configured node (${pox5SourceSha256})`
        : "Could not read active PoX-5 source from the configured node; check Node RPC connectivity and compatibility",
    });
  }

  const compatibility = selectCompatibilityProfile(
    config,
    sources,
    pox5ContractId ?? scheduledPox5ContractId,
    pox5SourceSha256,
  );
  checks.push({
    id: "network-compatibility",
    status: profileCheckStatus(config, compatibility.status),
    message:
      compatibility.status === "unrecognized" &&
      (config.network === "devnet" || config.network === "regtest")
        ? "Isolated development network uses capability checks without a launch profile"
        : compatibility.reason,
  });
  for (const issue of sources.compatibilityStore?.issues ?? []) {
    checks.push({
      id: `compatibility-profile:${issue.fileName ?? issue.code}`,
      status: "warn",
      message: `Compatibility profile ignored: ${issue.message}`,
    });
  }

  const selectedProfile = compatibility.selected?.profile ?? null;
  const nodeBuildPreviouslyTested = Boolean(
    selectedProfile &&
      nodeInfo.server_version &&
      selectedProfile.testedNodeBuilds.includes(nodeInfo.server_version),
  );
  const currentCycle = nodePoxInfo.current_cycle;
  const nextCycle = nodePoxInfo.next_cycle;
  const isPreparePhase = nextCycle
    ? nextCycle.blocks_until_prepare_phase <= 0 && nextCycle.blocks_until_reward_phase > 0
    : null;

  return {
    status: overallStatus(checks),
    network: config.network,
    node: {
      networkId: nodeInfo.network_id,
      parentNetworkId: nodeInfo.parent_network_id ?? null,
      serverVersion: nodeInfo.server_version ?? null,
      version: build.version,
      commit: build.commit,
      burnBlockHeight: nodeInfo.burn_block_height,
      stacksTipHeight: nodeInfo.stacks_tip_height,
    },
    api: {
      serverVersion: apiStatus.server_version,
      burnBlockHeight: apiStatus.chain_tip.burn_block_height,
      stacksTipHeight: apiStatus.chain_tip.block_height,
      burnBlockLag,
    },
    pox: {
      activeContractId: nodePoxInfo.contract_id,
      rewardCycleId: nodePoxInfo.reward_cycle_id,
      rewardCycleLength: nodePoxInfo.reward_cycle_length,
      prepareCycleLength: nodePoxInfo.prepare_cycle_length,
      activationState,
      pox5Available: activationState === "active",
      pox5ContractId,
      scheduledPox5ContractId,
      activationBurnHeight,
      firstRewardCycleId: pox5Version?.first_reward_cycle_id ?? null,
      blocksUntilActivation,
      blocksUntilEpoch4: blocksUntilActivation,
      sourceSha256: pox5SourceSha256,
      sbtcTokenContract: nodePoxInfo.pox_5_sbtc_contract ?? null,
      sbtcRegistryContract: nodePoxInfo.pox_5_sbtc_registry_contract ?? null,
    },
    compatibility: {
      status: compatibility.status,
      profileId: selectedProfile?.id ?? null,
      profileRevision: selectedProfile?.revision ?? null,
      profileLabel: selectedProfile?.label ?? null,
      origin: compatibility.selected?.origin ?? null,
      managerProfileId: selectedProfile?.referenceManager.profileId ?? null,
      managerSourceSha256: selectedProfile?.referenceManager.sourceSha256 ?? null,
      nodeBuildPreviouslyTested,
      reason: compatibility.reason,
      loadIssues: sources.compatibilityStore?.issues ?? [],
    },
    cycle: {
      currentId: currentCycle?.id ?? nodePoxInfo.reward_cycle_id,
      currentMinThresholdUstx: currentCycle ? String(currentCycle.min_threshold_ustx) : null,
      currentStackedUstx: currentCycle ? String(currentCycle.stacked_ustx) : null,
      nextId: nextCycle?.id ?? null,
      nextMinThresholdUstx: nextCycle ? String(nextCycle.min_threshold_ustx) : null,
      nextStackedUstx: nextCycle ? String(nextCycle.stacked_ustx) : null,
      preparePhaseStartBurnHeight: nextCycle?.prepare_phase_start_block_height ?? null,
      blocksUntilPreparePhase: nextCycle ? Math.max(0, nextCycle.blocks_until_prepare_phase) : null,
      rewardPhaseStartBurnHeight: nextCycle?.reward_phase_start_block_height ?? null,
      blocksUntilRewardPhase: nextCycle ? Math.max(0, nextCycle.blocks_until_reward_phase) : null,
      isPreparePhase,
    },
    checks,
  };
}
