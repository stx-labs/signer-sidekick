import type { ChainAnchor } from "./chain-anchor.js";
import type { StacksNodeClient } from "./chain-clients.js";
import { nakamotoBlockContainsTxid } from "./nakamoto-block.js";

type CanonicalBlockNode = Pick<
  StacksNodeClient,
  "getTenureInfo" | "getNakamotoBlockById" | "getNakamotoBlockAtHeight"
>;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && Buffer.compare(left, right) === 0;
}

/**
 * Outcome of checking a transaction against the local node's canonical chain.
 *
 * `reorged` and `absent` are ordinary chain outcomes a caller may act on, not failures.
 * Transport problems and a node that has not yet reached the height still throw, so a
 * temporarily unreachable node is never mistaken for a rolled-back transaction.
 */
export type CanonicalTransactionProof =
  | { status: "included" }
  | { status: "absent" }
  | { status: "reorged" };

/**
 * Fetches the block the indexed API named and proves it is the local node's canonical
 * block at that height, returning its bytes.
 *
 * New Stacks blocks may arrive while the two block reads are in flight; the `tip` query
 * keeps the proof anchored without mistaking normal tip advancement for a reorg.
 */
async function canonicalBlockBytes(
  node: CanonicalBlockNode,
  input: {
    blockHeight: number;
    indexBlockHash: ChainAnchor["indexBlockHash"];
    signal?: AbortSignal;
  },
): Promise<Uint8Array | null> {
  const requestOptions = input.signal ? { signal: input.signal } : {};
  const before = await node.getTenureInfo(requestOptions);
  if (input.blockHeight > before.tip_height) {
    throw new Error("Local node has not reached the indexed transaction block");
  }

  const [identified, canonical] = await Promise.all([
    node.getNakamotoBlockById(input.indexBlockHash, requestOptions),
    node.getNakamotoBlockAtHeight(input.blockHeight, {
      tip: before.tip_block_id,
      ...(input.signal ? { signal: input.signal } : {}),
    }),
  ]);
  return sameBytes(identified, canonical) ? identified : null;
}

/**
 * Checks whether the local node's canonical block at a height still contains a transaction.
 *
 * Reads the transaction ids out of the canonical block the node served, which is what lets
 * an operator run without `txindex`: block bytes are primary consensus data, so inclusion
 * is established at least as strongly as the derived index establishes it.
 *
 * Costs one block deserialization per check, against the single-row lookup an enabled
 * transaction index would have served.
 */
export async function checkTransactionInCanonicalBlock(
  node: CanonicalBlockNode,
  input: {
    blockHeight: number;
    indexBlockHash: ChainAnchor["indexBlockHash"];
    txId: string;
    signal?: AbortSignal;
  },
): Promise<CanonicalTransactionProof> {
  const block = await canonicalBlockBytes(node, input);
  if (!block) return { status: "reorged" };
  return nakamotoBlockContainsTxid(block, input.txId)
    ? { status: "included" }
    : { status: "absent" };
}

/**
 * Proves that an index block is the local node's canonical block at a historical height.
 *
 * This is the node-first fallback for historical transactions that predate the node's current
 * transaction index. The indexed API may identify the transaction's block, but the local node
 * independently selects the canonical bytes at that height from an explicitly captured local tip.
 */
export async function proveCanonicalNodeBlock(
  node: CanonicalBlockNode,
  input: {
    blockHeight: number;
    indexBlockHash: ChainAnchor["indexBlockHash"];
    signal?: AbortSignal;
  },
): Promise<void> {
  if (!(await canonicalBlockBytes(node, input))) {
    throw new Error("Indexed transaction block is not canonical according to the local node");
  }
}

/**
 * Proves a transaction is included in the local node's canonical block at a height, throwing
 * otherwise.
 *
 * The ingest paths use this because a transaction the indexed API just reported, that the
 * local node cannot corroborate, is a disagreement worth surfacing rather than a silent skip.
 */
export async function proveTransactionInCanonicalBlock(
  node: CanonicalBlockNode,
  input: {
    blockHeight: number;
    indexBlockHash: ChainAnchor["indexBlockHash"];
    txId: string;
    signal?: AbortSignal;
  },
): Promise<void> {
  const proof = await checkTransactionInCanonicalBlock(node, input);
  if (proof.status === "reorged") {
    throw new Error("Indexed transaction block is not canonical according to the local node");
  }
  if (proof.status === "absent") {
    throw new Error(
      `Transaction ${input.txId} is absent from the local node's canonical block at height ${input.blockHeight}`,
    );
  }
}
