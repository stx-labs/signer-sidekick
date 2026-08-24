import { makeSTXTokenTransfer } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import { nakamotoBlockContainsTxid, readNakamotoBlockTxids } from "./nakamoto-block.js";

async function transaction(nonce: bigint) {
  return makeSTXTokenTransfer({
    recipient: "ST000000000000000000002AMW42H",
    amount: 1n,
    senderKey: `${"11".repeat(32)}01`,
    nonce,
    fee: 1_000n,
    network: "testnet",
  });
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

/**
 * Builds a block in `NakamotoBlockHeader::consensus_serialize` order. The fixed prefix is
 * opaque to the reader, so it is filler; the variable-length fields are what the reader
 * actually has to walk.
 */
function block(options: {
  version: number;
  signerSignatures: number;
  bitvecBytes: number;
  problematicMarkers: number;
  transactions: Uint8Array[];
  trailingGarbage?: number;
}): Uint8Array {
  const parts: Uint8Array[] = [];
  const fixed = new Uint8Array(206).fill(0xab);
  fixed[0] = options.version;
  parts.push(fixed);

  parts.push(uint32(options.signerSignatures));
  parts.push(new Uint8Array(options.signerSignatures * 65).fill(0xcd));

  parts.push(new Uint8Array([0x00, 0x08])); // BitVec.len (u16)
  parts.push(uint32(options.bitvecBytes));
  parts.push(new Uint8Array(options.bitvecBytes).fill(0xff));

  if ((options.version & 0x7f) >= 1) {
    parts.push(uint32(options.problematicMarkers));
    parts.push(new Uint8Array(options.problematicMarkers * 5).fill(0x01));
  }

  parts.push(uint32(options.transactions.length));
  for (const tx of options.transactions) parts.push(tx);
  if (options.trailingGarbage) parts.push(new Uint8Array(options.trailingGarbage).fill(0x77));

  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

describe("readNakamotoBlockTxids", () => {
  it("recovers transaction ids from a version-1 header carrying problematic-tx markers", async () => {
    const txs = [await transaction(1n), await transaction(2n), await transaction(3n)];
    const bytes = block({
      version: 1,
      signerSignatures: 17,
      bitvecBytes: 1,
      problematicMarkers: 2,
      transactions: txs.map((tx) => tx.serializeBytes()),
    });

    expect(readNakamotoBlockTxids(bytes)).toEqual(txs.map((tx) => `0x${tx.txid()}`));
  });

  it("omits the problematic-tx vector for version-0 headers", async () => {
    const txs = [await transaction(4n)];
    const bytes = block({
      version: 0,
      signerSignatures: 13,
      bitvecBytes: 1,
      problematicMarkers: 0,
      transactions: txs.map((tx) => tx.serializeBytes()),
    });

    expect(readNakamotoBlockTxids(bytes)).toEqual([`0x${txs[0].txid()}`]);
  });

  it("treats the shadow-block flag as part of the version, not a new header shape", async () => {
    const txs = [await transaction(5n)];
    const bytes = block({
      version: 0x80, // shadow flag set, header version 0
      signerSignatures: 2,
      bitvecBytes: 1,
      problematicMarkers: 0,
      transactions: txs.map((tx) => tx.serializeBytes()),
    });

    expect(readNakamotoBlockTxids(bytes)).toEqual([`0x${txs[0].txid()}`]);
  });

  it("fails closed when the walk does not consume the block exactly", async () => {
    const txs = [await transaction(6n)];
    const bytes = block({
      version: 1,
      signerSignatures: 3,
      bitvecBytes: 1,
      problematicMarkers: 0,
      transactions: txs.map((tx) => tx.serializeBytes()),
      trailingGarbage: 9,
    });

    expect(() => readNakamotoBlockTxids(bytes)).toThrow(/did not consume the block exactly/);
  });

  it("fails closed on a truncated block rather than reporting a transaction absent", async () => {
    const txs = [await transaction(7n)];
    const bytes = block({
      version: 1,
      signerSignatures: 3,
      bitvecBytes: 1,
      problematicMarkers: 0,
      transactions: txs.map((tx) => tx.serializeBytes()),
    });

    expect(() => readNakamotoBlockTxids(bytes.slice(0, bytes.byteLength - 5))).toThrow();
  });

  it("rejects a header whose signer-signature count runs past the block", () => {
    const bytes = block({
      version: 1,
      signerSignatures: 1,
      bitvecBytes: 1,
      problematicMarkers: 0,
      transactions: [],
    });
    new DataView(bytes.buffer).setUint32(206, 5_000);

    expect(() => readNakamotoBlockTxids(bytes)).toThrow(/ended mid-header/);
  });
});

describe("nakamotoBlockContainsTxid", () => {
  it("matches irrespective of hex casing", async () => {
    const tx = await transaction(8n);
    const bytes = block({
      version: 1,
      signerSignatures: 4,
      bitvecBytes: 1,
      problematicMarkers: 1,
      transactions: [tx.serializeBytes()],
    });

    expect(nakamotoBlockContainsTxid(bytes, `0x${tx.txid().toUpperCase()}`)).toBe(true);
    expect(nakamotoBlockContainsTxid(bytes, `0x${"00".repeat(32)}`)).toBe(false);
  });
});
