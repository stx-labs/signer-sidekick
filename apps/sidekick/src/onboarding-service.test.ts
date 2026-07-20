import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { bufferCV } from "@stacks/transactions";
import { MAINNET_4_0_1_COMPATIBILITY } from "@stx-labs/signer-sidekick-protocol/known-network-compatibility";
import { afterEach, describe, expect, it } from "vitest";
import { UpstreamHttpError } from "./chain-clients.js";
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
  const pox5Source = await readFile(
    resolve(import.meta.dirname, "../../../contracts/upstream/stacks-core-4.0.1/pox-5.clar"),
    "utf8",
  );
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
      pox_5_sbtc_contract: MAINNET_4_0_1_COMPATIBILITY.sbtc.tokenContract,
      pox_5_sbtc_registry_contract: MAINNET_4_0_1_COMPATIBILITY.sbtc.registryContract,
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
    getContractSource: async (principal: string) => {
      if (principal === managerPrincipal) throw new UpstreamHttpError("not found", 404);
      return { source: pox5Source, publish_height: 8_500_000 };
    },
    callReadOnly: async () => bufferCV(Buffer.alloc(32, 7)),
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
  return {
    store,
    onboarding: new OnboardingService({
      store,
      runtimeSettings,
      managerPrincipal,
      contractsDirectory: resolve(import.meta.dirname, "../../../contracts"),
    }),
  };
}

