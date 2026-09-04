import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainAnchor } from "./chain-anchor.js";
import {
  captureChainAnchor,
  type StacksApiClient,
  type StacksNodeClient,
} from "./chain-clients.js";
import type { SidekickConfig } from "./config.js";
import { syncManagerEvents } from "./manager-event-sync.js";
import {
  type OperatorAnchorSnapshot,
  readOperatorAnchorSnapshot,
} from "./operator-anchor-snapshot.js";
import { OperatorService } from "./operator-service.js";
import {
  anchorSetupToRewardEvidence,
  resolveRosterProjectionAnchor,
} from "./reward-observation-anchor.js";
import {
  SignerStakerAnchorError,
  type SyncSignerStakersResult,
  syncSignerStakers,
} from "./signer-staker-sync.js";
import { openSidekickStore, type SidekickStore } from "./storage/store.js";

vi.mock("./operator-anchor-snapshot.js", () => ({ readOperatorAnchorSnapshot: vi.fn() }));
vi.mock("./chain-clients.js", async () => {
  const actual = await vi.importActual<typeof import("./chain-clients.js")>("./chain-clients.js");
  return { ...actual, captureChainAnchor: vi.fn() };
});
vi.mock("./manager-event-sync.js", () => ({ syncManagerEvents: vi.fn() }));
vi.mock("./signer-staker-sync.js", async () => {
  const actual =
    await vi.importActual<typeof import("./signer-staker-sync.js")>("./signer-staker-sync.js");
  return { ...actual, syncSignerStakers: vi.fn() };
});

const managerPrincipal = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.signer-manager";
const pox5ContractId = "ST000000000000000000002AMW42H.pox-5";
const config: SidekickConfig = {
  network: "devnet",
  nodeRpcUrl: "http://127.0.0.1:20443",
  apiUrl: "http://127.0.0.1:3999",
  apiKeyHeader: "x-api-key",
  maxApiBurnBlockLag: 12,
  forecastHorizonCycles: 6,
  stakerPageLimit: 37,
  eventPageLimit: 41,
  databasePath: ":memory:",
};
const stores: SidekickStore[] = [];

const stakerResult: SyncSignerStakersResult = {
  runId: "stable-run",
  resumed: false,
  status: "completed",
  authoritative: true,
  pagesProcessed: 1,
  itemsProcessed: 0,
  activeStakers: 0,
  nodeVerifiedStxPositions: 0,
  unverifiedStxDiscoveries: 0,
  discrepanciesObservedThisInvocation: [],
};
const eventResult = {
  stream: `manager-logs:v3:reference-manager-v1:${managerPrincipal}`,
  resumed: false,
  pagesProcessed: 1,
  eventsProcessed: 0,
  newEvents: 0,
  replayedEvents: 0,
  decodeFailures: 0,
  reorgedEvents: 0,
  stoppedAtKnownOverlap: false,
};

function anchor(stacksBlockHeight: number, burnBlockHeight: number): ChainAnchor {
  return {
    stacksBlockHeight,
    indexBlockHash: `0x${stacksBlockHeight.toString(16).padStart(64, "0")}`,
    burnBlockHeight,
    rewardCycle: 4,
    rewardCycleLength: 10,
    prepareCycleLength: 2,
    cyclePosition: 6,
    phase: "reward",
    checkpoint: "second-half",
  };
}

function setupSnapshot(chainAnchor: ChainAnchor): OperatorAnchorSnapshot {
  return {
    chainAnchor,
    preflight: {
      status: "pass",
      node: { networkId: 0x80000000 },
      api: {
        available: true,
        networkCompatible: true,
        status: "ready",
        serverVersion: "stacks-blockchain-api v9.0.0",
        burnBlockHeight: chainAnchor.burnBlockHeight,
        stacksTipHeight: chainAnchor.stacksBlockHeight,
        burnBlockLag: 0,
        stacksTipLag: 0,
        position: "equal",
        error: null,
      },
      pox: { pox5ContractId },
      checks: [],
    },
    manager: {
      attachAllowed: true,
      automationEligible: true,
      automationEligibilityReason: "Built-in reference manager is eligible for reviewed execution",
      source: {
        tier: "reference-built-in",
        profileId: "reference-devnet",
        origin: "built-in",
        sha256: "a".repeat(64),
        canonicalSha256: "b".repeat(64),
      },
    },
  } as unknown as OperatorAnchorSnapshot;
}

