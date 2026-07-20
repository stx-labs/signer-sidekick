import {
  AuthType,
  deserializeTransaction,
  estimateTransactionByteLength,
  isSingleSig,
  PayloadType,
  serializePayloadBytes,
  txidFromBytes,
  validateStacksAddress,
} from "@stacks/transactions";
import { z } from "zod";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface LiveTransactionReaderOptions {
  baseUrl: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: Fetch;
}

export type LiveReadUnavailableReason =
  | "timeout"
  | "connection-reset"
  | "transport-error"
  | "response-read-error"
  | "http-error"
  | "transaction-index-unavailable";

export type LiveReadSchemaReason =
  | "body-too-large"
  | "invalid-utf8"
  | "unexpected-content-type"
  | "invalid-json"
  | "unexpected-response"
  | "invalid-transaction"
  | "transaction-mismatch";

export interface LiveReadUnavailable {
  status: "unavailable";
  httpStatus: number | null;
  reason: LiveReadUnavailableReason;
}

export interface LiveReadSchemaInvalid {
  status: "schema-invalid";
  httpStatus: number;
  reason: LiveReadSchemaReason;
}

export interface LiveReadObserved<Value> {
  status: "observed";
  httpStatus: number;
  value: Value;
}

export interface LiveReadNotFound {
  status: "not-found";
  httpStatus: 404;
}

export type LiveObservation<Value> =
  | LiveReadObserved<Value>
  | LiveReadUnavailable
  | LiveReadSchemaInvalid;

export type LiveLookup<Value> = LiveObservation<Value> | LiveReadNotFound;

export interface AnchoredAccountObservation {
  principal: string;
  indexBlockHash: `0x${string}`;
  balanceUstx: bigint;
  lockedUstx: bigint;
  unlockHeight: bigint;
  nonce: bigint;
}

export interface TransactionFeeEstimate {
  feeRate: number;
  feeUstx: bigint;
}

export interface TransactionFeeObservation {
  transactionPayloadHex: string;
  estimatedFinalByteLength: number;
  estimatedCost: {
    readCount: bigint;
    readLength: bigint;
    runtime: bigint;
    writeCount: bigint;
    writeLength: bigint;
  };
  estimatedCostScalar: bigint;
  costScalarChangeByByte: number;
  estimates: {
    low: TransactionFeeEstimate;
    middle: TransactionFeeEstimate;
    high: TransactionFeeEstimate;
  };
}

interface ObservedTransaction {
  txid: `0x${string}`;
  transactionHex: string;
  nonce: bigint;
  feeUstx: bigint;
}

export interface UnconfirmedTransactionObservation extends ObservedTransaction {
  location:
    | { kind: "mempool" }
    | {
        kind: "microblock";
        blockHash: `0x${string}`;
        sequence: number;
      };
}

export interface IndexedTransactionObservation extends ObservedTransaction {
  indexBlockHash: `0x${string}`;
  blockHeight: bigint | null;
  isCanonical: boolean;
  resultRepr: string;
}

export type LiveTransactionReaderInputErrorCode =
  | "invalid-configuration"
  | "invalid-principal"
  | "invalid-index-block-hash"
  | "invalid-txid"
  | "invalid-unsigned-transaction";

/** A redacted local-input error; values and endpoint URLs are deliberately omitted. */
export class LiveTransactionReaderInputError extends TypeError {
  constructor(
    readonly code: LiveTransactionReaderInputErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LiveTransactionReaderInputError";
  }
}

const defaultTimeoutMs = 10_000;
const defaultMaxResponseBytes = 512 * 1024;
const maximumResponseBytes = 8 * 1024 * 1024;
const maximumUnsignedTransactionBytes = 256 * 1024;
const emptyRecoverableSignature = "00".repeat(65);
const prefixedHashPattern = /^0x[0-9a-f]{64}$/i;
const wireHashPattern = /^[0-9a-f]{64}$/;
const wireHexPattern = /^(?:[0-9a-f]{2})+$/;
const jsonContentTypePattern = /^application\/json(?:\s*;|$)/i;

const safeUnsignedIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, "Unsafe integer");
const finiteNonnegativeSchema = z.number().finite().nonnegative();
const u128HexSchema = z.string().regex(/^0x[0-9a-f]{32}$/);

