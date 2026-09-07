import { makeSTXTokenTransfer } from "@stacks/transactions";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as chainClients from "../chain-clients.js";
import { LiveRewardRunDriver } from "./live-reward-run.js";
import type { LiveTransactionReader } from "./live-transaction-reader.js";
import type { TransactionEngineRuntimeContext } from "./runtime.js";

const transaction = await makeSTXTokenTransfer({
  recipient: "ST000000000000000000002AMW42H",
  amount: 1n,
  senderKey: `${"11".repeat(32)}01`,
  nonce: 1n,
  fee: 1_000n,
  network: "testnet",
});
const otherTransaction = await makeSTXTokenTransfer({
  recipient: "ST000000000000000000002AMW42H",
  amount: 2n,
  senderKey: `${"12".repeat(32)}01`,
  nonce: 2n,
  fee: 1_000n,
  network: "testnet",
});
const txId = `0x${transaction.txid()}` as const;
const blockHash = `0x${"22".repeat(32)}` as const;
const indexBlockHash = `0x${"33".repeat(32)}` as const;
const blockHeight = 8_600_002;
const walletPrincipal = "ST000000000000000000002AMW42H";
afterEach(() => vi.restoreAllMocks());

function nakamotoBlockBytes(body = transaction.serializeBytes()): Uint8Array {
  const bytes = new Uint8Array(206 + 4 + 2 + 4 + 1 + 4 + 4 + body.byteLength);
  const view = new DataView(bytes.buffer);
  bytes.fill(0xab, 0, 206);
  view.setUint8(0, 1);
  let offset = 206;
  view.setUint32(offset, 0);
  offset += 4;
  view.setUint16(offset, 8);
  offset += 2;
  view.setUint32(offset, 1);
  offset += 5;
  view.setUint32(offset, 0);
  offset += 4;
  view.setUint32(offset, 1);
  offset += 4;
  bytes.set(body, offset);
  return bytes;
}

function driver(resultRepr: string, blockBytes = nakamotoBlockBytes()) {
  const node = {
    getTenureInfo: vi.fn(async () => ({
      tip_block_id: `0x${"99".repeat(32)}`,
      tip_height: blockHeight + 10,
      reward_cycle: 141,
    })),
    getNakamotoBlockById: vi.fn(async () => blockBytes),
    getNakamotoBlockAtHeight: vi.fn(async () => blockBytes),
  };
  const api = {
    getNodeInfo: vi.fn(async () => ({ network_id: 1 })),
    getTransactionDetails: vi.fn(async () => ({
      tx_id: txId,
      tx_status: "success",
      tx_result: { hex: "0x0703", repr: resultRepr },
      canonical: true,
      block_hash: blockHash,
      block_height: blockHeight,
    })),
    getBlock: vi.fn(async () => ({
      canonical: true,
      height: blockHeight,
      hash: blockHash,
      index_block_hash: indexBlockHash,
    })),
  };
  const reader = {
    readAnchoredAccount: vi.fn(),
    lookupIndexedTransaction: vi.fn(async () => ({
      status: "unavailable" as const,
      httpStatus: 501,
      reason: "transaction-index-unavailable" as const,
    })),
    lookupUnconfirmedTransaction: vi.fn(async () => ({
      status: "not-found" as const,
      httpStatus: 404 as const,
    })),
  };
  return {
    node,
    api,
    reader,
    value: new LiveRewardRunDriver({
      engine: { gasPayerIdentity: () => ({ principal: walletPrincipal }) } as never,
      runtimeContext: () =>
        ({
          config: { nodeRpcUrl: "http://node:20443" },
          node,
          api,
        }) as unknown as TransactionEngineRuntimeContext,
      feePolicy: () => ({
        minimumFeeUstx: 1_000n,
        standardFeeUstx: 2_000n,
        maximumFeeUstx: 3_000n,
      }),
      withdrawalRequestStatus: vi.fn(),
      createReader: () => reader as unknown as LiveTransactionReader,
    }),
  };
}

const operations = [
  "claim-rewards",
  "claim-staker-rewards",
  "settle-accepted-withdrawal",
  "reclaim-failed-withdrawal",
] as const;

