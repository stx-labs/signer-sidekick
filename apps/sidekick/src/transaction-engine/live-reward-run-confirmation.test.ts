import {
  deserializeTransaction,
  getAddressFromPublicKey,
  makeSTXTokenTransfer,
  privateKeyToPublic,
  TransactionSigner,
} from "@stacks/transactions";
import type { ConnectionAssessment } from "@stx-labs/signer-sidekick-api-contracts";
import { planRewardOperation } from "@stx-labs/signer-sidekick-protocol/reward-operation-plan";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as chainClients from "../chain-clients.js";
import {
  requireConnectedAssessment,
  requireObservationAssessment,
} from "../connection-assessment.js";
import { apiTransactionReceipt } from "../test-helpers/api-transaction.js";
import { nakamotoBlockBytes } from "../test-helpers/nakamoto-block.js";
import { LiveRewardRunDriver } from "./live-reward-run.js";
import type { LiveTransactionReader } from "./live-transaction-reader.js";
import type { RewardRunDriver } from "./reward-run-service.js";
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

function driver(
  resultRepr: string,
  blockBytes = nakamotoBlockBytes(transaction.serializeBytes()),
  assessment?: () => ConnectionAssessment,
) {
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
    getTransactionDetails: vi.fn(async () =>
      apiTransactionReceipt({ txId, blockHash, blockHeight, resultRepr }),
    ),
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
      runtimeContext: () => {
        if (assessment) requireConnectedAssessment(assessment());
        return {
          config: { nodeRpcUrl: "http://node:20443" },
          node,
          api,
        } as unknown as TransactionEngineRuntimeContext;
      },
      observationRuntimeContext: () => {
        if (assessment) requireObservationAssessment(assessment());
        return {
          config: { nodeRpcUrl: "http://node:20443" },
          node,
          api,
        } as unknown as TransactionEngineRuntimeContext;
      },
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

async function locallySignedInput(): Promise<Parameters<RewardRunDriver["reconcile"]>[0]> {
  const key = `${"11".repeat(32)}01`;
  const publicKey = privateKeyToPublic(key);
  const principal = getAddressFromPublicKey(publicKey, "testnet");
  const runId = "00000000-0000-4000-8000-000000000003";
  const recipeSha256 = "12".repeat(32);
  const plan = await planRewardOperation({
    authorization: { schemaVersion: 2, kind: "operator-run", runId, recipeSha256 },
    kind: "claim-rewards",
    network: { kind: "testnet", chainId: 0x80000000 },
    chainAnchor: { stacksBlockHeight: blockHeight, burnBlockHeight: 960240, indexBlockHash },
    sender: { principal, publicKey },
    managerSourceFingerprint: "34".repeat(32),
    managerContract: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.signer-manager",
    pox5Contract: "ST000000000000000000002AMW42H.pox-5",
    sbtcTokenContract: "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token",
    nonce: 9n,
    feeUstx: 1000n,
    rewardCycle: 141n,
    bondPeriods: [2n],
    expectedSbtcOutflow: 20000n,
  });
  const transaction = deserializeTransaction(plan.unsignedTransactionHex);
  new TransactionSigner(transaction).signOrigin(key);
  const txid = `0x${transaction.txid()}` as const;
  return {
    run: { runId, recipeSha256, walletPrincipal: principal, recipe: { chainId: 0x80000000 } },
    child: { operation: "claim-rewards", planSha256: plan.planSha256, failureReason: null, txid },
    plan,
    txid,
    signedAttempt: { precomputedTxid: txid, nonce: "9", feeUstx: "1000", state: "accepted" },
  } as Parameters<RewardRunDriver["reconcile"]>[0];
}

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
    runtime.api.getTransactionDetails.mockRejectedValue(
      new chainClients.UpstreamHttpError("not found", 404),
    );
    expect(await runtime.value.reconcile(input())).toEqual({ status: "pending" });
    expect(runtime.node.getTenureInfo).not.toHaveBeenCalled();
    expect(runtime.node.getNakamotoBlockById).not.toHaveBeenCalled();
    expect(runtime.api.getTransactionDetails).toHaveBeenCalledOnce();
  });

  it("does not load or revalidate the local signed plan without a terminal receipt", async () => {
    const runtime = driver("(ok true)");
    const submitted = await locallySignedInput();
    const loadPlan = vi.fn(() => {
      throw new Error("Pending observation must not load the plan");
    });
    Object.defineProperty(submitted, "plan", { get: loadPlan });
    runtime.api.getNodeInfo.mockResolvedValue({ network_id: 0x80000000 });
    runtime.api.getTransactionDetails.mockRejectedValue(
      new chainClients.UpstreamHttpError("missing", 404),
    );
    expect(await runtime.value.reconcile(submitted)).toEqual({ status: "pending" });
    expect(loadPlan).not.toHaveBeenCalled();
  });

  it.each([
    null,
    600_000,
  ])("requests read backoff for an unavailable API with hint %s", async (retryAfterMs) => {
    const runtime = driver("(ok true)");
    runtime.api.getTransactionDetails.mockRejectedValue(
      retryAfterMs === null
        ? new chainClients.UpstreamUnavailableError("offline")
        : new chainClients.RateLimitedError("limited", retryAfterMs),
    );
    expect(await runtime.value.reconcile(input())).toEqual({
      status: "pending",
      retryLater: true,
      ...(retryAfterMs !== null ? { retryAfterMs } : {}),
    });
    expect(runtime.node.getTenureInfo).not.toHaveBeenCalled();
  });

  it("does not complete a node-index result missing its anchored height", async () => {
    const runtime = driver("(ok true)");
    runtime.reader.lookupIndexedTransaction.mockResolvedValue({
      status: "observed",
      value: {
        isCanonical: true,
        blockHeight: null,
        resultRepr: "(ok true)",
      },
    } as never);
    expect(await runtime.value.reconcile(input())).toEqual({ status: "pending" });
    expect(runtime.api.getTransactionDetails).not.toHaveBeenCalled();
  });

  it.each([
    -1n,
    BigInt(Number.MAX_SAFE_INTEGER) + 1n,
  ])("does not publish an unsafe node receipt height %s", async (height) => {
    const runtime = driver("(ok true)");
    runtime.reader.lookupIndexedTransaction.mockResolvedValue({
      status: "observed",
      value: { isCanonical: true, blockHeight: height, resultRepr: "(ok true)" },
    } as never);
    expect(await runtime.value.reconcile(input())).toEqual({ status: "pending", retryLater: true });
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
    ).resolves.toEqual({ status: "confirmed", blockHeight, executionSource: "api-with-node" });
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
    ).resolves.toEqual({ status: "confirmed", blockHeight, executionSource: "api-with-node" });
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
    ).resolves.toEqual({
      status: "halt",
      reason: "Canonical transaction conflict: absent",
      requiresNodeCorroboration: true,
    });
    expect(runtime.reader.lookupUnconfirmedTransaction).not.toHaveBeenCalled();
  });

  it("completes a locally signed run with an unavailable assessment but keeps materialization and broadcast gated", async () => {
    let assessment = { status: "unavailable" } as ConnectionAssessment;
    const runtime = driver("(ok true)", undefined, () => assessment);
    const input = await locallySignedInput();
    runtime.api.getNodeInfo.mockResolvedValue({ network_id: input.run.recipe.chainId });
    runtime.api.getTransactionDetails.mockResolvedValue({
      ...(await runtime.api.getTransactionDetails()),
      tx_id: input.txid,
    });
    runtime.node.getTenureInfo.mockRejectedValue(
      new chainClients.UpstreamUnavailableError("node offline"),
    );
    runtime.reader.lookupIndexedTransaction.mockRejectedValue(
      new chainClients.UpstreamUnavailableError("index offline"),
    );
    expect(await runtime.value.reconcile(input)).toEqual({
      status: "confirmed",
      blockHeight,
      executionSource: "api",
    });
    await expect(runtime.value.materialize(input)).rejects.toBeInstanceOf(
      chainClients.UpstreamUnavailableError,
    );
    await expect(runtime.value.broadcast({} as never)).rejects.toBeInstanceOf(
      chainClients.UpstreamUnavailableError,
    );
    expect(runtime.reader.readAnchoredAccount).not.toHaveBeenCalled();
    assessment = { status: "blocked" } as ConnectionAssessment;
    runtime.api.getTransactionDetails.mockClear();
    await expect(runtime.value.reconcile(input)).rejects.toThrow("identity/network");
    expect(runtime.api.getTransactionDetails).not.toHaveBeenCalled();
  });

  it.each([
    "missing",
    "txid",
    "nonce",
    "fee",
    "rejected",
    "plan",
    "seal",
    "sender",
    "run",
    "recipe",
    "network",
    "prior-conflict",
    "operation",
    "child-txid",
  ])("does not accept API-only completion with a %s local binding defect", async (kind) => {
    const runtime = driver("(ok true)");
    const input = await locallySignedInput();
    runtime.api.getNodeInfo.mockResolvedValue({ network_id: input.run.recipe.chainId });
    runtime.api.getTransactionDetails.mockResolvedValue({
      ...(await runtime.api.getTransactionDetails()),
      tx_id: input.txid,
    });
    runtime.node.getTenureInfo.mockRejectedValue(
      new chainClients.UpstreamUnavailableError("offline"),
    );
    if (kind === "missing") delete input.signedAttempt;
    const attempt = input.signedAttempt;
    if (kind !== "missing" && !attempt) throw new Error("Missing fixture attempt");
    if (kind === "txid" && attempt) attempt.precomputedTxid = txId;
    if (kind === "nonce" && attempt) attempt.nonce = "10";
    if (kind === "fee" && attempt) attempt.feeUstx = "2000";
    if (kind === "rejected" && attempt) attempt.state = "rejected";
    if (kind === "plan") input.plan.unsignedTransactionHex = "00";
    if (kind === "seal") input.child.planSha256 = "00".repeat(32);
    if (kind === "sender") input.run.walletPrincipal = walletPrincipal;
    if (kind === "run") input.run.runId = "00000000-0000-4000-8000-000000000004";
    if (kind === "recipe") input.run.recipeSha256 = "00".repeat(32);
    if (kind === "network") input.run.recipe.chainId = 1;
    if (kind === "prior-conflict") input.child.failureReason = "Previous node disagreement";
    if (kind === "operation") input.child.operation = "calculate-rewards";
    if (kind === "child-txid") input.child.txid = txId;
    expect(await runtime.value.reconcile(input)).toEqual({ status: "pending", retryLater: true });
  });

  it("records a canonical API abort even when the optional external-completion read is unavailable", async () => {
    const runtime = driver("(err u32)");
    const input = await locallySignedInput();
    runtime.api.getNodeInfo.mockResolvedValue({ network_id: input.run.recipe.chainId });
    runtime.api.getTransactionDetails.mockResolvedValue({
      ...(await runtime.api.getTransactionDetails()),
      tx_id: input.txid,
      tx_status: "abort_by_response",
    });
    runtime.node.getTenureInfo.mockRejectedValue(
      new chainClients.UpstreamUnavailableError("offline"),
    );
    expect(await runtime.value.reconcile(input)).toEqual({
      status: "halt",
      reason: "Transaction aborted: (err u32)",
      executionSource: "api",
    });
  });
});