const accountSchema = z
  .object({
    balance: u128HexSchema,
    locked: u128HexSchema,
    unlock_height: safeUnsignedIntegerSchema,
    nonce: safeUnsignedIntegerSchema,
  })
  .strict();

const executionCostSchema = z
  .object({
    read_count: safeUnsignedIntegerSchema,
    read_length: safeUnsignedIntegerSchema,
    runtime: safeUnsignedIntegerSchema,
    write_count: safeUnsignedIntegerSchema,
    write_length: safeUnsignedIntegerSchema,
  })
  .strict();

const feeEstimateSchema = z
  .object({
    fee_rate: finiteNonnegativeSchema,
    fee: safeUnsignedIntegerSchema,
  })
  .strict();

const feeResponseSchema = z
  .object({
    estimated_cost: executionCostSchema,
    estimated_cost_scalar: safeUnsignedIntegerSchema,
    estimations: z.tuple([feeEstimateSchema, feeEstimateSchema, feeEstimateSchema]),
    cost_scalar_change_by_byte: finiteNonnegativeSchema,
  })
  .strict();

const unconfirmedResponseSchema = z
  .object({
    tx: z.string().regex(wireHexPattern),
    status: z.union([
      z.literal("Mempool"),
      z
        .object({
          Microblock: z
            .object({
              block_hash: z.string().regex(wireHashPattern),
              seq: z.number().int().min(0).max(65_535),
            })
            .strict(),
        })
        .strict(),
    ]),
  })
  .strict();

const indexedTransactionResponseSchema = z
  .object({
    index_block_hash: z.string().regex(wireHashPattern),
    tx: z.string().regex(wireHexPattern),
    result: z.string().min(1),
    block_height: safeUnsignedIntegerSchema.nullable(),
    is_canonical: z.boolean(),
  })
  .strict();

type WireReadResult =
  | { status: "body"; httpStatus: number; body: string }
  | LiveReadUnavailable
  | LiveReadSchemaInvalid
  | LiveReadNotFound;

function inputError(
  code: LiveTransactionReaderInputErrorCode,
  message: string,
): LiveTransactionReaderInputError {
  return new LiveTransactionReaderInputError(code, message);
}

function canonicalPrefixedHash(
  value: string,
  code: "invalid-index-block-hash" | "invalid-txid",
): `0x${string}` {
  const normalized = value.toLowerCase();
  if (!prefixedHashPattern.test(normalized)) {
    throw inputError(
      code,
      code === "invalid-txid" ? "Invalid transaction ID" : "Invalid index block hash",
    );
  }
  return normalized as `0x${string}`;
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") return code;
  const cause = (error as { cause?: unknown }).cause;
  return cause === error ? null : errorCode(cause);
}

function unavailableReason(error: unknown): LiveReadUnavailableReason {
  const name = error && typeof error === "object" ? (error as { name?: unknown }).name : null;
  const code = errorCode(error);
  if (
    name === "AbortError" ||
    name === "TimeoutError" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT"
  ) {
    return "timeout";
  }
  if (
    code === "ECONNRESET" ||
    code === "ECONNABORTED" ||
    code === "EPIPE" ||
    code === "UND_ERR_SOCKET"
  ) {
    return "connection-reset";
  }
  return "transport-error";
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort connection hygiene; the caller receives only a sanitized classification.
  }
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
): Promise<
  | { status: "body"; body: string }
  | { status: "unavailable"; reason: LiveReadUnavailableReason }
  | { status: "schema-invalid"; reason: "body-too-large" | "invalid-utf8" }
> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength &&
    /^\d+$/.test(contentLength) &&
    BigInt(contentLength) > BigInt(maximumBytes)
  ) {
    await cancelResponse(response);
    return { status: "schema-invalid", reason: "body-too-large" };
  }
  if (!response.body) return { status: "body", body: "" };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel();
        return { status: "schema-invalid", reason: "body-too-large" };
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // The response stream already failed.
    }
    const reason = unavailableReason(error);
    return {
      status: "unavailable",
      reason: reason === "transport-error" ? "response-read-error" : reason,
    };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { status: "body", body: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { status: "schema-invalid", reason: "invalid-utf8" };
  }
}

