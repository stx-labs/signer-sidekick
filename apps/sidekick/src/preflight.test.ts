import { MAINNET_4_0_1_COMPATIBILITY } from "@stx-labs/signer-sidekick-protocol/known-network-compatibility";
import { claritySourceSha256 } from "@stx-labs/signer-sidekick-protocol/manager-adapter";
import { describe, expect, it } from "vitest";
import type { SidekickConfig } from "./config.js";
import { evaluatePreflight, type PreflightSources } from "./preflight.js";

const config: SidekickConfig = {
  network: "mainnet",
  nodeRpcUrl: "http://127.0.0.1:20443",
  apiUrl: "https://api.mainnet.hiro.so",
  apiKeyHeader: "x-api-key",
  maxApiBurnBlockLag: 12,
  forecastHorizonCycles: 6,
  databasePath: "/tmp/sidekick.sqlite",
};

function sources(overrides: Partial<PreflightSources> = {}): PreflightSources {
  return {
    nodeInfo: {
      server_version: "stacks-node 4.0.1.0.0 (62e03cc, release build, linux [x86_64])",
      network_id: 1,
      burn_block_height: 958_100,
      stacks_tip_height: 8_500_000,
    },
    apiNodeInfo: { network_id: 1, burn_block_height: 958_098, stacks_tip_height: 8_499_990 },
    apiStatus: {
      server_version: "stacks-blockchain-api v9.0.0 (HEAD:3aa0ae7)",
      status: "ready",
      chain_tip: {
        block_height: 8_499_990,
        block_hash: "0x01",
        index_block_hash: "0x02",
        burn_block_height: 958_098,
      },
    },
    nodePoxInfo: {
      current_burnchain_block_height: 958_100,
      reward_cycle_id: 139,
      reward_cycle_length: 2_100,
      prepare_cycle_length: 100,
      contract_id: "SP000000000000000000002Q6VF78.pox-4",
      pox_5_sbtc_contract: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
      pox_5_sbtc_registry_contract: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-registry",
      contract_versions: [
        {
          contract_id: "SP000000000000000000002Q6VF78.pox-5",
          activation_burnchain_block_height: 960_230,
          first_reward_cycle_id: 141,
        },
      ],
    },
    ...overrides,
  };
}

