import {
  Cl,
  deserializeTransaction,
  estimateTransactionByteLength,
  getAddressFromPublicKey,
  makeUnsignedContractCall,
  PostConditionMode,
  privateKeyToPublic,
  serializePayloadBytes,
  TransactionSigner,
  txidFromBytes,
} from "@stacks/transactions";
import { describe, expect, it, vi } from "vitest";
import {
  LiveTransactionReader,
  type LiveTransactionReaderInputError,
} from "./live-transaction-reader.js";

const privateKey = `${"11".repeat(32)}01`;
const publicKey = privateKeyToPublic(privateKey);
const principal = getAddressFromPublicKey(publicKey, "testnet");
const indexBlockHash = `0x${"ab".repeat(32)}`;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function feeResponse() {
  return {
    estimated_cost: {
      read_count: 1,
      read_length: 2,
      runtime: 3,
      write_count: 4,
      write_length: 5,
    },
    estimated_cost_scalar: 6,
    estimations: [
      { fee_rate: 1.25, fee: 175 },
      { fee_rate: 2.5, fee: 350 },
      { fee_rate: 5, fee: 700 },
    ],
    cost_scalar_change_by_byte: 0.5,
  };
}

async function unsignedContractCall(signingPrivateKey = privateKey) {
  return makeUnsignedContractCall({
    contractAddress: "ST000000000000000000002AMW42H",
    contractName: "pox-5",
    functionName: "get-status",
    functionArgs: [Cl.uint(1)],
    publicKey: privateKeyToPublic(signingPrivateKey),
    fee: 1_000n,
    nonce: 7n,
    network: "testnet",
    postConditionMode: PostConditionMode.Deny,
    postConditions: [],
  });
}

async function signedTransactionFixture() {
  const transaction = await unsignedContractCall();
  new TransactionSigner(transaction).signOrigin(privateKey);
  const bytes = transaction.serializeBytes();
  return {
    bytes,
    hex: Buffer.from(bytes).toString("hex"),
    txid: `0x${txidFromBytes(bytes)}` as `0x${string}`,
  };
}

function reader(fetchImpl: typeof fetch, maxResponseBytes?: number): LiveTransactionReader {
  return new LiveTransactionReader({
    baseUrl: "http://node.internal:20443/",
    fetchImpl,
    ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
  });
}

async function expectInputError(
  run: () => Promise<unknown>,
  code: LiveTransactionReaderInputError["code"],
) {
  try {
    await run();
  } catch (error) {
    expect(error).toMatchObject({ name: "LiveTransactionReaderInputError", code });
    return;
  }
  throw new Error(`Expected input error ${code}`);
}