function parseJson<Value>(
  body: string,
  schema: z.ZodType<Value>,
  httpStatus: number,
): LiveReadObserved<Value> | LiveReadSchemaInvalid {
  let decoded: unknown;
  try {
    decoded = JSON.parse(body) as unknown;
  } catch {
    return { status: "schema-invalid", httpStatus, reason: "invalid-json" };
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    return { status: "schema-invalid", httpStatus, reason: "unexpected-response" };
  }
  return { status: "observed", httpStatus, value: parsed.data };
}

function unsignedFeeMaterial(unsignedTransactionHex: string): {
  transactionPayloadHex: string;
  estimatedFinalByteLength: number;
} {
  if (
    unsignedTransactionHex.length === 0 ||
    unsignedTransactionHex.length > maximumUnsignedTransactionBytes * 2 ||
    !wireHexPattern.test(unsignedTransactionHex)
  ) {
    throw inputError(
      "invalid-unsigned-transaction",
      "Unsigned transaction must be bounded canonical lowercase hex",
    );
  }
  try {
    const bytes = Uint8Array.from(Buffer.from(unsignedTransactionHex, "hex"));
    const transaction = deserializeTransaction(bytes);
    if (Buffer.from(transaction.serializeBytes()).toString("hex") !== unsignedTransactionHex) {
      throw new Error("non-canonical transaction");
    }
    if (
      transaction.auth.authType !== AuthType.Standard ||
      !isSingleSig(transaction.auth.spendingCondition) ||
      transaction.auth.spendingCondition.signature.data !== emptyRecoverableSignature ||
      transaction.payload.payloadType !== PayloadType.ContractCall
    ) {
      throw new Error("unsupported transaction");
    }
    const estimatedFinalByteLength = estimateTransactionByteLength(transaction);
    if (!Number.isSafeInteger(estimatedFinalByteLength) || estimatedFinalByteLength <= 0) {
      throw new Error("invalid final length");
    }
    return {
      transactionPayloadHex: Buffer.from(serializePayloadBytes(transaction.payload)).toString(
        "hex",
      ),
      estimatedFinalByteLength,
    };
  } catch (error) {
    if (error instanceof LiveTransactionReaderInputError) throw error;
    throw inputError(
      "invalid-unsigned-transaction",
      "Unsigned transaction must be one canonical standard contract call with an empty signature",
    );
  }
}

function parseObservedTransaction(
  transactionHex: string,
  expectedTxid: `0x${string}`,
):
  | { status: "observed"; value: ObservedTransaction }
  | { status: "schema-invalid"; reason: "invalid-transaction" | "transaction-mismatch" } {
  try {
    const bytes = Uint8Array.from(Buffer.from(transactionHex, "hex"));
    const transaction = deserializeTransaction(bytes);
    if (
      transaction.auth.authType !== AuthType.Standard ||
      Buffer.from(transaction.serializeBytes()).toString("hex") !== transactionHex
    ) {
      return { status: "schema-invalid", reason: "invalid-transaction" };
    }
    transaction.verifyOrigin();
    if (`0x${txidFromBytes(bytes)}` !== expectedTxid) {
      return { status: "schema-invalid", reason: "transaction-mismatch" };
    }
    return {
      status: "observed",
      value: {
        txid: expectedTxid,
        transactionHex,
        nonce: transaction.auth.spendingCondition.nonce,
        feeUstx: transaction.auth.spendingCondition.fee,
      },
    };
  } catch {
    return { status: "schema-invalid", reason: "invalid-transaction" };
  }
}

function feeEstimate(value: z.infer<typeof feeEstimateSchema>): TransactionFeeEstimate {
  return { feeRate: value.fee_rate, feeUstx: BigInt(value.fee) };
}

/**
 * One-shot Stacks Core reads for Assist planning and recovery. The client deliberately performs no
 * retries: each result represents one bounded observation that the durable orchestrator can record.
 */
export class LiveTransactionReader {
  readonly #baseUrl: URL;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #fetchImpl: Fetch;

