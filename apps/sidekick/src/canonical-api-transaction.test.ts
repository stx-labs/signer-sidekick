import { makeSTXTokenTransfer } from "@stacks/transactions";
import { describe, expect, it, vi } from "vitest";
import { lookupCanonicalApiTransaction } from "./canonical-api-transaction.js";
import { UpstreamHttpError, UpstreamUnavailableError } from "./chain-clients.js";

const transaction = await makeSTXTokenTransfer({
  recipient: "ST000000000000000000002AMW42H",
  amount: 1n,
  senderKey: `${"11".repeat(32)}01`,
  nonce: 1n,
  fee: 1000n,
  network: "testnet",
});
const txId = `0x${transaction.txid()}` as const;
const hash = `0x${"33".repeat(32)}` as const;

function fixture() {
  const body = transaction.serializeBytes();
  const block = new Uint8Array(220 + body.length);
  new DataView(block.buffer).setUint32(216, 1);
  block.set(body, 220);
  const api = {
    getNodeInfo: vi.fn(async () => ({ network_id: 0x80000000 })),
    getTransactionDetails: vi.fn(async () => ({
      tx_id: txId,
      tx_status: "success",
      canonical: true,
      block_height: 100,
      block_hash: hash,
      tx_result: { repr: "(ok true)" },
    })),
    getBlock: vi.fn(async () => ({ canonical: true, height: 100, hash, index_block_hash: hash })),
  };
  const node = {
    getTenureInfo: vi.fn(async () => ({ tip_height: 101, tip_block_id: hash })),
    getNakamotoBlockById: vi.fn(async () => block),
    getNakamotoBlockAtHeight: vi.fn(async () => block),
  };
  return {
    api,
    node,
    block,
    lookup: () =>
      lookupCanonicalApiTransaction({
        api: api as never,
        node: node as never,
        chainId: 0x80000000,
        txId,
      }),
  };
}

describe("canonical API receipt", () => {
  it("returns exact canonical block bytes for the ordinary wallet verifier", async () => {
    const f = fixture();
    expect(await f.lookup()).toMatchObject({
      status: "observed",
      value: {
        txid: txId,
        success: true,
        transactionHex: transaction.serialize(),
      },
    });
    expect(f.node.getNakamotoBlockAtHeight).toHaveBeenCalledWith(100, { tip: hash });
  });

  it.each([
    "reorged",
    "absent",
  ] as const)("reports positive %s evidence as conflict", async (reason) => {
    const f = fixture();
    const empty = new Uint8Array(220);
    f.node.getNakamotoBlockAtHeight.mockResolvedValue(empty);
    if (reason === "absent") f.node.getNakamotoBlockById.mockResolvedValue(empty);
    expect(await f.lookup()).toEqual({
      status: "conflict",
      reason,
      blockHeight: 100,
      indexBlockHash: hash,
    });
  });

  it.each([
    "timeout",
    "behind",
    "malformed-tail",
  ])("keeps %s unavailable rather than conflicting", async (kind) => {
    const f = fixture();
    if (kind === "timeout")
      f.node.getTenureInfo.mockRejectedValue(new UpstreamUnavailableError("timeout"));
    if (kind === "behind")
      f.node.getTenureInfo.mockResolvedValue({ tip_height: 99, tip_block_id: hash });
    if (kind === "malformed-tail") {
      const malformed = new Uint8Array([...f.block, 0]);
      f.node.getNakamotoBlockById.mockResolvedValue(malformed);
      f.node.getNakamotoBlockAtHeight.mockResolvedValue(malformed);
    }
    expect(await f.lookup()).toMatchObject({ status: "unavailable" });
  });

  it.each([
    "network",
    "txid",
    "orphaned-abort",
    "block-height",
    "block-hash",
    "block-canonical",
  ])("refuses incoherent %s evidence before checking node bytes", async (kind) => {
    const f = fixture();
    const details = await f.api.getTransactionDetails();
    const block = await f.api.getBlock();
    if (kind === "network") f.api.getNodeInfo.mockResolvedValue({ network_id: 1 });
    if (kind === "txid") f.api.getTransactionDetails.mockResolvedValue({ ...details, tx_id: hash });
    if (kind === "orphaned-abort")
      f.api.getTransactionDetails.mockResolvedValue({
        ...details,
        canonical: false,
        tx_status: "abort_by_response",
      });
    if (kind === "block-height") f.api.getBlock.mockResolvedValue({ ...block, height: 99 });
    if (kind === "block-hash") f.api.getBlock.mockResolvedValue({ ...block, hash: txId });
    if (kind === "block-canonical")
      f.api.getBlock.mockResolvedValue({ ...block, canonical: false });
    expect(await f.lookup()).toMatchObject({ status: "unavailable" });
    expect(f.node.getTenureInfo).not.toHaveBeenCalled();
  });

  it("requires exact canonical inclusion for abort too", async () => {
    const f = fixture();
    f.api.getTransactionDetails.mockResolvedValue({
      ...(await f.api.getTransactionDetails()),
      tx_status: "abort_by_post_condition",
    });
    expect(await f.lookup()).toMatchObject({ status: "observed", value: { success: false } });
    expect(f.node.getNakamotoBlockAtHeight).toHaveBeenCalledOnce();
  });

  it("treats an API 404 as missing, not as an abort", async () => {
    const f = fixture();
    f.api.getTransactionDetails.mockRejectedValue(new UpstreamHttpError("not found", 404));
    expect(await f.lookup()).toEqual({ status: "not-found" });
  });
});
