import { decodeClarityHex } from "@stx-labs/signer-sidekick-protocol/clarity-codecs";
import {
  decodeManagerPrintEvent,
  type ManagerPrintEvent,
} from "@stx-labs/signer-sidekick-protocol/manager-events";
import { proveCanonicalNodeBlock } from "./canonical-node-block.js";
import type {
  SmartContractLogPage,
  StacksNodeClient,
  TransactionSummary,
} from "./chain-clients.js";
import { transactionOccurredAt } from "./chain-clients.js";
import { type ManagerEventVocabulary, managerEventStream } from "./manager-event-vocabulary.js";
import type {
  ChainCursor,
  ChainCursorInput,
  ChainEventInput,
  SidekickStore,
  StoredChainEvent,
} from "./storage/store.js";
import type {
  IndexedTransactionObservation,
  LiveLookup,
} from "./transaction-engine/live-transaction-reader.js";

export interface ManagerEventApi {
  getSmartContractLogs(
    contractId: string,
    cursor?: string | null,
    limit?: number,
  ): Promise<SmartContractLogPage>;
  getTransaction(txId: string): Promise<TransactionSummary>;
}

export interface ManagerEventNodeTransactions {
  lookupIndexedTransaction(txId: string): Promise<LiveLookup<IndexedTransactionObservation>>;
}

export type ManagerEventNodeBlocks = Pick<
  StacksNodeClient,
  "getTenureInfo" | "getNakamotoBlockById" | "getNakamotoBlockAtHeight"
>;

export type ChainEventEvidenceLevel = "node-index-verified" | "canonical-block-correlated";

export interface ManagerEventStore {
  getCursor(sourceId: string, stream: string): ChainCursor | null;
  getChainEvent(chainId: number, txId: string, eventIndex: number): StoredChainEvent | null;
  hasChainEventsForContract(chainId: number, contractId: string): boolean;
  putChainEventPage(events: readonly ChainEventInput[], cursor: ChainCursorInput): void;
  markMissingCanonicalContractEvents(
    chainId: number,
    contractId: string,
    boundaryBlockHeight: number,
    includeBoundary: boolean,
    presentEventIds: ReadonlySet<string>,
    updatedAt: string,
  ): number;
}

export interface SyncManagerEventsOptions {
  store: ManagerEventStore | SidekickStore;
  api: ManagerEventApi;
  sourceId: string;
  chainId: number;
  managerPrincipal: string;
  eventVocabulary: ManagerEventVocabulary;
  /**
   * Independent local-node inclusion witness for every API-sourced transaction on a new page.
   * Callback bodies are never accepted as this witness.
   */
  nodeTransactions?: ManagerEventNodeTransactions;
  /** Local canonical-block witness used when an older transaction is absent from the tx index. */
  nodeBlocks?: ManagerEventNodeBlocks;
  observedAt: string;
  pageLimit?: number;
  signal?: AbortSignal;
  onProgress?(progress: {
    completed: number;
    total: number | null;
    eventsProcessed: number;
  }): void | Promise<void>;
}

export interface SyncManagerEventsResult {
  stream: string;
  resumed: boolean;
  pagesProcessed: number;
  eventsProcessed: number;
  newEvents: number;
  replayedEvents: number;
  decodeFailures: number;
  reorgedEvents: number;
  nodeVerifiedTransactions: number;
  stoppedAtKnownOverlap: boolean;
}

function decodeEvent(hex: string): ManagerPrintEvent | null {
  try {
    return decodeManagerPrintEvent(decodeClarityHex(hex));
  } catch {
    return null;
  }
}

async function enrichTransactions(
  api: ManagerEventApi,
  page: SmartContractLogPage,
  signal?: AbortSignal,
): Promise<Map<string, TransactionSummary>> {
  const transactionIds = [...new Set(page.results.map(({ tx_id }) => tx_id))];
  const entries: Array<[string, TransactionSummary]> = [];
  for (let index = 0; index < transactionIds.length; index += 8) {
    signal?.throwIfAborted();
    const batch = transactionIds.slice(index, index + 8);
    const batchEntries = await Promise.all(
      batch.map(
        async (txId): Promise<[string, TransactionSummary]> => [
          txId,
          await api.getTransaction(txId),
        ],
      ),
    );
    signal?.throwIfAborted();
    entries.push(...batchEntries);
  }
  return new Map(entries);
}

export async function verifyIndexedApiTransactionsWithNode(
  node: ManagerEventNodeTransactions,
  nodeBlocks: ManagerEventNodeBlocks | undefined,
  transactions: ReadonlyMap<string, TransactionSummary>,
  activityLabel: string,
  signal?: AbortSignal,
): Promise<number> {
  return (
    await verifyIndexedApiTransactionEvidenceWithNode(
      node,
      nodeBlocks,
      transactions,
      activityLabel,
      signal,
    )
  ).size;
}

