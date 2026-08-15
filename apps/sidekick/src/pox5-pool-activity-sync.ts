import { decodeClarityHex } from "@stx-labs/signer-sidekick-protocol/clarity-codecs";
import { z } from "zod";
import {
  type SmartContractLogPage,
  type TransactionSummary,
  transactionOccurredAt,
} from "./chain-clients.js";
import {
  type ManagerEventNodeBlocks,
  type ManagerEventNodeTransactions,
  verifyIndexedApiTransactionEvidenceWithNode,
} from "./manager-event-sync.js";
import { decodePox5PoolActivityEvent } from "./pox5-pool-events.js";
import type {
  ChainCursor,
  ChainEventInput,
  SidekickStore,
  StoredChainEvent,
} from "./storage/store.js";

const cursorStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    apiCursor: z.string().min(1),
    minimumStacksHeight: z.number().int().nonnegative().safe(),
  })
  .strict();

export interface Pox5PoolActivityApi {
  getSmartContractLogs(
    contractId: string,
    cursor?: string | null,
    limit?: number,
  ): Promise<SmartContractLogPage>;
  getTransaction(txId: string): Promise<TransactionSummary>;
}

export interface Pox5PoolActivityStore {
  getCursor(sourceId: string, stream: string): ChainCursor | null;
  getChainEvent(chainId: number, txId: string, eventIndex: number): StoredChainEvent | null;
  putChainEventPage(
    events: readonly ChainEventInput[],
    cursor: {
      sourceId: string;
      stream: string;
      cursor: string | null;
      lastBlockHeight: number | null;
      lastIndexBlockHash: string | null;
      updatedAt: string;
    },
  ): void;
}

export interface SyncPox5PoolActivityOptions {
  store: Pox5PoolActivityStore | SidekickStore;
  api: Pox5PoolActivityApi;
  nodeTransactions: ManagerEventNodeTransactions;
  nodeBlocks?: ManagerEventNodeBlocks;
  sourceId: string;
  chainId: number;
  managerPrincipal: string;
  pox5ContractId: string;
  observedAt: string;
  minimumStacksHeight?: number | null;
  pageLimit?: number;
  maxPages?: number;
  signal?: AbortSignal;
}

export interface SyncPox5PoolActivityResult {
  stream: string;
  pagesProcessed: number;
  logsInspected: number;
  relevantEvents: number;
  newEvents: number;
  replayedEvents: number;
  nodeVerifiedTransactions: number;
  caughtUp: boolean;
}

export function pox5PoolActivityStream(pox5ContractId: string, managerPrincipal: string): string {
  return `pox5-pool-activity:v1:${pox5ContractId}:${managerPrincipal}`;
}

/**
 * Project only this pool's PoX-5 prints. A trigger performs a small newest-first scan; if unusual
 * global activity pushes the triggering height outside that bound, the opaque API cursor is saved
 * and the observer scheduler resumes it on retry instead of expanding one request without limit.
 */