async function service(): Promise<OperatorService> {
  const { store } = await openSidekickStore(":memory:");
  stores.push(store);
  return new OperatorService({
    config,
    managerPrincipal,
    store,
    node: {} as StacksNodeClient,
    api: {} as StacksApiClient,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(captureChainAnchor).mockResolvedValue(anchor(100, 200));
});

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("OperatorService synchronization anchor retries", () => {
  it("reports an unavailable indexed API as an exact retryable delay", async () => {
    const snapshot = setupSnapshot(anchor(100, 200));
    snapshot.preflight.status = "warn";
    snapshot.preflight.api.available = false;
    snapshot.preflight.api.networkCompatible = false;
    snapshot.preflight.api.position = "unavailable";
    snapshot.preflight.checks = [
      {
        id: "api-availability",
        status: "warn",
        message: "The Reference API is unavailable",
      },
    ];
    vi.mocked(readOperatorAnchorSnapshot).mockResolvedValue(snapshot);
    const operator = await service();

    await expect(operator.synchronize()).rejects.toMatchObject({
      statusCode: 503,
      responseCode: "synchronization_source_temporarily_unavailable",
      retryable: true,
      message:
        "Chain data sync is waiting because the indexed API is temporarily unavailable. Local-node data remains available; Sidekick will retry automatically.",
    });
    expect(syncSignerStakers).not.toHaveBeenCalled();
  });

  it("continues synchronization when the indexed API is ahead", async () => {
    const snapshot = setupSnapshot(anchor(100, 200));
    snapshot.preflight.status = "warn";
    snapshot.preflight.api.position = "ahead";
    snapshot.preflight.checks = [
      {
        id: "api-lag",
        status: "warn",
        message: "The local node trails the API by 1 Stacks block",
      },
    ];
    vi.mocked(readOperatorAnchorSnapshot).mockResolvedValue(snapshot);
    vi.mocked(syncSignerStakers).mockResolvedValue(stakerResult);
    vi.mocked(syncManagerEvents).mockResolvedValue(eventResult);
    const operator = await service();

    await expect(operator.synchronize()).resolves.toMatchObject({
      stakers: stakerResult,
      events: eventResult,
    });
  });

  it("lets working indexed reads proceed when the API version label is unrecognized", async () => {
    const snapshot = setupSnapshot(anchor(100, 200));
    snapshot.preflight.status = "warn";
    snapshot.preflight.checks = [
      {
        id: "api-version",
        status: "warn",
        message: "Unable to confirm Stacks API v9+ from a proxy-defined version label",
      },
    ];
    vi.mocked(readOperatorAnchorSnapshot).mockResolvedValue(snapshot);
    vi.mocked(syncSignerStakers).mockResolvedValue(stakerResult);
    vi.mocked(syncManagerEvents).mockResolvedValue(eventResult);
    const operator = await service();

    await expect(operator.synchronize()).resolves.toMatchObject({
      stakers: stakerResult,
      events: eventResult,
    });
  });

  it("keeps proven compatibility failures blocking and reports the exact check", async () => {
    const snapshot = setupSnapshot(anchor(100, 200));
    snapshot.preflight.status = "fail";
    snapshot.preflight.checks = [
      {
        id: "node-network",
        status: "fail",
        message: "Node network ID 1 does not match testnet",
      },
    ];
    vi.mocked(readOperatorAnchorSnapshot).mockResolvedValue(snapshot);
    const operator = await service();

    await expect(operator.synchronize()).rejects.toMatchObject({
      statusCode: 422,
      responseCode: "synchronization_sources_incompatible",
      retryable: false,
      message: "Chain data sync is blocked: Node network ID 1 does not match testnet.",
    });
  });

  it("reports indexed height lag as retryable with the current and required heights", async () => {
    const snapshot = setupSnapshot(anchor(100, 200));
    snapshot.preflight.api.stacksTipHeight = 99;
    vi.mocked(readOperatorAnchorSnapshot).mockResolvedValue(snapshot);
    const operator = await service();

    await expect(operator.synchronize({ minimumStacksHeight: 100 })).rejects.toMatchObject({
      statusCode: 503,
      responseCode: "synchronization_source_temporarily_unavailable",
      retryable: true,
      message:
        "Chain data sync is waiting for the indexed API to reach Stacks block 100; it is currently at 99. Sidekick will retry automatically.",
    });
  });

  it("uses the shared indexed anchor and recaptures it after an anchor error", async () => {
    const localAnchor = anchor(110, 205);
    const staleAnchor = anchor(100, 200);
    const stableAnchor = anchor(101, 201);
    vi.mocked(readOperatorAnchorSnapshot)
      .mockResolvedValueOnce(setupSnapshot(localAnchor))
      .mockResolvedValueOnce(setupSnapshot(localAnchor));
    vi.mocked(captureChainAnchor)
      .mockResolvedValueOnce(staleAnchor)
      .mockResolvedValueOnce(stableAnchor);
    vi.mocked(syncSignerStakers)
      .mockRejectedValueOnce(new SignerStakerAnchorError("tip changed during roster scan"))
      .mockResolvedValueOnce(stakerResult);
    vi.mocked(syncManagerEvents).mockResolvedValue(eventResult);
    const operator = await service();

    await expect(operator.synchronize()).resolves.toMatchObject({
      stakers: stakerResult,
      events: eventResult,
    });

    expect(readOperatorAnchorSnapshot).toHaveBeenCalledTimes(2);
    expect(syncSignerStakers).toHaveBeenCalledTimes(2);
    expect(syncSignerStakers).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chainAnchor: staleAnchor,
        burnBlockHeight: staleAnchor.burnBlockHeight,
        stacksTipHeight: staleAnchor.stacksBlockHeight,
        currentRewardCycle: staleAnchor.rewardCycle,
      }),
    );
    expect(syncSignerStakers).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        chainAnchor: stableAnchor,
        burnBlockHeight: stableAnchor.burnBlockHeight,
        stacksTipHeight: stableAnchor.stacksBlockHeight,
        currentRewardCycle: stableAnchor.rewardCycle,
        pageLimit: config.stakerPageLimit,
      }),
    );
    expect(syncManagerEvents).toHaveBeenCalledTimes(1);
    expect(syncManagerEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: 0x80000000,
        managerPrincipal,
        pageLimit: config.eventPageLimit,
      }),
    );
    expect(vi.mocked(syncSignerStakers).mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(syncManagerEvents).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("does not retry or synchronize events after an arbitrary roster-sync failure", async () => {
    const failure = new Error("API response was malformed");
    vi.mocked(readOperatorAnchorSnapshot).mockResolvedValue(setupSnapshot(anchor(100, 200)));
    vi.mocked(syncSignerStakers).mockRejectedValue(failure);
    const operator = await service();

    await expect(operator.synchronize()).rejects.toBe(failure);

    expect(readOperatorAnchorSnapshot).toHaveBeenCalledTimes(1);
    expect(syncSignerStakers).toHaveBeenCalledTimes(1);
    expect(syncManagerEvents).not.toHaveBeenCalled();
  });
});

