import { checkTransactionInCanonicalBlock } from "./canonical-node-block.js";
import {
  RateLimitedError,
  type StacksApiClient,
  type StacksNodeClient,
  UpstreamHttpError,
} from "./chain-clients.js";

type CanonicalApiTransactionNode = Pick<
  StacksNodeClient,
  "getTenureInfo" | "getNakamotoBlockById" | "getNakamotoBlockAtHeight"
>;

type CanonicalApiTransactionApi = Pick<
  StacksApiClient,
  "getNodeInfo" | "getTransactionDetails" | "getBlock"
>;

export type CanonicalApiTransactionLookup =
  | {
      status: "observed";
      value: {
        txid: `0x${string}`;
        blockHeight: number;
        indexBlockHash: `0x${string}`;
        success: boolean;
        resultRepr: string;
        transactionHex: string | null;
        source: "api-with-node" | "api";
      };
    }
  // No terminal API receipt, including pending/dropped; not proof of absence from the node mempool.
  | { status: "not-found" }
  | {
      status: "conflict";
      reason: "reorged" | "absent";
      blockHeight: number;
      indexBlockHash: `0x${string}`;
    }
  | { status: "unavailable"; reason: string; retryAfterMs?: number };

function unavailable(error: unknown): CanonicalApiTransactionLookup {
  return {
    status: "unavailable",
    reason: error instanceof Error ? error.message : "the source returned no diagnostic detail",
    ...(error instanceof RateLimitedError && error.retryAfterMs !== null
      ? { retryAfterMs: error.retryAfterMs }
      : {}),
  };
}

/**
 * Coherent configured-API execution evidence, with node corroboration when available.
 * API-only evidence is opt-in at the caller's durable exact-transaction binding boundary;
 * public API payload summaries never establish that binding. Positive node conflicts win.
 */
export async function lookupCanonicalApiTransaction(input: {
  api: CanonicalApiTransactionApi;
  node: CanonicalApiTransactionNode;
  chainId: number;
  txId: `0x${string}`;
  allowApiEvidence?: boolean | (() => boolean | Promise<boolean>);
}): Promise<CanonicalApiTransactionLookup> {
  let details: Awaited<ReturnType<CanonicalApiTransactionApi["getTransactionDetails"]>>;
  try {
    const apiInfo = await input.api.getNodeInfo();
    if (apiInfo.network_id !== input.chainId) {
      return { status: "unavailable", reason: "Configured API is on a different network" };
    }
    details = await input.api.getTransactionDetails(input.txId);
  } catch (error) {
    if (error instanceof UpstreamHttpError && error.status === 404) {
      return { status: "not-found" };
    }
    return unavailable(error);
  }

  if (details.tx_id !== input.txId) {
    return { status: "unavailable", reason: "Configured API returned a different transaction" };
  }
  if (
    details.tx_status !== "success" &&
    details.tx_status !== "abort_by_response" &&
    details.tx_status !== "abort_by_post_condition"
  ) {
    return { status: "not-found" };
  }
  if (!details.canonical || details.block_hash === null) {
    return { status: "unavailable", reason: "Configured API has no canonical transaction block" };
  }

  try {
    const block = await input.api.getBlock(details.block_hash);
    if (
      !block.canonical ||
      block.hash !== details.block_hash ||
      block.height !== details.block_height
    ) {
      return {
        status: "unavailable",
        reason: "Configured API transaction and block records are not coherent",
      };
    }
    const receipt = {
      txid: details.tx_id,
      blockHeight: block.height,
      indexBlockHash: block.index_block_hash,
      success: details.tx_status === "success",
      resultRepr: details.tx_result.repr,
    };
    let proof: Awaited<ReturnType<typeof checkTransactionInCanonicalBlock>>;
    try {
      proof = await checkTransactionInCanonicalBlock(input.node, {
        blockHeight: block.height,
        indexBlockHash: block.index_block_hash,
        txId: input.txId,
      });
    } catch (error) {
      const allowed =
        typeof input.allowApiEvidence === "function"
          ? await input.allowApiEvidence()
          : input.allowApiEvidence;
      if (!allowed) return unavailable(error);
      return { status: "observed", value: { ...receipt, transactionHex: null, source: "api" } };
    }
    if (proof.status !== "included") {
      return {
        status: "conflict",
        reason: proof.status,
        blockHeight: block.height,
        indexBlockHash: block.index_block_hash,
      };
    }
    return {
      status: "observed",
      value: {
        ...receipt,
        transactionHex: proof.transaction.serialize(),
        source: "api-with-node",
      },
    };
  } catch (error) {
    return unavailable(error);
  }
}
