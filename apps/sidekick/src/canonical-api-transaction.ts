import { proveTransactionInCanonicalBlock } from "./canonical-node-block.js";
import { type StacksApiClient, type StacksNodeClient, UpstreamHttpError } from "./chain-clients.js";

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
      };
    }
  | { status: "not-found" }
  | { status: "unavailable"; reason: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : "the source returned no diagnostic detail";
}

/**
 * Uses an indexed API only to locate a transaction, then requires the local node to prove the
 * exact transaction is included in that canonical block. This is the confirmation path for
 * nodes that deliberately run without the derived transaction index.
 */
export async function lookupCanonicalApiTransaction(input: {
  api: CanonicalApiTransactionApi;
  node: CanonicalApiTransactionNode;
  chainId: number;
  txId: `0x${string}`;
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
    return { status: "unavailable", reason: message(error) };
  }

  if (details.tx_id !== input.txId) {
    return { status: "unavailable", reason: "Configured API returned a different transaction" };
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
    await proveTransactionInCanonicalBlock(input.node, {
      blockHeight: block.height,
      indexBlockHash: block.index_block_hash,
      txId: input.txId,
    });
    return {
      status: "observed",
      value: {
        txid: details.tx_id,
        blockHeight: block.height,
        indexBlockHash: block.index_block_hash,
        success: details.tx_status === "success",
        resultRepr: details.tx_result.repr,
      },
    };
  } catch (error) {
    return { status: "unavailable", reason: message(error) };
  }
}
