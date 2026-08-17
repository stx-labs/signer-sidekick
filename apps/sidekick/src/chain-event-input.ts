import { type TransactionSummary, transactionOccurredAt } from "./chain-clients.js";
import type { ChainEventInput } from "./storage/store.js";

interface ChainEventInputOptions {
  chainId: number;
  txId: string;
  eventIndex: number;
  transaction: TransactionSummary;
  contractId: string | null;
  topic: string | null;
  rawPayload: unknown;
  decodedPayload: unknown | null;
  decodedSchemaVersion: number | null;
  evidenceLevel: ChainEventInput["evidenceLevel"];
  sourceId: string;
  observedAt: string;
}

/** Builds the canonical anchored fields shared by every indexed chain-event ingestion path. */
export function buildChainEventInput(options: ChainEventInputOptions): ChainEventInput {
  return {
    chainId: options.chainId,
    txId: options.txId,
    eventIndex: options.eventIndex,
    blockHeight: options.transaction.block.height,
    blockHash: options.transaction.block.hash,
    indexBlockHash: options.transaction.block.index_hash,
    microblockHash: null,
    microblockSequence: null,
    canonical: true,
    microblockCanonical: true,
    contractId: options.contractId,
    topic: options.topic,
    rawPayload: options.rawPayload,
    decodedSchemaVersion: options.decodedSchemaVersion,
    decodedPayload: options.decodedPayload,
    evidenceLevel: options.evidenceLevel,
    sourceId: options.sourceId,
    occurredAt: transactionOccurredAt(options.transaction),
    observedAt: options.observedAt,
  };
}
