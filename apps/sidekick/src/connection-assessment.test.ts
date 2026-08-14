import { afterEach, describe, expect, it, vi } from "vitest";
import { type StacksNodeClient, UpstreamHttpError } from "./chain-clients.js";
import {
  ConnectionAssessmentService,
  type ConnectionManagerInspection,
} from "./connection-assessment.js";
import { openSidekickStore, type SidekickStore } from "./storage/store.js";

const checkedAt = "2026-08-13T12:00:00.000Z";
const later = "2026-08-13T12:05:00.000Z";
const manager = "SP000000000000000000002Q6VF78.signer-manager";
const otherManager = "SP2369QN53586176SYRF4XFGF4E84V0J0EWKRG0ZH.other-manager";
const testnetManager = "ST3PF13W7Z0RRM42A8VZRVFQ75SV1K26RXEP8YGKJ.signer-manager";
const pox5ContractId = "SP000000000000000000002Q6VF78.pox-5";
const stores: SidekickStore[] = [];

const nodeInfo = {
  server_version: "stacks-node 4.0.1",
  network_id: 1,
  parent_network_id: 0,
  burn_block_height: 962_250,
  stacks_tip_height: 8_750_000,
  stacks_tip: "0xe332d0d28b57f7683a1a119edfa3e7cce166d62abace289e865a6bc455fd36bb" as const,
  stacks_tip_consensus_hash: "87870f15496fba32a2f26ef47304478424153e51",
  is_fully_synced: true,
};
const indexBlockHash =
  "0x74b8cbf99ffdbf02775f7b9e2e3754181f18e8144674929ac5054d15a314f5db" as const;

const poxInfo = {
  current_burnchain_block_height: 962_250,
  reward_cycle_id: 141,
  reward_cycle_length: 2_100,
  prepare_cycle_length: 100,
  contract_id: pox5ContractId,
  contract_versions: [
    {
      contract_id: pox5ContractId,
      activation_burnchain_block_height: 962_100,
      first_reward_cycle_id: 141,
    },
  ],
};

function managerReport(compatible = true): ConnectionManagerInspection {
  return {
    publishHeight: 8_700_000,
    traitCompatible: compatible,
    traitReason: compatible
      ? "Manager exposes the exact PoX-5 signer-manager validate-stake! trait signature"
      : "Manager validate-stake! arguments do not match the PoX-5 signer-manager trait",
    clarityVersion: "Clarity4",
    epoch: "Epoch40",
  };
}

async function memoryStore(): Promise<SidekickStore> {
  const { store } = await openSidekickStore(":memory:", checkedAt);
  stores.push(store);
  return store;
}

function node(
  overrides: {
    getInfo?: () => Promise<typeof nodeInfo>;
    getPoxInfo?: () => Promise<typeof poxInfo>;
  } = {},
): StacksNodeClient {
  return {
    getInfo: overrides.getInfo ?? vi.fn(async () => nodeInfo),
    getPoxInfo: overrides.getPoxInfo ?? vi.fn(async () => poxInfo),
  } as unknown as StacksNodeClient;
}