describe("LiveTransactionReader account and fee observations", () => {
  it("reads balance and nonce at the exact anchored account endpoint", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(
        `http://node.internal:20443/v2/accounts/${principal}?proof=0&tip=${indexBlockHash.slice(2)}`,
      );
      expect(init).toMatchObject({ method: "GET", headers: { accept: "application/json" } });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse({
        balance: `0x${"00".repeat(8)}0000000100000000`,
        locked: `0x${"00".repeat(15)}05`,
        unlock_height: 4_200,
        nonce: 7,
      });
    });

    await expect(reader(fetchImpl).readAnchoredAccount(principal, indexBlockHash)).resolves.toEqual(
      {
        status: "observed",
        httpStatus: 200,
        value: {
          principal,
          indexBlockHash,
          balanceUstx: 4_294_967_296n,
          lockedUstx: 5n,
          unlockHeight: 4_200n,
          nonce: 7n,
        },
      },
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    {
      balance: "0x01",
      locked: `0x${"00".repeat(16)}`,
      unlock_height: 0,
      nonce: 0,
    },
    {
      balance: `0x${"00".repeat(16)}`,
      locked: `0x${"00".repeat(16)}`,
      unlock_height: 0,
      nonce: 9_007_199_254_740_992,
    },
    {
      balance: `0x${"00".repeat(16)}`,
      locked: `0x${"00".repeat(16)}`,
      unlock_height: 0,
      nonce: 0,
      nonce_proof: "must-be-absent-when-proof-is-zero",
    },
  ])("fails closed on malformed or lossy account data", async (body) => {
    const fetchImpl = vi.fn(async () => jsonResponse(body));

    await expect(reader(fetchImpl).readAnchoredAccount(principal, indexBlockHash)).resolves.toEqual(
      {
        status: "schema-invalid",
        httpStatus: 200,
        reason: "unexpected-response",
      },
    );
  });

  it("derives the official fee payload and final byte length from the unsigned transaction", async () => {
    const transaction = await unsignedContractCall();
    const unsignedTransactionHex = transaction.serialize();
    const roundTrip = deserializeTransaction(unsignedTransactionHex);
    const expectedPayload = Buffer.from(serializePayloadBytes(roundTrip.payload)).toString("hex");
    const expectedLength = estimateTransactionByteLength(roundTrip);
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("http://node.internal:20443/v2/fees/transaction");
      expect(init).toMatchObject({
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        transaction_payload: expectedPayload,
        estimated_len: expectedLength,
      });
      return jsonResponse(feeResponse());
    });

    await expect(
      reader(fetchImpl).estimateUnsignedTransactionFee(unsignedTransactionHex),
    ).resolves.toEqual({
      status: "observed",
      httpStatus: 200,
      value: {
        transactionPayloadHex: expectedPayload,
        estimatedFinalByteLength: expectedLength,
        estimatedCost: {
          readCount: 1n,
          readLength: 2n,
          runtime: 3n,
          writeCount: 4n,
          writeLength: 5n,
        },
        estimatedCostScalar: 6n,
        costScalarChangeByByte: 0.5,
        estimates: {
          low: { feeRate: 1.25, feeUstx: 175n },
          middle: { feeRate: 2.5, feeUstx: 350n },
          high: { feeRate: 5, feeUstx: 700n },
        },
      },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns one unavailable fee observation without a transfer-fee fallback", async () => {
    const transaction = await unsignedContractCall();
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          error: "Estimator error",
          reason: "NoEstimateAvailable",
          reason_data: { message: "No estimate is available" },
        },
        400,
      ),
    );

    await expect(
      reader(fetchImpl).estimateUnsignedTransactionFee(transaction.serialize()),
    ).resolves.toEqual({ status: "unavailable", httpStatus: 400, reason: "http-error" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0]?.[0])).toMatch(/\/v2\/fees\/transaction$/);
  });

  it.each([
    { ...feeResponse(), estimations: feeResponse().estimations.slice(0, 2) },
    {
      ...feeResponse(),
      estimations: [
        ...feeResponse().estimations.slice(0, 2),
        { fee_rate: 5, fee: 9_007_199_254_740_992 },
      ],
    },
    { ...feeResponse(), undocumented: true },
  ])("rejects incomplete, unsafe, or widened fee estimates", async (body) => {
    const transaction = await unsignedContractCall();
    const fetchImpl = vi.fn(async () => jsonResponse(body));

    await expect(
      reader(fetchImpl).estimateUnsignedTransactionFee(transaction.serialize()),
    ).resolves.toEqual({
      status: "schema-invalid",
      httpStatus: 200,
      reason: "unexpected-response",
    });
  });

  it("rejects signed or non-canonical fee inputs before any network call", async () => {
    const signed = await signedTransactionFixture();
    const fetchImpl = vi.fn();

    await expectInputError(
      () => reader(fetchImpl).estimateUnsignedTransactionFee(signed.hex),
      "invalid-unsigned-transaction",
    );
    await expectInputError(
      () => reader(fetchImpl).estimateUnsignedTransactionFee(signed.hex.toUpperCase()),
      "invalid-unsigned-transaction",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("LiveTransactionReader recovery lookups", () => {
  it("reads one exact mempool observation and exposes its nonce and fee", async () => {
    const transaction = await signedTransactionFixture();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe(
        `http://node.internal:20443/v2/transactions/unconfirmed/${transaction.txid.slice(2)}`,
      );
      return jsonResponse({ tx: transaction.hex, status: "Mempool" });
    });

    await expect(reader(fetchImpl).lookupUnconfirmedTransaction(transaction.txid)).resolves.toEqual(
      {
        status: "observed",
        httpStatus: 200,
        value: {
          txid: transaction.txid,
          transactionHex: transaction.hex,
          nonce: 7n,
          feeUstx: 1_000n,
          location: { kind: "mempool" },
        },
      },
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("parses the official externally-tagged microblock status", async () => {
    const transaction = await signedTransactionFixture();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        tx: transaction.hex,
        status: { Microblock: { block_hash: "cd".repeat(32), seq: 12 } },
      }),
    );

    await expect(
      reader(fetchImpl).lookupUnconfirmedTransaction(transaction.txid),
    ).resolves.toMatchObject({
      status: "observed",
      value: {
        location: { kind: "microblock", blockHash: `0x${"cd".repeat(32)}`, sequence: 12 },
      },
    });
  });

  it("distinguishes an absent mempool transaction from an unavailable observation", async () => {
    const transaction = await signedTransactionFixture();
    const notFound = vi.fn(async () => new Response("Not found", { status: 404 }));
    const unavailable = vi.fn(async () => {
      throw new DOMException("secret endpoint timed out", "TimeoutError");
    });

    await expect(reader(notFound).lookupUnconfirmedTransaction(transaction.txid)).resolves.toEqual({
      status: "not-found",
      httpStatus: 404,
    });
    const unavailableResult = await reader(unavailable).lookupUnconfirmedTransaction(
      transaction.txid,
    );
    expect(unavailableResult).toEqual({
      status: "unavailable",
      httpStatus: null,
      reason: "timeout",
    });
    expect(JSON.stringify(unavailableResult)).not.toContain("secret endpoint");
    expect(notFound).toHaveBeenCalledOnce();
    expect(unavailable).toHaveBeenCalledOnce();
  });

  it("rejects a mempool response whose transaction does not match the requested txid", async () => {
    const requested = await signedTransactionFixture();
    const otherPrivateKey = `${"22".repeat(32)}01`;
    const other = await unsignedContractCall(otherPrivateKey);
    new TransactionSigner(other).signOrigin(otherPrivateKey);
    const otherHex = other.serialize();
    const fetchImpl = vi.fn(async () => jsonResponse({ tx: otherHex, status: "Mempool" }));

    await expect(reader(fetchImpl).lookupUnconfirmedTransaction(requested.txid)).resolves.toEqual({
      status: "schema-invalid",
      httpStatus: 200,
      reason: "transaction-mismatch",
    });
  });

  it("reads canonical block identity and height from the indexed node transaction", async () => {
    const transaction = await signedTransactionFixture();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe(
        `http://node.internal:20443/v3/transaction/${transaction.txid.slice(2)}`,
      );
      return jsonResponse({
        index_block_hash: "ef".repeat(32),
        tx: transaction.hex,
        result: "(ok true)",
        block_height: 9_001,
        is_canonical: true,
      });
    });

    await expect(reader(fetchImpl).lookupIndexedTransaction(transaction.txid)).resolves.toEqual({
      status: "observed",
      httpStatus: 200,
      value: {
        txid: transaction.txid,
        transactionHex: transaction.hex,
        nonce: 7n,
        feeUstx: 1_000n,
        indexBlockHash: `0x${"ef".repeat(32)}`,
        blockHeight: 9_001n,
        isCanonical: true,
        resultRepr: "(ok true)",
      },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    [404, { status: "not-found", httpStatus: 404 }],
    [501, { status: "unavailable", httpStatus: 501, reason: "transaction-index-unavailable" }],
    [503, { status: "unavailable", httpStatus: 503, reason: "http-error" }],
  ] as const)("classifies indexed lookup HTTP %i without retry", async (status, expected) => {
    const transaction = await signedTransactionFixture();
    const fetchImpl = vi.fn(async () => new Response("sanitized by the reader", { status }));

    await expect(reader(fetchImpl).lookupIndexedTransaction(transaction.txid)).resolves.toEqual(
      expected,
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("distinguishes malformed indexed data from not-found and unavailable", async () => {
    const transaction = await signedTransactionFixture();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        index_block_hash: "ef".repeat(32),
        tx: transaction.hex,
        result: "(ok true)",
        block_height: 9_001,
      }),
    );

    await expect(reader(fetchImpl).lookupIndexedTransaction(transaction.txid)).resolves.toEqual({
      status: "schema-invalid",
      httpStatus: 200,
      reason: "unexpected-response",
    });
  });
});

describe("LiveTransactionReader transport boundaries", () => {
  it("bounds success bodies before JSON parsing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ padding: "x".repeat(256) }));

    await expect(
      reader(fetchImpl, 64).readAnchoredAccount(principal, indexBlockHash),
    ).resolves.toEqual({ status: "schema-invalid", httpStatus: 200, reason: "body-too-large" });
  });

  it("requires JSON content type on successful node responses", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));

    await expect(reader(fetchImpl).readAnchoredAccount(principal, indexBlockHash)).resolves.toEqual(
      {
        status: "schema-invalid",
        httpStatus: 200,
        reason: "unexpected-content-type",
      },
    );
  });

  it("rejects credential-bearing URLs and unsafe local inputs without echoing them", async () => {
    for (const baseUrl of [
      "http://operator:secret@node.internal:20443",
      "http://node.internal:20443?token=secret",
      "file:///secret/node.socket",
    ]) {
      expect(() => new LiveTransactionReader({ baseUrl })).toThrowError(
        expect.objectContaining({
          name: "LiveTransactionReaderInputError",
          code: "invalid-configuration",
        }),
      );
      try {
        new LiveTransactionReader({ baseUrl });
      } catch (error) {
        expect(String(error)).not.toContain("secret");
      }
    }

    const fetchImpl = vi.fn();
    await expectInputError(
      () => reader(fetchImpl).readAnchoredAccount("not-a-principal", indexBlockHash),
      "invalid-principal",
    );
    await expectInputError(
      () => reader(fetchImpl).lookupIndexedTransaction("0x1234"),
      "invalid-txid",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bounds timeout and response-limit configuration", () => {
    expect(
      () =>
        new LiveTransactionReader({
          baseUrl: "https://node.internal",
          timeoutMs: 0,
        }),
    ).toThrow("timeout");
    expect(
      () =>
        new LiveTransactionReader({
          baseUrl: "https://node.internal",
          maxResponseBytes: 8 * 1024 * 1024 + 1,
        }),
    ).toThrow("response limit");
  });
});
