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
    nodeInfo: { network_id: 1, burn_block_height: 958_100, stacks_tip_height: 8_500_000 },
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
      contract_versions: [],
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
    const result = evaluatePreflight(
      config,
      sources({
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
      }),
    );

    expect(result.pox).toMatchObject({ pox5Available: false, pox5ContractId: null });
  });

  it("fails closed on a node/API network mismatch", () => {
    const result = evaluatePreflight(
      config,
      sources({
        apiNodeInfo: {
          network_id: 0x80000000,
          burn_block_height: 194_760,
          stacks_tip_height: 4_042_210,
        },
      }),
    );

    expect(result.status).toBe("fail");
    expect(result.checks.find((check) => check.id === "api-network")).toMatchObject({
      status: "fail",
    });
  });

  it("warns when the API is unexpectedly ahead of the configured node", () => {
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
      status: "warn",
      message: "API burnchain tip is 20 block(s) ahead of the node",
    });
  });

  it("requires PoX-5 once Epoch 4.0 has activated", () => {
    const result = evaluatePreflight(
      config,
      sources({
        nodeInfo: { network_id: 1, burn_block_height: 960_230, stacks_tip_height: 8_600_000 },
      }),
    );

    expect(result.status).toBe("fail");
    expect(result.checks.find((check) => check.id === "pox5")).toMatchObject({ status: "fail" });
  });

  it("passes when PoX-5 is available and the API is within lag policy", () => {
    const result = evaluatePreflight(
      config,
      sources({
        nodeInfo: { network_id: 1, burn_block_height: 960_240, stacks_tip_height: 8_600_000 },
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
          current_cycle: {
            id: 140,
            min_threshold_ustx: 120_000_000_000,
            stacked_ustx: 550_000_000_000_000,
            is_pox_active: true,
          },
          next_cycle: {
            id: 141,
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
      }),
    );

    expect(result.status).toBe("pass");
    expect(result.pox.pox5Available).toBe(true);
    expect(result.cycle).toMatchObject({
      currentId: 140,
      currentMinThresholdUstx: "120000000000",
      nextId: 141,
      nextMinThresholdUstx: "50000000000",
      preparePhaseStartBurnHeight: 962_050,
      blocksUntilPreparePhase: 1_810,
      isPreparePhase: false,
    });
  });
});
