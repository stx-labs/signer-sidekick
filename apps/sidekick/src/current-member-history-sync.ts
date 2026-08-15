import { decodeClarityHex } from "@stx-labs/signer-sidekick-protocol/clarity-codecs";
import type {
  PrincipalTransactionPage,
  TransactionEventPage,
  TransactionSummary,
} from "./chain-clients.js";
import { transactionOccurredAt } from "./chain-clients.js";
import {
  type ManagerEventNodeBlocks,
  type ManagerEventNodeTransactions,
  verifyIndexedApiTransactionEvidenceWithNode,
} from "./manager-event-sync.js";
import { decodePox5PoolActivityEvent } from "./pox5-pool-events.js";
import type {
  ChainCursorInput,
  ChainEventInput,
  CurrentMemberHistoryRecovery,
} from "./storage/store.js";

export interface CurrentMemberHistoryApi {
  getPrincipalTransactions(
    principal: string,
    cursor?: string | null,
    limit?: number,
  ): Promise<PrincipalTransactionPage>;
  getTransactionEvents(
    txId: string,
    cursor?: string | null,
    limit?: number,
  ): Promise<TransactionEventPage>;
}

export interface CurrentMemberHistoryStore {
  ensureCurrentMemberHistoryRecovery(input: {
    sourceId: string;
    managerPrincipal: string;
    pox5ContractId: string;
    stakerPrincipals: readonly string[];
    observedAt: string;
  }): number;
  nextCurrentMemberHistoryRecovery(
    sourceId: string,
    managerPrincipal: string,
    pox5ContractId: string,
  ): CurrentMemberHistoryRecovery | null;
  putChainEventPage(events: readonly ChainEventInput[], cursor: ChainCursorInput): void;
  recordCurrentMemberHistoryRecoveryPage(input: {
    sourceId: string;
    managerPrincipal: string;
    pox5ContractId: string;
    stakerPrincipal: string;
    nextCursor: string | null;
    transactionsInspected: number;
    relevantEvents: number;
    observedAt: string;
  }): CurrentMemberHistoryRecovery;
}

export interface SyncCurrentMemberHistoryOptions {
  store: CurrentMemberHistoryStore;
  api: CurrentMemberHistoryApi;
  nodeTransactions: ManagerEventNodeTransactions;
  nodeBlocks?: ManagerEventNodeBlocks;
  sourceId: string;
  chainId: number;
  managerPrincipal: string;
  pox5ContractId: string;
  currentStakerPrincipals: readonly string[];
  observedAt: string;
  pageLimit?: number;
  signal?: AbortSignal;
}

export interface SyncCurrentMemberHistoryResult {
  seededMembers: number;
  memberProcessed: string | null;
  transactionsInspected: number;
  relevantTransactions: number;
  relevantEvents: number;
  caughtUp: boolean;
}

export function currentMemberHistoryStream(
  managerPrincipal: string,
  pox5ContractId: string,
  stakerPrincipal: string,
): string {
  return `current-member-history:v1:${pox5ContractId}:${managerPrincipal}:${stakerPrincipal}`;
}

/**
 * Process one page for the least-recently-touched current member. Repeated anti-entropy passes are
 * fair across the roster, and a crash can at worst replay an idempotent page.
 */