  constructor(options: LiveTransactionReaderOptions) {
    let baseUrl: URL;
    try {
      baseUrl = new URL(options.baseUrl);
    } catch {
      throw inputError("invalid-configuration", "Transaction reader requires a valid node URL");
    }
    if (
      (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") ||
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.search ||
      baseUrl.hash
    ) {
      throw inputError(
        "invalid-configuration",
        "Transaction reader requires an HTTP(S) node URL without credentials, query, or fragment",
      );
    }
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
      throw inputError(
        "invalid-configuration",
        "Transaction reader timeout must be between 1 and 120000 milliseconds",
      );
    }
    const maxResponseBytes = options.maxResponseBytes ?? defaultMaxResponseBytes;
    if (
      !Number.isSafeInteger(maxResponseBytes) ||
      maxResponseBytes <= 0 ||
      maxResponseBytes > maximumResponseBytes
    ) {
      throw inputError(
        "invalid-configuration",
        "Transaction reader response limit must be between 1 and 8388608 bytes",
      );
    }
    baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, "");
    this.#baseUrl = baseUrl;
    this.#timeoutMs = timeoutMs;
    this.#maxResponseBytes = maxResponseBytes;
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  #endpoint(path: string): URL {
    const endpoint = new URL(this.#baseUrl);
    endpoint.pathname = `${this.#baseUrl.pathname.replace(/\/+$/, "")}${path}`;
    return endpoint;
  }

