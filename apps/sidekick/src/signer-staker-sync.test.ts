import { contractPrincipalCV, noneCV, someCV, tupleCV, uintCV } from "@stacks/transactions";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SignerStakersPage } from "./chain-clients.js";
import { syncSignerStakers } from "./signer-staker-sync.js";
import {
  createChainSourceId,
  createNodeSourceId,
  openSidekickStore,
  type SidekickStore,
} from "./storage/store.js";

const observedAt = "2026-07-14T12:00:00.000Z";
const apiUrl = "https://api.mainnet.hiro.so";
const sourceId = createChainSourceId("mainnet", apiUrl);
const nodeUrl = "http://127.0.0.1:20443";
const nodeSourceId = createNodeSourceId("mainnet", nodeUrl);
const manager = "SP000000000000000000002Q6VF78.signer-manager";
const otherManager = "SP000000000000000000002Q6VF78.other-manager";
const pox5 = "SP000000000000000000002Q6VF78.pox-5";
const stakerOne = "SP000000000000000000002Q6VF78";
const stakerTwo = "SP2JXKMSH007NPYAQHKJPQMAQYAD90NQGTVJVQ02B";
const openStores: SidekickStore[] = [];

function page(
  results: SignerStakersPage["results"],
  current: string | null,
  next: string | null,
): SignerStakersPage {
  return {
    total: 2,
    limit: 1,
    cursor: { current, next, previous: null },
    results,
  };
}

async function store(): Promise<SidekickStore> {
  const { store } = await openSidekickStore(":memory:", observedAt);
  openStores.push(store);
  store.upsertChainSource({
    sourceId,
    kind: "api",
    network: "mainnet",
    baseUrl: apiUrl,
    observedAt,
  });
  store.upsertChainSource({
    sourceId: nodeSourceId,
    kind: "node",
    network: "mainnet",
    baseUrl: nodeUrl,
    observedAt,
  });
  return store;
}

function position(signer = manager) {
  const [address, contractName] = signer.split(".") as [string, string];
  return someCV(
    tupleCV({
      "amount-ustx": uintCV(75_000_000_000n),
      "first-reward-cycle": uintCV(141n),
      "num-cycles": uintCV(2n),
      signer: contractPrincipalCV(address, contractName),
    }),
  );
}

function membership(amountUstx = 75_000_000_000n, signer = manager) {
  const [address, contractName] = signer.split(".") as [string, string];
  return someCV(
    tupleCV({
      "amount-ustx": uintCV(amountUstx),
      signer: contractPrincipalCV(address, contractName),
    }),
  );
}

function nodeReads() {
  return {
    callReadOnly: vi.fn().mockImplementation((_contract, functionName) => {
      if (functionName === "get-staker-info") return Promise.resolve(position());
      if (functionName === "reward-cycle-to-burn-height") {
        return Promise.resolve(uintCV(961_000n));
      }
      return Promise.resolve(membership());
    }),
  };
}

function options(
  sidekickStore: SidekickStore,
  api: { getSignerStakers: ReturnType<typeof vi.fn> },
  node: { callReadOnly: ReturnType<typeof vi.fn> },
) {
  return {
    store: sidekickStore,
    api,
    node,
    sourceId,
    nodeSourceId,
    managerPrincipal: manager,
    pox5ContractId: pox5,
    observedAt,
    burnBlockHeight: 960_240,
    stacksTipHeight: 8_600_000,
    currentRewardCycle: 141,
    pageLimit: 1,
  };
}

afterEach(() => {
  for (const sidekickStore of openStores.splice(0)) sidekickStore.close();
});

