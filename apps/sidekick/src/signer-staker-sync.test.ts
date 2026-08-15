import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contractPrincipalCV,
  falseCV,
  noneCV,
  someCV,
  trueCV,
  tupleCV,
  uintCV,
} from "@stacks/transactions";
import { encodePrincipalHex } from "@stx-labs/signer-sidekick-protocol/clarity-codecs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiStatus, SignerStakersPage, StacksBlockSummary } from "./chain-clients.js";
import { SignerStakerAnchorError, syncSignerStakers } from "./signer-staker-sync.js";
import {
  createChainSourceId,
  createNodeSourceId,
  openSidekickStore,
  type SidekickStore,
} from "./storage/store.js";

const observedAt = "2026-07-14T12:00:00.000Z";
const later = "2026-07-14T12:01:00.000Z";
const latest = "2026-07-14T12:02:00.000Z";
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
const temporaryDirectories: string[] = [];
const indexBlockHash = `0x${"33".repeat(32)}`;
const chainAnchor = {
  stacksBlockHeight: 8_600_000,
  indexBlockHash,
  burnBlockHeight: 960_240,
  rewardCycle: 141,
  rewardCycleLength: 2_100,
  prepareCycleLength: 100,
  cyclePosition: 1_240,
  phase: "reward" as const,
  checkpoint: "second-half" as const,
};

function apiStatus(overrides: Partial<ApiStatus["chain_tip"]> = {}): ApiStatus {
  return {
    server_version: "stacks-blockchain-api v9",
    status: "ready",
    chain_tip: {
      block_height: chainAnchor.stacksBlockHeight,
      block_hash: `0x${"22".repeat(32)}`,
      index_block_hash: chainAnchor.indexBlockHash,
      burn_block_height: chainAnchor.burnBlockHeight,
      ...overrides,
    },
  };
}

function apiBlock(overrides: Partial<StacksBlockSummary> = {}): StacksBlockSummary {
  return {
    canonical: true,
    height: chainAnchor.stacksBlockHeight,
    hash: `0x${"22".repeat(32)}`,
    index_block_hash: chainAnchor.indexBlockHash,
    parent_block_hash: `0x${"11".repeat(32)}`,
    parent_index_block_hash: `0x${"12".repeat(32)}`,
    burn_block_height: chainAnchor.burnBlockHeight,
    ...overrides,
  };
}

