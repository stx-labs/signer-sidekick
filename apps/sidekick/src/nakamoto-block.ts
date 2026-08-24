import { BytesReader, deserializeTransaction } from "@stacks/transactions";

// `NakamotoBlockHeader::consensus_serialize` writes a fixed prefix before the two
// variable-length fields: version(1) + chain_length(8) + burn_spent(8) +
// consensus_hash(20) + parent_block_id(32) + tx_merkle_root(32) +
// state_index_root(32) + timestamp(8) + miner_signature(65).
const FIXED_HEADER_BYTES = 206;
const MESSAGE_SIGNATURE_BYTES = 65;
// `ProblematicTxMarker`: tx_index(u32) + category(u8).
const PROBLEMATIC_TX_MARKER_BYTES = 5;
// The high bit of `version` is the shadow-block flag; the header version is the
// low 7 bits. `problematic_txs` was added in Epoch 4.0 (header version 1) and is
// absent from version-0 headers entirely.
const HEADER_VERSION_MASK = 0x7f;
const HEADER_VERSION_EPOCH_4 = 1;

function requireBytes(block: Uint8Array, offset: number, length: number): void {
  if (offset + length > block.byteLength) {
    throw new Error("Nakamoto block ended mid-header");
  }
}

/**
 * Locates the transaction array by walking the block header's wire format.
 *
 * Only the two variable-length header fields need real parsing; everything else is
 * a fixed-width skip.
 */
function transactionArrayOffset(block: Uint8Array): number {
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  requireBytes(block, 0, FIXED_HEADER_BYTES + 4);
  const version = view.getUint8(0);
  let offset = FIXED_HEADER_BYTES;

  // signer_signature: Vec<MessageSignature>
  const signatures = view.getUint32(offset);
  offset += 4;
  requireBytes(block, offset, signatures * MESSAGE_SIGNATURE_BYTES);
  offset += signatures * MESSAGE_SIGNATURE_BYTES;

  // pox_treatment: BitVec — u16 bit length, then the backing Vec<u8>.
  requireBytes(block, offset, 6);
  offset += 2;
  const bitvecBytes = view.getUint32(offset);
  offset += 4;
  requireBytes(block, offset, bitvecBytes);
  offset += bitvecBytes;

  if ((version & HEADER_VERSION_MASK) >= HEADER_VERSION_EPOCH_4) {
    requireBytes(block, offset, 4);
    const markers = view.getUint32(offset);
    offset += 4;
    requireBytes(block, offset, markers * PROBLEMATIC_TX_MARKER_BYTES);
    offset += markers * PROBLEMATIC_TX_MARKER_BYTES;
  }

  return offset;
}

/**
 * Recovers the transaction ids a Nakamoto block commits to, straight from the
 * consensus-serialized block the node served.
 *
 * This is what lets Sidekick confirm a transaction is *in* a block without the
 * node's transaction index: the block bytes are primary consensus data, so
 * deserializing them establishes inclusion at least as strongly as the derived
 * index does.
 *
 * The parse is deliberately fail-closed. The transaction array runs to the end of
 * the block, so a trailing-byte mismatch means the header walk went wrong; that
 * throws rather than returning a partial set a caller could read as "absent".
 */
export function readNakamotoBlockTxids(block: Uint8Array): `0x${string}`[] {
  const reader = new BytesReader(block);
  reader.readOffset = transactionArrayOffset(block);
  const count = reader.readUInt32BE();

  const txids: `0x${string}`[] = [];
  for (let index = 0; index < count; index++) {
    try {
      txids.push(`0x${deserializeTransaction(reader).txid().toLowerCase()}`);
    } catch (cause) {
      throw new Error(`Nakamoto block transaction ${index} could not be deserialized`, { cause });
    }
  }

  if (reader.readOffset !== block.byteLength) {
    throw new Error("Nakamoto block transactions did not consume the block exactly");
  }
  return txids;
}

/** Whether `txId` is one of the transactions the block commits to. */
export function nakamotoBlockContainsTxid(block: Uint8Array, txId: string): boolean {
  const needle = txId.toLowerCase();
  return readNakamotoBlockTxids(block).some((candidate) => candidate === needle);
}
