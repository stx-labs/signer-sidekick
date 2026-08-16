import {
  contractPrincipalCV,
  cvToHex,
  noneCV,
  stringAsciiCV,
  tupleCV,
  uintCV,
} from "@stacks/transactions";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SmartContractLogPage, TransactionSummary } from "./chain-clients.js";
import { syncManagerEvents } from "./manager-event-sync.js";
import { createChainSourceId, openSidekickStore, type SidekickStore } from "./storage/store.js";

const observedAt = "2026-07-14T12:00:00.000Z";
const manager = "SP000000000000000000002Q6VF78.signer-manager";
const staker = "SP000000000000000000002Q6VF78.staker";
const apiUrl = "https://api.mainnet.hiro.so";
const sourceId = createChainSourceId("mainnet", apiUrl);
const txOne = `0x${"11".repeat(32)}`;
const txTwo = `0x${"22".repeat(32)}`;
const cursorTwo = "8599999:2147483647:2:0";
const openStores: SidekickStore[] = [];

async function store(): Promise<SidekickStore> {
  const { store } = await openSidekickStore(":memory:", observedAt);
  openStores.push(store);
  store.chainState.upsertSource({
    sourceId,
    kind: "api",
    network: "mainnet",
    baseUrl: apiUrl,
    observedAt,
  });
  return store;
}

function claimEventHex(): string {
  return cvToHex(
    tupleCV({
      topic: stringAsciiCV("claim-staker-rewards"),
      staker: contractPrincipalCV("SP000000000000000000002Q6VF78", "staker"),
      "reward-cycle": uintCV(141n),
      "bond-index": noneCV(),
      "amount-sats": uintCV(10_000n),
      "l1-withdrawal": noneCV(),
    }),
  );
}

function settleEventHex(): string {
  return cvToHex(
    tupleCV({
      topic: stringAsciiCV("settle-accepted-withdrawal"),
      "request-id": uintCV(72n),
      staker: contractPrincipalCV("SP000000000000000000002Q6VF78", "staker"),
      "liability-released": uintCV(10_000n),
    }),
  );
}

function page(
  txId: string,
  eventIndex: number,
  hex: string,
  cursor: string,
  nextCursor: string | null,
): SmartContractLogPage {
  return {
    limit: 1,
    offset: 0,
    total: 2,
    cursor,
    next_cursor: null,
    prev_cursor: nextCursor,
    results: [
      {
        event_index: eventIndex,
        event_type: "smart_contract_log",
        tx_id: txId,
        contract_log: {
          contract_id: manager,
          topic: "print",
          value: { hex, repr: "(tuple ...)" },
        },
      },
    ],
  };
}

function transaction(txId: string, height: number): TransactionSummary {
  return {
    tx_id: txId,
    status: "success",
    block: {
      height,
      hash: `0x${"33".repeat(32)}`,
      index_hash: `0x${"44".repeat(32)}`,
      time: 1_784_000_000,
      tx_index: 2,
    },
    bitcoin_block: { height: 960_240, time: 1_784_000_000 },
  };
}

function nodeTransaction(txId: string, height: number) {
  return {
    status: "observed" as const,
    httpStatus: 200,
    value: {
      txid: txId as `0x${string}`,
      transactionHex: "00",
      nonce: 0n,
      feeUstx: 0n,
      indexBlockHash: `0x${"44".repeat(32)}` as `0x${string}`,
      blockHeight: BigInt(height),
      isCanonical: true,
      resultRepr: "(ok true)",
    },
  };
}

function nodeBlocks(canonical = true) {
  return {
    getTenureInfo: vi.fn(async () => ({
      tip_block_id: `0x${"99".repeat(32)}` as `0x${string}`,
      tip_height: 8_700_000,
      reward_cycle: 141,
    })),
    getNakamotoBlockById: vi.fn(async () => Uint8Array.of(1, 2, 3)),
    getNakamotoBlockAtHeight: vi.fn(async () =>
      canonical ? Uint8Array.of(1, 2, 3) : Uint8Array.of(4, 5, 6),
    ),
  };
}

afterEach(() => {
  for (const sidekickStore of openStores.splice(0)) sidekickStore.close();
});

