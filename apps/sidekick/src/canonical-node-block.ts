import type { ChainAnchor } from "./chain-anchor.js";
import type { StacksNodeClient } from "./chain-clients.js";

type CanonicalBlockNode = Pick<
  StacksNodeClient,
  "getTenureInfo" | "getNakamotoBlockById" | "getNakamotoBlockAtHeight"
>;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && Buffer.compare(left, right) === 0;
}

/**
 * Proves that an index block is the local node's canonical block at a historical height.
 *
 * This is the node-first fallback for historical transactions that predate the node's current
 * transaction index. The indexed API may identify the transaction's block, but the local node
 * independently selects the canonical bytes at that height from an explicitly captured local tip.
 * New Stacks blocks may arrive while the two block reads are in flight; the `tip` query keeps the
 * proof anchored without mistaking normal tip advancement for a reorg.
 */
export async function proveCanonicalNodeBlock(
  node: CanonicalBlockNode,
  input: {
    blockHeight: number;
    indexBlockHash: ChainAnchor["indexBlockHash"];
    signal?: AbortSignal;
  },
): Promise<void> {
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
  if (!sameBytes(identified, canonical)) {
    throw new Error("Indexed transaction block is not canonical according to the local node");
  }
}
