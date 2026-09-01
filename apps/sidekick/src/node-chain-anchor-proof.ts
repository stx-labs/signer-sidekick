import { type ChainAnchor, chainAnchorsEqual } from "./chain-anchor.js";
import type { StacksNodeClient } from "./chain-clients.js";

type ChainAnchorProofNode = Pick<
  StacksNodeClient,
  "getNakamotoBlockById" | "getNakamotoBlockAtHeight"
>;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length || left.length === 0) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Proves that an older local-node anchor is still canonical beneath a newer live tip.
 *
 * Fetching the block by its index-block ID proves the sealed identity is still available. Fetching
 * the block at the same height under the newer tip proves that identity remains on the canonical
 * branch. No indexed API is involved.
 */
export async function nodeProvesChainAnchorCanonical(
  node: ChainAnchorProofNode,
  anchor: ChainAnchor,
  liveAnchor: ChainAnchor,
): Promise<boolean> {
  if (chainAnchorsEqual(anchor, liveAnchor)) return true;
  if (anchor.stacksBlockHeight > liveAnchor.stacksBlockHeight) return false;
  try {
    const [byId, atHeight] = await Promise.all([
      node.getNakamotoBlockById(anchor.indexBlockHash),
      node.getNakamotoBlockAtHeight(anchor.stacksBlockHeight, {
        tip: liveAnchor.indexBlockHash,
      }),
    ]);
    return bytesEqual(byId, atHeight);
  } catch {
    return false;
  }
}