describe("roster projection anchor selection", () => {
  it("aligns transaction setup to a canonical reward anchor during ordinary indexed lag", () => {
    const liveAnchor = anchor(101, 201);
    const rewardAnchor = anchor(100, 200);
    const liveSetup = setupSnapshot(liveAnchor);

    const aligned = anchorSetupToRewardEvidence(liveSetup, rewardAnchor);

    expect(aligned).not.toBe(liveSetup);
    expect(aligned.chainAnchor).toBe(rewardAnchor);
    expect(aligned.preflight).toBe(liveSetup.preflight);
    expect(aligned.manager).toBe(liveSetup.manager);
  });

  it("preserves the fenced setup when reward evidence is already live", () => {
    const liveAnchor = anchor(101, 201);
    const liveSetup = setupSnapshot(liveAnchor);

    expect(anchorSetupToRewardEvidence(liveSetup, { ...liveAnchor })).toBe(liveSetup);
  });

  it("keeps a completed pinned roster when the live tip advances normally", async () => {
    const pinnedAnchor = anchor(100, 200);
    const liveAnchor = anchor(101, 200);
    const status = {
      chain_tip: {
        block_height: liveAnchor.stacksBlockHeight,
        block_hash: `0x${"aa".repeat(32)}`,
        index_block_hash: liveAnchor.indexBlockHash,
        burn_block_height: liveAnchor.burnBlockHeight,
      },
    };
    const api = {
      getStatus: vi.fn().mockResolvedValue(status),
      getBlock: vi.fn().mockResolvedValue({
        canonical: true,
        height: pinnedAnchor.stacksBlockHeight,
        index_block_hash: pinnedAnchor.indexBlockHash,
        burn_block_height: pinnedAnchor.burnBlockHeight,
      }),
    } as unknown as Pick<StacksApiClient, "getStatus" | "getBlock">;
    const store = {
      getLatestCompletedSignerStakerRun: vi.fn().mockReturnValue({
        authoritative: true,
        chainAnchor: pinnedAnchor,
      }),
    } as unknown as Pick<SidekickStore, "getLatestCompletedSignerStakerRun">;

    await expect(
      resolveRosterProjectionAnchor({
        store,
        api,
        sourceId: "api:testnet:source",
        managerPrincipal,
        liveAnchor,
      }),
    ).resolves.toEqual(pinnedAnchor);
    expect(api.getBlock).toHaveBeenCalledWith(pinnedAnchor.stacksBlockHeight);
  });

  it("discards a completed roster whose pinned block was reorged", async () => {
    const pinnedAnchor = anchor(100, 200);
    const liveAnchor = anchor(101, 200);
    const status = {
      chain_tip: {
        block_height: liveAnchor.stacksBlockHeight,
        block_hash: `0x${"aa".repeat(32)}`,
        index_block_hash: liveAnchor.indexBlockHash,
        burn_block_height: liveAnchor.burnBlockHeight,
      },
    };
    const api = {
      getStatus: vi.fn().mockResolvedValue(status),
      getBlock: vi.fn().mockResolvedValue({
        canonical: true,
        height: pinnedAnchor.stacksBlockHeight,
        index_block_hash: `0x${"ff".repeat(32)}`,
        burn_block_height: pinnedAnchor.burnBlockHeight,
      }),
    } as unknown as Pick<StacksApiClient, "getStatus" | "getBlock">;
    const store = {
      getLatestCompletedSignerStakerRun: vi.fn().mockReturnValue({
        authoritative: true,
        chainAnchor: pinnedAnchor,
      }),
    } as unknown as Pick<SidekickStore, "getLatestCompletedSignerStakerRun">;

    await expect(
      resolveRosterProjectionAnchor({
        store,
        api,
        sourceId: "api:testnet:source",
        managerPrincipal,
        liveAnchor,
      }),
    ).resolves.toEqual(liveAnchor);
  });

  it("lets the local node confirm a roster anchor the indexed API cannot", async () => {
    const pinnedAnchor = anchor(100, 200);
    const liveAnchor = anchor(104, 201);
    const api = {
      getStatus: vi.fn().mockResolvedValue({
        chain_tip: {
          block_height: liveAnchor.stacksBlockHeight,
          block_hash: `0x${"aa".repeat(32)}`,
          index_block_hash: liveAnchor.indexBlockHash,
          burn_block_height: liveAnchor.burnBlockHeight,
        },
      }),
      getBlock: vi.fn().mockResolvedValue({
        canonical: true,
        height: pinnedAnchor.stacksBlockHeight,
        index_block_hash: `0x${"ff".repeat(32)}`,
        burn_block_height: pinnedAnchor.burnBlockHeight,
      }),
    } as unknown as Pick<StacksApiClient, "getStatus" | "getBlock">;
    const block = Uint8Array.from([7, 7, 7]);
    const node = {
      getNakamotoBlockById: vi.fn().mockResolvedValue(block),
      getNakamotoBlockAtHeight: vi.fn().mockResolvedValue(Uint8Array.from(block)),
    } as unknown as Pick<StacksNodeClient, "getNakamotoBlockById" | "getNakamotoBlockAtHeight">;
    const store = {
      getLatestCompletedSignerStakerRun: vi.fn().mockReturnValue({
        authoritative: true,
        chainAnchor: pinnedAnchor,
      }),
    } as unknown as Pick<SidekickStore, "getLatestCompletedSignerStakerRun">;

    await expect(
      resolveRosterProjectionAnchor({
        store,
        api,
        node,
        sourceId: "api:testnet:source",
        managerPrincipal,
        liveAnchor,
      }),
    ).resolves.toEqual(pinnedAnchor);
    expect(api.getBlock).toHaveBeenCalledWith(pinnedAnchor.stacksBlockHeight);
    expect(node.getNakamotoBlockAtHeight).toHaveBeenCalledWith(pinnedAnchor.stacksBlockHeight, {
      tip: liveAnchor.indexBlockHash,
    });
  });

  it("keeps the sealed roster anchor through an indexed-API outage when the local node proves it", async () => {
    const pinnedAnchor = anchor(100, 200);
    const liveAnchor = anchor(104, 201);
    const block = Uint8Array.from([1, 2, 3, 4]);
    const api = {
      getStatus: vi.fn().mockRejectedValue(new Error("api down")),
      getBlock: vi.fn().mockRejectedValue(new Error("api down")),
    } as unknown as Pick<StacksApiClient, "getStatus" | "getBlock">;
    const node = {
      getNakamotoBlockById: vi.fn().mockResolvedValue(block),
      getNakamotoBlockAtHeight: vi.fn().mockResolvedValue(Uint8Array.from(block)),
    } as unknown as Pick<StacksNodeClient, "getNakamotoBlockById" | "getNakamotoBlockAtHeight">;
    const store = {
      getLatestCompletedSignerStakerRun: vi.fn().mockReturnValue({
        authoritative: true,
        chainAnchor: pinnedAnchor,
      }),
    } as unknown as Pick<SidekickStore, "getLatestCompletedSignerStakerRun">;

    await expect(
      resolveRosterProjectionAnchor({
        store,
        api,
        node,
        sourceId: "api:testnet:source",
        managerPrincipal,
        liveAnchor,
        indexedApiAvailable: false,
      }),
    ).resolves.toEqual(pinnedAnchor);
    expect(api.getStatus).not.toHaveBeenCalled();
    expect(api.getBlock).not.toHaveBeenCalled();
    expect(node.getNakamotoBlockById).toHaveBeenCalledWith(pinnedAnchor.indexBlockHash);
    expect(node.getNakamotoBlockAtHeight).toHaveBeenCalledWith(pinnedAnchor.stacksBlockHeight, {
      tip: liveAnchor.indexBlockHash,
    });
  });

  it("falls back to the live anchor during an indexed-API outage when the node cannot prove the roster", async () => {
    const pinnedAnchor = anchor(100, 200);
    const liveAnchor = anchor(104, 201);
    const api = {
      getStatus: vi.fn().mockRejectedValue(new Error("api down")),
      getBlock: vi.fn().mockRejectedValue(new Error("api down")),
    } as unknown as Pick<StacksApiClient, "getStatus" | "getBlock">;
    const store = {
      getLatestCompletedSignerStakerRun: vi.fn().mockReturnValue({
        authoritative: true,
        chainAnchor: pinnedAnchor,
      }),
    } as unknown as Pick<SidekickStore, "getLatestCompletedSignerStakerRun">;
    const reorged = {
      getNakamotoBlockById: vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3, 4])),
      getNakamotoBlockAtHeight: vi.fn().mockResolvedValue(Uint8Array.from([9, 9, 9, 9])),
    } as unknown as Pick<StacksNodeClient, "getNakamotoBlockById" | "getNakamotoBlockAtHeight">;
    const unreachable = {
      getNakamotoBlockById: vi.fn().mockRejectedValue(new Error("node busy")),
      getNakamotoBlockAtHeight: vi.fn().mockRejectedValue(new Error("node busy")),
    } as unknown as Pick<StacksNodeClient, "getNakamotoBlockById" | "getNakamotoBlockAtHeight">;

    for (const node of [reorged, unreachable, undefined]) {
      await expect(
        resolveRosterProjectionAnchor({
          store,
          api,
          node,
          sourceId: "api:testnet:source",
          managerPrincipal,
          liveAnchor,
          indexedApiAvailable: false,
        }),
      ).resolves.toEqual(liveAnchor);
    }
    expect(api.getBlock).not.toHaveBeenCalled();
  });
});
