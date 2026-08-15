import {
  contractPrincipalCV,
  cvToHex,
  standardPrincipalCV,
  stringAsciiCV,
  tupleCV,
  uintCV,
} from "@stacks/transactions";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SmartContractLogPage, TransactionSummary } from "./chain-clients.js";
import { pox5PoolActivityStream, syncPox5PoolActivity } from "./pox5-pool-activity-sync.js";
import { createChainSourceId, openSidekickStore, type SidekickStore } from "./storage/store.js";

const observedAt = "2026-08-15T12:00:00.000Z";
const manager = "SP000000000000000000002Q6VF78.signer-manager";
const otherManager = "SP2369QN53586176SYRF4XFGF4E84V0J0EWKRG0ZH.signer-manager";
const pox5 = "SP000000000000000000002Q6VF78.pox-5";
const staker = "SP2369QN53586176SYRF4XFGF4E84V0J0EWKRG0ZH";
const sourceId = createChainSourceId("mainnet", "https://api.mainnet.hiro.so");
const txid = `0x${"11".repeat(32)}`;
const otherTxid = `0x${"22".repeat(32)}`;
const stores: SidekickStore[] = [];

function contract(value: string) {
  const [address, name] = value.split(".") as [string, string];
  return contractPrincipalCV(address, name);
}

function eventHex(signer: string): string {
  return cvToHex(
    tupleCV({
      topic: stringAsciiCV("stake"),
      signer: contract(signer),
      staker: standardPrincipalCV(staker),
      "amount-ustx": uintCV(50_000_000_000n),
      "first-reward-cycle": uintCV(142),
      "unlock-cycle": uintCV(154),
    }),
  );
}

function page(): SmartContractLogPage {
  return {
    limit: 100,
    offset: 0,
    total: 2,
    cursor: null,
    next_cursor: null,
    prev_cursor: null,
    results: [
      {
        event_index: 3,
        event_type: "smart_contract_log",
        tx_id: txid,
        contract_log: {
          contract_id: pox5,
          topic: "print",
          value: { hex: eventHex(manager), repr: "(tuple ...)" },
        },
      },
      {
        event_index: 4,
        event_type: "smart_contract_log",
        tx_id: otherTxid,
        contract_log: {
          contract_id: pox5,
          topic: "print",
          value: { hex: eventHex(otherManager), repr: "(tuple ...)" },
        },
      },
    ],
  };
}

function transaction(id: string): TransactionSummary {
  return {
    tx_id: id,
    status: "success",
    block: {
      height: 8_700_000,
      hash: `0x${"33".repeat(32)}`,
      index_hash: `0x${"44".repeat(32)}`,
      time: 1_786_800_000,
      tx_index: 2,
    },
    bitcoin_block: { height: 962_300, time: 1_786_800_000 },
  };
}

async function store(): Promise<SidekickStore> {
  const opened = await openSidekickStore(":memory:", observedAt);
  stores.push(opened.store);
  opened.store.upsertChainSource({
    sourceId,
    kind: "api",
    network: "mainnet",
    baseUrl: "https://api.mainnet.hiro.so",
    observedAt,
  });
  return opened.store;
}

afterEach(() => {
  for (const value of stores.splice(0)) value.close();
});

describe("PoX-5 pool Activity synchronization", () => {
  it("stores only this manager's staker event after local-node verification", async () => {
    const sidekickStore = await store();
    const nodeTransactions = {
      lookupIndexedTransaction: vi.fn().mockResolvedValue({
        status: "observed" as const,
        httpStatus: 200,
        value: {
          txid,
          transactionHex: "00",
          nonce: 0n,
          feeUstx: 0n,
          indexBlockHash: `0x${"44".repeat(32)}` as `0x${string}`,
          blockHeight: 8_700_000n,
          isCanonical: true,
          resultRepr: "(ok true)",
        },
      }),
    };
    const api = {
      getSmartContractLogs: vi.fn().mockResolvedValue(page()),
      getTransaction: vi.fn(async (id: string) => transaction(id)),
    };

    await expect(
      syncPox5PoolActivity({
        store: sidekickStore,
        api,
        nodeTransactions,
        sourceId,
        chainId: 1,
        managerPrincipal: manager,
        pox5ContractId: pox5,
        observedAt,
      }),
    ).resolves.toMatchObject({
      logsInspected: 2,
      relevantEvents: 1,
      newEvents: 1,
      nodeVerifiedTransactions: 1,
      caughtUp: true,
    });
    expect(api.getTransaction).toHaveBeenCalledWith(txid);
    expect(api.getTransaction).toHaveBeenCalledWith(otherTxid);
    expect(nodeTransactions.lookupIndexedTransaction).toHaveBeenCalledWith(txid);
    expect(sidekickStore.getChainEvent(1, txid, 3)).toMatchObject({
      occurredAt: "2026-08-15T13:20:00.000Z",
      firstSeenAt: observedAt,
      decodedPayload: {
        event: { kind: "stake", relationship: "joined", stakerPrincipal: staker },
      },
    });
    expect(sidekickStore.getChainEvent(1, otherTxid, 4)).toBeNull();
    expect(sidekickStore.getCursor(sourceId, pox5PoolActivityStream(pox5, manager))).toMatchObject({
      cursor: null,
      lastBlockHeight: 8_700_000,
    });
  });

  it("rejects API activity that the local node reports at a different anchor", async () => {
    const sidekickStore = await store();
    await expect(
      syncPox5PoolActivity({
        store: sidekickStore,
        api: {
          getSmartContractLogs: vi.fn().mockResolvedValue(page()),
          getTransaction: vi.fn(async (id: string) => transaction(id)),
        },
        nodeTransactions: {
          lookupIndexedTransaction: vi.fn().mockResolvedValue({
            status: "observed" as const,
            httpStatus: 200,
            value: {
              txid,
              transactionHex: "00",
              nonce: 0n,
              feeUstx: 0n,
              indexBlockHash: `0x${"55".repeat(32)}` as `0x${string}`,
              blockHeight: 8_700_000n,
              isCanonical: true,
              resultRepr: "(ok true)",
            },
          }),
        },
        sourceId,
        chainId: 1,
        managerPrincipal: manager,
        pox5ContractId: pox5,
        observedAt,
      }),
    ).rejects.toThrow("disagree on PoX-5 pool activity transaction");
    expect(sidekickStore.getChainEvent(1, txid, 3)).toBeNull();
  });
});
