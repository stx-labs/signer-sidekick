import { STACKS_CORE_4_0_0 } from "@stx-labs/signer-sidekick-protocol";
import type { ApiStatus, NodeInfo, PoxInfo } from "./chain-clients.js";
import type { SidekickConfig } from "./config.js";

export type PreflightCheckStatus = "pass" | "warn" | "fail";

export interface PreflightCheck {
  id: string;
  status: PreflightCheckStatus;
  message: string;
}

export interface PreflightResult {
  status: PreflightCheckStatus;
  network: SidekickConfig["network"];
  node: {
    networkId: number;
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
    pox5Available: boolean;
    blocksUntilEpoch4: number | null;
  };
  checks: PreflightCheck[];
}

export interface PreflightSources {
  nodeInfo: NodeInfo;
  nodePoxInfo: PoxInfo;
  apiNodeInfo: NodeInfo;
  apiStatus: ApiStatus;
}

const networkIds: Record<SidekickConfig["network"], number> = {
  mainnet: 1,
  testnet: 0x80000000,
  devnet: 0x80000000,
  regtest: 0x80000000,
};

function overallStatus(checks: readonly PreflightCheck[]): PreflightCheckStatus {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "warn")) return "warn";
  return "pass";
}

export function evaluatePreflight(
  config: SidekickConfig,
  sources: PreflightSources,
): PreflightResult {
  const { nodeInfo, nodePoxInfo, apiNodeInfo, apiStatus } = sources;
  const checks: PreflightCheck[] = [];
  const expectedNetworkId = networkIds[config.network];

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
        ? "API burnchain tip is at the node tip"
        : `API burnchain tip is ${burnBlockLag} block(s) ${apiTipPosition} the node`,
  });

  const pox5Available =
    nodePoxInfo.contract_id.endsWith(".pox-5") ||
    nodePoxInfo.contract_versions.some((version) => version.contract_id.endsWith(".pox-5"));
  const blocksUntilEpoch4 =
    config.network === "mainnet"
      ? Math.max(
          0,
          STACKS_CORE_4_0_0.mainnetEpoch4ActivationBurnHeight - nodeInfo.burn_block_height,
        )
      : null;
  const pox5Required = config.network === "mainnet" ? blocksUntilEpoch4 === 0 : true;
  checks.push({
    id: "pox5",
    status: pox5Available ? "pass" : pox5Required ? "fail" : "warn",
    message: pox5Available
      ? "PoX-5 is available from the connected node"
      : pox5Required
        ? "PoX-5 is not available after the configured Epoch 4.0 activation height"
        : `PoX-5 is not active yet; ${blocksUntilEpoch4 ?? "an unknown number of"} burn block(s) remain`,
  });

  return {
    status: overallStatus(checks),
    network: config.network,
    node: {
      networkId: nodeInfo.network_id,
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
      pox5Available,
      blocksUntilEpoch4,
    },
    checks,
  };
}
