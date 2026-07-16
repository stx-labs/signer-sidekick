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
  store.upsertChainSource({
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

afterEach(() => {
  for (const sidekickStore of openStores.splice(0)) sidekickStore.close();
});

describe("manager event synchronization", () => {
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
        observedAt: "2026-07-14T12:01:00.000Z",
        pageLimit: 1,
      }),
    ).resolves.toMatchObject({ pagesProcessed: 2, newEvents: 1, reorgedEvents: 0 });
    expect(sidekickStore.getChainEvent(1, txOne, 1)?.canonical).toBe(true);
    expect(sidekickStore.getChainEvent(1, txTwo, 0)?.canonical).toBe(true);
  });
});
