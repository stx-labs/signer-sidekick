/** Minimal version-0 Nakamoto header with empty signer vectors and the supplied transactions. */
export function nakamotoBlockBytes(...transactions: (Uint8Array | string)[]): Uint8Array {
  const bytes = transactions.map((tx) =>
    typeof tx === "string" ? Buffer.from(tx.replace(/^0x/, ""), "hex") : tx,
  );
  const block = new Uint8Array(220 + bytes.reduce((size, tx) => size + tx.length, 0));
  new DataView(block.buffer).setUint32(216, bytes.length);
  let offset = 220;
  for (const tx of bytes) {
    block.set(tx, offset);
    offset += tx.length;
  }
  return block;
}