function page(
  results: SignerStakersPage["results"],
  _requestedCursor: string | null,
  next: string | null,
  total = results.length,
  current = results[0]?.staker ?? null,
  limit = 1,
): SignerStakersPage {
  return {
    total,
    limit,
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

function position(signer = manager, firstRewardCycle = 141n, numCycles = 2n) {
  const [address, contractName] = signer.split(".") as [string, string];
  return someCV(
    tupleCV({
      "amount-ustx": uintCV(75_000_000_000n),
      "first-reward-cycle": uintCV(firstRewardCycle),
      "num-cycles": uintCV(numCycles),
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

/** `get-bond-membership` for a staker with an active bond under `signer`. */
function bondMembership(
  signer = manager,
  { bondIndex = 0n, isL1Lock = false, amountSats = 100_000n, amountUstx = 1_000_000_000n } = {},
) {
  const [address, contractName] = signer.split(".") as [string, string];
  return someCV(
    tupleCV({
      "bond-index": uintCV(bondIndex),
      "amount-ustx": uintCV(amountUstx),
      "amount-sats": uintCV(amountSats),
      "is-l1-lock": isL1Lock ? trueCV() : falseCV(),
      signer: contractPrincipalCV(address, contractName),
    }),
  );
}

function nodeReads() {
  return {
    callReadOnly: vi.fn().mockImplementation((_contract, functionName) => {
      if (functionName === "get-bond-membership") return Promise.resolve(bondMembership());
      if (functionName === "get-staker-info") return Promise.resolve(position());
      if (functionName === "reward-cycle-to-burn-height") {
        return Promise.resolve(uintCV(961_000n));
      }
      return Promise.resolve(membership());
    }),
  };
}

function nodeReadsForPositions(
  positions: ReadonlyMap<string, ReturnType<typeof position> | null>,
  bonds: ReadonlyMap<string, ReturnType<typeof bondMembership>> = new Map(),
) {
  const positionsByEncodedPrincipal = new Map(
    [...positions].map(([principal, value]) => [encodePrincipalHex(principal), value] as const),
  );
  const bondsByEncodedPrincipal = new Map(
    [...bonds].map(([principal, value]) => [encodePrincipalHex(principal), value] as const),
  );
  return {
    callReadOnly: vi
      .fn()
      .mockImplementation(
        (_contract: string, functionName: string, _sender: string, args: readonly string[]) => {
          if (functionName === "get-bond-membership") {
            const principal = args[0];
            return Promise.resolve(
              (principal && bondsByEncodedPrincipal.get(principal)) ?? noneCV(),
            );
          }
          if (functionName === "get-staker-info") {
            const principal = args[0];
            if (!principal || !positionsByEncodedPrincipal.has(principal)) {
              throw new Error(`Unexpected staker-info read for ${principal ?? "<missing>"}`);
            }
            return Promise.resolve(positionsByEncodedPrincipal.get(principal) ?? noneCV());
          }
          if (functionName === "reward-cycle-to-burn-height") {
            return Promise.resolve(uintCV(961_000n));
          }
          return Promise.resolve(membership());
        },
      ),
  };
}

function options(
  sidekickStore: SidekickStore,
  api: {
    getSignerStakers: ReturnType<typeof vi.fn>;
    getStatus?: ReturnType<typeof vi.fn>;
    getBlock?: ReturnType<typeof vi.fn>;
  },
  node: { callReadOnly: ReturnType<typeof vi.fn> },
) {
  return {
    store: sidekickStore,
    api: {
      ...api,
      getStatus: api.getStatus ?? vi.fn().mockResolvedValue(apiStatus()),
      getBlock: api.getBlock ?? vi.fn().mockResolvedValue(apiBlock()),
    },
    node,
    sourceId,
    nodeSourceId,
    managerPrincipal: manager,
    pox5ContractId: pox5,
    observedAt,
    burnBlockHeight: 960_240,
    stacksTipHeight: 8_600_000,
    currentRewardCycle: 141,
    chainAnchor,
    pageLimit: 1,
  };
}

afterEach(async () => {
  for (const sidekickStore of openStores.splice(0)) sidekickStore.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("signer-staker synchronization", () => {
  it("paginates the API roster and trusts only node-verified STX positions", async () => {
    const sidekickStore = await store();
    const api = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValueOnce(page([{ staker: stakerOne, types: ["stx"] }], null, stakerTwo, 2))
        .mockResolvedValueOnce(page([{ staker: stakerTwo, types: ["btc"] }], stakerTwo, null, 2)),
    };
    let cycleReads = 0;
    const node = {
      callReadOnly: vi
        .fn()
        .mockImplementation(
          async (
            _contract: string,
            functionName: string,
            _sender: string,
            args: readonly string[],
          ) => {
            if (functionName === "get-bond-membership") {
              // The node confirms the bond the API labelled; `types` alone would not be enough.
              return args[0] === encodePrincipalHex(stakerTwo)
                ? bondMembership(manager, { isL1Lock: true })
                : noneCV();
            }
            if (functionName === "get-staker-info") {
              // `register-for-bond` never writes `staker-info`, so the bond participant has none.
              return args[0] === encodePrincipalHex(stakerTwo) ? noneCV() : position();
            }
            if (functionName === "reward-cycle-to-burn-height") return uintCV(961_000n);
            cycleReads += 1;
            return cycleReads === 1 ? membership(49_000_000_000n) : membership();
          },
        ),
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
    // Both authoritative reads run for both candidates regardless of what the API labelled them,
    // plus the unlock-height and cycle-membership reads for the one real STX position.
    expect(node.callReadOnly).toHaveBeenCalledTimes(7);
    expect(node.callReadOnly).toHaveBeenCalledWith(
      pox5,
      "get-bond-membership",
      manager,
      expect.arrayContaining([expect.stringMatching(/^0x/)]),
      { tip: indexBlockHash },
    );
    expect(node.callReadOnly).toHaveBeenCalledWith(
      pox5,
      "get-staker-info",
      manager,
      expect.arrayContaining([expect.stringMatching(/^0x/)]),
      { tip: indexBlockHash },
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
    expect(sidekickStore.listStakerPositionObservations(manager, stakerOne)).toMatchObject([
      { observedIndexBlockHash: indexBlockHash },
    ]);
    // The bond participant is carried with the type the node reported, not the API's label.
    expect(
      sidekickStore.listSignerStakers(manager).find((s) => s.stakerPrincipal === stakerTwo)?.bond,
    ).toMatchObject({ bondIndex: 0n, isL1Lock: true, amountSats: 100_000n });
  });

  it("fails closed when the API claims a bond the node does not confirm", async () => {
    const sidekickStore = await store();
    const api = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValue(page([{ staker: stakerTwo, types: ["btc"] }], null, null, 1)),
    };
    // Revision 1 recorded this staker as active purely on the API's `types` label. The node is
    // authoritative now, and it reports no bond membership at the anchor.
    const node = {
      callReadOnly: vi.fn().mockImplementation(async () => noneCV()),
    };

    await expect(syncSignerStakers(options(sidekickStore, api, node))).resolves.toMatchObject({
      status: "incomplete",
      authoritative: false,
      discrepanciesObservedThisInvocation: [
        { kind: "bond-position-missing", stakerPrincipal: stakerTwo },
      ],
    });
  });

  it("accepts a bond participant that has no STX position", async () => {
    const sidekickStore = await store();
    const api = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValue(page([{ staker: stakerTwo, types: ["stx", "btc"] }], null, null, 1)),
    };
    // `register-for-bond` never writes `staker-info`, so a bond participant the API also labels
    // "stx" reads back with no STX position. Revision 1 treated that as an unexplained gap and
    // voided the whole run; a positive bond membership for this manager explains it.
    const node = {
      callReadOnly: vi.fn().mockImplementation(async (_contract: string, functionName: string) => {
        if (functionName === "get-bond-membership") return bondMembership();
        if (functionName === "get-staker-info") return noneCV();
        return noneCV();
      }),
    };

    await expect(syncSignerStakers(options(sidekickStore, api, node))).resolves.toMatchObject({
      status: "completed",
      authoritative: true,
      discrepanciesObservedThisInvocation: [],
    });
    expect(sidekickStore.listSignerStakers(manager)[0]).toMatchObject({
      stakerPrincipal: stakerTwo,
      active: true,
      bond: { bondIndex: 0n, isL1Lock: false },
    });
  });

  it("refuses to count another signer's bond as this pool's roster", async () => {
    const sidekickStore = await store();
    const api = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValue(page([{ staker: stakerTwo, types: ["btc"] }], null, null, 1)),
    };
    const otherManager = "SP2JXKMSH007NPYAQHKJPQMAQYAD90NQGTVJVQ02B.other-manager";
    const node = {
      callReadOnly: vi
        .fn()
        .mockImplementation(async (_contract: string, functionName: string) =>
          functionName === "get-bond-membership" ? bondMembership(otherManager) : noneCV(),
        ),
    };

    await expect(syncSignerStakers(options(sidekickStore, api, node))).resolves.toMatchObject({
      status: "incomplete",
      discrepanciesObservedThisInvocation: [
        {
          kind: "bond-signer-mismatch",
          stakerPrincipal: stakerTwo,
          expectedSignerPrincipal: manager,
          actualSignerPrincipal: otherManager,
        },
      ],
    });
  });

  it("does not present a cold-start empty API roster as authoritatively complete", async () => {
    const sidekickStore = await store();
    const api = { getSignerStakers: vi.fn().mockResolvedValue(page([], null, null, 0)) };
    const node = { callReadOnly: vi.fn() };

    await expect(syncSignerStakers(options(sidekickStore, api, node))).resolves.toMatchObject({
      status: "incomplete",
      authoritative: false,
      activeStakers: 0,
    });
    expect(node.callReadOnly).not.toHaveBeenCalled();
    expect(sidekickStore.getLatestCompletedSignerStakerRun(sourceId, manager)).toBeNull();
  });

  it("uses exact cycle membership when the latest signer has changed", async () => {
    const sidekickStore = await store();
    const api = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValue(page([{ staker: stakerOne, types: ["stx"] }], null, null)),
    };
    let cycleReads = 0;
    const node = {
      callReadOnly: vi.fn().mockImplementation(async (_contract: string, fn: string) => {
        if (fn === "get-bond-membership") return noneCV();
        if (fn === "get-staker-info") return position(otherManager);
        if (fn === "reward-cycle-to-burn-height") return uintCV(961_000n);
        cycleReads += 1;
        return cycleReads === 1
          ? membership(49_000_000_000n, manager)
          : membership(75_000_000_000n, otherManager);
      }),
    };

    await expect(syncSignerStakers(options(sidekickStore, api, node))).resolves.toMatchObject({
      nodeVerifiedStxPositions: 1,
      unverifiedStxDiscoveries: 0,
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
      {
        stakerPrincipal: stakerOne,
        stxNodeVerified: true,
        position: { signerPrincipal: otherManager },
      },
    ]);
    expect(sidekickStore.listCycleMemberships(manager)).toEqual([
      {
        stakerPrincipal: stakerOne,
        rewardCycle: 141n,
        signerPrincipal: manager,
        amountUstx: 49_000_000_000n,
        active: true,
      },
    ]);
  });

  it("retains an API-omitted current-cycle member across a signer switch", async () => {
    const sidekickStore = await store();
    const initialApi = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValue(page([{ staker: stakerOne, types: ["stx"] }], null, null)),
    };
    await syncSignerStakers(options(sidekickStore, initialApi, nodeReads()));

    const omittedApi = {
      getSignerStakers: vi.fn().mockResolvedValue(page([], null, null)),
    };
    let switchedCycleReads = 0;
    const switchedNode = {
      callReadOnly: vi.fn().mockImplementation(async (_contract: string, fn: string) => {
        if (fn === "get-bond-membership") return noneCV();
        if (fn === "get-staker-info") return position(otherManager);
        if (fn === "reward-cycle-to-burn-height") return uintCV(961_000n);
        switchedCycleReads += 1;
        return switchedCycleReads === 1
          ? membership(49_000_000_000n, manager)
          : membership(75_000_000_000n, otherManager);
      }),
    };

    await expect(
      syncSignerStakers({
        ...options(sidekickStore, omittedApi, switchedNode),
        observedAt: later,
      }),
    ).resolves.toMatchObject({ status: "completed", authoritative: true, activeStakers: 1 });
    expect(sidekickStore.listCycleMemberships(manager)).toEqual([
      expect.objectContaining({
        stakerPrincipal: stakerOne,
        rewardCycle: 141n,
        signerPrincipal: manager,
        active: true,
      }),
    ]);
    expect(sidekickStore.listCycleMembershipsForCycle(manager, 142)).toEqual([
      expect.objectContaining({ stakerPrincipal: stakerOne, active: false }),
    ]);
  });

  it("prunes a naturally expired retained STX position without wedging surviving stakers", async () => {
    const sidekickStore = await store();
    const initialApi = {
      getSignerStakers: vi.fn().mockResolvedValue(
        page(
          [
            { staker: stakerOne, types: ["stx"] },
            { staker: stakerTwo, types: ["stx"] },
          ],
          null,
          null,
          2,
          stakerOne,
          2,
        ),
      ),
    };
    const initialNode = nodeReadsForPositions(
      new Map([
        [stakerOne, position(manager, 141n, 2n)],
        [stakerTwo, position(manager, 141n, 4n)],
      ]),
    );
    await syncSignerStakers({
      ...options(sidekickStore, initialApi, initialNode),
      pageLimit: 2,
      stakerConcurrency: 1,
    });

    const survivorApi = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValue(page([{ staker: stakerTwo, types: ["stx"] }], null, null)),
    };
    const expiryNode = nodeReadsForPositions(
      new Map([
        [stakerOne, null],
        [stakerTwo, position(manager, 141n, 4n)],
      ]),
    );
    await expect(
      syncSignerStakers({
        ...options(sidekickStore, survivorApi, expiryNode),
        observedAt: later,
        currentRewardCycle: 143,
        chainAnchor: { ...chainAnchor, rewardCycle: 143 },
        stakerConcurrency: 1,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      authoritative: true,
      activeStakers: 1,
      unverifiedStxDiscoveries: 0,
      discrepanciesObservedThisInvocation: [],
    });
    expect(sidekickStore.listSignerStakers(manager)).toMatchObject([
      { stakerPrincipal: stakerTwo, active: true, stxNodeVerified: true },
    ]);
    expect(sidekickStore.listSignerStakers(manager, false)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stakerPrincipal: stakerOne,
          active: false,
          stxNodeVerified: false,
          position: expect.objectContaining({ active: false, unlockCycle: 143n }),
        }),
      ]),
    );
    expect(sidekickStore.listCycleMemberships(manager)).toEqual([
      expect.objectContaining({ stakerPrincipal: stakerTwo, rewardCycle: 143n, active: true }),
      expect.objectContaining({ stakerPrincipal: stakerTwo, rewardCycle: 144n, active: true }),
    ]);
    expect(sidekickStore.listCycleMembershipsForCycle(manager, 142)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stakerPrincipal: stakerOne, active: false }),
      ]),
    );

    const repeatedNode = nodeReadsForPositions(new Map([[stakerTwo, position(manager, 141n, 4n)]]));
    await expect(
      syncSignerStakers({
        ...options(sidekickStore, survivorApi, repeatedNode),
        observedAt: latest,
        currentRewardCycle: 144,
        chainAnchor: { ...chainAnchor, rewardCycle: 144 },
        stakerConcurrency: 1,
      }),
    ).resolves.toMatchObject({ status: "completed", authoritative: true, activeStakers: 1 });
    expect(repeatedNode.callReadOnly).not.toHaveBeenCalledWith(
      pox5,
      "get-staker-info",
      manager,
      [encodePrincipalHex(stakerOne)],
      expect.anything(),
    );
  });

  it("authoritatively deactivates a retained roster when every STX position has expired", async () => {
    const sidekickStore = await store();
    const initialApi = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValue(page([{ staker: stakerOne, types: ["stx"] }], null, null)),
    };
    await syncSignerStakers(
      options(
        sidekickStore,
        initialApi,
        nodeReadsForPositions(new Map([[stakerOne, position(manager, 141n, 2n)]])),
      ),
    );

    const emptyApi = { getSignerStakers: vi.fn().mockResolvedValue(page([], null, null, 0)) };
    const result = await syncSignerStakers({
      ...options(sidekickStore, emptyApi, nodeReadsForPositions(new Map([[stakerOne, null]]))),
      observedAt: later,
      currentRewardCycle: 143,
      chainAnchor: { ...chainAnchor, rewardCycle: 143 },
    });

    expect(result).toMatchObject({
      status: "completed",
      authoritative: true,
      activeStakers: 0,
      discrepanciesObservedThisInvocation: [],
    });
    expect(sidekickStore.getLatestCompletedSignerStakerRun(sourceId, manager)?.runId).toBe(
      result.runId,
    );
    expect(sidekickStore.listSignerStakers(manager)).toEqual([]);
    expect(sidekickStore.listSignerStakers(manager, false)).toMatchObject([
      { stakerPrincipal: stakerOne, active: false, stxNodeVerified: false },
    ]);
    expect(sidekickStore.listCycleMemberships(manager)).toEqual([]);
    expect(sidekickStore.listCycleMembershipsForCycle(manager, 142)).toEqual([
      expect.objectContaining({ stakerPrincipal: stakerOne, active: false }),
    ]);

    const warmEmptyNode = { callReadOnly: vi.fn() };
    const warmEmpty = await syncSignerStakers({
      ...options(sidekickStore, emptyApi, warmEmptyNode),
      observedAt: latest,
      currentRewardCycle: 144,
      chainAnchor: { ...chainAnchor, rewardCycle: 144 },
    });
    expect(warmEmpty).toMatchObject({
      status: "completed",
      authoritative: true,
      activeStakers: 0,
      discrepanciesObservedThisInvocation: [],
    });
    expect(warmEmptyNode.callReadOnly).not.toHaveBeenCalled();
    expect(sidekickStore.getLatestCompletedSignerStakerRun(sourceId, manager)?.runId).toBe(
      warmEmpty.runId,
    );
  });

  it("keeps transition-only and retained bond candidates fail-closed on missing STX state", async () => {
    const transitionStore = await store();
    const emptyApi = { getSignerStakers: vi.fn().mockResolvedValue(page([], null, null, 0)) };
    await expect(
      syncSignerStakers({
        ...options(transitionStore, emptyApi, nodeReadsForPositions(new Map([[stakerOne, null]]))),
        transitionCandidatePrincipals: [stakerOne],
      }),
    ).resolves.toMatchObject({
      status: "incomplete",
      authoritative: false,
      discrepanciesObservedThisInvocation: [
        { kind: "stx-position-missing", stakerPrincipal: stakerOne },
      ],
    });
    await expect(
      syncSignerStakers({
        ...options(transitionStore, emptyApi, nodeReadsForPositions(new Map([[stakerOne, null]]))),
        observedAt: later,
      }),
    ).resolves.toMatchObject({
      status: "incomplete",
      authoritative: false,
      discrepanciesObservedThisInvocation: [
        { kind: "stx-position-missing", stakerPrincipal: stakerOne },
      ],
    });

    const bondStore = await store();
    const initialApi = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValue(page([{ staker: stakerTwo, types: ["stx", "btc"] }], null, null)),
    };
    await syncSignerStakers(
      options(
        bondStore,
        initialApi,
        nodeReadsForPositions(new Map([[stakerTwo, position(manager, 141n, 2n)]])),
      ),
    );
    // Retained bond candidate, both anchored reads empty: the API's silence and the node's agree,
    // so this is a verified absence rather than the permanent fail-closed state revision 1 left it
    // in once the bond term ended.
    await expect(
      syncSignerStakers({
        ...options(bondStore, emptyApi, nodeReadsForPositions(new Map([[stakerTwo, null]]))),
        observedAt: later,
        currentRewardCycle: 143,
        chainAnchor: { ...chainAnchor, rewardCycle: 143 },
      }),
    ).resolves.toMatchObject({
      status: "completed",
      authoritative: true,
      discrepanciesObservedThisInvocation: [],
    });
    expect(bondStore.listSignerStakers(manager)).toEqual([]);

    // A still-live bond keeps the candidate active with the type the node reported.
    const liveBondStore = await store();
    await expect(
      syncSignerStakers(
        options(
          liveBondStore,
          initialApi,
          nodeReadsForPositions(
            new Map([[stakerTwo, null]]),
            new Map([[stakerTwo, bondMembership(manager, { isL1Lock: true })]]),
          ),
        ),
      ),
    ).resolves.toMatchObject({ status: "completed", authoritative: true });
    expect(liveBondStore.listSignerStakers(manager)).toMatchObject([
      { stakerPrincipal: stakerTwo, active: true, bond: { isL1Lock: true } },
    ]);
  });

  it("preserves prior memberships and resumes enumeration when the exact API tip moves", async () => {
    const sidekickStore = await store();
    await syncSignerStakers(
      options(
        sidekickStore,
        {
          getSignerStakers: vi
            .fn()
            .mockResolvedValue(page([{ staker: stakerOne, types: ["stx"] }], null, null)),
        },
        nodeReads(),
      ),
    );
    const movedStatus = apiStatus({ index_block_hash: `0x${"44".repeat(32)}` });
    const failedNode = nodeReads();
    const api = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValueOnce(page([{ staker: stakerOne, types: ["stx"] }], null, stakerTwo, 2))
        .mockResolvedValueOnce(page([{ staker: stakerTwo, types: ["btc"] }], stakerTwo, null, 2)),
      getStatus: vi.fn().mockResolvedValueOnce(apiStatus()).mockResolvedValueOnce(movedStatus),
    };

    const result = syncSignerStakers({
      ...options(sidekickStore, api, failedNode),
      observedAt: later,
    });
    await expect(result).rejects.toBeInstanceOf(SignerStakerAnchorError);
    await expect(result).rejects.toThrow("Chain tip moved during signer-staker enumeration");
    expect(failedNode.callReadOnly).not.toHaveBeenCalled();
    const partial = sidekickStore.startOrResumeSignerStakerRun(
      sourceId,
      manager,
      later,
      chainAnchor,
    );
    expect(partial).toMatchObject({ status: "running", pagesProcessed: 1, itemsProcessed: 1 });
    expect(sidekickStore.getSignerStakerApiScan(partial.runId)).toMatchObject({
      sealed: false,
      expectedTotal: 2,
      items: [{ stakerPrincipal: stakerOne, hasStx: true, hasBtc: false }],
    });
    expect(sidekickStore.listCycleMemberships(manager)).toHaveLength(2);
    expect(sidekickStore.listCycleMemberships(manager)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rewardCycle: 141n, active: true }),
        expect.objectContaining({ rewardCycle: 142n, active: true }),
      ]),
    );

    const resumedApi = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValue(page([{ staker: stakerTwo, types: ["btc"] }], stakerTwo, null, 2)),
    };
    await expect(
      syncSignerStakers({
        ...options(sidekickStore, resumedApi, nodeReads()),
        observedAt: latest,
      }),
    ).resolves.toMatchObject({
      resumed: true,
      status: "completed",
      authoritative: true,
      pagesProcessed: 2,
      itemsProcessed: 2,
      activeStakers: 2,
    });
    expect(resumedApi.getSignerStakers).toHaveBeenCalledWith(manager, stakerTwo, 1);
  });

  it("classifies a stale API tip before enumeration as a retryable anchor boundary", async () => {
    const sidekickStore = await store();
    const api = {
      getSignerStakers: vi.fn(),
      getStatus: vi.fn().mockResolvedValue(apiStatus({ index_block_hash: `0x${"44".repeat(32)}` })),
    };

    await expect(
      syncSignerStakers(options(sidekickStore, api, nodeReads())),
    ).rejects.toBeInstanceOf(SignerStakerAnchorError);
    expect(api.getSignerStakers).not.toHaveBeenCalled();
  });

  it("rejects an anchored sync without block lookup before discovery or persistence", async () => {
    const sidekickStore = await store();
    const getSignerStakers = vi.fn();
    const startRun = vi.spyOn(sidekickStore, "startOrResumeSignerStakerRun");
    const base = options(sidekickStore, { getSignerStakers }, { callReadOnly: vi.fn() });

    const result = syncSignerStakers({
      ...base,
      api: { getSignerStakers, getStatus: vi.fn().mockResolvedValue(apiStatus()) },
    });

    await expect(result).rejects.toBeInstanceOf(SignerStakerAnchorError);
    await expect(result).rejects.toThrow(
      "Anchored signer-staker synchronization requires API status and block lookup",
    );
    expect(getSignerStakers).not.toHaveBeenCalled();
    expect(startRun).not.toHaveBeenCalled();
  });

  it("preserves the API receiver for class methods and accepts normalized hash casing", async () => {
    const sidekickStore = await store();
    class StatefulApi {
      statusCalls = 0;
      blockCalls = 0;
      enumerationCalls = 0;

      async getSignerStakers() {
        this.enumerationCalls += 1;
        return page([{ staker: stakerOne, types: ["btc"] }], null, null);
      }

      async getStatus() {
        this.statusCalls += 1;
        return apiStatus({
          index_block_hash: chainAnchor.indexBlockHash.toUpperCase().replace("0X", "0x"),
        });
      }

      async getBlock() {
        this.blockCalls += 1;
        return apiBlock({
          index_block_hash: chainAnchor.indexBlockHash.toUpperCase().replace("0X", "0x"),
        });
      }
    }
    const api = new StatefulApi();
    const base = options(
      sidekickStore,
      { getSignerStakers: vi.fn() },
      {
        callReadOnly: vi
          .fn()
          .mockImplementation(async (_contract: string, functionName: string) =>
            functionName === "get-bond-membership" ? bondMembership() : noneCV(),
          ),
      },
    );

    await expect(syncSignerStakers({ ...base, api })).resolves.toMatchObject({
      status: "completed",
      authoritative: true,
    });
    expect(api).toMatchObject({ statusCalls: 4, blockCalls: 1, enumerationCalls: 1 });
  });

  it("does not commit verified projections after cancellation", async () => {
    const sidekickStore = await store();
    const controller = new AbortController();
    const api = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValue(page([{ staker: stakerOne, types: ["stx"] }], null, null)),
    };
    const node = {
      callReadOnly: vi.fn().mockImplementation((_contract, functionName) => {
        if (functionName === "get-bond-membership") return Promise.resolve(noneCV());
        if (functionName === "get-staker-info") {
          controller.abort(new Error("shutdown requested"));
          return Promise.resolve(position());
        }
        if (functionName === "reward-cycle-to-burn-height") {
          return Promise.resolve(uintCV(961_000n));
        }
        return Promise.resolve(membership());
      }),
    };

    await expect(
      syncSignerStakers({ ...options(sidekickStore, api, node), signal: controller.signal }),
    ).rejects.toThrow("shutdown requested");
    expect(sidekickStore.listSignerStakers(manager)).toEqual([]);
    expect(sidekickStore.getLatestCompletedSignerStakerRun(sourceId, manager)).toBeNull();
    expect(sidekickStore.getResumableSignerStakerRun(sourceId, manager)).toMatchObject({
      status: "running",
      chainAnchor,
    });
  });

  it("resumes sealed verification at its pinned anchor after restart and ordinary tip advance", async () => {
    const sidekickStore = await store();
    const api = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValue(page([{ staker: stakerOne, types: ["stx"] }], null, null)),
    };
    await expect(
      syncSignerStakers({
        ...options(sidekickStore, api, nodeReads()),
        onProgress: (progress) => {
          if (progress.phase === "discovering" && progress.completed === 1) {
            throw new Error("simulated restart after roster seal");
          }
        },
      }),
    ).rejects.toThrow("simulated restart after roster seal");

    const sealedRun = sidekickStore.getResumableSignerStakerRun(sourceId, manager);
    expect(sealedRun).toMatchObject({
      status: "running",
      pagesProcessed: 1,
      itemsProcessed: 1,
      chainAnchor,
    });
    expect(sidekickStore.getSignerStakerApiScan(sealedRun?.runId ?? "")).toMatchObject({
      sealed: true,
      anchorFenced: true,
      expectedTotal: 1,
    });

    const advancedAnchor = {
      ...chainAnchor,
      stacksBlockHeight: chainAnchor.stacksBlockHeight + 5,
      indexBlockHash: `0x${"55".repeat(32)}`,
      burnBlockHeight: chainAnchor.burnBlockHeight + 1,
      cyclePosition: chainAnchor.cyclePosition + 1,
    };
    const resumedApi = {
      getSignerStakers: vi.fn(),
      getStatus: vi.fn().mockResolvedValue(
        apiStatus({
          block_height: advancedAnchor.stacksBlockHeight,
          index_block_hash: advancedAnchor.indexBlockHash,
          burn_block_height: advancedAnchor.burnBlockHeight,
        }),
      ),
      getBlock: vi.fn().mockResolvedValue(apiBlock()),
    };
    const resumedNode = nodeReads();
    const progress: Array<{ phase: string; completed: number; total: number | null }> = [];
    const result = await syncSignerStakers({
      ...options(sidekickStore, resumedApi, resumedNode),
      observedAt: later,
      burnBlockHeight: advancedAnchor.burnBlockHeight,
      stacksTipHeight: advancedAnchor.stacksBlockHeight,
      chainAnchor: advancedAnchor,
      onProgress: (value) => progress.push(value),
    });

    expect(result).toMatchObject({ resumed: true, status: "completed", authoritative: true });
    expect(progress[0]).toEqual({ phase: "verifying", completed: 0, total: 1 });
    expect(resumedApi.getSignerStakers).not.toHaveBeenCalled();
    expect(resumedApi.getStatus).toHaveBeenCalledTimes(2);
    expect(resumedApi.getBlock).toHaveBeenCalledWith(chainAnchor.stacksBlockHeight);
    for (const call of resumedNode.callReadOnly.mock.calls) {
      expect(call[4]).toEqual({ tip: chainAnchor.indexBlockHash });
    }
    expect(sidekickStore.getLatestCompletedSignerStakerRun(sourceId, manager)?.chainAnchor).toEqual(
      chainAnchor,
    );
  });

  it("keeps a sealed roster canonical across Bitcoin-only advances", async () => {
    const sidekickStore = await store();
    const api = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValue(page([{ staker: stakerOne, types: ["stx"] }], null, null)),
      getStatus: vi
        .fn()
        // The discovery fence remains exact to the sealed snapshot.
        .mockResolvedValueOnce(apiStatus())
        .mockResolvedValueOnce(apiStatus())
        // Bitcoin advances on either side of the canonical block lookup without a new Stacks tip.
        .mockResolvedValueOnce(apiStatus({ burn_block_height: chainAnchor.burnBlockHeight + 1 }))
        .mockResolvedValueOnce(apiStatus({ burn_block_height: chainAnchor.burnBlockHeight + 2 })),
      // The unchanged canonical Stacks block retains the Bitcoin height that originally anchored
      // it; it does not inherit the snapshot's newer live burn height.
      getBlock: vi
        .fn()
        .mockResolvedValue(apiBlock({ burn_block_height: chainAnchor.burnBlockHeight - 1 })),
    };

    await expect(
      syncSignerStakers(options(sidekickStore, api, nodeReads())),
    ).resolves.toMatchObject({
      status: "completed",
      authoritative: true,
    });
    expect(api.getStatus).toHaveBeenCalledTimes(4);
    expect(api.getBlock).toHaveBeenCalledWith(chainAnchor.stacksBlockHeight);
    expect(sidekickStore.getLatestCompletedSignerStakerRun(sourceId, manager)?.chainAnchor).toEqual(
      chainAnchor,
    );
  });

  it("rejects a sealed roster when its pinned anchor became noncanonical", async () => {
    const sidekickStore = await store();
    const api = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValue(page([{ staker: stakerOne, types: ["stx"] }], null, null)),
      getBlock: vi.fn().mockResolvedValue(apiBlock({ canonical: false })),
    };

    const failure = await syncSignerStakers(options(sidekickStore, api, nodeReads())).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      name: SignerStakerAnchorError.name,
      message: "Sealed signer-staker anchor is no longer canonical",
      invalidatesSealedRun: true,
      evidence: {
        anchor: {
          stacksBlockHeight: chainAnchor.stacksBlockHeight,
          indexBlockHash: chainAnchor.indexBlockHash,
          burnBlockHeight: chainAnchor.burnBlockHeight,
        },
        apiTipBefore: {
          stacksBlockHeight: chainAnchor.stacksBlockHeight,
          indexBlockHash: chainAnchor.indexBlockHash,
          burnBlockHeight: chainAnchor.burnBlockHeight,
        },
        indexedBlock: {
          canonical: false,
          stacksBlockHeight: chainAnchor.stacksBlockHeight,
          indexBlockHash: chainAnchor.indexBlockHash,
          burnBlockHeight: chainAnchor.burnBlockHeight,
        },
      },
    });
    expect(sidekickStore.getLatestCompletedSignerStakerRun(sourceId, manager)).toBeNull();
    expect(sidekickStore.listSignerStakers(manager)).toEqual([]);
    expect(sidekickStore.getResumableSignerStakerRun(sourceId, manager)).toBeNull();

    const replacementAnchor = {
      ...chainAnchor,
      stacksBlockHeight: chainAnchor.stacksBlockHeight + 1,
      indexBlockHash: `0x${"77".repeat(32)}`,
      burnBlockHeight: chainAnchor.burnBlockHeight + 1,
      cyclePosition: chainAnchor.cyclePosition + 1,
    };
    const replacementApi = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValue(page([{ staker: stakerOne, types: ["stx"] }], null, null)),
      getStatus: vi.fn().mockResolvedValue(
        apiStatus({
          block_height: replacementAnchor.stacksBlockHeight,
          index_block_hash: replacementAnchor.indexBlockHash,
          burn_block_height: replacementAnchor.burnBlockHeight,
        }),
      ),
      getBlock: vi.fn().mockResolvedValue(
        apiBlock({
          height: replacementAnchor.stacksBlockHeight,
          index_block_hash: replacementAnchor.indexBlockHash,
          burn_block_height: replacementAnchor.burnBlockHeight,
        }),
      ),
    };
    await expect(
      syncSignerStakers({
        ...options(sidekickStore, replacementApi, nodeReads()),
        observedAt: later,
        burnBlockHeight: replacementAnchor.burnBlockHeight,
        stacksTipHeight: replacementAnchor.stacksBlockHeight,
        chainAnchor: replacementAnchor,
      }),
    ).resolves.toMatchObject({
      resumed: false,
      status: "completed",
      authoritative: true,
    });
  });

  it("treats a retained API entry with zero PoX-5 cycles as inactive", async () => {
    const sidekickStore = await store();
    const api = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValue(page([{ staker: stakerOne, types: ["stx"] }], null, null)),
    };
    const node = {
      callReadOnly: vi
        .fn()
        .mockImplementation(async (_contract: string, functionName: string) =>
          functionName === "get-bond-membership" ? noneCV() : position(manager, 141n, 0n),
        ),
    };

    await expect(syncSignerStakers(options(sidekickStore, api, node))).resolves.toMatchObject({
      nodeVerifiedStxPositions: 0,
      activeStakers: 0,
      unverifiedStxDiscoveries: 0,
      discrepanciesObservedThisInvocation: [],
    });
    // Bond membership plus staker info: both authoritative reads are taken before concluding the
    // retained entry holds nothing.
    expect(node.callReadOnly).toHaveBeenCalledTimes(2);
    expect(sidekickStore.listSignerStakers(manager)).toEqual([]);
    expect(sidekickStore.listSignerStakers(manager, false)).toMatchObject([
      { stakerPrincipal: stakerOne, active: false, stxNodeVerified: false, position: null },
    ]);
    expect(sidekickStore.listCycleMemberships(manager)).toEqual([]);
  });

  it("reconciles long-lived positions whose accumulated lifetime exceeds 96 cycles", async () => {
    const sidekickStore = await store();
    const api = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValue(page([{ staker: stakerOne, types: ["stx"] }], null, null)),
    };
    let cycleReads = 0;
    const node = {
      callReadOnly: vi.fn().mockImplementation(async (_contract: string, fn: string) => {
        if (fn === "get-bond-membership") return noneCV();
        if (fn === "get-staker-info") return position(manager, 11n, 275n);
        if (fn === "reward-cycle-to-burn-height") return uintCV(5_720n);
        cycleReads += 1;
        return cycleReads === 1 ? membership(100_000_000_000n) : membership(100_000_000_000n);
      }),
    };

    await expect(
      syncSignerStakers({
        ...options(sidekickStore, api, node),
        currentRewardCycle: 284,
        chainAnchor: { ...chainAnchor, rewardCycle: 284 },
      }),
    ).resolves.toMatchObject({
      status: "completed",
      nodeVerifiedStxPositions: 1,
      unverifiedStxDiscoveries: 0,
      discrepanciesObservedThisInvocation: [],
    });
    expect(sidekickStore.listSignerStakers(manager)).toMatchObject([
      {
        stakerPrincipal: stakerOne,
        stxNodeVerified: true,
        position: { firstRewardCycle: 11n, numCycles: 275n },
      },
    ]);
    expect(sidekickStore.listCycleMemberships(manager)).toMatchObject([
      { rewardCycle: 284n, amountUstx: 100_000_000_000n },
      { rewardCycle: 285n, amountUstx: 100_000_000_000n },
    ]);
  });

  it("rejects positions with more than 97 active cycles", async () => {
    const sidekickStore = await store();
    const api = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValue(page([{ staker: stakerOne, types: ["stx"] }], null, null)),
    };
    const node = {
      callReadOnly: vi.fn().mockImplementation(async (_contract: string, fn: string) => {
        if (fn === "get-bond-membership") return noneCV();
        if (fn === "get-staker-info") return position(manager, 141n, 98n);
        if (fn === "reward-cycle-to-burn-height") return uintCV(5_720n);
        throw new Error(`unexpected read ${fn}`);
      }),
    };

    await expect(syncSignerStakers(options(sidekickStore, api, node))).rejects.toThrow(
      "PoX-5 returned invalid active cycle span 98",
    );
  });

  it("excludes cycles whose exact membership still belongs to the prior signer", async () => {
    const sidekickStore = await store();
    const api = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValue(page([{ staker: stakerOne, types: ["stx"] }], null, null)),
    };
    let cycleReads = 0;
    const node = {
      callReadOnly: vi.fn().mockImplementation(async (_contract: string, fn: string) => {
        if (fn === "get-bond-membership") return noneCV();
        if (fn === "get-staker-info") return position();
        if (fn === "reward-cycle-to-burn-height") return uintCV(961_000n);
        cycleReads += 1;
        return cycleReads === 1 ? membership(49_000_000_000n, otherManager) : membership();
      }),
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
        .mockResolvedValueOnce(page([{ staker: stakerOne, types: ["stx"] }], null, stakerTwo, 2))
        .mockRejectedValueOnce(new Error("API unavailable")),
    };
    const node = nodeReads();

    await expect(syncSignerStakers(options(sidekickStore, interruptedApi, node))).rejects.toThrow(
      "API unavailable",
    );
    expect(
      sidekickStore.startOrResumeSignerStakerRun(sourceId, manager, observedAt, chainAnchor),
    ).toMatchObject({ status: "running", cursor: stakerTwo, pagesProcessed: 1 });

    const wrongCursorApi = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValue(page([{ staker: stakerOne, types: ["btc"] }], stakerTwo, null, 2)),
    };
    await expect(syncSignerStakers(options(sidekickStore, wrongCursorApi, node))).rejects.toThrow(
      `did not resume at requested cursor ${stakerTwo}`,
    );

    const resumedApi = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValue(page([{ staker: stakerTwo, types: ["btc"] }], stakerTwo, null, 2)),
    };
    await expect(
      syncSignerStakers(options(sidekickStore, resumedApi, node)),
    ).resolves.toMatchObject({
      resumed: true,
      status: "completed",
      pagesProcessed: 2,
      itemsProcessed: 2,
    });
    expect(resumedApi.getSignerStakers).toHaveBeenCalledWith(manager, stakerTwo, 1);
    expect(sidekickStore.listSignerStakers(manager)).toHaveLength(2);
  });

  it("rejects a current cursor that does not identify the first returned staker", async () => {
    const sidekickStore = await store();
    const api = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValue(page([{ staker: stakerOne, types: ["btc"] }], null, null, 1, null)),
    };

    await expect(syncSignerStakers(options(sidekickStore, api, nodeReads()))).rejects.toThrow(
      `current cursor <empty> does not match first result ${stakerOne}`,
    );
  });

  it("resumes a committed page after the SQLite store is closed and reopened", async () => {
    const directory = await mkdtemp(join(tmpdir(), "signer-sidekick-resume-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "sidekick.sqlite");
    const first = await openSidekickStore(databasePath, observedAt);
    first.store.upsertChainSource({
      sourceId,
      kind: "api",
      network: "mainnet",
      baseUrl: apiUrl,
      observedAt,
    });
    first.store.upsertChainSource({
      sourceId: nodeSourceId,
      kind: "node",
      network: "mainnet",
      baseUrl: nodeUrl,
      observedAt,
    });
    const interruptedApi = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValueOnce(page([{ staker: stakerOne, types: ["stx"] }], null, stakerTwo, 2))
        .mockRejectedValueOnce(new Error("API unavailable")),
    };

    await expect(
      syncSignerStakers(options(first.store, interruptedApi, nodeReads())),
    ).rejects.toThrow("API unavailable");
    first.store.close();

    const reopened = await openSidekickStore(databasePath, later);
    openStores.push(reopened.store);
    const resumedApi = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValue(page([{ staker: stakerTwo, types: ["btc"] }], stakerTwo, null, 2)),
    };
    await expect(
      syncSignerStakers(options(reopened.store, resumedApi, nodeReads())),
    ).resolves.toMatchObject({
      resumed: true,
      status: "completed",
      pagesProcessed: 2,
      itemsProcessed: 2,
      activeStakers: 2,
    });
    expect(resumedApi.getSignerStakers).toHaveBeenCalledWith(manager, stakerTwo, 1);
  });

  it("reconciles 500 stakers at default concurrency after the live API tip advances", async () => {
    const sidekickStore = await store();
    const stakers = Array.from({ length: 500 }, (_, index) => ({
      staker: `${stakerOne}.s${index.toString().padStart(4, "0")}`,
      types: ["stx"] as ("stx" | "btc")[],
    }));
    const indexByPrincipal = new Map(stakers.map(({ staker }, index) => [staker, index] as const));
    let verificationStarted = false;
    const advancedStatus = apiStatus({
      block_height: chainAnchor.stacksBlockHeight + 1,
      index_block_hash: `0x${"66".repeat(32)}`,
    });
    const api = {
      getSignerStakers: vi.fn(
        async (_managerPrincipal: string, cursor: string | null, limit: number) => {
          const start = cursor === null ? 0 : indexByPrincipal.get(cursor);
          if (start === undefined) throw new Error(`Unknown cursor ${cursor}`);
          const results = stakers.slice(start, start + limit);
          const nextIndex = start + results.length;
          return {
            total: stakers.length,
            limit,
            cursor: {
              current: results[0]?.staker ?? null,
              next: nextIndex < stakers.length ? (stakers[nextIndex]?.staker ?? null) : null,
              previous: null,
            },
            results,
          } satisfies SignerStakersPage;
        },
      ),
      getStatus: vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(verificationStarted ? advancedStatus : apiStatus()),
        ),
      getBlock: vi.fn().mockResolvedValue(apiBlock()),
    };
    let activeStakerReads = 0;
    let maximumStakerReads = 0;
    const node = {
      callReadOnly: vi.fn().mockImplementation(async (_contract, functionName) => {
        if (functionName === "get-bond-membership") return Promise.resolve(noneCV());
        if (functionName === "get-staker-info") {
          verificationStarted = true;
          activeStakerReads += 1;
          maximumStakerReads = Math.max(maximumStakerReads, activeStakerReads);
          await Promise.resolve();
          activeStakerReads -= 1;
          return position(manager, 141n, 12n);
        }
        if (functionName === "reward-cycle-to-burn-height") {
          return uintCV(986_200n);
        }
        return membership();
      }),
    };
    const scaleOptions = {
      ...options(sidekickStore, api, node),
      pageLimit: 200,
    };

    await expect(syncSignerStakers(scaleOptions)).resolves.toMatchObject({
      status: "completed",
      authoritative: true,
      pagesProcessed: 3,
      itemsProcessed: 500,
      activeStakers: 500,
      nodeVerifiedStxPositions: 500,
      unverifiedStxDiscoveries: 0,
      discrepanciesObservedThisInvocation: [],
    });
    expect(maximumStakerReads).toBe(4);
    expect(api.getStatus).toHaveBeenCalledTimes(4);
    expect(api.getBlock).toHaveBeenCalledWith(chainAnchor.stacksBlockHeight);
    expect(sidekickStore.listSignerStakers(manager)).toHaveLength(500);
    expect(sidekickStore.listCycleMemberships(manager)).toHaveLength(6_000);
    expect(sidekickStore.listCycleMembershipsForCycle(manager, 141)).toHaveLength(500);
    expect(sidekickStore.listCycleMembershipsForCycle(manager, 152)).toHaveLength(500);
  }, 30_000);

  it("records a missing node position as a discrepancy", async () => {
    const sidekickStore = await store();
    const api = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValue(page([{ staker: stakerOne, types: ["stx"] }], null, null)),
    };
    const node = { callReadOnly: vi.fn().mockResolvedValue(noneCV()) };

    await expect(syncSignerStakers(options(sidekickStore, api, node))).resolves.toMatchObject({
      status: "incomplete",
      authoritative: false,
      unverifiedStxDiscoveries: 1,
      discrepanciesObservedThisInvocation: [
        { kind: "stx-position-missing", stakerPrincipal: stakerOne },
      ],
    });
  });

  it("records a mid-scan cycle-membership race without aborting the synchronization", async () => {
    const sidekickStore = await store();
    const api = {
      getSignerStakers: vi
        .fn()
        .mockResolvedValue(page([{ staker: stakerOne, types: ["stx"] }], null, null)),
    };
    let cycleReads = 0;
    const node = {
      callReadOnly: vi.fn().mockImplementation(async (_contract: string, fn: string) => {
        if (fn === "get-bond-membership") return noneCV();
        if (fn === "get-staker-info") return position();
        if (fn === "reward-cycle-to-burn-height") return uintCV(961_000n);
        cycleReads += 1;
        return cycleReads === 1 ? noneCV() : membership();
      }),
    };

    await expect(syncSignerStakers(options(sidekickStore, api, node))).resolves.toMatchObject({
      status: "incomplete",
      nodeVerifiedStxPositions: 0,
      unverifiedStxDiscoveries: 1,
      discrepanciesObservedThisInvocation: [
        {
          kind: "cycle-membership-missing",
          stakerPrincipal: stakerOne,
          rewardCycle: "141",
        },
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

    // The bound is on candidates in flight, not raw reads. Each candidate now issues its bond and
    // staker-info reads together so both land at the same anchor, so two candidates means four
    // concurrent reads.
    expect(maximumReads).toBe(4);
    // One bond read and one staker-info read per candidate, taken together at the same anchor.
    expect(node.callReadOnly).toHaveBeenCalledTimes(4);
  });
});
