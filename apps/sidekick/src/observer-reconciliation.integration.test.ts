import {
  contractPrincipalCV,
  cvToHex,
  noneCV,
  stringAsciiCV,
  tupleCV,
  uintCV,
} from "@stacks/transactions";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodeInfo, NodeTenureInfo, SmartContractLogPage } from "./chain-clients.js";
import { syncManagerEvents } from "./manager-event-sync.js";
import { ObserverInboxProcessor } from "./observer-inbox.js";
import { ObserverReconciliationScheduler } from "./observer-reconciliation.js";
import { createObserverServer } from "./observer-server.js";
import { createChainSourceId, openSidekickStore, type SidekickStore } from "./storage/store.js";

const manager = "SP000000000000000000002Q6VF78.signer-manager";
const staker = "SP000000000000000000002Q6VF78.staker";
const pox5 = "SP000000000000000000002Q6VF78.pox-5";
const sourceId = createChainSourceId("mainnet", "https://api.mainnet.hiro.so");
const txOne = `0x${"11".repeat(32)}`;
const txTwo = `0x${"22".repeat(32)}`;
const openStores: SidekickStore[] = [];

function identity(byte: string) {
  return {
    blockHash: `0x${byte.repeat(32)}` as `0x${string}`,
    indexBlockHash: `0x${String(Number(byte) + 1)
      .padStart(2, "0")
      .repeat(32)}` as `0x${string}`,
    bytes: Uint8Array.of(Number(byte), 2, 3, 4),
  };
}

function eventHex(topic: "claim-staker-rewards" | "settle-accepted-withdrawal"): string {
  return topic === "claim-staker-rewards"
    ? cvToHex(
        tupleCV({
          topic: stringAsciiCV(topic),
          staker: contractPrincipalCV("SP000000000000000000002Q6VF78", "staker"),
          "reward-cycle": uintCV(141n),
          "bond-index": noneCV(),
          "amount-sats": uintCV(10_000n),
          "l1-withdrawal": noneCV(),
        }),
      )
    : cvToHex(
        tupleCV({
          topic: stringAsciiCV(topic),
          "request-id": uintCV(72n),
          staker: contractPrincipalCV("SP000000000000000000002Q6VF78", "staker"),
          "liability-released": uintCV(10_000n),
        }),
      );
}

function page(txId: string, eventIndex: number, hex: string): SmartContractLogPage {
  return {
    limit: 100,
    offset: 0,
    total: 1,
    cursor: "100:2147483647:0:0",
    next_cursor: null,
    prev_cursor: null,
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

function callbackBody(block: ReturnType<typeof identity>, txId: string): string {
  return JSON.stringify({
    events: [
      {
        txid: txId,
        event_index: 0,
        committed: true,
        type: "contract_event",
        contract_event: {
          contract_identifier: manager,
          topic: "print",
          raw_value: "0x01",
        },
      },
    ],
    block_hash: block.blockHash,
    block_height: 100,
    index_block_hash: block.indexBlockHash,
    transactions: [],
  });
}

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
});