describe("manager event synchronization", () => {
  it("commits API event content only after a canonical local transaction witness", async () => {
    const sidekickStore = await store();
    const nodeTransactions = {
      lookupIndexedTransaction: vi.fn().mockResolvedValue(nodeTransaction(txOne, 8_600_000)),
    };

    await expect(
      syncManagerEvents({
        store: sidekickStore,
        api: {
          getSmartContractLogs: vi
            .fn()
            .mockResolvedValue(page(txOne, 1, claimEventHex(), "8600000:2147483647:3:1", null)),
          getTransaction: vi.fn().mockResolvedValue(transaction(txOne, 8_600_000)),
        },
        nodeTransactions,
        sourceId,
        chainId: 1,
        managerPrincipal: manager,
        eventVocabulary: "reference-manager-v1",
        observedAt,
        pageLimit: 100,
      }),
    ).resolves.toMatchObject({ newEvents: 1, nodeVerifiedTransactions: 1 });
    expect(nodeTransactions.lookupIndexedTransaction).toHaveBeenCalledWith(txOne);
    expect(sidekickStore.getChainEvent(1, txOne, 1)).toMatchObject({
      occurredAt: "2026-07-14T03:33:20.000Z",
      firstSeenAt: observedAt,
    });
  });

  it("rejects a page atomically when the local transaction witness disagrees", async () => {
    const sidekickStore = await store();
    const mismatched = nodeTransaction(txOne, 8_600_000);
    mismatched.value.indexBlockHash = `0x${"55".repeat(32)}`;

    await expect(
      syncManagerEvents({
        store: sidekickStore,
        api: {
          getSmartContractLogs: vi
            .fn()
            .mockResolvedValue(page(txOne, 1, claimEventHex(), "8600000:2147483647:3:1", null)),
          getTransaction: vi.fn().mockResolvedValue(transaction(txOne, 8_600_000)),
        },
        nodeTransactions: {
          lookupIndexedTransaction: vi.fn().mockResolvedValue(mismatched),
        },
        sourceId,
        chainId: 1,
        managerPrincipal: manager,
        eventVocabulary: "reference-manager-v1",
        observedAt,
        pageLimit: 100,
      }),
    ).rejects.toThrow("Local node and indexed API disagree");
    expect(sidekickStore.getChainEvent(1, txOne, 1)).toBeNull();
    expect(
      sidekickStore.chainState.getCursor(
        sourceId,
        `manager-logs:v3:reference-manager-v1:${manager}`,
      ),
    ).toBeNull();
  });

  it("uses a stable local canonical-block proof when an old transaction is absent from the index", async () => {
    const sidekickStore = await store();
    const blocks = nodeBlocks();

    await expect(
      syncManagerEvents({
        store: sidekickStore,
        api: {
          getSmartContractLogs: vi
            .fn()
            .mockResolvedValue(page(txOne, 1, claimEventHex(), "8600000:2147483647:3:1", null)),
          getTransaction: vi.fn().mockResolvedValue(transaction(txOne, 8_600_000)),
        },
        nodeTransactions: {
          lookupIndexedTransaction: vi.fn().mockResolvedValue({
            status: "not-found",
            httpStatus: 404,
          }),
        },
        nodeBlocks: blocks,
        sourceId,
        chainId: 1,
        managerPrincipal: manager,
        eventVocabulary: "reference-manager-v1",
        observedAt,
        pageLimit: 100,
      }),
    ).resolves.toMatchObject({ newEvents: 1, nodeVerifiedTransactions: 1 });
    expect(blocks.getNakamotoBlockById).toHaveBeenCalledWith(`0x${"44".repeat(32)}`, {});
    expect(blocks.getNakamotoBlockAtHeight).toHaveBeenCalledWith(8_600_000, {
      tip: `0x${"99".repeat(32)}`,
    });
    expect(sidekickStore.getChainEvent(1, txOne, 1)).not.toBeNull();
  });

  it("rejects an API event when its historical block is not canonical on the local node", async () => {
    const sidekickStore = await store();

    await expect(
      syncManagerEvents({
        store: sidekickStore,
        api: {
          getSmartContractLogs: vi
            .fn()
            .mockResolvedValue(page(txOne, 1, claimEventHex(), "8600000:2147483647:3:1", null)),
          getTransaction: vi.fn().mockResolvedValue(transaction(txOne, 8_600_000)),
        },
        nodeTransactions: {
          lookupIndexedTransaction: vi.fn().mockResolvedValue({
            status: "not-found",
            httpStatus: 404,
          }),
        },
        nodeBlocks: nodeBlocks(false),
        sourceId,
        chainId: 1,
        managerPrincipal: manager,
        eventVocabulary: "reference-manager-v1",
        observedAt,
        pageLimit: 100,
      }),
    ).rejects.toThrow("not canonical according to the local node");
    expect(sidekickStore.getChainEvent(1, txOne, 1)).toBeNull();
  });

  it("backfills canonical logs, enriches block identity, and stops future scans at overlap", async () => {
    const sidekickStore = await store();
    const firstApi = {
      getSmartContractLogs: vi
        .fn()
        .mockResolvedValueOnce(page(txOne, 1, claimEventHex(), "8600000:2147483647:3:1", cursorTwo))
        .mockResolvedValueOnce(page(txTwo, 0, settleEventHex(), cursorTwo, null)),
      getTransaction: vi
        .fn()
        .mockResolvedValueOnce(transaction(txOne, 8_600_000))
        .mockResolvedValueOnce(transaction(txTwo, 8_599_999)),
    };

    await expect(
      syncManagerEvents({
        store: sidekickStore,
        api: firstApi,
        sourceId,
        chainId: 1,
        managerPrincipal: manager,
        eventVocabulary: "reference-manager-v1",
        observedAt,
        pageLimit: 1,
      }),
    ).resolves.toMatchObject({
      resumed: false,
      pagesProcessed: 2,
      eventsProcessed: 2,
      newEvents: 2,
      decodeFailures: 0,
    });
    expect(sidekickStore.getChainEvent(1, txOne, 1)).toMatchObject({
      blockHeight: 8_600_000,
      topic: "claim-staker-rewards",
      decodedPayload: {
        transactionStatus: "success",
        event: { kind: "claim-staker-rewards", stakerPrincipal: staker },
      },
    });

    const overlapApi = {
      getSmartContractLogs: vi
        .fn()
        .mockResolvedValue(page(txOne, 1, claimEventHex(), "8600000:2147483647:3:1", cursorTwo)),
      getTransaction: vi.fn().mockResolvedValue(transaction(txOne, 8_600_000)),
    };
    await expect(
      syncManagerEvents({
        store: sidekickStore,
        api: overlapApi,
        sourceId,
        chainId: 1,
        managerPrincipal: manager,
        eventVocabulary: "reference-manager-v1",
        observedAt,
        pageLimit: 1,
      }),
    ).resolves.toMatchObject({
      pagesProcessed: 1,
      newEvents: 0,
      replayedEvents: 1,
      stoppedAtKnownOverlap: true,
    });
    expect(overlapApi.getSmartContractLogs).toHaveBeenCalledTimes(1);
    expect(overlapApi.getTransaction).not.toHaveBeenCalled();
  });

  it("stores lookalike custom events as generic raw data and removes stale projections", async () => {
    const sidekickStore = await store();
    const api = {
      getSmartContractLogs: vi
        .fn()
        .mockResolvedValue(page(txOne, 1, claimEventHex(), "8600000:2147483647:3:1", null)),
      getTransaction: vi.fn().mockResolvedValue(transaction(txOne, 8_600_000)),
    };

    await syncManagerEvents({
      store: sidekickStore,
      api,
      sourceId,
      chainId: 1,
      managerPrincipal: manager,
      eventVocabulary: "reference-manager-v1",
      observedAt,
      pageLimit: 100,
    });
    expect(sidekickStore.listManagerClaims(1, manager).total).toBe(1);

    const genericResult = await syncManagerEvents({
      store: sidekickStore,
      api,
      sourceId,
      chainId: 1,
      managerPrincipal: manager,
      eventVocabulary: "generic-v1",
      observedAt: "2026-07-14T12:01:00.000Z",
      pageLimit: 100,
    });

    expect(genericResult.decodeFailures).toBe(0);
    expect(sidekickStore.getChainEvent(1, txOne, 1)).toMatchObject({
      topic: "print",
      decodedSchemaVersion: null,
      decodedPayload: null,
    });
    expect(sidekickStore.listManagerClaims(1, manager).total).toBe(0);
    expect(
      sidekickStore.chainState.getCursor(sourceId, `manager-logs:v3:generic-v1:${manager}`),
    ).toMatchObject({ cursor: null });
  });

  it("resumes from the page cursor committed before an interruption", async () => {
    const sidekickStore = await store();
    const interruptedApi = {
      getSmartContractLogs: vi
        .fn()
        .mockResolvedValueOnce(page(txOne, 1, claimEventHex(), "8600000:2147483647:3:1", cursorTwo))
        .mockRejectedValueOnce(new Error("API unavailable")),
      getTransaction: vi.fn().mockResolvedValue(transaction(txOne, 8_600_000)),
    };

    await expect(
      syncManagerEvents({
        store: sidekickStore,
        api: interruptedApi,
        sourceId,
        chainId: 1,
        managerPrincipal: manager,
        eventVocabulary: "reference-manager-v1",
        observedAt,
        pageLimit: 1,
      }),
    ).rejects.toThrow("API unavailable");

    const resumedApi = {
      getSmartContractLogs: vi
        .fn()
        .mockResolvedValue(page(txTwo, 0, settleEventHex(), cursorTwo, null)),
      getTransaction: vi.fn().mockResolvedValue(transaction(txTwo, 8_599_999)),
    };
    await expect(
      syncManagerEvents({
        store: sidekickStore,
        api: resumedApi,
        sourceId,
        chainId: 1,
        managerPrincipal: manager,
        eventVocabulary: "reference-manager-v1",
        observedAt,
        pageLimit: 1,
      }),
    ).resolves.toMatchObject({ resumed: true, pagesProcessed: 1, newEvents: 1 });
    expect(resumedApi.getSmartContractLogs).toHaveBeenCalledWith(manager, cursorTwo, 1);
  });

  it("marks a displaced canonical event non-canonical during overlapping replay", async () => {
    const sidekickStore = await store();
    await syncManagerEvents({
      store: sidekickStore,
      api: {
        getSmartContractLogs: vi
          .fn()
          .mockResolvedValue(page(txOne, 1, claimEventHex(), "8600000:2147483647:3:1", null)),
        getTransaction: vi.fn().mockResolvedValue(transaction(txOne, 8_600_000)),
      },
      sourceId,
      chainId: 1,
      managerPrincipal: manager,
      eventVocabulary: "reference-manager-v1",
      observedAt,
      pageLimit: 100,
    });

    await expect(
      syncManagerEvents({
        store: sidekickStore,
        api: {
          getSmartContractLogs: vi
            .fn()
            .mockResolvedValue(page(txTwo, 0, settleEventHex(), cursorTwo, null)),
          getTransaction: vi.fn().mockResolvedValue(transaction(txTwo, 8_600_000)),
        },
        sourceId,
        chainId: 1,
        managerPrincipal: manager,
        eventVocabulary: "reference-manager-v1",
        observedAt: "2026-07-14T12:01:00.000Z",
        pageLimit: 100,
      }),
    ).resolves.toMatchObject({ reorgedEvents: 1 });
    expect(sidekickStore.getChainEvent(1, txOne, 1)?.canonical).toBe(false);
    expect(sidekickStore.getChainEvent(1, txTwo, 0)?.canonical).toBe(true);
  });

  it("reconciles a multi-page incremental window without displacing its newer page", async () => {
    const sidekickStore = await store();
    await syncManagerEvents({
      store: sidekickStore,
      api: {
        getSmartContractLogs: vi
          .fn()
          .mockResolvedValue(page(txTwo, 0, settleEventHex(), cursorTwo, null)),
        getTransaction: vi.fn().mockResolvedValue(transaction(txTwo, 8_599_999)),
      },
      sourceId,
      chainId: 1,
      managerPrincipal: manager,
      eventVocabulary: "reference-manager-v1",
      observedAt,
      pageLimit: 1,
    });

    await expect(
      syncManagerEvents({
        store: sidekickStore,
        api: {
          getSmartContractLogs: vi
            .fn()
            .mockResolvedValueOnce(
              page(txOne, 1, claimEventHex(), "8600000:2147483647:3:1", cursorTwo),
            )
            .mockResolvedValueOnce(page(txTwo, 0, settleEventHex(), cursorTwo, null)),
          getTransaction: vi
            .fn()
            .mockResolvedValueOnce(transaction(txOne, 8_600_000))
            .mockResolvedValueOnce(transaction(txTwo, 8_599_999)),
        },
        sourceId,
        chainId: 1,
        managerPrincipal: manager,
        eventVocabulary: "reference-manager-v1",
        observedAt: "2026-07-14T12:01:00.000Z",
        pageLimit: 1,
      }),
    ).resolves.toMatchObject({ pagesProcessed: 2, newEvents: 1, reorgedEvents: 0 });
    expect(sidekickStore.getChainEvent(1, txOne, 1)?.canonical).toBe(true);
    expect(sidekickStore.getChainEvent(1, txTwo, 0)?.canonical).toBe(true);
  });

  it("does not commit an enriched page after cancellation", async () => {
    const sidekickStore = await store();
    const controller = new AbortController();
    let release: ((value: TransactionSummary) => void) | undefined;
    const pendingTransaction = new Promise<TransactionSummary>((resolve) => {
      release = resolve;
    });
    const api = {
      getSmartContractLogs: vi
        .fn()
        .mockResolvedValue(page(txOne, 1, claimEventHex(), "8600000:2147483647:3:1", null)),
      getTransaction: vi.fn().mockReturnValue(pendingTransaction),
    };
    const synchronization = syncManagerEvents({
      store: sidekickStore,
      api,
      sourceId,
      chainId: 1,
      managerPrincipal: manager,
      eventVocabulary: "reference-manager-v1",
      observedAt,
      pageLimit: 100,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(api.getTransaction).toHaveBeenCalledOnce());
    controller.abort(new Error("shutdown requested"));
    release?.(transaction(txOne, 8_600_000));

    await expect(synchronization).rejects.toThrow("shutdown requested");
    expect(sidekickStore.getChainEvent(1, txOne, 1)).toBeNull();
    expect(
      sidekickStore.chainState.getCursor(
        sourceId,
        `manager-logs:v3:reference-manager-v1:${manager}`,
      ),
    ).toBeNull();
  });
});