function service(options: {
  store: SidekickStore;
  node?: StacksNodeClient;
  managerPrincipal?: string;
  network?: "mainnet" | "testnet" | "devnet" | "regtest";
  expectedNetworkId?: number;
  now?: () => string;
  inspectManager?: (tip?: `0x${string}`) => Promise<ConnectionManagerInspection>;
  assessmentDeadlineMs?: number;
  runtime?: () => {
    config: {
      network: "mainnet" | "testnet" | "devnet" | "regtest";
      nodeRpcUrl: string;
      expectedNetworkId?: number;
    };
    node: StacksNodeClient;
  };
}): ConnectionAssessmentService {
  return new ConnectionAssessmentService({
    config: {
      network: options.network ?? "mainnet",
      nodeRpcUrl: "http://127.0.0.1:20443",
      ...(options.expectedNetworkId === undefined
        ? {}
        : { expectedNetworkId: options.expectedNetworkId }),
    },
    managerPrincipal: options.managerPrincipal ?? manager,
    node: options.node ?? node(),
    store: options.store,
    now: options.now ?? (() => checkedAt),
    ...(options.assessmentDeadlineMs === undefined
      ? {}
      : { assessmentDeadlineMs: options.assessmentDeadlineMs }),
    ...(options.runtime ? { runtime: options.runtime } : {}),
    inspectManager: options.inspectManager ?? (async () => managerReport()),
  });
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("first-run connection assessment", () => {
  it("connects and binds an empty database using only local-node and trait evidence", async () => {
    const store = await memoryStore();
    const inspectManager = vi.fn(async () => managerReport());
    const configuredNode = node();
    const result = await service({ store, node: configuredNode, inspectManager }).check();

    expect(result).toMatchObject({
      status: "connected",
      outcomeCode: null,
      stale: false,
      observed: {
        networkId: 1,
        stacksTipHeight: nodeInfo.stacks_tip_height,
        burnBlockHeight: nodeInfo.burn_block_height,
        pox5ContractId,
        manager: { deployed: true, traitCompatible: true },
      },
      deploymentIdentity: { status: "bound", reason: null },
    });
    expect(configuredNode.getPoxInfo).toHaveBeenCalledWith({ tip: indexBlockHash });
    expect(inspectManager).toHaveBeenCalledWith(indexBlockHash);
    expect(store.getDeploymentIdentity()).toMatchObject({
      managerPrincipal: manager,
      network: "mainnet",
      networkId: 1,
      bindingSource: "new",
      lastVerifiedAt: checkedAt,
    });
  });

  it.each([
    {
      name: "wrong node network",
      expected: "node-network-mismatch",
      build: async (store: SidekickStore) =>
        service({
          store,
          node: node({ getInfo: async () => ({ ...nodeInfo, network_id: 0x80000005 }) }),
        }),
    },
    {
      name: "PoX-5 unavailable",
      expected: "pox5-unavailable",
      build: async (store: SidekickStore) =>
        service({
          store,
          node: node({
            getPoxInfo: async () => ({
              ...poxInfo,
              contract_id: "SP000000000000000000002Q6VF78.pox-4",
              contract_versions: [],
            }),
          }),
        }),
    },
    {
      name: "principal on another network",
      expected: "principal-network-mismatch",
      build: async (store: SidekickStore) => service({ store, managerPrincipal: testnetManager }),
    },
    {
      name: "manager not deployed",
      expected: "manager-not-deployed",
      build: async (store: SidekickStore) =>
        service({
          store,
          inspectManager: async () => {
            throw new UpstreamHttpError("contract source returned HTTP 404", 404);
          },
        }),
    },
    {
      name: "manager trait mismatch",
      expected: "manager-trait-mismatch",
      build: async (store: SidekickStore) =>
        service({ store, inspectManager: async () => managerReport(false) }),
    },
  ])("returns the stable $expected outcome for $name", async ({ build, expected }) => {
    const store = await memoryStore();
    const result = await (await build(store)).check();
    expect(result.status).toBe("blocked");
    expect(result.outcomeCode).toBe(expected);
    expect(store.getDeploymentIdentity()).toBeNull();
  });

  it("preserves the last successful anchor as stale when the local node later fails", async () => {
    const store = await memoryStore();
    let reachable = true;
    const localNode = node({
      getInfo: async () => {
        if (!reachable) throw new Error("offline");
        return nodeInfo;
      },
    });
    let now = checkedAt;
    const connection = service({ store, node: localNode, now: () => now });
    await connection.check();

    reachable = false;
    now = later;
    const result = await connection.check(true);
    expect(result).toMatchObject({
      status: "unavailable",
      outcomeCode: "node-unreachable",
      checkedAt: later,
      stale: true,
      lastSuccessful: {
        lastVerifiedAt: checkedAt,
        lastStacksTipHeight: nodeInfo.stacks_tip_height,
        lastBurnBlockHeight: nodeInfo.burn_block_height,
      },
    });
  });

  it("resolves the configured node again for each forced assessment", async () => {
    const store = await memoryStore();
    const originalInfo = vi.fn(async () => nodeInfo);
    const replacementInfo = vi.fn(async () => ({ ...nodeInfo, stacks_tip_height: 8_750_100 }));
    let current = {
      config: { network: "mainnet" as const, nodeRpcUrl: "http://old-node:20443" },
      node: node({ getInfo: originalInfo }),
    };
    const connection = service({ store, runtime: () => current });

    expect(await connection.check()).toMatchObject({
      status: "connected",
      configured: { nodeRpcUrl: "http://old-node:20443" },
      observed: { stacksTipHeight: nodeInfo.stacks_tip_height },
    });
    current = {
      config: { network: "mainnet", nodeRpcUrl: "http://new-node:20443" },
      node: node({ getInfo: replacementInfo }),
    };

    expect(await connection.check(true)).toMatchObject({
      status: "connected",
      configured: { nodeRpcUrl: "http://new-node:20443" },
      observed: { stacksTipHeight: 8_750_100 },
    });
    expect(originalInfo).toHaveBeenCalledOnce();
    expect(replacementInfo).toHaveBeenCalledOnce();
  });

  it("bounds an unresponsive local-node assessment with the stable unavailable outcome", async () => {
    const store = await memoryStore();
    const getInfo = vi.fn(async () => await new Promise<typeof nodeInfo>(() => undefined));
    const result = await service({
      store,
      node: node({ getInfo }),
      assessmentDeadlineMs: 5,
    }).check(true);

    expect(result).toMatchObject({
      status: "unavailable",
      outcomeCode: "node-unreachable",
      stale: false,
      checks: expect.arrayContaining([
        expect.objectContaining({ id: "node-network", status: "unavailable" }),
      ]),
    });
  });

  it("enters diagnostic safe mode before reading the node when a bound identity differs", async () => {
    const store = await memoryStore();
    store.bindDeploymentIdentity({
      network: "mainnet",
      networkId: 1,
      parentNetworkId: 0,
      managerPrincipal: manager,
      bindingSource: "new",
      verifiedAt: checkedAt,
      stacksTipHeight: nodeInfo.stacks_tip_height,
      burnBlockHeight: nodeInfo.burn_block_height,
      pox5ContractId,
    });
    const getInfo = vi.fn(async () => nodeInfo);
    const result = await service({
      store,
      node: node({ getInfo }),
      managerPrincipal: otherManager,
    }).check();

    expect(result).toMatchObject({
      status: "blocked",
      outcomeCode: "deployment-identity-mismatch",
      stale: true,
      deploymentIdentity: {
        status: "mismatch",
        stored: { managerPrincipal: manager },
      },
    });
    expect(getInfo).not.toHaveBeenCalled();
  });

  it("rejects ambiguous legacy evidence but auto-binds matching evidence after proof", async () => {
    const conflicting = await memoryStore();
    conflicting.recordManagerTrustState({
      managerPrincipal: otherManager,
      recognitionTier: "unrecognized",
      profileId: null,
      profileOrigin: null,
      sourceSha256: null,
      canonicalSourceSha256: null,
      automationEligible: false,
      eligibilityReason: "Observe only",
      observedAt: checkedAt,
    });
    expect((await service({ store: conflicting }).check()).outcomeCode).toBe(
      "deployment-identity-mismatch",
    );

    const matching = await memoryStore();
    matching.upsertChainSource({
      sourceId: "node:mainnet:legacy",
      kind: "node",
      network: "mainnet",
      baseUrl: "http://127.0.0.1:20443",
      observedAt: checkedAt,
    });
    matching.recordManagerTrustState({
      managerPrincipal: manager,
      recognitionTier: "unrecognized",
      profileId: null,
      profileOrigin: null,
      sourceSha256: null,
      canonicalSourceSha256: null,
      automationEligible: false,
      eligibilityReason: "Observe only",
      observedAt: checkedAt,
    });
    expect((await service({ store: matching }).check()).status).toBe("connected");
    expect(matching.getDeploymentIdentity()?.bindingSource).toBe("legacy-evidence");
  });

  it("coalesces simultaneous forced rechecks without starting any synchronization", async () => {
    const store = await memoryStore();
    let release: ((value: typeof nodeInfo) => void) | undefined;
    const pendingInfo = new Promise<typeof nodeInfo>((resolve) => {
      release = resolve;
    });
    const getInfo = vi.fn(async () => await pendingInfo);
    const connection = service({ store, node: node({ getInfo }) });

    const first = connection.check(true);
    const second = connection.check(true);
    release?.(nodeInfo);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(getInfo).toHaveBeenCalledTimes(1);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.status).toBe("connected");
  });
});