describe("observer reconciliation integration", () => {
  it.each([
    "cold-start",
    "running-outage",
    "lost-follow-up",
  ] as const)("lets bounded replay finish during %s and recovers a discarded payment through verified history", async (scenario) => {
    const { store } = await openSidekickStore(":memory:", "2026-08-13T12:00:00.000Z");
    openStores.push(store);
    store.chainState.upsertSource({
      sourceId,
      kind: "api",
      network: "mainnet",
      baseUrl: "https://api.mainnet.hiro.so",
      observedAt: "2026-08-13T12:00:00.000Z",
    });
    let nodeReady = false;
    let indexedHistoryReady = false;
    const block = identity("11");
    const api = {
      getSmartContractLogs: vi.fn(async () => {
        if (!indexedHistoryReady) throw new Error("indexer catching up");
        return page(txOne, 0, eventHex("claim-staker-rewards"));
      }),
      getTransaction: vi.fn(async (txId: string) => ({
        tx_id: txId,
        status: "success" as const,
        block: {
          height: 101,
          hash: block.blockHash,
          index_hash: block.indexBlockHash,
          time: 1_784_000_000,
          tx_index: 0,
        },
        bitcoin_block: { height: 962_300, time: 1_784_000_000 },
      })),
    };
    const nodeTransactions = {
      lookupIndexedTransaction: vi.fn(async (txId: string) => ({
        status: "observed" as const,
        httpStatus: 200,
        value: {
          txid: txId as `0x${string}`,
          transactionHex: "00",
          nonce: 0n,
          feeUstx: 0n,
          indexBlockHash: block.indexBlockHash,
          blockHeight: 101n,
          isCanonical: true,
          resultRepr: "(ok true)",
        },
      })),
    };
    const scheduler = new ObserverReconciliationScheduler({
      service: {
        refreshSnapshot: vi.fn().mockResolvedValue(undefined),
        synchronizeManagerActivity: async (options) =>
          syncManagerEvents({
            store,
            api,
            nodeTransactions,
            sourceId,
            chainId: 1,
            managerPrincipal: manager,
            eventVocabulary: "reference-manager-v1",
            observedAt: "2026-08-13T12:00:01.000Z",
            pageLimit: 100,
            ...(options?.signal ? { signal: options.signal } : {}),
          }),
        synchronizeRewardRealizations: vi.fn().mockResolvedValue(undefined),
        synchronize: vi.fn().mockResolvedValue(undefined),
      },
      logger: { info: vi.fn(), warn: vi.fn() },
      managerPrincipal: manager,
      getPox5ContractId: () => pox5,
      canRun: () => nodeReady,
      failureDelayMs: 10,
      maxBackoffMs: 20,
    });
    const node = {
      getInfo: vi.fn(async () => ({
        network_id: 1,
        burn_block_height: 962_300,
        stacks_tip_height: 119,
        stacks_tip: block.blockHash,
      })),
      getTenureInfo: vi.fn(async () => ({
        tip_block_id: block.indexBlockHash,
        tip_height: 119,
        reward_cycle: 141,
      })),
      getNakamotoBlockById: vi.fn(async () => block.bytes),
      getNakamotoBlockAtHeight: vi.fn(async () => block.bytes),
    };
    const processor = new ObserverInboxProcessor({
      store: store.observerInbox,
      getNode: () => node,
      canProcess: () => nodeReady,
      onProcessed: (delivery, outcome) => scheduler.notifyProcessed(delivery, outcome),
    });
    const server = createObserverServer({
      store: store.observerInbox,
      maxBodyBytes: 4 * 1_024 * 1_024,
      inboxLimits: { maximumPendingDeliveries: 1, maximumPendingPayloadBytes: 1_024 * 1_024 },
      onAccepted: () => processor.notify(),
      // Simulate loss of the in-memory request before worker construction or on restart.
      ...(scenario === "lost-follow-up" ? {} : { onOverflow: () => scheduler.requestCatchUp() }),
    });
    try {
      if (scenario === "running-outage") {
        scheduler.start();
        processor.start();
      }
      // The producer will not expose RPC until every replayed callback is acknowledged.
      // The payment is in the *discarded* second callback, not the retained first one.
      for (let offset = 0; offset < 20; offset += 1) {
        const payload = {
          ...JSON.parse(callbackBody(block, txOne)),
          block_height: 100 + offset,
          ...(offset === 1 ? {} : { events: [] }),
        };
        const response = await server.inject({ method: "POST", url: "/new_block", payload });
        expect(response.statusCode).toBe(200);
        expect(response.json().accepted).toBe(offset === 0);
      }
      expect(store.observerInbox.status()).toMatchObject({
        queueDepth: 1,
        uniqueDeliveries: 1,
        processingAttempts: 0,
      });
      expect(node.getInfo).not.toHaveBeenCalled();
      expect(api.getSmartContractLogs).not.toHaveBeenCalled();
      expect(store.listManagerClaims(1, manager).total).toBe(0);

      nodeReady = true;
      scheduler.start();
      processor.start();
      processor.notify();
      await vi.waitFor(() => expect(store.observerInbox.status().queueDepth).toBe(0));
      await vi.waitFor(() => expect(api.getSmartContractLogs).toHaveBeenCalled());
      // Even after inbox recovery, missing source evidence must not invent a payment.
      expect(store.listManagerClaims(1, manager).total).toBe(0);
      indexedHistoryReady = true;
      await vi.waitFor(() => expect(store.listManagerClaims(1, manager).total).toBe(1));
      expect(nodeTransactions.lookupIndexedTransaction).toHaveBeenCalledWith(txOne);
      expect(store.listManagerClaims(1, manager).items[0]?.stakerPrincipal).toBe(staker);
      expect(store.observerInbox.status().uniqueDeliveries).toBe(1);
    } finally {
      await server.close();
      await processor.stop();
      await scheduler.stop();
    }
  });

  it("converges permanent manager activity after a callback-observed reorg", async () => {
    const { store } = await openSidekickStore(":memory:", "2026-08-13T12:00:00.000Z");
    openStores.push(store);
    store.chainState.upsertSource({
      sourceId,
      kind: "api",
      network: "mainnet",
      baseUrl: "https://api.mainnet.hiro.so",
      observedAt: "2026-08-13T12:00:00.000Z",
    });

    const firstIdentity = identity("11");
    const secondIdentity = identity("22");
    let canonicalIdentity = firstIdentity;
    let indexedPage: SmartContractLogPage = {
      limit: 100,
      offset: 0,
      total: 0,
      cursor: null,
      next_cursor: null,
      prev_cursor: null,
      results: [],
    };
    let transactionId = txOne;
    let transactionIndexHash = canonicalIdentity.indexBlockHash;
    const api = {
      getSmartContractLogs: vi.fn(async () => indexedPage),
      getTransaction: vi.fn(async (txId: string) => ({
        tx_id: txId,
        status: "success" as const,
        block: {
          height: 100,
          hash: `0x${"44".repeat(32)}`,
          index_hash: transactionIndexHash,
          time: 1_784_000_000,
          tx_index: 0,
        },
        bitcoin_block: { height: 962_300, time: 1_784_000_000 },
      })),
    };
    const nodeTransactions = {
      lookupIndexedTransaction: vi.fn(async (txId: string) => ({
        status: "observed" as const,
        httpStatus: 200,
        value: {
          txid: txId as `0x${string}`,
          transactionHex: "00",
          nonce: 0n,
          feeUstx: 0n,
          indexBlockHash: transactionIndexHash,
          blockHeight: 100n,
          isCanonical: true,
          resultRepr: "(ok true)",
        },
      })),
    };
    const activity = async (signal?: AbortSignal) =>
      await syncManagerEvents({
        store,
        api,
        nodeTransactions,
        sourceId,
        chainId: 1,
        managerPrincipal: manager,
        eventVocabulary: "reference-manager-v1",
        observedAt: "2026-08-13T12:00:01.000Z",
        pageLimit: 100,
        ...(signal ? { signal } : {}),
      });
    const scheduler = new ObserverReconciliationScheduler({
      service: {
        refreshSnapshot: vi.fn().mockResolvedValue(undefined),
        synchronizeManagerActivity: async (options) => await activity(options?.signal),
        synchronizeRewardRealizations: vi.fn().mockResolvedValue(undefined),
        synchronize: vi.fn().mockResolvedValue(undefined),
      },
      logger: { info: vi.fn(), warn: vi.fn() },
      managerPrincipal: manager,
      getPox5ContractId: () => pox5,
    });
    const node = {
      getInfo: vi.fn(
        async (): Promise<NodeInfo> => ({
          network_id: 1,
          burn_block_height: 962_300,
          stacks_tip_height: 100,
          stacks_tip: canonicalIdentity.blockHash,
        }),
      ),
      getTenureInfo: vi.fn(
        async (): Promise<NodeTenureInfo> => ({
          tip_block_id: canonicalIdentity.indexBlockHash,
          tip_height: 100,
          reward_cycle: 141,
        }),
      ),
      getNakamotoBlockById: vi.fn(async () => canonicalIdentity.bytes),
      getNakamotoBlockAtHeight: vi.fn(async () => canonicalIdentity.bytes),
    };
    const processor = new ObserverInboxProcessor({
      store: store.observerInbox,
      getNode: () => node,
      onProcessed: (delivery, outcome) => scheduler.notifyProcessed(delivery, outcome),
      retryIntervalMs: 60_000,
    });

    scheduler.start();
    await vi.waitFor(() =>
      expect(scheduler.status().domains["manager-activity"].successes).toBe(1),
    );
    processor.start();

    indexedPage = page(txOne, 0, eventHex("claim-staker-rewards"));
    transactionId = txOne;
    transactionIndexHash = canonicalIdentity.indexBlockHash;
    const firstCallbackBody = callbackBody(canonicalIdentity, transactionId);
    store.observerInbox.acceptDelivery({
      endpointKind: "new-block",
      contentSha256: "aa".repeat(32),
      rawPayloadJson: firstCallbackBody,
      payloadBytes: Buffer.byteLength(firstCallbackBody, "utf8"),
      state: "observer-claimed",
      stateReason: null,
      claimedBlockHeight: 100,
      claimedBlockHash: canonicalIdentity.blockHash,
      claimedIndexBlockHash: canonicalIdentity.indexBlockHash,
      claimedBurnBlockHeight: null,
      claimedBurnBlockHash: null,
      receivedAt: "2026-08-13T12:00:01.000Z",
    });
    processor.notify();
    await vi.waitFor(() => expect(store.listManagerClaims(1, manager).total).toBe(1));
    expect(store.listManagerClaims(1, manager).items[0]?.stakerPrincipal).toBe(staker);

    canonicalIdentity = secondIdentity;
    indexedPage = page(txTwo, 0, eventHex("settle-accepted-withdrawal"));
    transactionId = txTwo;
    transactionIndexHash = canonicalIdentity.indexBlockHash;
    const reorgCallbackBody = callbackBody(canonicalIdentity, transactionId);
    store.observerInbox.acceptDelivery({
      endpointKind: "new-block",
      contentSha256: "bb".repeat(32),
      rawPayloadJson: reorgCallbackBody,
      payloadBytes: Buffer.byteLength(reorgCallbackBody, "utf8"),
      state: "observer-claimed",
      stateReason: null,
      claimedBlockHeight: 100,
      claimedBlockHash: canonicalIdentity.blockHash,
      claimedIndexBlockHash: canonicalIdentity.indexBlockHash,
      claimedBurnBlockHeight: null,
      claimedBurnBlockHash: null,
      receivedAt: "2026-08-13T12:00:02.000Z",
    });
    processor.notify();

    await vi.waitFor(() => expect(store.getChainEvent(1, txOne, 0)?.canonical).toBe(false));
    expect(store.getChainEvent(1, txTwo, 0)?.canonical).toBe(true);
    expect(store.listManagerClaims(1, manager).total).toBe(0);
    expect(scheduler.status().domains["manager-activity"]).toMatchObject({
      requests: 3,
      successes: 3,
      failuresTotal: 0,
    });

    await processor.stop();
    await scheduler.stop();
  });
});
