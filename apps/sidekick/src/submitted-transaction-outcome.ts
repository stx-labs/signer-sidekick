import type { TransactionExecutionSource } from "@stx-labs/signer-sidekick-api-contracts";
import { lookupCanonicalApiTransaction } from "./canonical-api-transaction.js";
import type { LiveTransactionReader } from "./transaction-engine/live-transaction-reader.js";

export type SubmittedTransactionOutcome =
  | {
      status: "confirmed";
      success: boolean;
      resultRepr: string;
      blockHeight: number;
      source: TransactionExecutionSource;
    }
  | { status: "conflict"; reason: string }
  | { status: "pending"; retryLater?: boolean; retryAfterMs?: number };

/** Read-only receipt triage for locally signed runs/sweeps. Callers own binding and transitions. */
export async function readSubmittedTransactionOutcome(
  input: Parameters<typeof lookupCanonicalApiTransaction>[0] & {
    reader: Pick<LiveTransactionReader, "lookupIndexedTransaction">;
  },
): Promise<SubmittedTransactionOutcome> {
  const indexed = await input.reader.lookupIndexedTransaction(input.txId).catch(() => null);
  if (indexed?.status === "observed") {
    if (!indexed.value.isCanonical)
      return { status: "conflict", reason: "Transaction became noncanonical" };
    // An observed node record wins; no API can fill in a missing node height.
    if (indexed.value.blockHeight === null) return { status: "pending" };
    const blockHeight = Number(indexed.value.blockHeight);
    if (!Number.isSafeInteger(blockHeight) || blockHeight < 0)
      return { status: "pending", retryLater: true };
    return {
      status: "confirmed",
      success: indexed.value.resultRepr.trim().startsWith("(ok"),
      resultRepr: indexed.value.resultRepr,
      blockHeight,
      source: "node",
    };
  }
  const receipt = await lookupCanonicalApiTransaction(input);
  if (receipt.status === "conflict")
    return { status: "conflict", reason: `Canonical transaction conflict: ${receipt.reason}` };
  if (receipt.status === "observed")
    return {
      status: "confirmed",
      success: receipt.value.success,
      resultRepr: receipt.value.resultRepr,
      blockHeight: receipt.value.blockHeight,
      source: receipt.value.source,
    };
  return receipt.status === "unavailable"
    ? {
        status: "pending",
        retryLater: true,
        ...(receipt.retryAfterMs === undefined ? {} : { retryAfterMs: receipt.retryAfterMs }),
      }
    : { status: "pending" };
}