describe("reward run confirmation without node txindex", () => {
  const input = () =>
    ({
      run: {
        walletPrincipal,
        recipe: { chainId: 1, preparedAnchor: { stacksBlockHeight: blockHeight, indexBlockHash } },
      },
      child: { operation: "claim-rewards" },
      plan: { material: { kind: "claim-rewards" } },
      txid: txId,
    }) as never;

  it("does not read the preparation block while reconciling a pending submitted transaction", async () => {
    const runtime = driver("(ok true)");
    runtime.reader.lookupIndexedTransaction.mockResolvedValue({
      status: "unavailable",
      httpStatus: 503,
      reason: "transport-error",
    } as never);
    expect(await runtime.value.reconcile(input())).toEqual({ status: "pending" });
    expect(runtime.node.getTenureInfo).not.toHaveBeenCalled();
    expect(runtime.node.getNakamotoBlockById).not.toHaveBeenCalled();
    expect(runtime.api.getTransactionDetails).not.toHaveBeenCalled();
  });

  it("still halts a new materialization on positive preparation-anchor mismatch", async () => {
    const runtime = driver("(ok true)");
    runtime.node.getNakamotoBlockAtHeight.mockResolvedValue(
      nakamotoBlockBytes(otherTransaction.serializeBytes()),
    );
    expect(await runtime.value.materialize(input())).toEqual({
      status: "halt",
      reason: "The reward run preparation anchor became noncanonical",
    });
    expect(runtime.reader.readAnchoredAccount).not.toHaveBeenCalled();
  });

  it("keeps preparation anchor timeouts and a node behind the anchor distinct from reorgs", async () => {
    const runtime = driver("(ok true)");
    runtime.node.getTenureInfo.mockRejectedValueOnce(
      new chainClients.UpstreamUnavailableError("timeout"),
    );
    await expect(runtime.value.materialize(input())).rejects.toBeInstanceOf(
      chainClients.UpstreamUnavailableError,
    );
    runtime.node.getTenureInfo.mockResolvedValue({
      tip_block_id: indexBlockHash,
      tip_height: blockHeight - 1,
      reward_cycle: 141,
    });
    await expect(runtime.value.materialize(input())).rejects.toBeInstanceOf(
      chainClients.UpstreamUnavailableError,
    );
    expect(runtime.node.getNakamotoBlockById).not.toHaveBeenCalled();
  });

  it.each([
    null,
    200,
    408,
    429,
    503,
  ])("propagates an unavailable nonce/balance read for bounded retry (HTTP %s)", async (httpStatus) => {
    const runtime = driver("(ok true)");
    vi.spyOn(chainClients, "captureNodeChainAnchor").mockResolvedValue({ indexBlockHash } as never);
    runtime.reader.readAnchoredAccount.mockResolvedValue({
      status: "unavailable",
      httpStatus,
      reason: httpStatus === 200 ? "response-read-error" : "http-error",
    });
    await expect(runtime.value.materialize(input())).rejects.toBeInstanceOf(
      chainClients.UpstreamUnavailableError,
    );
  });

  it.each([
    { status: "schema-invalid", httpStatus: 200, reason: "unexpected-response" },
    { status: "unavailable", httpStatus: 401, reason: "http-error" },
  ])("does not classify invalid or unauthorized account evidence as transport recovery: %s", async (account) => {
    const runtime = driver("(ok true)");
    vi.spyOn(chainClients, "captureNodeChainAnchor").mockResolvedValue({ indexBlockHash } as never);
    runtime.reader.readAnchoredAccount.mockResolvedValue(account);
    expect(await runtime.value.materialize(input())).toMatchObject({ status: "halt" });
  });

  it.each(operations)("confirms %s from an API-located, node-proven block", async (operation) => {
    const runtime = driver("(ok true)");
    await expect(
      runtime.value.reconcile({
        run: {
          recipe: {
            chainId: 1,
            preparedAnchor: { stacksBlockHeight: blockHeight, indexBlockHash },
          },
        },
        child: { operation },
        plan: { material: { kind: operation } },
        txid: txId,
      } as never),
    ).resolves.toEqual({ status: "confirmed", blockHeight });
    expect(runtime.api.getTransactionDetails).toHaveBeenCalledWith(txId);
    expect(runtime.reader.lookupUnconfirmedTransaction).not.toHaveBeenCalled();
    expect(runtime.node.getNakamotoBlockById).toHaveBeenCalledTimes(1);
    expect(runtime.node.getNakamotoBlockAtHeight).toHaveBeenCalledTimes(1);
  });

  it("confirms calculate-rewards only when the API result matches the sealed target", async () => {
    const runtime = driver(
      "(ok (tuple (calculation-height u960240) (distribution-cycle u2) (stx-cycle u141)))",
    );
    await expect(
      runtime.value.reconcile({
        run: {
          recipe: {
            chainId: 1,
            preparedAnchor: { stacksBlockHeight: blockHeight, indexBlockHash },
          },
        },
        child: { operation: "calculate-rewards" },
        plan: {
          material: {
            kind: "calculate-rewards",
            targetRewardCycle: "141",
            expectedLastRewardComputeBurnHeight: 960_240,
          },
        },
        txid: txId,
      } as never),
    ).resolves.toEqual({ status: "confirmed", blockHeight });
  });

  it("does not confirm an API transaction the local canonical block does not contain", async () => {
    const runtime = driver("(ok true)", nakamotoBlockBytes(otherTransaction.serializeBytes()));
    await expect(
      runtime.value.reconcile({
        run: {
          recipe: {
            chainId: 1,
            preparedAnchor: { stacksBlockHeight: blockHeight, indexBlockHash },
          },
        },
        child: { operation: "claim-rewards" },
        plan: { material: { kind: "claim-rewards" } },
        txid: txId,
      } as never),
    ).resolves.toEqual({ status: "pending" });
    expect(runtime.reader.lookupUnconfirmedTransaction).toHaveBeenCalledWith(txId);
  });
});
