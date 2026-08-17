import {
  contractPrincipalCV,
  cvToHex,
  standardPrincipalCV,
  stringAsciiCV,
  tupleCV,
  uintCV,
} from "@stacks/transactions";
import { describe, expect, it, vi } from "vitest";
import type { PrincipalTransactionPage, TransactionEventPage } from "./chain-clients.js";
import {
  type CurrentMemberHistoryStore,
  currentMemberHistoryStream,
  syncCurrentMemberHistoryPass,
} from "./current-member-history-sync.js";
import type {
  ChainCursorInput,
  ChainEventInput,
  CurrentMemberHistoryRecovery,
} from "./storage/store.js";

const observedAt = "2026-08-15T12:00:00.000Z";
const manager = "SP000000000000000000002Q6VF78.signer-manager";
const otherManager = "SP2369QN53586176SYRF4XFGF4E84V0J0EWKRG0ZH.signer-manager";
const pox5 = "SP000000000000000000002Q6VF78.pox-5";
const staker = "SP2369QN53586176SYRF4XFGF4E84V0J0EWKRG0ZH";
const otherStaker = "SP1A3NMZC75C6BHNTF6JT4ASJN4J8BKH1Q10673R7";
const sourceId = "api:mainnet:test";
const txid = `0x${"11".repeat(32)}` as `0x${string}`;

function contract(value: string) {
  const [address, name] = value.split(".") as [string, string];
  return contractPrincipalCV(address, name);
}

function stakeHex(signer: string, principal: string): string {
  return cvToHex(
    tupleCV({
      topic: stringAsciiCV("stake"),
      signer: contract(signer),
      staker: standardPrincipalCV(principal),
      "amount-ustx": uintCV(50_000_000_000n),
      "first-reward-cycle": uintCV(142),
      "unlock-cycle": uintCV(154),
    }),
  );
}

function principalPage(): PrincipalTransactionPage {
  return {
    total: 1,
    limit: 50,
    cursor: { current: "8700000:2147483647:0", previous: null, next: null },
    results: [
      {
        transaction: {
          tx_id: txid,
          status: "success",
          type: "contract_call",
          contract_call: { contract_id: pox5, function_name: "stake" },
          block: {
            height: 8_700_000,
            hash: `0x${"22".repeat(32)}`,
            index_hash: `0x${"33".repeat(32)}`,
            time: 1_786_800_000,
            tx_index: 2,
          },
          bitcoin_block: { height: 962_300, time: 1_786_800_000 },
        },
      },
    ],
  };
}

function eventPage(): TransactionEventPage {
  return {
    total: 3,
    limit: 100,
    cursor: { current: "0", previous: null, next: null },
    results: [
      {
        event_index: 1,
        type: "contract_log",
        contract_log: {
          contract_id: pox5,
          topic: "print",
          value: { hex: stakeHex(manager, staker), repr: "(tuple ...)" },
        },
      },
      {
        event_index: 2,
        type: "contract_log",
        contract_log: {
          contract_id: pox5,
          topic: "print",
          value: { hex: stakeHex(otherManager, staker), repr: "(tuple ...)" },
        },
      },
      {
        event_index: 3,
        type: "contract_log",
        contract_log: {
          contract_id: pox5,
          topic: "print",
          value: { hex: stakeHex(manager, otherStaker), repr: "(tuple ...)" },
        },
      },
    ],
  };
}

function recovery(): CurrentMemberHistoryRecovery {
  return {
    sourceId,
    managerPrincipal: manager,
    pox5ContractId: pox5,
    stakerPrincipal: staker,
    status: "pending",
    cursor: null,
    pagesProcessed: 0,
    transactionsInspected: 0,
    relevantEvents: 0,
    discoveredAt: observedAt,
    updatedAt: observedAt,
    completedAt: null,
  };
}

describe("current-member history synchronization", () => {
  it("imports only the current member's events for this manager with local-node evidence", async () => {
    const storedEvents: ChainEventInput[] = [];
    let storedCursor: ChainCursorInput | null = null;
    const progress = vi.fn();
    const store: CurrentMemberHistoryStore = {
      ensureCurrentMemberHistoryRecovery: vi.fn().mockReturnValue(1),
      nextCurrentMemberHistoryRecovery: vi.fn().mockReturnValue(recovery()),
      putChainEventPage: vi.fn((events, cursor) => {
        storedEvents.push(...events);
        storedCursor = cursor;
      }),
      recordCurrentMemberHistoryRecoveryPage: progress.mockReturnValue({
        ...recovery(),
        status: "complete",
        pagesProcessed: 1,
        transactionsInspected: 1,
        relevantEvents: 1,
        completedAt: observedAt,
      }),
    };
    const nodeTransactions = {
      lookupIndexedTransaction: vi.fn().mockResolvedValue({
        status: "observed" as const,
        httpStatus: 200,
        value: {
          txid,
          transactionHex: "00",
          nonce: 0n,
          feeUstx: 0n,
          indexBlockHash: `0x${"33".repeat(32)}` as `0x${string}`,
          blockHeight: 8_700_000n,
          isCanonical: true,
          resultRepr: "(ok true)",
        },
      }),
    };

    await expect(
      syncCurrentMemberHistoryPass({
        store,
        api: {
          getPrincipalTransactions: vi.fn().mockResolvedValue(principalPage()),
          getTransactionEvents: vi.fn().mockResolvedValue(eventPage()),
        },
        nodeTransactions,
        sourceId,
        chainId: 1,
        managerPrincipal: manager,
        pox5ContractId: pox5,
        currentStakerPrincipals: [staker],
        observedAt,
      }),
    ).resolves.toEqual({
      seededMembers: 1,
      memberProcessed: staker,
      transactionsInspected: 1,
      relevantTransactions: 1,
      relevantEvents: 1,
      caughtUp: true,
    });
    expect(storedEvents).toHaveLength(1);
    expect(storedEvents[0]).toMatchObject({
      txId: txid,
      eventIndex: 1,
      evidenceLevel: "node-index-verified",
      occurredAt: "2026-08-15T13:20:00.000Z",
      decodedPayload: { event: { stakerPrincipal: staker, signer: manager } },
    });
    expect(storedCursor).toMatchObject({
      stream: currentMemberHistoryStream(manager, pox5, staker),
      cursor: null,
    });
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        stakerPrincipal: staker,
        nextCursor: null,
        transactionsInspected: 1,
        relevantEvents: 1,
      }),
    );
  });

  it("does no API work when every current member is already complete", async () => {
    const getPrincipalTransactions = vi.fn();
    const store = {
      ensureCurrentMemberHistoryRecovery: vi.fn().mockReturnValue(0),
      nextCurrentMemberHistoryRecovery: vi.fn().mockReturnValue(null),
      putChainEventPage: vi.fn(),
      recordCurrentMemberHistoryRecoveryPage: vi.fn(),
    } satisfies CurrentMemberHistoryStore;
    await expect(
      syncCurrentMemberHistoryPass({
        store,
        api: { getPrincipalTransactions, getTransactionEvents: vi.fn() },
        nodeTransactions: { lookupIndexedTransaction: vi.fn() },
        sourceId,
        chainId: 1,
        managerPrincipal: manager,
        pox5ContractId: pox5,
        currentStakerPrincipals: [],
        observedAt,
      }),
    ).resolves.toMatchObject({ memberProcessed: null, caughtUp: true });
    expect(getPrincipalTransactions).not.toHaveBeenCalled();
  });
});