export async function syncPox5PoolActivity(
  options: SyncPox5PoolActivityOptions,
): Promise<SyncPox5PoolActivityResult> {
  const pageLimit = z
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(options.pageLimit ?? 100);
  const maxPages = z
    .number()
    .int()
    .min(1)
    .max(10)
    .parse(options.maxPages ?? 3);
  const chainId = z.number().int().nonnegative().safe().parse(options.chainId);
  const requestedMinimum = z
    .number()
    .int()
    .nonnegative()
    .safe()
    .nullable()
    .parse(options.minimumStacksHeight ?? null);
  const stream = pox5PoolActivityStream(options.pox5ContractId, options.managerPrincipal);
  const checkpoint = options.store.getCursor(options.sourceId, stream);
  const resumed = checkpoint?.cursor
    ? cursorStateSchema.parse(JSON.parse(checkpoint.cursor))
    : null;
  let cursor = resumed?.apiCursor ?? null;
  const targetHeight = resumed?.minimumStacksHeight ?? requestedMinimum;
  let pagesProcessed = 0;
  let logsInspected = 0;
  let relevantEvents = 0;
  let newEvents = 0;
  let replayedEvents = 0;
  let nodeVerifiedTransactions = 0;
  let caughtUp = targetHeight === null;
  let lastBlockHeight = checkpoint?.lastBlockHeight ?? null;
  let lastIndexBlockHash = checkpoint?.lastIndexBlockHash ?? null;

  while (pagesProcessed < (targetHeight === null ? 1 : maxPages)) {
    options.signal?.throwIfAborted();
    const page = await options.api.getSmartContractLogs(options.pox5ContractId, cursor, pageLimit);
    logsInspected += page.results.length;

    const decoded = page.results.flatMap((log) => {
      if (
        log.contract_log.contract_id !== options.pox5ContractId ||
        log.contract_log.topic !== "print"
      ) {
        return [];
      }
      const event = decodePox5PoolActivityEvent(
        decodeClarityHex(log.contract_log.value.hex),
        options.managerPrincipal,
      );
      return event ? [{ log, event }] : [];
    });
    relevantEvents += decoded.length;

    const transactionIds = [...new Set(decoded.map(({ log }) => log.tx_id))];
    const transactionEntries: Array<[string, TransactionSummary]> = [];
    for (let index = 0; index < transactionIds.length; index += 8) {
      options.signal?.throwIfAborted();
      transactionEntries.push(
        ...(await Promise.all(
          transactionIds
            .slice(index, index + 8)
            .map(
              async (txId): Promise<[string, TransactionSummary]> => [
                txId,
                await options.api.getTransaction(txId),
              ],
            ),
        )),
      );
    }
    const transactions = new Map(transactionEntries);
    const transactionEvidence = await verifyIndexedApiTransactionEvidenceWithNode(
      options.nodeTransactions,
      options.nodeBlocks,
      transactions,
      "PoX-5 pool activity",
      options.signal,
    );
    nodeVerifiedTransactions += transactionEvidence.size;

    const storedEvents: ChainEventInput[] = decoded.map(({ log, event }) => {
      const transaction = transactions.get(log.tx_id);
      if (!transaction) throw new Error(`Missing transaction enrichment for ${log.tx_id}`);
      if (options.store.getChainEvent(chainId, log.tx_id, log.event_index)) replayedEvents += 1;
      else newEvents += 1;
      return {
        chainId,
        txId: log.tx_id,
        eventIndex: log.event_index,
        blockHeight: transaction.block.height,
        blockHash: transaction.block.hash,
        indexBlockHash: transaction.block.index_hash,
        microblockHash: null,
        microblockSequence: null,
        canonical: true,
        microblockCanonical: true,
        contractId: options.pox5ContractId,
        topic: event.topic,
        rawPayload: {
          schema: "stacks-api-v2-contract-log",
          transactionStatus: transaction.status,
          transactionIndex: transaction.block.tx_index,
          bitcoinBlockHeight: transaction.bitcoin_block.height,
          contractLog: log.contract_log,
        },
        decodedSchemaVersion: 1,
        decodedPayload: { transactionStatus: transaction.status, event },
        evidenceLevel: transactionEvidence.get(log.tx_id),
        sourceId: options.sourceId,
        occurredAt: transactionOccurredAt(transaction),
        observedAt: options.observedAt,
      };
    });

    const boundary = page.results.at(-1);
    const boundaryTransaction = boundary
      ? (transactions.get(boundary.tx_id) ?? (await options.api.getTransaction(boundary.tx_id)))
      : null;
    const newest = decoded[0] ? transactions.get(decoded[0].log.tx_id) : null;
    if (newest) {
      lastBlockHeight = Math.max(lastBlockHeight ?? 0, newest.block.height);
      lastIndexBlockHash = newest.block.index_hash;
    }
    caughtUp =
      targetHeight === null ||
      page.results.length === 0 ||
      page.prev_cursor === null ||
      (boundaryTransaction !== null && boundaryTransaction.block.height <= targetHeight);
    const nextCursor = caughtUp
      ? null
      : page.prev_cursor
        ? JSON.stringify({
            schemaVersion: 1,
            apiCursor: page.prev_cursor,
            minimumStacksHeight: targetHeight,
          })
        : null;
    options.store.putChainEventPage(storedEvents, {
      sourceId: options.sourceId,
      stream,
      cursor: nextCursor,
      lastBlockHeight,
      lastIndexBlockHash,
      updatedAt: options.observedAt,
    });
    pagesProcessed += 1;
    if (caughtUp) break;
    if (!page.prev_cursor) throw new Error("PoX-5 pool activity API ended without a cursor");
    cursor = page.prev_cursor;
  }

  if (!caughtUp) {
    throw new Error(
      `PoX-5 pool activity scan retained its cursor before Stacks height ${targetHeight}; retry to continue`,
    );
  }
  return {
    stream,
    pagesProcessed,
    logsInspected,
    relevantEvents,
    newEvents,
    replayedEvents,
    nodeVerifiedTransactions,
    caughtUp,
  };
}
