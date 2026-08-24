import { deserializeTransaction, txidFromBytes } from "@stacks/transactions";
import type {
  SignedGasWalletSweepTransaction,
  SignedRewardOperationTransaction,
} from "./gas-payer-signer.js";

export type BroadcastableSignedTransaction =
  | SignedGasWalletSweepTransaction
  | SignedRewardOperationTransaction;

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface TransactionBroadcasterOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: Fetch;
}

export type TransactionBroadcastResult =
  | {
      status: "accepted";
      txid: `0x${string}`;
      httpStatus: number;
    }
  | {
      status: "deterministic-rejection";
      txid: `0x${string}` | null;
      httpStatus: number | null;
      reason: "invalid-signed-attempt" | "node-rejection";
      nodeMessage: string | null;
    }
  | {
      status: "ambiguous";
      txid: `0x${string}`;
      httpStatus: number | null;
      reason:
        | "timeout"
        | "connection-reset"
        | "transport-error"
        | "server-error"
        | "invalid-success-response"
        | "node-rejection";
      nodeMessage?: string | null;
    };

const txidPattern = /^0x[0-9a-f]{64}$/;
const maximumNodeMessageLength = 256;
const deterministicNodeRejectionReasons = new Set([
  "Serialization",
  "Deserialization",
  "SignatureValidation",
  "FeeTooLow",
  "NoSuchPublicFunction",
  "BadFunctionArgument",
  "BadAddressVersionByte",
]);

function canonicalTxid(value: string): `0x${string}` | null {
  const normalized = value.trim().replace(/^"|"$/g, "").toLowerCase();
  const prefixed = normalized.startsWith("0x") ? normalized : `0x${normalized}`;
  return txidPattern.test(prefixed) ? (prefixed as `0x${string}`) : null;
}

function nodeMessage(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string") return parsed.slice(0, maximumNodeMessageLength);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const field of ["reason", "error", "message"]) {
        const value = record[field];
        if (typeof value === "string") return value.slice(0, maximumNodeMessageLength);
      }
    }
  } catch {
    // Use the bounded plain-text response below.
  }
  return trimmed.slice(0, maximumNodeMessageLength);
}

function deterministicNodeRejection(body: string, expectedTxid: `0x${string}`): string | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.reason !== "string" ||
      !deterministicNodeRejectionReasons.has(record.reason) ||
      typeof record.txid !== "string" ||
      canonicalTxid(record.txid) !== expectedTxid
    ) {
      return null;
    }
    return record.reason;
  } catch {
    return null;
  }
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") return code;
  const cause = (error as { cause?: unknown }).cause;
  return cause === error ? null : errorCode(cause);
}

function ambiguousTransportReason(
  error: unknown,
): "timeout" | "connection-reset" | "transport-error" {
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

function successTxid(body: string): `0x${string}` | null {
  const direct = canonicalTxid(body);
  if (direct) return direct;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object") {
      const txid = (parsed as { txid?: unknown }).txid;
      if (typeof txid === "string") return canonicalTxid(txid);
    }
  } catch {
    return null;
  }
  return null;
}

function validateSignedAttempt(
  attempt: BroadcastableSignedTransaction,
): { bytes: Uint8Array; txid: `0x${string}` } | null {
  try {
    if (attempt.kind !== "signed-gas-wallet-sweep" && attempt.kind !== "signed-reward-operation") {
      return null;
    }
    const txid = canonicalTxid(attempt.precomputedTxid);
    const bytes = attempt.signedTransactionBytes;
    if (!txid || bytes.length === 0) return null;
    deserializeTransaction(bytes);
    if (`0x${txidFromBytes(bytes)}` !== txid) return null;
    return { bytes, txid };
  } catch {
    return null;
  }
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Submission has already become ambiguous; cancellation is best-effort connection hygiene.
  }
}

/**
 * Broadcasts one previously sealed attempt exactly once. It deliberately owns no retry loop:
 * timeout, reset, and 5xx paths may have reached the node and therefore return `ambiguous`.
 */
export class NoRetryTransactionBroadcaster {
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #fetchImpl: Fetch;

  constructor(options: TransactionBroadcasterOptions) {
    let baseUrl: URL;
    try {
      baseUrl = new URL(options.baseUrl);
    } catch {
      throw new TypeError("Transaction broadcaster requires a valid node URL");
    }
    if (
      (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") ||
      baseUrl.username ||
      baseUrl.password
    ) {
      throw new TypeError(
        "Transaction broadcaster requires an HTTP(S) node URL without credentials",
      );
    }
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
      throw new TypeError(
        "Transaction broadcaster timeout must be between 1 and 120000 milliseconds",
      );
    }
    baseUrl.pathname = `${baseUrl.pathname.replace(/\/$/, "")}/v2/transactions`;
    baseUrl.search = "";
    baseUrl.hash = "";
    this.#endpoint = baseUrl.toString();
    this.#timeoutMs = timeoutMs;
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  async broadcast(attempt: BroadcastableSignedTransaction): Promise<TransactionBroadcastResult> {
    const validated = validateSignedAttempt(attempt);
    const attemptedTxid = canonicalTxid(attempt.precomputedTxid);
    if (!validated) {
      return {
        status: "deterministic-rejection",
        txid: attemptedTxid,
        httpStatus: null,
        reason: "invalid-signed-attempt",
        nodeMessage: null,
      };
    }

    let response: Response;
    try {
      response = await this.#fetchImpl(this.#endpoint, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: Buffer.from(validated.bytes),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      return {
        status: "ambiguous",
        txid: validated.txid,
        httpStatus: null,
        reason: ambiguousTransportReason(error),
      };
    }

    if (response.status >= 500) {
      await cancelResponse(response);
      return {
        status: "ambiguous",
        txid: validated.txid,
        httpStatus: response.status,
        reason: "server-error",
      };
    }

    if (!response.ok) {
      let body = "";
      try {
        body = await response.text();
      } catch {
        // The response still cannot prove exclusive nonce ownership even without its explanation.
      }
      const deterministicReason =
        response.status === 400 ? deterministicNodeRejection(body, validated.txid) : null;
      return deterministicReason === null
        ? {
            status: "ambiguous",
            txid: validated.txid,
            httpStatus: response.status,
            reason: "node-rejection",
            nodeMessage: nodeMessage(body),
          }
        : {
            status: "deterministic-rejection",
            txid: validated.txid,
            httpStatus: response.status,
            reason: "node-rejection",
            nodeMessage: deterministicReason,
          };
    }

    let body: string;
    try {
      body = await response.text();
    } catch {
      return {
        status: "ambiguous",
        txid: validated.txid,
        httpStatus: response.status,
        reason: "connection-reset",
      };
    }
    if (successTxid(body) !== validated.txid) {
      return {
        status: "ambiguous",
        txid: validated.txid,
        httpStatus: response.status,
        reason: "invalid-success-response",
      };
    }
    return { status: "accepted", txid: validated.txid, httpStatus: response.status };
  }
}
