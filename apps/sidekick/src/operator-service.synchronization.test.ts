import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainAnchor } from "./chain-anchor.js";
import {
  captureChainAnchor,
  type StacksApiClient,
  type StacksNodeClient,
} from "./chain-clients.js";
import type { SidekickConfig } from "./config.js";
import { syncManagerEvents } from "./manager-event-sync.js";
import { OperatorService, resolveRosterProjectionAnchor } from "./operator-service.js";
import { readSetupSnapshot, type SetupSnapshot } from "./setup-snapshot.js";
import {
  SignerStakerAnchorError,
  type SyncSignerStakersResult,
  syncSignerStakers,
} from "./signer-staker-sync.js";
import { openSidekickStore, type SidekickStore } from "./storage/store.js";

vi.mock("./setup-snapshot.js", () => ({ readSetupSnapshot: vi.fn() }));
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

function setupSnapshot(chainAnchor: ChainAnchor): SetupSnapshot {
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
      automationEligibilityReason: "Built-in reference manager is eligible for Assist",
      source: {
        tier: "reference-built-in",
        profileId: "reference-devnet",
        origin: "built-in",
        sha256: "a".repeat(64),
        canonicalSha256: "b".repeat(64),
      },
    },
  } as unknown as SetupSnapshot;
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
  it("uses the shared indexed anchor and recaptures it after an anchor error", async () => {
    const localAnchor = anchor(110, 205);
    const staleAnchor = anchor(100, 200);
    const stableAnchor = anchor(101, 201);
    vi.mocked(readSetupSnapshot)
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

    expect(readSetupSnapshot).toHaveBeenCalledTimes(2);
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
    vi.mocked(readSetupSnapshot).mockResolvedValue(setupSnapshot(anchor(100, 200)));
    vi.mocked(syncSignerStakers).mockRejectedValue(failure);
    const operator = await service();

    await expect(operator.synchronize()).rejects.toBe(failure);

    expect(readSetupSnapshot).toHaveBeenCalledTimes(1);
    expect(syncSignerStakers).toHaveBeenCalledTimes(1);
    expect(syncManagerEvents).not.toHaveBeenCalled();
  });
});

describe("roster projection anchor selection", () => {
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
});