  async #read(
    endpoint: URL,
    init: RequestInit,
    options: { notFound?: boolean; transactionIndex?: boolean } = {},
  ): Promise<WireReadResult> {
    let response: Response;
    try {
      response = await this.#fetchImpl(endpoint.toString(), {
        ...init,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      return { status: "unavailable", httpStatus: null, reason: unavailableReason(error) };
    }

    if (!response.ok) {
      await cancelResponse(response);
      if (options.notFound && response.status === 404) {
        return { status: "not-found", httpStatus: 404 };
      }
      return {
        status: "unavailable",
        httpStatus: response.status,
        reason:
          options.transactionIndex && response.status === 501
            ? "transaction-index-unavailable"
            : "http-error",
      };
    }

    const contentType = response.headers.get("content-type");
    if (!contentType || !jsonContentTypePattern.test(contentType)) {
      await cancelResponse(response);
      return {
        status: "schema-invalid",
        httpStatus: response.status,
        reason: "unexpected-content-type",
      };
    }
    const body = await readBoundedBody(response, this.#maxResponseBytes);
    if (body.status === "unavailable") {
      return {
        status: "unavailable",
        httpStatus: response.status,
        reason: body.reason,
      };
    }
    if (body.status === "schema-invalid") {
      return { status: "schema-invalid", httpStatus: response.status, reason: body.reason };
    }
    return { status: "body", httpStatus: response.status, body: body.body };
  }

  async readAnchoredAccount(
    principal: string,
    indexBlockHash: string,
  ): Promise<LiveObservation<AnchoredAccountObservation>> {
    if (!principal || principal.includes(".") || !validateStacksAddress(principal)) {
      throw inputError("invalid-principal", "Transaction reader requires an account principal");
    }
    const tip = canonicalPrefixedHash(indexBlockHash, "invalid-index-block-hash");
    const endpoint = this.#endpoint(`/v2/accounts/${encodeURIComponent(principal)}`);
    endpoint.searchParams.set("proof", "0");
    endpoint.searchParams.set("tip", tip.slice(2));
    const wire = await this.#read(endpoint, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (wire.status !== "body") return wire as LiveObservation<AnchoredAccountObservation>;
    const parsed = parseJson(wire.body, accountSchema, wire.httpStatus);
    if (parsed.status !== "observed") return parsed;
    return {
      status: "observed",
      httpStatus: wire.httpStatus,
      value: {
        principal,
        indexBlockHash: tip,
        balanceUstx: BigInt(parsed.value.balance),
        lockedUstx: BigInt(parsed.value.locked),
        unlockHeight: BigInt(parsed.value.unlock_height),
        nonce: BigInt(parsed.value.nonce),
      },
    };
  }

  async estimateUnsignedTransactionFee(
    unsignedTransactionHex: string,
  ): Promise<LiveObservation<TransactionFeeObservation>> {
    const material = unsignedFeeMaterial(unsignedTransactionHex);
    const endpoint = this.#endpoint("/v2/fees/transaction");
    const wire = await this.#read(endpoint, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        transaction_payload: material.transactionPayloadHex,
        estimated_len: material.estimatedFinalByteLength,
      }),
    });
    if (wire.status !== "body") return wire as LiveObservation<TransactionFeeObservation>;
    const parsed = parseJson(wire.body, feeResponseSchema, wire.httpStatus);
    if (parsed.status !== "observed") return parsed;
    const [low, middle, high] = parsed.value.estimations;
    return {
      status: "observed",
      httpStatus: wire.httpStatus,
      value: {
        ...material,
        estimatedCost: {
          readCount: BigInt(parsed.value.estimated_cost.read_count),
          readLength: BigInt(parsed.value.estimated_cost.read_length),
          runtime: BigInt(parsed.value.estimated_cost.runtime),
          writeCount: BigInt(parsed.value.estimated_cost.write_count),
          writeLength: BigInt(parsed.value.estimated_cost.write_length),
        },
        estimatedCostScalar: BigInt(parsed.value.estimated_cost_scalar),
        costScalarChangeByByte: parsed.value.cost_scalar_change_by_byte,
        estimates: {
          low: feeEstimate(low),
          middle: feeEstimate(middle),
          high: feeEstimate(high),
        },
      },
    };
  }

  async lookupUnconfirmedTransaction(
    txid: string,
  ): Promise<LiveLookup<UnconfirmedTransactionObservation>> {
    const canonicalTxid = canonicalPrefixedHash(txid, "invalid-txid");
    const endpoint = this.#endpoint(`/v2/transactions/unconfirmed/${canonicalTxid.slice(2)}`);
    const wire = await this.#read(
      endpoint,
      { method: "GET", headers: { accept: "application/json" } },
      { notFound: true },
    );
    if (wire.status !== "body") return wire as LiveLookup<UnconfirmedTransactionObservation>;
    const parsed = parseJson(wire.body, unconfirmedResponseSchema, wire.httpStatus);
    if (parsed.status !== "observed") return parsed;
    const transaction = parseObservedTransaction(parsed.value.tx, canonicalTxid);
    if (transaction.status !== "observed") {
      return {
        status: "schema-invalid",
        httpStatus: wire.httpStatus,
        reason: transaction.reason,
      };
    }
    return {
      status: "observed",
      httpStatus: wire.httpStatus,
      value: {
        ...transaction.value,
        location:
          parsed.value.status === "Mempool"
            ? { kind: "mempool" }
            : {
                kind: "microblock",
                blockHash: `0x${parsed.value.status.Microblock.block_hash}`,
                sequence: parsed.value.status.Microblock.seq,
              },
      },
    };
  }

  async lookupIndexedTransaction(txid: string): Promise<LiveLookup<IndexedTransactionObservation>> {
    const canonicalTxid = canonicalPrefixedHash(txid, "invalid-txid");
    const endpoint = this.#endpoint(`/v3/transaction/${canonicalTxid.slice(2)}`);
    const wire = await this.#read(
      endpoint,
      { method: "GET", headers: { accept: "application/json" } },
      { notFound: true, transactionIndex: true },
    );
    if (wire.status !== "body") return wire as LiveLookup<IndexedTransactionObservation>;
    const parsed = parseJson(wire.body, indexedTransactionResponseSchema, wire.httpStatus);
    if (parsed.status !== "observed") return parsed;
    const transaction = parseObservedTransaction(parsed.value.tx, canonicalTxid);
    if (transaction.status !== "observed") {
      return {
        status: "schema-invalid",
        httpStatus: wire.httpStatus,
        reason: transaction.reason,
      };
    }
    return {
      status: "observed",
      httpStatus: wire.httpStatus,
      value: {
        ...transaction.value,
        indexBlockHash: `0x${parsed.value.index_block_hash}`,
        blockHeight: parsed.value.block_height === null ? null : BigInt(parsed.value.block_height),
        isCanonical: parsed.value.is_canonical,
        resultRepr: parsed.value.result,
      },
    };
  }
}
