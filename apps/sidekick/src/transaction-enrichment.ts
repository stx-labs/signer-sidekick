import type { TransactionSummary } from "./chain-clients.js";

export interface TransactionSummarySource {
  getTransaction(txId: string): Promise<TransactionSummary>;
}

/** Loads unique transaction summaries in small batches to avoid bursting an indexed API. */
export async function loadTransactionSummaries(
  source: TransactionSummarySource,
  transactionIds: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, TransactionSummary>> {
  const uniqueIds = [...new Set(transactionIds)];
  const entries: Array<[string, TransactionSummary]> = [];
  for (let index = 0; index < uniqueIds.length; index += 8) {
    signal?.throwIfAborted();
    entries.push(
      ...(await Promise.all(
        uniqueIds
          .slice(index, index + 8)
          .map(
            async (txId): Promise<[string, TransactionSummary]> => [
              txId,
              await source.getTransaction(txId),
            ],
          ),
      )),
    );
    signal?.throwIfAborted();
  }
  return new Map(entries);
}