describe("operator preflight", () => {
  it("reports a pre-activation warning without failing healthy endpoints", () => {
    const result = evaluatePreflight(config, sources());

    expect(result.status).toBe("warn");
    expect(result.pox.blocksUntilEpoch4).toBe(2_130);
    expect(result.checks.find((check) => check.id === "pox5")).toMatchObject({
      status: "warn",
    });
  });

  it("does not call a scheduled PoX-5 version available before its activation height", () => {
    const baseline = sources();
    const activeSources = sources({
      nodePoxInfo: {
        ...baseline.nodePoxInfo,
        contract_versions: [
          {
            contract_id: "SP000000000000000000002Q6VF78.pox-5",
            activation_burnchain_block_height: 960_230,
            first_reward_cycle_id: 141,
          },
        ],
      },
    });
    const result = evaluatePreflight(config, activeSources);

    expect(result.pox).toMatchObject({ pox5Available: false, pox5ContractId: null });
  });

  it("degrades indexed features without failing local-node readiness on an API mismatch", () => {
    const result = evaluatePreflight(
      config,
      sources({
        apiNodeInfo: {
          network_id: 0x80000000,
          burn_block_height: 194_760,
          stacks_tip_height: 4_042_210,
        },
        apiStatus: {
          server_version: "stacks-blockchain-api v9.0.0 (HEAD:3aa0ae7)",
          status: "ready",
          chain_tip: {
            block_height: 8_500_010,
            block_hash: "0x03",
            index_block_hash: "0x04",
            burn_block_height: 958_101,
          },
        },
      }),
    );

    expect(result.status).toBe("warn");
    expect(result.api.networkCompatible).toBe(false);
    expect(result.checks.find((check) => check.id === "api-network")).toMatchObject({
      status: "warn",
    });
    expect(result.checks.find((check) => check.id === "api-lag")).toMatchObject({
      status: "warn",
    });
  });

  it("accepts a custom network_id when expectedNetworkId overrides the network default", () => {
    const customNetwork = { ...config, network: "regtest" as const, expectedNetworkId: 256 };
    const result = evaluatePreflight(
      customNetwork,
      sources({
        nodeInfo: { network_id: 256, burn_block_height: 5_636, stacks_tip_height: 192_259 },
        apiNodeInfo: { network_id: 256, burn_block_height: 5_636, stacks_tip_height: 192_259 },
      }),
    );

    expect(result.checks.find((check) => check.id === "node-network")).toMatchObject({
      status: "pass",
    });
    expect(result.checks.find((check) => check.id === "api-network")).toMatchObject({
      status: "pass",
    });
  });

  it("uses the PoX-5 Testnet network ID for testnet", () => {
    const testnetConfig = { ...config, network: "testnet" as const };
    const result = evaluatePreflight(
      testnetConfig,
      sources({
        nodeInfo: {
          network_id: 0x80000005,
          burn_block_height: 5_636,
          stacks_tip_height: 192_259,
        },
        apiNodeInfo: {
          network_id: 0x80000005,
          burn_block_height: 5_636,
          stacks_tip_height: 192_259,
        },
      }),
    );

    expect(result.checks.find((check) => check.id === "node-network")).toMatchObject({
      status: "pass",
    });
    expect(result.checks.find((check) => check.id === "api-network")).toMatchObject({
      status: "pass",
    });
  });

  it("fails readiness when the local node is behind the API", () => {
    const result = evaluatePreflight(
      config,
      sources({
        apiStatus: {
          server_version: "stacks-blockchain-api v9.0.0",
          status: "ready",
          chain_tip: {
            block_height: 8_500_100,
            block_hash: "0x01",
            index_block_hash: "0x02",
            burn_block_height: 958_120,
          },
        },
      }),
    );

    expect(result.api.burnBlockLag).toBe(20);
    expect(result.checks.find((check) => check.id === "api-lag")).toMatchObject({
      status: "fail",
      message: "The local node trails the API by 20 Bitcoin blocks and 100 Stacks blocks",
    });
  });

  it("reports a lagging API diagnostically without treating it as a coherent sync anchor", () => {
    const result = evaluatePreflight(
      config,
      sources({
        apiStatus: {
          server_version: "stacks-blockchain-api v9.0.0",
          status: "ready",
          chain_tip: {
            block_height: 8_499_900,
            block_hash: "0x01",
            index_block_hash: "0x02",
            burn_block_height: 958_080,
          },
        },
      }),
    );

    expect(result.api.burnBlockLag).toBe(20);
    expect(result.checks.find((check) => check.id === "api-lag")).toMatchObject({
      status: "warn",
      message: "API chain data is behind the local node by 20 Bitcoin blocks and 100 Stacks blocks",
    });
  });

  it("keeps local-node preflight usable when the Reference API is unavailable", () => {
    const baseline = sources();
    const result = evaluatePreflight(config, {
      ...baseline,
      apiNodeInfo: null,
      apiStatus: null,
      apiError: "reference API unavailable",
    });

    expect(result.status).toBe("warn");
    expect(result.api).toMatchObject({
      available: false,
      networkCompatible: false,
      position: "unavailable",
      error: "reference API unavailable",
    });
    expect(result.checks.find((check) => check.id === "api-availability")).toMatchObject({
      status: "warn",
    });
    expect(result.checks.find((check) => check.id === "node-network")).toMatchObject({
      status: "pass",
    });
  });

  it("requires PoX-5 once Epoch 4.0 has activated", () => {
    const baseline = sources();
    const result = evaluatePreflight(
      config,
      sources({
        nodeInfo: { network_id: 1, burn_block_height: 960_230, stacks_tip_height: 8_600_000 },
        nodePoxInfo: {
          ...baseline.nodePoxInfo,
          current_burnchain_block_height: 960_230,
          contract_versions: [],
        },
      }),
    );

    expect(result.status).toBe("fail");
    expect(result.checks.find((check) => check.id === "pox5")).toMatchObject({ status: "fail" });
  });

  it("passes when PoX-5 is available and the API is within lag policy", () => {
    const poxSource = "(define-public (test) (ok true))";
    const profile = {
      ...MAINNET_4_0_1_COMPATIBILITY,
      pox5: {
        ...MAINNET_4_0_1_COMPATIBILITY.pox5,
        sourceSha256: claritySourceSha256(poxSource),
      },
      testedNodeBuilds: [],
    };
    const activeSources = sources({
      nodeInfo: {
        server_version: "stacks-node 9.9.9.0.0 (abcdef0, release build, linux [x86_64])",
        network_id: 1,
        burn_block_height: 960_240,
        stacks_tip_height: 8_600_000,
      },
      apiNodeInfo: { network_id: 1, burn_block_height: 960_238, stacks_tip_height: 8_599_990 },
      apiStatus: {
        server_version: "stacks-blockchain-api v9.0.0",
        status: "ready",
        chain_tip: {
          block_height: 8_599_990,
          block_hash: "0x01",
          index_block_hash: "0x02",
          burn_block_height: 960_238,
        },
      },
      nodePoxInfo: {
        current_burnchain_block_height: 960_240,
        reward_cycle_id: 141,
        reward_cycle_length: 2_100,
        prepare_cycle_length: 100,
        contract_id: "SP000000000000000000002Q6VF78.pox-5",
        pox_5_sbtc_contract: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
        pox_5_sbtc_registry_contract: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-registry",
        current_cycle: {
          id: 141,
          min_threshold_ustx: 120_000_000_000,
          stacked_ustx: 550_000_000_000_000,
          is_pox_active: true,
        },
        next_cycle: {
          id: 142,
          min_threshold_ustx: 50_000_000_000,
          min_increment_ustx: 10_000_000_000,
          stacked_ustx: 75_000_000_000,
          prepare_phase_start_block_height: 962_050,
          blocks_until_prepare_phase: 1_810,
          reward_phase_start_block_height: 962_150,
          blocks_until_reward_phase: 1_910,
        },
        contract_versions: [
          {
            contract_id: "SP000000000000000000002Q6VF78.pox-5",
            activation_burnchain_block_height: 960_230,
            first_reward_cycle_id: 141,
          },
        ],
      },
      pox5Source: { source: poxSource, publish_height: 1 },
      compatibilityStore: {
        directory: null,
        profiles: [{ profile, origin: "built-in", fileName: null }],
        issues: [],
      },
    });
    const result = evaluatePreflight(config, activeSources);

    expect(result.status).toBe("pass");
    expect(result.pox.pox5Available).toBe(true);
    expect(result.node).toMatchObject({ version: "9.9.9.0.0", commit: "abcdef0" });
    expect(result.compatibility).toMatchObject({
      status: "matched",
      nodeBuildPreviouslyTested: false,
    });
    expect(result.cycle).toMatchObject({
      currentId: 141,
      currentMinThresholdUstx: "120000000000",
      nextId: 142,
      nextMinThresholdUstx: "50000000000",
      preparePhaseStartBurnHeight: 962_050,
      blocksUntilPreparePhase: 1_810,
      isPreparePhase: false,
    });

    const mismatch = evaluatePreflight(config, {
      ...activeSources,
      pox5Source: { source: `${poxSource}\n;; changed`, publish_height: 1 },
    });
    expect(mismatch.status).toBe("fail");
    expect(mismatch.compatibility).toMatchObject({ status: "inconsistent" });
  });
});