describe("onboarding service", () => {
  it("persists a resumable fresh path and creates deterministic download artifacts", async () => {
    const { onboarding, store } = await service();
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
    expect(store.listOnboardingAudit().map(({ action }) => action)).toEqual([
      "fresh-prepared",
      "path-started",
    ]);
  });

  it("refuses a fresh principal that differs from the configured deployment", async () => {
    const { onboarding } = await service();
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

  it("preserves progress on same-path starts and requires confirmation to switch paths", async () => {
    const { onboarding } = await service();
    onboarding.start("fresh");
    const prepared = await onboarding.prepareFresh({
      adminPrincipal: "SP000000000000000000002Q6VF78",
      contractName: "signer-manager",
      authId: "7",
      signerConfigPath: "/etc/stacks-signer/signer.toml",
    });

    expect(onboarding.start("fresh")).toMatchObject({
      currentStep: prepared.currentStep,
      artifact: { available: true },
    });
    expect(() => onboarding.start("attach")).toThrow("requires explicit reset confirmation");
    expect(onboarding.start("attach", true)).toMatchObject({
      path: "attach",
      currentStep: "preflight",
      artifact: { available: false },
    });
  });

  it("fails closed to no public state when persisted onboarding JSON is invalid", async () => {
    const { onboarding, store } = await service();
    store.putOnboardingState({
      path: "fresh",
      currentStep: "deploy-manager",
      status: "in-progress",
      state: { schemaVersion: 999, managerPrincipal },
      updatedAt: "2026-07-15T12:10:00.000Z",
      auditAction: "invalid-test-state",
    });

    expect(onboarding.get()).toBeNull();
    expect(() => onboarding.artifact("source")).toThrow("Stored onboarding state is invalid");
  });

  it("records a reversible wizard dismissal without discarding onboarding progress", async () => {
    const { onboarding } = await service();
    onboarding.start("fresh", false, "2026-07-15T12:05:00.000Z");
    const prepared = await onboarding.prepareFresh(
      {
        adminPrincipal: "SP000000000000000000002Q6VF78",
        contractName: "signer-manager",
        authId: "7",
        signerConfigPath: "/etc/stacks-signer/signer.toml",
      },
      "2026-07-15T12:10:00.000Z",
    );

    expect(onboarding.dismissWizard("2026-07-15T12:15:00.000Z")).toMatchObject({
      dismissed: true,
      dismissedAt: "2026-07-15T12:15:00.000Z",
      audit: [{ action: "dismissed" }],
    });
    expect(onboarding.get()).toMatchObject({
      path: "fresh",
      currentStep: prepared.currentStep,
      artifact: { available: true },
    });
    expect(onboarding.resumeWizard("2026-07-15T12:20:00.000Z")).toMatchObject({
      dismissed: false,
      dismissedAt: null,
      audit: [{ action: "resumed" }, { action: "dismissed" }],
    });
    expect(onboarding.get()).toMatchObject({
      path: "fresh",
      currentStep: prepared.currentStep,
      artifact: { available: true },
    });
  });

  it("prepares a fresh signer grant from the Attach path without reopening Fresh Setup", async () => {
    const { onboarding, store } = await service();
    onboarding.start("attach", false, "2026-07-19T12:00:00.000Z");

    const prepared = await onboarding.prepareManagerSignerGrant(
      {
        authId: "8",
        signerConfigPath: "/etc/stacks-signer/signer.toml",
      },
      "2026-07-19T12:01:00.000Z",
    );

    expect(prepared).toMatchObject({
      path: "attach",
      currentStep: "preflight",
      signerGrant: {
        preparation: {
          managerPrincipal,
          pox5ContractId: MAINNET_4_0_1_COMPATIBILITY.pox5.contractId,
          authId: "8",
          expectedMessageHashHex: "07".repeat(32),
        },
        verified: null,
      },
    });
    expect(prepared.signerGrant.preparation?.command).toContain(
      "--config '/etc/stacks-signer/signer.toml'",
    );
    expect(store.listOnboardingAudit().map(({ action }) => action)).toEqual([
      "manager-grant-prepared",
      "path-started",
    ]);
  });

  it("discards stale onboarding manager state before preparing manager operations", async () => {
    const { onboarding, store } = await service();
    onboarding.start("attach", false, "2026-07-19T12:00:00.000Z");
    await onboarding.prepareManagerSignerGrant(
      { authId: "8", signerConfigPath: "/etc/stacks-signer/signer.toml" },
      "2026-07-19T12:00:15.000Z",
    );
    const stored = store.getOnboardingState();
    if (!stored?.state || typeof stored.state !== "object") {
      throw new Error("Expected persisted onboarding state");
    }
    store.putOnboardingState({
      path: stored.path,
      currentStep: stored.currentStep,
      status: stored.status,
      state: {
        ...(stored.state as Record<string, unknown>),
        managerPrincipal: "SP2JXKMSH007NPYAQHKJPQMAQYAD90NQGTVJVQ02B.old-manager",
      },
      updatedAt: "2026-07-19T12:00:30.000Z",
      auditAction: "stale-manager-fixture",
    });
    const readWalletState = onboarding as unknown as {
      readWalletState(): { managerPrincipal: string; signerGrant: { verified: unknown } };
    };
    expect(readWalletState.readWalletState()).toMatchObject({
      managerPrincipal,
      signerGrant: { verified: null },
    });
    await expect(
      onboarding.verifyManagerSignerGrant("stale signer output", "2026-07-19T12:00:45.000Z"),
    ).rejects.toThrow("Prepare a fresh signer grant before verifying signer output");

    const prepared = await onboarding.prepareManagerSignerGrant(
      { authId: "9", signerConfigPath: "/etc/stacks-signer/signer.toml" },
      "2026-07-19T12:01:00.000Z",
    );

    expect(prepared).toMatchObject({
      path: "attach",
      managerPrincipal,
      signerGrant: { preparation: { managerPrincipal, authId: "9" } },
    });
  });

  it("synthesizes manager state when an upgraded install has no onboarding row", async () => {
    const { onboarding, store } = await service();
    expect(store.getOnboardingState()).toBeNull();

    const readWalletState = onboarding as unknown as {
      readWalletState(): {
        managerPrincipal: string;
        freshInput: null;
        managerArtifact: null;
        signerGrant: { preparation: null; verified: null };
      };
    };
    expect(readWalletState.readWalletState()).toEqual({
      managerPrincipal,
      freshInput: null,
      managerArtifact: null,
      signerGrant: { preparation: null, verified: null },
    });
    expect(store.getOnboardingState()).toBeNull();
  });

  it("initializes a resumable Attach state when grant preparation starts without onboarding", async () => {
    const { onboarding, store } = await service();
    const prepared = await onboarding.prepareManagerSignerGrant(
      { authId: "9", signerConfigPath: "/etc/stacks-signer/signer.toml" },
      "2026-07-19T12:01:00.000Z",
    );

    expect(prepared).toMatchObject({
      path: "attach",
      status: "in-progress",
      currentStep: "preflight",
      managerPrincipal,
      signerGrant: { preparation: { authId: "9" }, verified: null },
    });
    expect(store.getOnboardingState()).toMatchObject({
      path: "attach",
      status: "in-progress",
      currentStep: "preflight",
    });
    expect(store.listOnboardingAudit().map(({ action }) => action)).toEqual([
      "manager-grant-prepared",
    ]);
  });

  it("prepares one sealed deployment intent and binds only an idempotent txid", async () => {
    const { onboarding, store } = await service();
    onboarding.start("fresh", false, "2026-07-18T18:00:00.000Z");
    await onboarding.prepareFresh(
      {
        adminPrincipal: "SP000000000000000000002Q6VF78",
        contractName: "signer-manager",
        authId: "7",
        signerConfigPath: "/etc/stacks-signer/signer.toml",
      },
      "2026-07-18T18:01:00.000Z",
    );

    const prepared = await onboarding.wallet.prepare("deploy-manager", "2026-07-18T18:02:00.000Z");
    expect(prepared).toMatchObject({
      action: "deploy-manager",
      network: "mainnet",
      requiredSender: "SP000000000000000000002Q6VF78",
      status: "prepared",
      txid: null,
      transaction: {
        method: "stx_deployContract",
        params: { clarityVersion: 6, sponsored: false, postConditionMode: "deny" },
      },
    });
    expect(prepared.seal.factsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.seal.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await onboarding.wallet.prepare("deploy-manager", "2026-07-18T18:03:00.000Z"),
    ).toMatchObject({ id: prepared.id });

    const txid = `0x${"ab".repeat(32)}`;
    expect(
      await onboarding.wallet.submit(prepared.id, txid, "2026-07-18T18:04:00.000Z"),
    ).toMatchObject({ status: "submitted", txid });
    expect(
      await onboarding.wallet.submit(prepared.id, txid, "2026-07-18T18:05:00.000Z"),
    ).toMatchObject({ status: "submitted", txid });
    expect(store.walletIntents.listObservations(prepared.id)).toHaveLength(1);
    await expect(
      onboarding.wallet.submit(prepared.id, `0x${"cd".repeat(32)}`, "2026-07-18T18:06:00.000Z"),
    ).rejects.toMatchObject({ code: "wallet_intent_conflict" });
  });

  it("supersedes an unsigned intent when the authoritative setup path changes", async () => {
    const { onboarding } = await service();
    onboarding.start("fresh", false, "2026-07-18T18:00:00.000Z");
    await onboarding.prepareFresh(
      {
        adminPrincipal: "SP000000000000000000002Q6VF78",
        contractName: "signer-manager",
        authId: "7",
        signerConfigPath: "/etc/stacks-signer/signer.toml",
      },
      "2026-07-18T18:01:00.000Z",
    );
    const prepared = await onboarding.wallet.prepare("deploy-manager", "2026-07-18T18:02:00.000Z");

    onboarding.start("attach", true, "2026-07-18T18:03:00.000Z");

    await expect(
      onboarding.wallet.refresh(prepared.id, "2026-07-18T18:04:00.000Z"),
    ).resolves.toMatchObject({
      status: "superseded",
      verification: { outcome: "superseded", canonical: null },
    });
  });

  it("attaches a broadcast after the live setup state changes and the intent expires", async () => {
    const { onboarding, store } = await service();
    onboarding.start("fresh", false, "2026-07-18T18:00:00.000Z");
    await onboarding.prepareFresh(
      {
        adminPrincipal: "SP000000000000000000002Q6VF78",
        contractName: "signer-manager",
        authId: "7",
        signerConfigPath: "/etc/stacks-signer/signer.toml",
      },
      "2026-07-18T18:01:00.000Z",
    );
    const prepared = await onboarding.wallet.prepare("deploy-manager", "2026-07-18T18:02:00.000Z");
    store.walletIntents.appendObservation({
      intentId: prepared.id,
      outcome: "pre-submit",
      canonical: null,
      blockHeight: null,
      indexBlockHash: null,
      evidence: { detail: "Intent existed before the delayed wallet callback" },
      observedAt: "2026-07-18T18:02:30.000Z",
    });
    onboarding.start("attach", true, "2026-07-18T18:03:00.000Z");

    const txid = `0x${"ab".repeat(32)}`;
    await expect(
      onboarding.wallet.submit(prepared.id, txid, prepared.expiresAt),
    ).resolves.toMatchObject({ status: "submitted", txid });
    expect(onboarding.wallet.get(prepared.id)).toMatchObject({ status: "submitted", txid });
    expect(store.walletIntents.listObservations(prepared.id).map(({ outcome }) => outcome)).toEqual(
      ["pre-submit", "submitted"],
    );
  });
});