export async function syncCurrentMemberHistoryPass(
  options: SyncCurrentMemberHistoryOptions,
): Promise<SyncCurrentMemberHistoryResult> {
  const pageLimit = options.pageLimit ?? 50;
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 50) {
    throw new Error("pageLimit must be an integer from 1 through 50");
  }
  const seededMembers = options.store.ensureCurrentMemberHistoryRecovery({
    sourceId: options.sourceId,
    managerPrincipal: options.managerPrincipal,
    pox5ContractId: options.pox5ContractId,
    stakerPrincipals: options.currentStakerPrincipals,
    observedAt: options.observedAt,
  });
  const recovery = options.store.nextCurrentMemberHistoryRecovery(
    options.sourceId,
    options.managerPrincipal,
    options.pox5ContractId,
  );
  if (!recovery) {
    return {
      seededMembers,
      memberProcessed: null,
      transactionsInspected: 0,
      relevantTransactions: 0,
      relevantEvents: 0,
      caughtUp: true,
    };
  }

  options.signal?.throwIfAborted();
  const page = await options.api.getPrincipalTransactions(
    recovery.stakerPrincipal,
    recovery.cursor,
    pageLimit,
  );
  options.signal?.throwIfAborted();
  const candidates = page.results
    .map(({ transaction }) => transaction)
    .filter(
      (transaction) =>
        transaction.status === "success" &&
        transaction.type === "contract_call" &&
        transaction.contract_call?.contract_id === options.pox5ContractId,
    );

  const decodedByTransaction = new Map<
    string,
    Array<{
      eventIndex: number;
      contractLog: NonNullable<TransactionEventPage["results"][number]["contract_log"]>;
      decoded: NonNullable<ReturnType<typeof decodePox5PoolActivityEvent>>;
    }>
  >();
  for (let index = 0; index < candidates.length; index += 4) {
    options.signal?.throwIfAborted();
    await Promise.all(
      candidates.slice(index, index + 4).map(async (transaction) => {
        const events = await options.api.getTransactionEvents(transaction.tx_id, null, 100);
        if (events.cursor.next !== null) {
          throw new Error(
            `PoX-5 transaction ${transaction.tx_id} has more than 100 events; refusing an incomplete history import`,
          );
        }
        const relevant = events.results.flatMap((event) => {
          const contractLog = event.contract_log;
          if (
            event.type !== "contract_log" ||
            !contractLog ||
            contractLog.contract_id !== options.pox5ContractId ||
            contractLog.topic !== "print"
          ) {
            return [];
          }
          const decoded = decodePox5PoolActivityEvent(
            decodeClarityHex(contractLog.value.hex),
            options.managerPrincipal,
          );
          return decoded?.stakerPrincipal === recovery.stakerPrincipal
            ? [{ eventIndex: event.event_index, contractLog, decoded }]
            : [];
        });
        if (relevant.length > 0) decodedByTransaction.set(transaction.tx_id, relevant);
      }),
    );
  }
  options.signal?.throwIfAborted();

  const transactionById = new Map<string, TransactionSummary>();
  for (const transaction of candidates) {
    if (decodedByTransaction.has(transaction.tx_id)) {
      transactionById.set(transaction.tx_id, transaction);
    }
  }
  const transactionEvidence = await verifyIndexedApiTransactionEvidenceWithNode(
    options.nodeTransactions,
    options.nodeBlocks,
    transactionById,
    `PoX-5 history for ${recovery.stakerPrincipal}`,
    options.signal,
  );
  const storedEvents: ChainEventInput[] = [];
  for (const [txId, relevant] of decodedByTransaction) {
    const transaction = transactionById.get(txId);
    const evidenceLevel = transactionEvidence.get(txId);
    if (!transaction || !evidenceLevel) {
      throw new Error(`Missing verified transaction evidence for ${txId}`);
    }
    for (const { eventIndex, contractLog, decoded } of relevant) {
      storedEvents.push({
        chainId: options.chainId,
        txId,
        eventIndex,
        blockHeight: transaction.block.height,
        blockHash: transaction.block.hash,
        indexBlockHash: transaction.block.index_hash,
        microblockHash: null,
        microblockSequence: null,
        canonical: true,
        microblockCanonical: true,
        contractId: options.pox5ContractId,
        topic: decoded.topic,
        rawPayload: {
          schema: "stacks-api-v3-current-member-history",
          stakerPrincipal: recovery.stakerPrincipal,
          transactionStatus: transaction.status,
          transactionIndex: transaction.block.tx_index,
          bitcoinBlockHeight: transaction.bitcoin_block.height,
          contractLog,
        },
        decodedSchemaVersion: 1,
        decodedPayload: { transactionStatus: transaction.status, event: decoded },
        evidenceLevel,
        sourceId: options.sourceId,
        occurredAt: transactionOccurredAt(transaction),
        observedAt: options.observedAt,
      });
    }
  }

  const nextCursor = page.cursor.next;
  options.store.putChainEventPage(storedEvents, {
    sourceId: options.sourceId,
    stream: currentMemberHistoryStream(
      options.managerPrincipal,
      options.pox5ContractId,
      recovery.stakerPrincipal,
    ),
    cursor: nextCursor,
    lastBlockHeight: page.results[0]?.transaction.block.height ?? null,
    lastIndexBlockHash: page.results[0]?.transaction.block.index_hash ?? null,
    updatedAt: options.observedAt,
  });
  options.store.recordCurrentMemberHistoryRecoveryPage({
    sourceId: options.sourceId,
    managerPrincipal: options.managerPrincipal,
    pox5ContractId: options.pox5ContractId,
    stakerPrincipal: recovery.stakerPrincipal,
    nextCursor,
    transactionsInspected: page.results.length,
    relevantEvents: storedEvents.length,
    observedAt: options.observedAt,
  });
  return {
    seededMembers,
    memberProcessed: recovery.stakerPrincipal,
    transactionsInspected: page.results.length,
    relevantTransactions: transactionById.size,
    relevantEvents: storedEvents.length,
    caughtUp: nextCursor === null,
  };
}
