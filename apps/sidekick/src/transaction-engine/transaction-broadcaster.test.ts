import { makeSTXTokenTransfer } from "@stacks/transactions";
import { describe, expect, it, vi } from "vitest";
import type { SignedRewardOperationTransaction } from "./gas-payer-signer.js";
import { NoRetryTransactionBroadcaster } from "./transaction-broadcaster.js";

async function signedAttempt(): Promise<SignedRewardOperationTransaction> {
  const transaction = await makeSTXTokenTransfer({
    recipient: "ST000000000000000000002AMW42H",
    amount: 1n,
    senderKey: `${"11".repeat(32)}01`,
    nonce: 7n,
    fee: 1_000n,
    network: "testnet",
  });
  const bytes = transaction.serializeBytes();
  return {
    kind: "signed-reward-operation",
    operationKind: "claim-staker-rewards",
    planSha256: "ab".repeat(32),
    unsignedTransactionSha256: "cd".repeat(32),
    precomputedTxid: `0x${transaction.txid()}`,
    nonce: "7",
    fee: "1000",
    get signedTransactionBytes() {
      return Uint8Array.from(bytes);
    },
    toJSON() {
      return {};
    },
  } as unknown as SignedRewardOperationTransaction;
}

describe("NoRetryTransactionBroadcaster", () => {
  it("submits exactly once and accepts only the precomputed txid", async () => {
    const attempt = await signedAttempt();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(attempt.precomputedTxid)));
    const broadcaster = new NoRetryTransactionBroadcaster({
      baseUrl: "https://node.example/",
      fetchImpl,
    });

    await expect(broadcaster.broadcast(attempt)).resolves.toEqual({
      status: "accepted",
      txid: attempt.precomputedTxid,
      httpStatus: 200,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, request] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://node.example/v2/transactions");
    expect(request).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
    });
    expect(Buffer.from(request?.body as Uint8Array)).toEqual(
      Buffer.from(attempt.signedTransactionBytes),
    );
  });

  it.each([
    [400, "BadNonce"],
    [409, "ConflictingNonceInMempool"],
    [422, "NotEnoughFunds"],
  ])("keeps nonce ownership unresolved for HTTP %i node rejection %s", async (status, message) => {
    const attempt = await signedAttempt();
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: message, reason_data: { expected: 8 } }), {
          status,
        }),
    );
    const result = await new NoRetryTransactionBroadcaster({
      baseUrl: "http://node.example",
      fetchImpl,
    }).broadcast(attempt);

    expect(result).toEqual({
      status: "ambiguous",
      txid: attempt.precomputedTxid,
      httpStatus: status,
      reason: "node-rejection",
      nodeMessage: message,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    "FeeTooLow",
    "NoSuchPublicFunction",
    "BadFunctionArgument",
  ])("classifies a bound HTTP 400 %s response as a deterministic rejection", async (reason) => {
    const attempt = await signedAttempt();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: "transaction rejected",
            reason,
            txid: attempt.precomputedTxid,
          }),
          { status: 400 },
        ),
    );

    await expect(
      new NoRetryTransactionBroadcaster({
        baseUrl: "http://node.example",
        fetchImpl,
      }).broadcast(attempt),
    ).resolves.toEqual({
      status: "deterministic-rejection",
      txid: attempt.precomputedTxid,
      httpStatus: 400,
      reason: "node-rejection",
      nodeMessage: reason,
    });
  });

  it.each([
    ["BadNonce", "nonce failures require reconciliation"],
    ["FeeTooLow", "a mismatched txid is not authoritative"],
    ["NotEnoughFunds", "funding can make the same signed bytes valid later"],
    ["NoSuchContract", "deployment can make the same signed bytes valid later"],
    ["ServerFailureDatabase", "server failures remain uncertain"],
  ])("keeps %s ambiguous when %s", async (reason, _description) => {
    const attempt = await signedAttempt();
    const txid = reason === "FeeTooLow" ? `0x${"aa".repeat(32)}` : attempt.precomputedTxid;
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "transaction rejected", reason, txid }), {
          status: 400,
        }),
    );

    await expect(
      new NoRetryTransactionBroadcaster({
        baseUrl: "http://node.example",
        fetchImpl,
      }).broadcast(attempt),
    ).resolves.toMatchObject({
      status: "ambiguous",
      txid: attempt.precomputedTxid,
      httpStatus: 400,
      reason: "node-rejection",
      nodeMessage: reason,
    });
  });

  it.each([500, 502, 503])("classifies HTTP %i as ambiguous without retrying", async (status) => {
    const attempt = await signedAttempt();
    const fetchImpl = vi.fn(async () => new Response("server error", { status }));
    const result = await new NoRetryTransactionBroadcaster({
      baseUrl: "http://node.example",
      fetchImpl,
    }).broadcast(attempt);

    expect(result).toEqual({
      status: "ambiguous",
      txid: attempt.precomputedTxid,
      httpStatus: status,
      reason: "server-error",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    [new DOMException("timed out", "TimeoutError"), "timeout"],
    [Object.assign(new Error("socket reset"), { code: "ECONNRESET" }), "connection-reset"],
    [new TypeError("fetch failed"), "transport-error"],
  ] as const)("classifies transport uncertainty as ambiguous", async (error, reason) => {
    const attempt = await signedAttempt();
    const fetchImpl = vi.fn(async () => {
      throw error;
    });
    const result = await new NoRetryTransactionBroadcaster({
      baseUrl: "http://node.example",
      fetchImpl,
    }).broadcast(attempt);

    expect(result).toEqual({
      status: "ambiguous",
      txid: attempt.precomputedTxid,
      httpStatus: null,
      reason,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats a malformed or mismatched success response as ambiguous acceptance", async () => {
    const attempt = await signedAttempt();
    for (const body of ["accepted", JSON.stringify(`0x${"ff".repeat(32)}`)]) {
      const fetchImpl = vi.fn(async () => new Response(body));
      await expect(
        new NoRetryTransactionBroadcaster({
          baseUrl: "http://node.example",
          fetchImpl,
        }).broadcast(attempt),
      ).resolves.toEqual({
        status: "ambiguous",
        txid: attempt.precomputedTxid,
        httpStatus: 200,
        reason: "invalid-success-response",
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects locally tampered signed bytes before making a network request", async () => {
    const attempt = await signedAttempt();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(attempt.precomputedTxid)));
    const tamperedBytes = attempt.signedTransactionBytes;
    tamperedBytes[10] = (tamperedBytes[10] ?? 0) ^ 1;
    const tampered = {
      ...attempt,
      signedTransactionBytes: tamperedBytes,
    } as unknown as SignedRewardOperationTransaction;

    await expect(
      new NoRetryTransactionBroadcaster({
        baseUrl: "http://node.example",
        fetchImpl,
      }).broadcast(tampered),
    ).resolves.toMatchObject({
      status: "deterministic-rejection",
      reason: "invalid-signed-attempt",
      httpStatus: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects unsafe endpoint and timeout configuration", () => {
    expect(
      () =>
        new NoRetryTransactionBroadcaster({
          baseUrl: "https://user:password@node.example",
        }),
    ).toThrow("without credentials");
    expect(() => new NoRetryTransactionBroadcaster({ baseUrl: "file:///tmp/node.socket" })).toThrow(
      "HTTP(S)",
    );
    expect(
      () => new NoRetryTransactionBroadcaster({ baseUrl: "https://node.example", timeoutMs: 0 }),
    ).toThrow("timeout");
  });
});