describe("signer-staker synchronization", () => {
  it("paginates the API roster and trusts only node-verified STX positions", async () => {
    const sidekickStore = await store();
    const api = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValueOnce(page([{ staker: stakerOne, types: ["stx"] }], null, stakerTwo))
        .mockResolvedValueOnce(page([{ staker: stakerTwo, types: ["btc"] }], stakerTwo, null)),
    };
    const node = {
      callReadOnly: vi
        .fn()
        .mockResolvedValueOnce(position())
        .mockResolvedValueOnce(uintCV(961_000n))
        .mockResolvedValueOnce(membership(49_000_000_000n))
        .mockResolvedValueOnce(membership()),
    };

    await expect(syncSignerStakers(options(sidekickStore, api, node))).resolves.toMatchObject({
      status: "completed",
      resumed: false,
      pagesProcessed: 2,
      itemsProcessed: 2,
      activeStakers: 2,
      nodeVerifiedStxPositions: 1,
      unverifiedStxDiscoveries: 0,
      discrepanciesObservedThisInvocation: [],
    });

    expect(api.getSignerStakers).toHaveBeenNthCalledWith(1, manager, null, 1);
    expect(api.getSignerStakers).toHaveBeenNthCalledWith(2, manager, stakerTwo, 1);
    expect(node.callReadOnly).toHaveBeenCalledTimes(4);
    expect(node.callReadOnly).toHaveBeenCalledWith(
      pox5,
      "get-staker-info",
      manager,
      expect.arrayContaining([expect.stringMatching(/^0x/)]),
    );
    expect(sidekickStore.listCycleMemberships(manager)).toEqual([
      {
        stakerPrincipal: stakerOne,
        rewardCycle: 141n,
        signerPrincipal: manager,
        amountUstx: 49_000_000_000n,
        active: true,
      },
      {
        stakerPrincipal: stakerOne,
        rewardCycle: 142n,
        signerPrincipal: manager,
        amountUstx: 75_000_000_000n,
        active: true,
      },
    ]);
  });

  it("keeps API-only signer mismatches visible but untrusted", async () => {
    const sidekickStore = await store();
    const api = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValue(page([{ staker: stakerOne, types: ["stx"] }], null, null)),
    };
    const node = { callReadOnly: vi.fn().mockResolvedValue(position(otherManager)) };

    await expect(syncSignerStakers(options(sidekickStore, api, node))).resolves.toMatchObject({
      nodeVerifiedStxPositions: 0,
      unverifiedStxDiscoveries: 1,
      discrepanciesObservedThisInvocation: [
        {
          kind: "signer-mismatch",
          stakerPrincipal: stakerOne,
          expectedSignerPrincipal: manager,
          actualSignerPrincipal: otherManager,
        },
      ],
    });
    expect(sidekickStore.listSignerStakers(manager)).toMatchObject([
      { stakerPrincipal: stakerOne, stxNodeVerified: false, position: null },
    ]);
    expect(sidekickStore.listCycleMemberships(manager)).toEqual([]);
  });

  it("excludes cycles whose exact membership still belongs to the prior signer", async () => {
    const sidekickStore = await store();
    const api = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValue(page([{ staker: stakerOne, types: ["stx"] }], null, null)),
    };
    const node = {
      callReadOnly: vi
        .fn()
        .mockResolvedValueOnce(position())
        .mockResolvedValueOnce(uintCV(961_000n))
        .mockResolvedValueOnce(membership(49_000_000_000n, otherManager))
        .mockResolvedValueOnce(membership()),
    };

    await syncSignerStakers(options(sidekickStore, api, node));

    expect(sidekickStore.listCycleMemberships(manager)).toMatchObject([
      { rewardCycle: 142n, signerPrincipal: manager, amountUstx: 75_000_000_000n },
    ]);
  });

  it("resumes from the last committed page after an interrupted scan", async () => {
    const sidekickStore = await store();
    const interruptedApi = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValueOnce(page([{ staker: stakerOne, types: ["stx"] }], null, stakerTwo))
        .mockRejectedValueOnce(new Error("API unavailable")),
    };
    const node = nodeReads();

    await expect(syncSignerStakers(options(sidekickStore, interruptedApi, node))).rejects.toThrow(
      "API unavailable",
    );
    expect(sidekickStore.startOrResumeSignerStakerRun(sourceId, manager, observedAt)).toMatchObject(
      { status: "running", cursor: stakerTwo, pagesProcessed: 1 },
    );

    const resumedApi = {
      getSignerStakers: vi.fn().mockResolvedValue(page([], stakerTwo, null)),
    };
    await expect(
      syncSignerStakers(options(sidekickStore, resumedApi, node)),
    ).resolves.toMatchObject({
      resumed: true,
      status: "completed",
      pagesProcessed: 2,
      itemsProcessed: 1,
    });
    expect(resumedApi.getSignerStakers).toHaveBeenCalledWith(manager, stakerTwo, 1);
    expect(sidekickStore.listSignerStakers(manager)).toHaveLength(1);
  });

  it("records a missing node position as a discrepancy", async () => {
    const sidekickStore = await store();
    const api = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValue(page([{ staker: stakerOne, types: ["stx"] }], null, null)),
    };
    const node = { callReadOnly: vi.fn().mockResolvedValue(noneCV()) };

    await expect(syncSignerStakers(options(sidekickStore, api, node))).resolves.toMatchObject({
      unverifiedStxDiscoveries: 1,
      discrepanciesObservedThisInvocation: [
        { kind: "stx-position-missing", stakerPrincipal: stakerOne },
      ],
    });
  });

  it("verifies stakers concurrently while respecting the configured worker bound", async () => {
    const sidekickStore = await store();
    const api = {
      getSignerStakers: vi.fn().mockResolvedValue(
        page(
          [
            { staker: stakerOne, types: ["stx"] },
            { staker: stakerTwo, types: ["stx"] },
          ],
          null,
          null,
        ),
      ),
    };
    let activeReads = 0;
    let maximumReads = 0;
    const node = {
      callReadOnly: vi.fn().mockImplementation(async () => {
        activeReads += 1;
        maximumReads = Math.max(maximumReads, activeReads);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeReads -= 1;
        return noneCV();
      }),
    };

    await syncSignerStakers({
      ...options(sidekickStore, api, node),
      pageLimit: 2,
      stakerConcurrency: 2,
    });

    expect(maximumReads).toBe(2);
    expect(node.callReadOnly).toHaveBeenCalledTimes(2);
  });
});
