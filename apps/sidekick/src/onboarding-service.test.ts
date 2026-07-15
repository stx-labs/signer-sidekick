import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SidekickConfig } from "./config.js";
import { OnboardingService } from "./onboarding-service.js";
import type { RuntimeSettingsController } from "./runtime-settings.js";
import { openSidekickStore, type SidekickStore } from "./storage/store.js";

const managerPrincipal = "SP000000000000000000002Q6VF78.signer-manager";
const stores: SidekickStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function service() {
  const { store } = await openSidekickStore(":memory:", "2026-07-15T12:00:00.000Z");
  stores.push(store);
  const config: SidekickConfig = {
    network: "mainnet",
    nodeRpcUrl: "http://127.0.0.1:20443",
    apiUrl: "https://api.mainnet.hiro.so",
    apiKeyHeader: "x-api-key",
    maxApiBurnBlockLag: 12,
    forecastHorizonCycles: 6,
    databasePath: ":memory:",
  };
  const node = {
    getInfo: async () => ({
      network_id: 1,
      burn_block_height: 960_240,
      stacks_tip_height: 8_600_000,
    }),
    getPoxInfo: async () => ({
      current_burnchain_block_height: 960_240,
      reward_cycle_id: 141,
      reward_cycle_length: 2_100,
      prepare_cycle_length: 100,
      contract_id: "SP000000000000000000002Q6VF78.pox-5",
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
    }),
  };
  const api = {
    getNodeInfo: async () => ({
      network_id: 1,
      burn_block_height: 960_238,
      stacks_tip_height: 8_599_990,
    }),
    getStatus: async () => ({
      server_version: "stacks-blockchain-api v9.0.0",
      status: "ready",
      chain_tip: {
        block_height: 8_599_990,
        block_hash: "0x01",
        index_block_hash: "0x02",
        burn_block_height: 960_238,
      },
    }),
  };
  const runtimeSettings = {
    clients: () => ({ config, node, api }),
  } as unknown as RuntimeSettingsController;
  return new OnboardingService({
    store,
    runtimeSettings,
    managerPrincipal,
    contractsDirectory: resolve(import.meta.dirname, "../../../contracts"),
  });
}

describe("onboarding service", () => {
  it("persists a resumable fresh path and creates deterministic download artifacts", async () => {
    const onboarding = await service();
    expect(onboarding.start("fresh")).toMatchObject({
      path: "fresh",
      currentStep: "preflight",
      safety: { acceptsManagerAdminKey: false, acceptsSignerPrivateKey: false },
    });

    const prepared = await onboarding.prepareFresh({
      adminPrincipal: "SP000000000000000000002Q6VF78",
      contractName: "signer-manager",
      authId: "7",
      signerConfigPath: "/etc/stacks-signer/signer.toml",
    });
    expect(prepared).toMatchObject({
      path: "fresh",
      managerPrincipal,
      artifact: { available: true, sourceFile: "signer-manager.clar" },
      freshInput: { authId: "7" },
    });
    expect(prepared.activationPlan?.steps.find(({ id }) => id === "render-manager")?.status).toBe(
      "complete",
    );
    expect(onboarding.artifact("source").body).toContain("define-public (register-self");
    expect(JSON.parse(onboarding.artifact("manifest").body)).toMatchObject({
      managerPrincipal,
      transaction: { signingAuthority: "external-offline-admin" },
    });
    expect(onboarding.get()).toMatchObject({ currentStep: prepared.currentStep });
  });

  it("refuses a fresh principal that differs from the configured deployment", async () => {
    const onboarding = await service();
    onboarding.start("fresh");
    await expect(
      onboarding.prepareFresh({
        adminPrincipal: "SP2JXKMSH007NPYAQHKJPQMAQYAD90NQGTVJVQ02B",
        contractName: "different-manager",
        authId: "1",
        signerConfigPath: "/tmp/signer.toml",
      }),
    ).rejects.toThrow("must match SIDEKICK_MANAGER_PRINCIPAL");
  });
});