export async function verifyIndexedApiTransactionEvidenceWithNode(
  node: ManagerEventNodeTransactions,
  nodeBlocks: ManagerEventNodeBlocks | undefined,
  transactions: ReadonlyMap<string, TransactionSummary>,
  activityLabel: string,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, ChainEventEvidenceLevel>> {
  const entries = [...transactions.entries()];
  const evidence = new Map<string, ChainEventEvidenceLevel>();
  for (let index = 0; index < entries.length; index += 8) {
    signal?.throwIfAborted();
    const batch = entries.slice(index, index + 8);
    await Promise.all(
      batch.map(async ([txId, transaction]) => {
        const observation = await node.lookupIndexedTransaction(txId);
        if (observation.status === "not-found" && nodeBlocks) {
          await proveCanonicalNodeBlock(nodeBlocks, {
            blockHeight: transaction.block.height,
            indexBlockHash: transaction.block.index_hash,
            ...(signal ? { signal } : {}),
          });
          evidence.set(txId, "canonical-block-correlated");
          return;
        }
        if (observation.status !== "observed") {
          const reason =
            observation.status === "not-found"
              ? "not-found"
              : `${observation.status}:${observation.reason}`;
          throw new Error(
            `Local node could not verify ${activityLabel} transaction ${txId}: ${reason}`,
          );
        }
        const local = observation.value;
        if (!local.isCanonical) {
          throw new Error(
            `Local node reports ${activityLabel} transaction ${txId} as non-canonical`,
          );
        }
        if (local.indexBlockHash.toLowerCase() !== transaction.block.index_hash.toLowerCase()) {
          throw new Error(
            `Local node and indexed API disagree on ${activityLabel} transaction ${txId}`,
          );
        }
        if (local.blockHeight === null || local.blockHeight !== BigInt(transaction.block.height)) {
          throw new Error(
            `Local node and indexed API disagree on ${activityLabel} transaction ${txId}`,
          );
        }
        evidence.set(txId, "node-index-verified");
      }),
    );
    signal?.throwIfAborted();
  }
  return evidence;
}

export async function syncManagerEvents(
  options: SyncManagerEventsOptions,
): Promise<SyncManagerEventsResult> {
  const pageLimit = options.pageLimit ?? 100;
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 100) {
    throw new Error("pageLimit must be an integer from 1 through 100");
  }
  if (!Number.isSafeInteger(options.chainId) || options.chainId < 0) {
    throw new Error("chainId must be a non-negative safe integer");
  }
  // v3 scopes the cursor to the reviewed decoding vocabulary. Moving from generic storage to a
  // reviewed adapter (or removing one) forces a complete replay instead of reusing projections
  // produced under different semantic assumptions.
  const stream = managerEventStream(options.managerPrincipal, options.eventVocabulary);
  const checkpoint = options.store.getCursor(options.sourceId, stream);
  let cursor = checkpoint?.cursor ?? null;
  const resumed = cursor !== null;
  const incrementalScan = checkpoint !== null && cursor === null;
  const requestedCursors = new Set<string | null>();
  let pagesProcessed = 0;
  let eventsProcessed = 0;
  let newEvents = 0;
  let replayedEvents = 0;
  let decodeFailures = 0;
  let reorgedEvents = 0;
  let nodeVerifiedTransactions = 0;
  let stoppedAtKnownOverlap = false;
  const scannedEventIds = new Set<string>();
  let scannedBoundaryBlockHeight: number | null = null;
  let scannedBoundaryIsComplete = false;

  while (true) {
    options.signal?.throwIfAborted();
    if (requestedCursors.has(cursor)) {
      throw new Error(`Manager event API repeated cursor ${cursor ?? "<initial>"}`);
    }
    requestedCursors.add(cursor);
    const page = await options.api.getSmartContractLogs(
      options.managerPrincipal,
      cursor,
      pageLimit,
    );
    options.signal?.throwIfAborted();
    // The API returns logs newest-first. `prev_cursor` advances toward older events;
    // `next_cursor` points back toward newer events and is null on the first page.
    if (page.prev_cursor !== null && page.prev_cursor === cursor) {
      throw new Error(`Manager event API did not advance cursor ${cursor}`);
    }
    const knownEvents = page.results.map((event) =>
      options.store.getChainEvent(options.chainId, event.tx_id, event.event_index),
    );
    const allKnownBeforeReplay =
      page.results.length > 0 && knownEvents.every((event) => event !== null);
    if (incrementalScan && allKnownBeforeReplay) {
      const storedEvents = knownEvents.filter((event) => event !== null);
      options.store.putChainEventPage([], {
        sourceId: options.sourceId,
        stream,
        cursor: null,
        lastBlockHeight:
          storedEvents.length === 0
            ? (checkpoint?.lastBlockHeight ?? null)
            : Math.max(...storedEvents.map(({ blockHeight }) => blockHeight)),
        lastIndexBlockHash:
          storedEvents[0]?.indexBlockHash ?? checkpoint?.lastIndexBlockHash ?? null,
        updatedAt: options.observedAt,
      });
      for (const event of storedEvents) {
        scannedEventIds.add(`${event.txId}:${event.eventIndex}`);
      }
      if (storedEvents.length > 0) {
        scannedBoundaryBlockHeight = Math.min(
          ...storedEvents.map(({ blockHeight }) => blockHeight),
        );
        scannedBoundaryIsComplete = page.results.length < pageLimit || page.prev_cursor === null;
      }
      pagesProcessed += 1;
      eventsProcessed += page.results.length;
      replayedEvents += page.results.length;
      stoppedAtKnownOverlap = true;
      await options.onProgress?.({
        completed: pagesProcessed,
        total: null,
        eventsProcessed,
      });
      break;
    }
    const transactionById = await enrichTransactions(options.api, page, options.signal);
    options.signal?.throwIfAborted();
    const transactionEvidence = options.nodeTransactions
      ? await verifyIndexedApiTransactionEvidenceWithNode(
          options.nodeTransactions,
          options.nodeBlocks,
          transactionById,
          "manager",
          options.signal,
        )
      : null;
    nodeVerifiedTransactions += transactionEvidence?.size ?? 0;
    options.signal?.throwIfAborted();
    const storedEvents: ChainEventInput[] = page.results.map((event, index) => {
      const transaction = transactionById.get(event.tx_id);
      if (!transaction) throw new Error(`Missing transaction enrichment for ${event.tx_id}`);
      const decodeReferenceEvent = options.eventVocabulary === "reference-manager-v1";
      const decoded = decodeReferenceEvent ? decodeEvent(event.contract_log.value.hex) : null;
      if (decodeReferenceEvent && !decoded) decodeFailures += 1;
      if (knownEvents[index]) {
        replayedEvents += 1;
      } else {
        newEvents += 1;
      }
      return {
        chainId: options.chainId,
        txId: event.tx_id,
        eventIndex: event.event_index,
        blockHeight: transaction.block.height,
        blockHash: transaction.block.hash,
        indexBlockHash: transaction.block.index_hash,
        microblockHash: null,
        microblockSequence: null,
        canonical: true,
        microblockCanonical: true,
        contractId: event.contract_log.contract_id,
        topic: decoded?.topic ?? event.contract_log.topic,
        rawPayload: {
          schema: "stacks-api-v2-contract-log",
          transactionStatus: transaction.status,
          transactionIndex: transaction.block.tx_index,
          bitcoinBlockHeight: transaction.bitcoin_block.height,
          contractLog: event.contract_log,
        },
        decodedSchemaVersion: decoded ? 1 : null,
        decodedPayload: decoded ? { transactionStatus: transaction.status, event: decoded } : null,
        evidenceLevel: transactionEvidence?.get(event.tx_id) ?? "indexer-reported",
        sourceId: options.sourceId,
        occurredAt: transactionOccurredAt(transaction),
        observedAt: options.observedAt,
      };
    });
    const firstTransaction = page.results[0]
      ? transactionById.get(page.results[0].tx_id)
      : undefined;
    options.signal?.throwIfAborted();
    options.store.putChainEventPage(storedEvents, {
      sourceId: options.sourceId,
      stream,
      cursor: page.prev_cursor,
      lastBlockHeight:
        storedEvents.length === 0
          ? (checkpoint?.lastBlockHeight ?? null)
          : Math.max(...storedEvents.map(({ blockHeight }) => blockHeight)),
      lastIndexBlockHash:
        firstTransaction?.block.index_hash ?? checkpoint?.lastIndexBlockHash ?? null,
      updatedAt: options.observedAt,
    });
    if (incrementalScan && storedEvents.length > 0) {
      for (const { txId, eventIndex } of storedEvents) {
        scannedEventIds.add(`${txId}:${eventIndex}`);
      }
      const pageBoundary = Math.min(...storedEvents.map(({ blockHeight }) => blockHeight));
      scannedBoundaryBlockHeight =
        scannedBoundaryBlockHeight === null
          ? pageBoundary
          : Math.min(scannedBoundaryBlockHeight, pageBoundary);
      scannedBoundaryIsComplete = page.results.length < pageLimit || page.prev_cursor === null;
    }
    pagesProcessed += 1;
    eventsProcessed += page.results.length;
    await options.onProgress?.({
      completed: pagesProcessed,
      total: page.prev_cursor === null ? pagesProcessed : null,
      eventsProcessed,
    });
    if (page.prev_cursor === null) break;
    cursor = page.prev_cursor;
  }

  // Reconcile only after the whole incremental window has been observed. Reconciling each page
  // independently would make events from a newer page look absent while processing an older page.
  // An interrupted incremental scan intentionally defers this step until the next complete scan.
  if (incrementalScan && scannedBoundaryBlockHeight !== null) {
    options.signal?.throwIfAborted();
    reorgedEvents = options.store.markMissingCanonicalContractEvents(
      options.chainId,
      options.managerPrincipal,
      scannedBoundaryBlockHeight,
      scannedBoundaryIsComplete,
      scannedEventIds,
      options.observedAt,
    );
  }

  return {
    stream,
    resumed,
    pagesProcessed,
    eventsProcessed,
    newEvents,
    replayedEvents,
    decodeFailures,
    reorgedEvents,
    nodeVerifiedTransactions,
    stoppedAtKnownOverlap,
  };
}
