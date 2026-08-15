import { createHash } from "node:crypto";
import {
  type ClarityValue,
  decodeClarityHex,
} from "@stx-labs/signer-sidekick-protocol/clarity-codecs";
import {
  parseContractPrincipal,
  validatePrincipal,
} from "@stx-labs/signer-sidekick-protocol/principals";
import { z } from "zod";
import { type ChainAnchor, chainAnchorSchema, parseChainAnchor } from "./chain-anchor.js";
import { currentInteractiveRequestSignal } from "./request-context.js";

const nodeInfoSchema = z.object({
  server_version: z.string().min(1).optional(),
  network_id: z.number().int(),
  parent_network_id: z.number().int().nonnegative().optional(),
  burn_block_height: z.number().int().nonnegative(),
  stacks_tip_height: z.number().int().nonnegative(),
  stacks_tip: z
    .string()
    .regex(/^(?:0x)?[0-9a-f]{64}$/i)
    .transform(
      (value): `0x${string}` => `0x${value.replace(/^0x/i, "").toLowerCase()}` as `0x${string}`,
    )
    .optional(),
  stacks_tip_consensus_hash: z
    .string()
    .regex(/^(?:0x)?[0-9a-f]{40}$/i)
    .transform((value) => value.replace(/^0x/i, "").toLowerCase())
    .optional(),
  is_fully_synced: z.boolean().optional(),
});

const nodeHealthSchema = z.object({
  difference_from_max_peer: z.number().int().nonnegative(),
  max_stacks_height_of_neighbors: z.number().int().nonnegative(),
  max_stacks_neighbor_address: z.string(),
  node_stacks_tip_height: z.number().int().nonnegative(),
});

const nodeTenureInfoSchema = z.object({
  tip_block_id: z
    .string()
    .regex(/^(?:0x)?[0-9a-f]{64}$/i)
    .transform(
      (value): `0x${string}` => `0x${value.replace(/^0x/i, "").toLowerCase()}` as `0x${string}`,
    ),
  tip_height: z.number().int().nonnegative(),
  reward_cycle: z.number().int().nonnegative(),
});

const nodeHeaderSchema = z
  .object({
    consensus_hash: z
      .string()
      .regex(/^(?:0x)?[0-9a-f]{40}$/i)
      .transform((value) => value.replace(/^0x/i, "").toLowerCase()),
    header: z
      .string()
      .regex(/^(?:[0-9a-f]{2})+$/i)
      .transform((value) => value.toLowerCase()),
    parent_block_id: z
      .string()
      .regex(/^(?:0x)?[0-9a-f]{64}$/i)
      .transform(
        (value): `0x${string}` => `0x${value.replace(/^0x/i, "").toLowerCase()}` as `0x${string}`,
      ),
  })
  .strict();
const nodeHeadersSchema = z.array(nodeHeaderSchema).max(2_100);

const contractPrincipalSchema = z.string().refine((value) => {
  try {
    parseContractPrincipal(value);
    return true;
  } catch {
    return false;
  }
}, "Invalid contract principal");

// stacks-core currently serializes these uSTX quantities as JSON numbers. The known STX supply is
// below this boundary, but rejecting an unsafe value is essential because JSON.parse would
// otherwise silently round it before any bigint conversion.
const safeUstxNumberSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, "uSTX value exceeds JavaScript's safe integer range");

const poxInfoSchema = z.object({
  first_burnchain_block_height: z.number().int().nonnegative().optional(),
  current_burnchain_block_height: z.number().int().nonnegative(),
  reward_cycle_id: z.number().int().nonnegative(),
  reward_cycle_length: z.number().int().positive(),
  prepare_cycle_length: z.number().int().nonnegative(),
  contract_id: z.string(),
  pox_5_sbtc_contract: contractPrincipalSchema.optional(),
  pox_5_sbtc_registry_contract: contractPrincipalSchema.optional(),
  current_cycle: z
    .object({
      id: z.number().int().nonnegative(),
      min_threshold_ustx: safeUstxNumberSchema,
      stacked_ustx: safeUstxNumberSchema,
      is_pox_active: z.boolean(),
    })
    .optional(),
  next_cycle: z
    .object({
      id: z.number().int().nonnegative(),
      min_threshold_ustx: safeUstxNumberSchema,
      min_increment_ustx: safeUstxNumberSchema,
      stacked_ustx: safeUstxNumberSchema,
      prepare_phase_start_block_height: z.number().int().nonnegative(),
      blocks_until_prepare_phase: z.number().int(),
      reward_phase_start_block_height: z.number().int().nonnegative(),
      blocks_until_reward_phase: z.number().int(),
    })
    .optional(),
  contract_versions: z.array(
    z.object({
      contract_id: z.string(),
      activation_burnchain_block_height: z.number().int().nonnegative(),
      first_reward_cycle_id: z.number().int().nonnegative(),
    }),
  ),
});

const contractSourceSchema = z.object({
  source: z.string(),
  publish_height: z.number().int().nonnegative(),
});

const contractInterfaceSchema = z.object({
  clarity_version: z
    .string()
    .regex(/^Clarity[1-9][0-9]*$/)
    .optional(),
  epoch: z
    .string()
    .regex(/^Epoch[0-9]+(?:_[0-9]+)*$/)
    .optional(),
  functions: z.array(
    z.object({
      name: z.string(),
      access: z.string(),
      args: z.array(z.unknown()),
      outputs: z.unknown(),
    }),
  ),
});

const readOnlyResponseSchema = z.discriminatedUnion("okay", [
  z.object({ okay: z.literal(true), result: z.string() }),
  z.object({ okay: z.literal(false), cause: z.string() }),
]);

const clarityFunctionNamePattern = /^[a-zA-Z][a-zA-Z0-9-_!?+<>=/*]*$/;
const clarityHexPattern = /^(?:0x)?(?:[0-9a-fA-F]{2})+$/;
const clarityDataResponseSchema = z.object({
  data: z.string().refine((value) => clarityHexPattern.test(value), "Invalid Clarity hex"),
});

const canonicalHex = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/i)
  .transform((value): `0x${string}` => value.toLowerCase() as `0x${string}`);

const apiStatusSchema = z.object({
  server_version: z.string(),
  status: z.string(),
  chain_tip: z.object({
    block_height: z.number().int().nonnegative().safe(),
    block_hash: canonicalHex,
    index_block_hash: canonicalHex,
    burn_block_height: z.number().int().nonnegative().safe(),
  }),
});

const burnBlockPageSchema = z.object({
  limit: z.number().int().min(1).max(30),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  results: z
    .array(
      z.object({
        burn_block_time: z.number().int().nonnegative(),
        burn_block_height: z.number().int().nonnegative(),
      }),
    )
    .max(30),
});

const signerStakersPageSchema = z
  .object({
    total: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(200),
    cursor: z
      .object({
        next: z.string().nullable(),
        previous: z.string().nullable(),
        current: z.string().nullable(),
      })
      .strict(),
    results: z.array(
      z
        .object({
          staker: z.string().refine(validatePrincipal, "Invalid staker principal"),
          types: z.array(z.enum(["stx", "btc"])).min(1),
        })
        .strict(),
    ),
  })
  .strict();

const eventCursorSchema = z.string().regex(/^\d+:\d+:\d+:\d+$/);
const smartContractLogPageSchema = z
  .object({
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    next_cursor: eventCursorSchema.nullable(),
    prev_cursor: eventCursorSchema.nullable(),
    cursor: eventCursorSchema.nullable(),
    results: z.array(
      z
        .object({
          event_index: z.number().int().nonnegative(),
          event_type: z.literal("smart_contract_log"),
          tx_id: canonicalHex,
          contract_log: z
            .object({
              contract_id: z.string(),
              topic: z.string(),
              value: z.object({ hex: z.string(), repr: z.string() }).strict(),
            })
            .strict(),
        })
        .strict(),
    ),
  })
  .strict();

const transactionSummarySchema = z.object({
  tx_id: canonicalHex,
  status: z.enum(["success", "abort_by_response", "abort_by_post_condition"]),
  block: z.object({
    height: z.number().int().nonnegative(),
    hash: canonicalHex,
    index_hash: canonicalHex,
    time: z.number().nonnegative(),
    tx_index: z.number().int().nonnegative(),
  }),
  bitcoin_block: z.object({
    height: z.number().int().nonnegative(),
    time: z.number().nonnegative(),
  }),
});

const historyCursorSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[0-9:]+$/);
const principalTransactionPageSchema = z
  .object({
    total: z.number().int().nonnegative().safe(),
    limit: z.number().int().min(1).max(50),
    cursor: z
      .object({
        next: historyCursorSchema.nullable(),
        previous: historyCursorSchema.nullable(),
        current: historyCursorSchema.nullable(),
      })
      .strict(),
    results: z
      .array(
        z
          .object({
            transaction: transactionSummarySchema.extend({
              type: z.string(),
              contract_call: z
                .object({
                  contract_id: contractPrincipalSchema,
                  function_name: z.string().regex(clarityFunctionNamePattern),
                })
                .nullable()
                .optional()
                .default(null),
            }),
          })
          .strip(),
      )
      .max(50),
  })
  .strict();

const historicalTransactionEventSchema = z
  .object({
    event_index: z.number().int().nonnegative().safe(),
    type: z.string().min(1),
    contract_log: z
      .object({
        contract_id: contractPrincipalSchema,
        topic: z.string(),
        value: z.object({ hex: z.string(), repr: z.string() }).strict(),
      })
      .optional(),
  })
  .strip()
  .superRefine((value, context) => {
    if (value.type === "contract_log" && !value.contract_log) {
      context.addIssue({
        code: "custom",
        path: ["contract_log"],
        message: "A contract-log event must include its contract log",
      });
    }
  });

const transactionEventPageSchema = z
  .object({
    total: z.number().int().nonnegative().safe(),
    limit: z.number().int().min(1).max(100),
    cursor: z
      .object({
        next: historyCursorSchema.nullable(),
        previous: historyCursorSchema.nullable(),
        current: historyCursorSchema.nullable(),
      })
      .strict(),
    results: z.array(historicalTransactionEventSchema).max(100),
  })
  .strict();

// `/extended/v3/transactions` intentionally exposes only inclusion data. The v1 transaction
// endpoint supplies the signed transaction's public call details needed for the narrow fallback
// used when a node explicitly has transaction indexing disabled.
const transactionDetailSchema = z
  .object({
    tx_id: canonicalHex,
    tx_status: z.enum(["success", "abort_by_response", "abort_by_post_condition"]),
    sender_address: z.string().refine(validatePrincipal, "Invalid transaction sender"),
    tx_type: z.string(),
    contract_call: z
      .object({
        contract_id: contractPrincipalSchema,
        function_name: z.string().regex(clarityFunctionNamePattern),
        function_args: z.array(z.object({ hex: z.string().regex(clarityHexPattern) }).strip()),
      })
      .nullable()
      .optional()
      .default(null),
    smart_contract: z
      .object({
        contract_id: contractPrincipalSchema,
        source_code: z.string(),
        // The indexed API currently returns null for some historical deployments.
        clarity_version: z.number().int().nonnegative().safe().nullable().optional().default(null),
      })
      .nullable()
      .optional()
      .default(null),
    post_conditions: z.array(z.unknown()),
    sponsored: z.boolean(),
    anchor_mode: z.enum(["any", "on_chain_only", "off_chain_only"]),
    post_condition_mode: z.enum(["allow", "deny"]),
    canonical: z.boolean(),
    block_hash: canonicalHex.nullable(),
    block_height: z.number().int().nonnegative().safe(),
  })
  .strip();

const stacksBlockSummarySchema = z
  .object({
    canonical: z.boolean(),
    height: z.number().int().nonnegative().safe(),
    hash: canonicalHex,
    index_block_hash: canonicalHex,
    parent_block_hash: canonicalHex,
    parent_index_block_hash: canonicalHex,
    burn_block_height: z.number().int().nonnegative().safe(),
  })
  // The endpoint has a much larger response contract. Deliberately project only the bounded
  // canonicality fields Sidekick is allowed to trust instead of retaining unvalidated data.
  .strip();

const mempoolCursorSchema = z.string().regex(/^\d+:(?:0x)?[0-9a-f]{64}$/i);
const safeMempoolIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, "Integer exceeds JavaScript's safe integer range");
const standardPrincipalSchema = z
  .string()
  .refine(
    (value) => !value.includes(".") && validatePrincipal(value),
    "Invalid standard principal",
  );
const mempoolParticipantSchema = z
  .object({
    address: standardPrincipalSchema,
    nonce: safeMempoolIntegerSchema,
  })
  .strict();
const mempoolTransactionSchema = z
  .object({
    tx_id: canonicalHex,
    sender: mempoolParticipantSchema,
    sponsor: mempoolParticipantSchema.nullable(),
    // These endpoints query the live mempool. A dropped row here would not be safe to
    // interpret as current nonce activity, so reject it instead of silently filtering it.
    status: z.literal("pending"),
  })
  .passthrough();
const mempoolPageSchema = z
  .object({
    total: safeMempoolIntegerSchema,
    limit: z.number().int().min(1).max(50),
    cursor: z
      .object({
        next: mempoolCursorSchema.nullable(),
        previous: mempoolCursorSchema.nullable(),
        current: mempoolCursorSchema.nullable(),
      })
      .strict(),
    results: z.array(mempoolTransactionSchema).max(50),
  })
  .strict();

export type NodeInfo = z.infer<typeof nodeInfoSchema>;
export type NodeHealth = z.infer<typeof nodeHealthSchema>;
export type NodeTenureInfo = z.infer<typeof nodeTenureInfoSchema>;
export type PoxInfo = z.infer<typeof poxInfoSchema>;
export type NodeHeader = z.infer<typeof nodeHeaderSchema>;
export type ApiStatus = z.infer<typeof apiStatusSchema>;
export type BurnBlockPage = z.infer<typeof burnBlockPageSchema>;
export type ContractSource = z.infer<typeof contractSourceSchema>;
export type ContractInterface = z.infer<typeof contractInterfaceSchema>;
export type SignerStakersPage = z.infer<typeof signerStakersPageSchema>;
export type SmartContractLogPage = z.infer<typeof smartContractLogPageSchema>;
export type TransactionSummary = z.infer<typeof transactionSummarySchema>;

/** Return the canonical Stacks block time for an indexed transaction as an ISO instant. */
export function transactionOccurredAt(transaction: TransactionSummary): string {
  const occurredAt = new Date(transaction.block.time * 1_000);
  if (!Number.isFinite(occurredAt.getTime())) {
    throw new Error(`Transaction ${transaction.tx_id} has an invalid Stacks block time`);
  }
  return occurredAt.toISOString();
}
export type PrincipalTransactionPage = z.infer<typeof principalTransactionPageSchema>;
export type TransactionEventPage = z.infer<typeof transactionEventPageSchema>;
export type TransactionDetail = z.infer<typeof transactionDetailSchema>;
export type StacksBlockSummary = z.infer<typeof stacksBlockSummarySchema>;

export function stacksTipIndexBlockHash(
  info: Pick<NodeInfo, "stacks_tip" | "stacks_tip_consensus_hash">,
): `0x${string}` | undefined {
  if (!info.stacks_tip || !info.stacks_tip_consensus_hash) return undefined;
  // Stacks Core addresses chainstate by StacksBlockId, the SHA-512/256 digest of the block-header
  // hash followed by its consensus hash. /v2/info exposes those two inputs separately; stacks_tip
  // alone is not a valid historical ?tip= value under Nakamoto.
  const digest = createHash("sha512-256")
    .update(Buffer.from(info.stacks_tip.slice(2), "hex"))
    .update(Buffer.from(info.stacks_tip_consensus_hash, "hex"))
    .digest("hex");
  return `0x${digest}`;
}

export interface GasPayerMempoolActivityOptions {
  /** Rows requested per API page. The current v3 contract permits at most 50. */
  pageSize?: number;
  /** Hard request bound. Reaching it returns `incomplete`; it never truncates successfully. */
  maxPages?: number;
  /** Hard bound across all global mempool rows. */
  maxTransactions?: number;
}

export type GasPayerMempoolNonceRole = "origin" | "sponsor";

export interface GasPayerMempoolNonceActivity {
  txid: `0x${string}`;
  principal: string;
  nonce: bigint;
  role: GasPayerMempoolNonceRole;
  state: "mempool";
  origin: { principal: string; nonce: bigint };
  sponsor: null | { principal: string; nonce: bigint };
}

export type GasPayerMempoolIncompleteReason =
  | "transaction-limit"
  | "page-limit"
  | "page-size-mismatch"
  | "total-changed"
  | "cursor-cycle"
  | "cursor-mismatch"
  | "duplicate-transaction"
  | "snapshot-changed"
  | "count-mismatch";

interface GasPayerMempoolActivityResultBase {
  principal: string;
  nonceActivities: readonly GasPayerMempoolNonceActivity[];
  pagesRead: number;
  /** Every unique global mempool row observed, including rows unrelated to this principal. */
  observedTransactionCount: number;
  reportedTotal: number;
}

export type GasPayerMempoolActivityResult =
  | (GasPayerMempoolActivityResultBase & { status: "complete" })
  | (GasPayerMempoolActivityResultBase & {
      status: "incomplete";
      reason: GasPayerMempoolIncompleteReason;
    });

type MempoolTransaction = z.infer<typeof mempoolTransactionSchema>;
type BoundedMempoolEnumeration =
  | {
      status: "complete";
      transactions: readonly MempoolTransaction[];
      pagesRead: number;
      observedTransactionCount: number;
      reportedTotal: number;
    }
  | {
      status: "incomplete";
      reason: GasPayerMempoolIncompleteReason;
      transactions: readonly MempoolTransaction[];
      pagesRead: number;
      observedTransactionCount: number;
      reportedTotal: number;
    };

function canonicalMempoolSnapshot(transactions: readonly MempoolTransaction[]): string {
  return JSON.stringify(
    transactions
      .map((transaction) => ({
        txid: transaction.tx_id,
        origin: {
          principal: transaction.sender.address,
          nonce: transaction.sender.nonce,
        },
        sponsor:
          transaction.sponsor === null
            ? null
            : {
                principal: transaction.sponsor.address,
                nonce: transaction.sponsor.nonce,
              },
      }))
      .sort((left, right) => left.txid.localeCompare(right.txid)),
  );
}

export interface ChainReadOptions {
  tip: ChainAnchor["indexBlockHash"];
  signal?: AbortSignal;
}

type Fetch = typeof fetch;

export class UpstreamHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "UpstreamHttpError";
  }
}

export class RateLimitedError extends UpstreamHttpError {
  constructor(
    message: string,
    readonly retryAfterMs: number | null,
    readonly endpoint?: string,
  ) {
    super(message, 429);
    this.name = "RateLimitedError";
  }
}

export interface RateLimitApiSource {
  apiUrl: string;
  apiKeyConfigured: boolean;
}

export interface RateLimitInfo {
  source: "hiro-api" | "stacks-api" | "node";
  retryAfterSeconds: number;
  apiKeyConfigured?: boolean;
}

function origin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function isHiroApi(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "api.hiro.so" || hostname.endsWith(".hiro.so");
  } catch {
    return false;
  }
}

/**
 * Reduce an upstream 429 to safe operator-facing facts. The endpoint itself never leaves
 * Sidekick; it is only compared with the configured indexed API to distinguish it from node RPC.
 */
export function rateLimitInfo(
  error: RateLimitedError,
  api: RateLimitApiSource,
): RateLimitInfo | null {
  const endpointOrigin = error.endpoint ? origin(error.endpoint) : null;
  const apiOrigin = origin(api.apiUrl);
  if (!endpointOrigin || !apiOrigin) return null;
  const retryAfterSeconds = Math.min(
    30,
    Math.max(1, Math.ceil((error.retryAfterMs ?? 1_000) / 1_000)),
  );
  if (endpointOrigin !== apiOrigin) return { source: "node", retryAfterSeconds };
  if (isHiroApi(api.apiUrl)) {
    return { source: "hiro-api", retryAfterSeconds, apiKeyConfigured: api.apiKeyConfigured };
  }
  return { source: "stacks-api", retryAfterSeconds };
}

export class UpstreamUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UpstreamUnavailableError";
  }
}

export class UpstreamSchemaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UpstreamSchemaError";
  }
}

function sanitizedEndpoint(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

function readTip(options?: ChainReadOptions): string | null {
  if (!options) return null;
  return chainAnchorSchema.shape.indexBlockHash.parse(options.tip).slice(2);
}

function appendQuery(url: string, values: Readonly<Record<string, string | null>>): string {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(values)) {
    if (value !== null) parsed.searchParams.set(key, value);
  }
  return parsed.toString();
}

function retryAfterMilliseconds(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  if (/^[0-9]+$/.test(value)) return Number(value) * 1_000;
  if (!value.includes(",")) return null;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function retryDelay(attempt: number): number {
  const exponential = Math.min(5_000, 250 * 2 ** (attempt - 1));
  return Math.round(exponential * (0.75 + Math.random() * 0.5));
}

async function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    timeout.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already unusable; cancellation is best-effort connection-pool hygiene.
  }
}

async function fetchJson<T>(
  fetchImpl: Fetch,
  url: string,
  schema: z.ZodType<T>,
  request: RequestInit = {},
): Promise<T> {
  const { response, cancellationSignal, endpoint } = await fetchResponse(fetchImpl, url, request);
  cancellationSignal?.throwIfAborted();
  try {
    return schema.parse(await response.json());
  } catch (error) {
    cancellationSignal?.throwIfAborted();
    throw new UpstreamSchemaError(`${endpoint} returned an unexpected response shape`, {
      cause: error,
    });
  }
}

async function fetchResponse(
  fetchImpl: Fetch,
  url: string,
  request: RequestInit = {},
): Promise<{
  response: Response;
  cancellationSignal: AbortSignal | undefined;
  endpoint: string;
}> {
  const endpoint = sanitizedEndpoint(url);
  const maxAttempts = 4;
  const interactiveSignal = currentInteractiveRequestSignal();
  const cancellationSignals = [request.signal, interactiveSignal].filter(
    (signal): signal is AbortSignal => signal !== null && signal !== undefined,
  );
  const cancellationSignal =
    cancellationSignals.length > 1 ? AbortSignal.any(cancellationSignals) : cancellationSignals[0];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    cancellationSignal?.throwIfAborted();
    let response: Response;
    try {
      const signals = [AbortSignal.timeout(10_000)];
      if (cancellationSignal) signals.push(cancellationSignal);
      response = await fetchImpl(url, {
        ...request,
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      cancellationSignal?.throwIfAborted();
      if (attempt === maxAttempts) {
        throw new UpstreamUnavailableError(
          `${endpoint} was unavailable after ${attempt} attempts`,
          {
            cause: error,
          },
        );
      }
      await sleep(retryDelay(attempt), cancellationSignal);
      continue;
    }

    if (!response.ok) {
      const retryAfterMs = retryAfterMilliseconds(response.headers.get("retry-after"));
      if (response.status === 429) {
        // A short, explicit retry is useful for long paginated reconciliations without turning an
        // interactive status request into a multi-second retry storm. Longer or unspecified
        // limits return immediately so OperatorService can serve its last-good observation.
        if (retryAfterMs !== null && retryAfterMs <= 1_000 && attempt === 1) {
          await cancelResponse(response);
          await sleep(retryAfterMs, cancellationSignal);
          continue;
        }
        await cancelResponse(response);
        throw new RateLimitedError(`${endpoint} returned HTTP 429`, retryAfterMs, endpoint);
      }
      if (response.status >= 500 && attempt < maxAttempts) {
        await cancelResponse(response);
        await sleep(Math.min(30_000, retryAfterMs ?? retryDelay(attempt)), cancellationSignal);
        continue;
      }
      await cancelResponse(response);
      if (response.status >= 500) {
        throw new UpstreamUnavailableError(
          `${endpoint} returned HTTP ${response.status} after ${attempt} attempts`,
        );
      }
      throw new UpstreamHttpError(`${endpoint} returned HTTP ${response.status}`, response.status);
    }

    return { response, cancellationSignal, endpoint };
  }
  throw new UpstreamUnavailableError(`${endpoint} was unavailable`);
}

const MAX_NAKAMOTO_BLOCK_BYTES = 2 * 1_024 * 1_024;

async function fetchBoundedBytes(
  fetchImpl: Fetch,
  url: string,
  request: RequestInit = {},
): Promise<Uint8Array> {
  const { response, cancellationSignal, endpoint } = await fetchResponse(fetchImpl, url, request);
  cancellationSignal?.throwIfAborted();
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_NAKAMOTO_BLOCK_BYTES) {
    await cancelResponse(response);
    throw new UpstreamSchemaError(`${endpoint} returned an oversized Nakamoto block`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  cancellationSignal?.throwIfAborted();
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_NAKAMOTO_BLOCK_BYTES) {
    throw new UpstreamSchemaError(`${endpoint} returned an invalid Nakamoto block size`);
  }
  return bytes;
}

export class StacksNodeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  getInfo(options: { signal?: AbortSignal } = {}): Promise<NodeInfo> {
    return fetchJson(this.fetchImpl, `${this.baseUrl}/v2/info`, nodeInfoSchema, {
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  getHealth(): Promise<NodeHealth> {
    return fetchJson(this.fetchImpl, `${this.baseUrl}/v3/health`, nodeHealthSchema);
  }

  getTenureInfo(options: { signal?: AbortSignal } = {}): Promise<NodeTenureInfo> {
    return fetchJson(this.fetchImpl, `${this.baseUrl}/v3/tenures/info`, nodeTenureInfoSchema, {
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  getHeaders(count: number, options?: ChainReadOptions): Promise<NodeHeader[]> {
    const parsedCount = z.number().int().min(1).max(2_100).parse(count);
    return fetchJson(
      this.fetchImpl,
      appendQuery(`${this.baseUrl}/v2/headers/${parsedCount}`, { tip: readTip(options) }),
      nodeHeadersSchema,
      options?.signal ? { signal: options.signal } : {},
    );
  }

  getNakamotoBlockById(
    blockId: ChainAnchor["indexBlockHash"],
    options: { signal?: AbortSignal } = {},
  ): Promise<Uint8Array> {
    const parsedBlockId = canonicalHex.parse(blockId).slice(2);
    return fetchBoundedBytes(this.fetchImpl, `${this.baseUrl}/v3/blocks/${parsedBlockId}`, {
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  getNakamotoBlockAtHeight(height: number, options: ChainReadOptions): Promise<Uint8Array> {
    const parsedHeight = z.number().int().nonnegative().safe().parse(height);
    return fetchBoundedBytes(
      this.fetchImpl,
      appendQuery(`${this.baseUrl}/v3/blocks/height/${parsedHeight}`, {
        tip: readTip(options),
      }),
      options.signal ? { signal: options.signal } : {},
    );
  }

  getPoxInfo(options?: ChainReadOptions): Promise<PoxInfo> {
    return fetchJson(
      this.fetchImpl,
      appendQuery(`${this.baseUrl}/v2/pox`, { tip: readTip(options) }),
      poxInfoSchema,
    );
  }

  async getContractSource(principal: string, options?: ChainReadOptions): Promise<ContractSource> {
    const { address, contractName } = parseContractPrincipal(principal);
    return await fetchJson(
      this.fetchImpl,
      appendQuery(
        `${this.baseUrl}/v2/contracts/source/${encodeURIComponent(address)}/${encodeURIComponent(contractName)}`,
        { proof: "0", tip: readTip(options) },
      ),
      contractSourceSchema,
    );
  }

  async getContractInterface(
    principal: string,
    options?: ChainReadOptions,
  ): Promise<ContractInterface> {
    const { address, contractName } = parseContractPrincipal(principal);
    return await fetchJson(
      this.fetchImpl,
      appendQuery(
        `${this.baseUrl}/v2/contracts/interface/${encodeURIComponent(address)}/${encodeURIComponent(contractName)}`,
        { tip: readTip(options) },
      ),
      contractInterfaceSchema,
    );
  }

  async getDataVar(
    principal: string,
    variableName: string,
    options?: ChainReadOptions,
  ): Promise<ClarityValue> {
    const { address, contractName } = parseContractPrincipal(principal);
    if (!clarityFunctionNamePattern.test(variableName)) {
      throw new Error("Invalid Clarity data variable name");
    }
    const response = await fetchJson(
      this.fetchImpl,
      appendQuery(
        `${this.baseUrl}/v2/data_var/${encodeURIComponent(address)}/${encodeURIComponent(contractName)}/${encodeURIComponent(variableName)}`,
        { proof: "0", tip: readTip(options) },
      ),
      clarityDataResponseSchema,
    );
    return decodeClarityHex(response.data);
  }

  async getMapEntry(
    principal: string,
    mapName: string,
    key: string,
    options?: ChainReadOptions,
  ): Promise<ClarityValue> {
    const { address, contractName } = parseContractPrincipal(principal);
    if (!clarityFunctionNamePattern.test(mapName)) throw new Error("Invalid Clarity map name");
    if (!clarityHexPattern.test(key)) {
      throw new Error("Map key must be a hex-encoded Clarity value");
    }
    const response = await fetchJson(
      this.fetchImpl,
      appendQuery(
        `${this.baseUrl}/v2/map_entry/${encodeURIComponent(address)}/${encodeURIComponent(contractName)}/${encodeURIComponent(mapName)}`,
        { proof: "0", tip: readTip(options) },
      ),
      clarityDataResponseSchema,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(key),
      },
    );
    return decodeClarityHex(response.data);
  }

  async callReadOnly(
    principal: string,
    functionName: string,
    sender: string,
    args: readonly string[],
    options?: ChainReadOptions,
  ): Promise<ClarityValue> {
    const { address, contractName } = parseContractPrincipal(principal);
    if (!clarityFunctionNamePattern.test(functionName)) {
      throw new Error("Invalid Clarity function name");
    }
    if (!validatePrincipal(sender)) throw new Error("Invalid read-only sender principal");
    if (args.some((argument) => !clarityHexPattern.test(argument))) {
      throw new Error("Read-only arguments must be hex-encoded Clarity values");
    }

    const response = await fetchJson(
      this.fetchImpl,
      appendQuery(
        `${this.baseUrl}/v2/contracts/call-read/${encodeURIComponent(address)}/${encodeURIComponent(contractName)}/${encodeURIComponent(functionName)}`,
        { tip: readTip(options) },
      ),
      readOnlyResponseSchema,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender, arguments: args }),
      },
    );
    if (!response.okay) throw new Error(`Read-only call failed: ${response.cause}`);
    return decodeClarityHex(response.result);
  }
}

export class StacksApiClient {
  private readonly headers: Record<string, string> | undefined;

  constructor(
    private readonly baseUrl: string,
    apiKey?: string,
    apiKeyHeader = "x-api-key",
    private readonly fetchImpl: Fetch = fetch,
  ) {
    this.headers = apiKey ? { [apiKeyHeader]: apiKey } : undefined;
  }

  getNodeInfo(options: { signal?: AbortSignal } = {}): Promise<NodeInfo> {
    return fetchJson(this.fetchImpl, `${this.baseUrl}/v2/info`, nodeInfoSchema, {
      ...(this.headers ? { headers: this.headers } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  getStatus(options: { signal?: AbortSignal } = {}): Promise<ApiStatus> {
    return fetchJson(this.fetchImpl, `${this.baseUrl}/extended/v1/status`, apiStatusSchema, {
      ...(this.headers ? { headers: this.headers } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  async getBurnBlocks(limit = 200): Promise<BurnBlockPage> {
    const parsedLimit = z.number().int().min(2).max(200).parse(limit);
    const results: BurnBlockPage["results"] = [];
    const seenHeights = new Set<number>();
    let expectedTotal: number | null = null;

    while (results.length < parsedLimit) {
      const offset = results.length;
      const pageLimit = Math.min(30, parsedLimit - offset);
      const query = new URLSearchParams({ limit: String(pageLimit), offset: String(offset) });
      const page = await fetchJson(
        this.fetchImpl,
        `${this.baseUrl}/extended/v2/burn-blocks?${query}`,
        burnBlockPageSchema,
        this.headers ? { headers: this.headers } : {},
      );
      if (page.limit !== pageLimit || page.offset !== offset) {
        throw new UpstreamSchemaError("Burn-block API returned mismatched pagination metadata");
      }
      if (page.results.length > pageLimit) {
        throw new UpstreamSchemaError("Burn-block API returned more rows than requested");
      }
      if (expectedTotal !== null && page.total !== expectedTotal) {
        throw new UpstreamSchemaError("Burn-block API total changed during pagination");
      }
      expectedTotal = page.total;
      for (const block of page.results) {
        if (seenHeights.has(block.burn_block_height)) {
          throw new UpstreamSchemaError("Burn-block API repeated a block during pagination");
        }
        seenHeights.add(block.burn_block_height);
        results.push(block);
      }
      if (page.results.length < pageLimit || results.length >= page.total) break;
    }

    if (results.length !== Math.min(parsedLimit, expectedTotal ?? 0)) {
      throw new UpstreamSchemaError("Burn-block API ended before the requested history was read");
    }
    return { limit: parsedLimit, offset: 0, total: expectedTotal ?? 0, results };
  }

  getSignerStakers(
    signerPrincipal: string,
    cursor: string | null = null,
    limit = 200,
  ): Promise<SignerStakersPage> {
    if (!validatePrincipal(signerPrincipal)) throw new Error("Invalid signer principal");
    if (cursor !== null && !validatePrincipal(cursor)) throw new Error("Invalid staker cursor");
    const parsedLimit = z.number().int().min(1).max(200).parse(limit);
    const query = new URLSearchParams({ limit: String(parsedLimit) });
    if (cursor !== null) query.set("cursor", cursor);
    return fetchJson(
      this.fetchImpl,
      `${this.baseUrl}/extended/v3/staking/signers/${encodeURIComponent(signerPrincipal)}/stakers?${query}`,
      signerStakersPageSchema,
      this.headers ? { headers: this.headers } : {},
    );
  }

  getSmartContractLogs(
    contractId: string,
    cursor: string | null = null,
    limit = 100,
  ): Promise<SmartContractLogPage> {
    if (!validatePrincipal(contractId) || !contractId.includes(".")) {
      throw new Error("Invalid contract principal");
    }
    if (cursor !== null) eventCursorSchema.parse(cursor);
    const parsedLimit = z.number().int().min(1).max(100).parse(limit);
    const query = new URLSearchParams({ limit: String(parsedLimit), offset: "0" });
    if (cursor !== null) query.set("cursor", cursor);
    return fetchJson(
      this.fetchImpl,
      `${this.baseUrl}/extended/v2/smart-contracts/${encodeURIComponent(contractId)}/logs?${query}`,
      smartContractLogPageSchema,
      this.headers ? { headers: this.headers } : {},
    );
  }

  getTransaction(txId: string): Promise<TransactionSummary> {
    const parsedTxId = z
      .string()
      .regex(/^0x[0-9a-f]{64}$/i)
      .parse(txId);
    return fetchJson(
      this.fetchImpl,
      `${this.baseUrl}/extended/v3/transactions/${parsedTxId}`,
      transactionSummarySchema,
      this.headers ? { headers: this.headers } : {},
    );
  }

  getPrincipalTransactions(
    principal: string,
    cursor: string | null = null,
    limit = 50,
  ): Promise<PrincipalTransactionPage> {
    if (!validatePrincipal(principal)) throw new Error("Invalid principal");
    if (cursor !== null) historyCursorSchema.parse(cursor);
    const parsedLimit = z.number().int().min(1).max(50).parse(limit);
    const query = new URLSearchParams({ limit: String(parsedLimit) });
    if (cursor !== null) query.set("cursor", cursor);
    return fetchJson(
      this.fetchImpl,
      `${this.baseUrl}/extended/v3/principals/${encodeURIComponent(principal)}/transactions?${query}`,
      principalTransactionPageSchema,
      this.headers ? { headers: this.headers } : {},
    );
  }

  getTransactionEvents(
    txId: string,
    cursor: string | null = null,
    limit = 100,
  ): Promise<TransactionEventPage> {
    const parsedTxId = canonicalHex.parse(txId);
    if (cursor !== null) historyCursorSchema.parse(cursor);
    const parsedLimit = z.number().int().min(1).max(100).parse(limit);
    const query = new URLSearchParams({ limit: String(parsedLimit) });
    if (cursor !== null) query.set("cursor", cursor);
    return fetchJson(
      this.fetchImpl,
      `${this.baseUrl}/extended/v3/transactions/${parsedTxId}/events?${query}`,
      transactionEventPageSchema,
      this.headers ? { headers: this.headers } : {},
    );
  }

  getTransactionDetails(txId: string): Promise<TransactionDetail> {
    const parsedTxId = z
      .string()
      .regex(/^0x[0-9a-f]{64}$/i)
      .parse(txId);
    return fetchJson(
      this.fetchImpl,
      `${this.baseUrl}/extended/v1/tx/${parsedTxId}`,
      transactionDetailSchema,
      this.headers ? { headers: this.headers } : {},
    );
  }

  getBlock(heightOrHash: number | string): Promise<StacksBlockSummary> {
    const path =
      typeof heightOrHash === "number"
        ? z.number().int().nonnegative().safe().parse(heightOrHash).toString()
        : canonicalHex.parse(heightOrHash);
    return fetchJson(
      this.fetchImpl,
      `${this.baseUrl}/extended/v2/blocks/${encodeURIComponent(path)}`,
      stacksBlockSummarySchema,
      this.headers ? { headers: this.headers } : {},
    );
  }

  /**
   * Enumerate the bounded global v3 mempool and project every nonce-consuming role held by the
   * requested gas principal. Unlike the principal-scoped endpoint, this proves coverage of both
   * origin and sponsor activity when, and only when, it returns `complete`.
   *
   * Because the API has no immutable snapshot token, success requires two consecutive complete
   * scans with identical canonical transaction-role facts. The scans deliberately sacrifice
   * availability for nonce safety: bounds, changes, cursor instability, duplicate rows, and count
   * mismatches return `incomplete`. Transport, HTTP, and schema failures retain the client's typed
   * exceptions. Callers must block on every outcome other than `complete`.
   */
  async enumerateGasPayerMempoolActivity(
    principal: string,
    options: GasPayerMempoolActivityOptions = {},
  ): Promise<GasPayerMempoolActivityResult> {
    const parsedPrincipal = standardPrincipalSchema.parse(principal);
    const firstEnumeration = await this.#enumerateMempoolEndpoint(
      `${this.baseUrl}/extended/v3/mempool/transactions`,
      options,
      { maxPages: 20, maxTransactions: 1_000 },
    );
    let enumeration: BoundedMempoolEnumeration = firstEnumeration;
    let pagesRead = firstEnumeration.pagesRead;
    if (firstEnumeration.status === "complete") {
      const secondEnumeration = await this.#enumerateMempoolEndpoint(
        `${this.baseUrl}/extended/v3/mempool/transactions`,
        options,
        { maxPages: 20, maxTransactions: 1_000 },
      );
      pagesRead += secondEnumeration.pagesRead;
      enumeration = secondEnumeration;
      if (
        secondEnumeration.status === "complete" &&
        (secondEnumeration.reportedTotal !== firstEnumeration.reportedTotal ||
          canonicalMempoolSnapshot(secondEnumeration.transactions) !==
            canonicalMempoolSnapshot(firstEnumeration.transactions))
      ) {
        enumeration = {
          ...secondEnumeration,
          status: "incomplete",
          reason: "snapshot-changed",
        };
      }
    }
    const nonceActivities = enumeration.transactions.flatMap<GasPayerMempoolNonceActivity>(
      (transaction) => {
        const origin = {
          principal: transaction.sender.address,
          nonce: BigInt(transaction.sender.nonce),
        };
        const sponsor =
          transaction.sponsor === null
            ? null
            : {
                principal: transaction.sponsor.address,
                nonce: BigInt(transaction.sponsor.nonce),
              };
        const matches: GasPayerMempoolNonceActivity[] = [];
        if (origin.principal === parsedPrincipal) {
          matches.push({
            txid: transaction.tx_id,
            principal: parsedPrincipal,
            nonce: origin.nonce,
            role: "origin",
            state: "mempool",
            origin,
            sponsor,
          });
        }
        if (sponsor?.principal === parsedPrincipal) {
          matches.push({
            txid: transaction.tx_id,
            principal: parsedPrincipal,
            nonce: sponsor.nonce,
            role: "sponsor",
            state: "mempool",
            origin,
            sponsor,
          });
        }
        return matches;
      },
    );
    const result = {
      principal: parsedPrincipal,
      nonceActivities,
      pagesRead,
      observedTransactionCount: enumeration.observedTransactionCount,
      reportedTotal: enumeration.reportedTotal,
    };
    return enumeration.status === "complete"
      ? { status: "complete", ...result }
      : { status: "incomplete", reason: enumeration.reason, ...result };
  }

  async #enumerateMempoolEndpoint(
    endpoint: string,
    options: GasPayerMempoolActivityOptions,
    defaults: { maxPages: number; maxTransactions: number },
  ): Promise<BoundedMempoolEnumeration> {
    const pageSize = z
      .number()
      .int()
      .min(1)
      .max(50)
      .parse(options.pageSize ?? 50);
    const maxPages = z
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(options.maxPages ?? defaults.maxPages);
    const maxTransactions = z
      .number()
      .int()
      .min(1)
      .max(5_000)
      .parse(options.maxTransactions ?? defaults.maxTransactions);
    const transactions: MempoolTransaction[] = [];
    const observedTxids = new Set<string>();
    const requestedCursors = new Set<string>();
    let cursor: string | null = null;
    let pagesRead = 0;
    let reportedTotal: number | null = null;

    const result = (
      status: "complete" | "incomplete",
      reason?: GasPayerMempoolIncompleteReason,
    ): BoundedMempoolEnumeration => {
      const base = {
        transactions,
        pagesRead,
        observedTransactionCount: observedTxids.size,
        reportedTotal: reportedTotal ?? 0,
      };
      return status === "complete"
        ? { status, ...base }
        : { status, reason: reason ?? "count-mismatch", ...base };
    };

    for (;;) {
      const query = new URLSearchParams({ limit: String(pageSize) });
      if (cursor !== null) query.set("cursor", cursor);
      const page = await fetchJson(
        this.fetchImpl,
        `${endpoint}?${query}`,
        mempoolPageSchema,
        this.headers ? { headers: this.headers } : {},
      );
      pagesRead += 1;

      if (page.limit !== pageSize || page.results.length > page.limit) {
        return result("incomplete", "page-size-mismatch");
      }
      if (cursor !== null && page.cursor.current !== cursor) {
        return result("incomplete", "cursor-mismatch");
      }
      if (reportedTotal === null) {
        reportedTotal = page.total;
      } else if (page.total !== reportedTotal) {
        return result("incomplete", "total-changed");
      }

      for (const transaction of page.results) {
        if (observedTxids.has(transaction.tx_id)) {
          return result("incomplete", "duplicate-transaction");
        }
        observedTxids.add(transaction.tx_id);
        transactions.push(transaction);
      }

      if (reportedTotal > maxTransactions || observedTxids.size > maxTransactions) {
        return result("incomplete", "transaction-limit");
      }
      if (page.cursor.next === null) {
        return observedTxids.size === reportedTotal
          ? result("complete")
          : result("incomplete", "count-mismatch");
      }
      if (observedTxids.size >= reportedTotal) {
        return result("incomplete", "count-mismatch");
      }
      if (requestedCursors.has(page.cursor.next)) {
        return result("incomplete", "cursor-cycle");
      }
      if (pagesRead >= maxPages) {
        return result("incomplete", "page-limit");
      }
      cursor = page.cursor.next;
      requestedCursors.add(cursor);
    }
  }
}

export interface ChainSourceTips {
  readonly node: {
    readonly stacksTipHeight: number;
    readonly burnBlockHeight: number;
  };
  readonly api: {
    readonly stacksTipHeight: number;
    readonly burnBlockHeight: number;
  };
  readonly poxBurnBlockHeight: number;
}

export class ChainAnchorError extends Error {
  readonly retryable: boolean;
  readonly tips: ChainSourceTips | null;

  constructor(message: string, options: { retryable?: boolean; tips?: ChainSourceTips } = {}) {
    super(message);
    this.name = "ChainAnchorError";
    this.retryable = options.retryable ?? false;
    this.tips = options.tips ?? null;
  }
}

function sameApiTip(left: ApiStatus, right: ApiStatus): boolean {
  return (
    left.chain_tip.block_height === right.chain_tip.block_height &&
    left.chain_tip.index_block_hash.toLowerCase() ===
      right.chain_tip.index_block_hash.toLowerCase() &&
    left.chain_tip.burn_block_height === right.chain_tip.burn_block_height
  );
}

function apiStatusAtNodeTip(
  apiStatus: ApiStatus,
  nodeInfo: NodeInfo,
  block: StacksBlockSummary,
): ApiStatus {
  if (
    !nodeInfo.stacks_tip ||
    !block.canonical ||
    block.height !== nodeInfo.stacks_tip_height ||
    block.hash !== nodeInfo.stacks_tip
  ) {
    throw new ChainAnchorError("API could not prove the node tip is canonical", {
      retryable: true,
    });
  }
  return {
    ...apiStatus,
    chain_tip: {
      block_height: block.height,
      block_hash: block.hash,
      index_block_hash: block.index_block_hash,
      burn_block_height: block.burn_block_height,
    },
  };
}

async function sharedApiStatus(
  apiStatus: ApiStatus,
  nodeInfo: NodeInfo,
  api: StacksApiClient,
): Promise<ApiStatus> {
  if (nodeInfo.stacks_tip_height === apiStatus.chain_tip.block_height) return apiStatus;
  // When the API has indexed exactly one newer Stacks block, the node's own tip is still a safe
  // common position if the API can independently prove that exact block is canonical. Pin all
  // subsequent node reads to its API-derived index hash instead of mixing the two live tips.
  if (nodeInfo.stacks_tip && apiStatus.chain_tip.block_height === nodeInfo.stacks_tip_height + 1) {
    return apiStatusAtNodeTip(apiStatus, nodeInfo, await api.getBlock(nodeInfo.stacks_tip));
  }
  return apiStatus;
}

export function createChainAnchor(
  nodeInfo: NodeInfo,
  apiStatus: ApiStatus,
  poxInfo: PoxInfo,
): ChainAnchor {
  const apiTip = apiStatus.chain_tip;
  const nodeBurnLag = nodeInfo.burn_block_height - apiTip.burn_block_height;
  // The API tip is the shared anchor: it is fenced before and after this read, while the node
  // proves it can execute PoX queries at that exact index block hash. An older API anchor remains
  // safe for indexed reads for as long as the local node can still execute at that exact tip.
  // PoX reports the node's live burn tip even when the chainstate query is tip-pinned, so derive
  // the anchor's cycle facts from the API burn height below instead of comparing it to the API.
  if (
    nodeInfo.stacks_tip_height < apiTip.block_height ||
    nodeBurnLag < 0 ||
    poxInfo.current_burnchain_block_height !== nodeInfo.burn_block_height
  ) {
    throw new ChainAnchorError("Node, API, and PoX tips do not describe one chain position", {
      retryable: true,
      tips: {
        node: {
          stacksTipHeight: nodeInfo.stacks_tip_height,
          burnBlockHeight: nodeInfo.burn_block_height,
        },
        api: {
          stacksTipHeight: apiTip.block_height,
          burnBlockHeight: apiTip.burn_block_height,
        },
        poxBurnBlockHeight: poxInfo.current_burnchain_block_height,
      },
    });
  }
  const nextCycle = poxInfo.next_cycle;
  if (!nextCycle || nextCycle.id !== poxInfo.reward_cycle_id + 1) {
    throw new ChainAnchorError("PoX response does not expose the next-cycle boundary");
  }
  const currentCycleStart = nextCycle.reward_phase_start_block_height - poxInfo.reward_cycle_length;
  const anchorCycleOffset = Math.floor(
    (apiTip.burn_block_height - currentCycleStart) / poxInfo.reward_cycle_length,
  );
  const rewardCycle = poxInfo.reward_cycle_id + anchorCycleOffset;
  const cyclePosition =
    apiTip.burn_block_height -
    (currentCycleStart + anchorCycleOffset * poxInfo.reward_cycle_length);
  if (
    rewardCycle < 0 ||
    !Number.isSafeInteger(rewardCycle) ||
    cyclePosition < 0 ||
    cyclePosition >= poxInfo.reward_cycle_length
  ) {
    throw new ChainAnchorError("PoX cycle boundary is inconsistent with the current Bitcoin block");
  }
  const phase =
    cyclePosition >= poxInfo.reward_cycle_length - poxInfo.prepare_cycle_length
      ? "prepare"
      : "reward";
  const checkpoint =
    cyclePosition < Math.floor(poxInfo.reward_cycle_length / 2) ? "first-half" : "second-half";
  return parseChainAnchor({
    stacksBlockHeight: apiTip.block_height,
    indexBlockHash: apiTip.index_block_hash,
    burnBlockHeight: apiTip.burn_block_height,
    rewardCycle,
    rewardCycleLength: poxInfo.reward_cycle_length,
    prepareCycleLength: poxInfo.prepare_cycle_length,
    cyclePosition,
    phase,
    checkpoint,
  });
}

export function createNodeChainAnchor(
  nodeInfo: NodeInfo,
  tenureInfo: NodeTenureInfo,
  poxInfo: PoxInfo,
): ChainAnchor {
  if (
    nodeInfo.stacks_tip_height !== tenureInfo.tip_height ||
    nodeInfo.burn_block_height !== poxInfo.current_burnchain_block_height
  ) {
    throw new ChainAnchorError("Node and PoX tips do not describe one chain position", {
      retryable: true,
    });
  }
  const anchor = createChainAnchor(
    nodeInfo,
    {
      server_version: "local-stacks-node",
      status: "ready",
      chain_tip: {
        block_height: tenureInfo.tip_height,
        block_hash: tenureInfo.tip_block_id,
        index_block_hash: tenureInfo.tip_block_id,
        burn_block_height: nodeInfo.burn_block_height,
      },
    },
    poxInfo,
  );
  if (anchor.rewardCycle !== tenureInfo.reward_cycle) {
    throw new ChainAnchorError("Node tenure and PoX reward-cycle facts disagree", {
      retryable: true,
    });
  }
  return anchor;
}

function sameNodeTip(
  leftInfo: NodeInfo,
  leftTenure: NodeTenureInfo,
  rightInfo: NodeInfo,
  rightTenure: NodeTenureInfo,
): boolean {
  return (
    leftInfo.stacks_tip_height === rightInfo.stacks_tip_height &&
    leftInfo.burn_block_height === rightInfo.burn_block_height &&
    leftTenure.tip_height === rightTenure.tip_height &&
    leftTenure.tip_block_id === rightTenure.tip_block_id &&
    leftTenure.reward_cycle === rightTenure.reward_cycle
  );
}

/** Capture the local node's current canonical position without consulting an external indexer. */
export async function captureNodeChainAnchor(node: StacksNodeClient): Promise<ChainAnchor> {
  const maxAttempts = 3;
  let lastError: ChainAnchorError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const [beforeInfo, beforeTenure] = await Promise.all([node.getInfo(), node.getTenureInfo()]);
      const poxInfo = await node.getPoxInfo({ tip: beforeTenure.tip_block_id });
      const [afterInfo, afterTenure] = await Promise.all([node.getInfo(), node.getTenureInfo()]);
      if (!sameNodeTip(beforeInfo, beforeTenure, afterInfo, afterTenure)) {
        throw new ChainAnchorError("Node tip moved while the anchor was being captured", {
          retryable: true,
        });
      }
      return createNodeChainAnchor(beforeInfo, beforeTenure, poxInfo);
    } catch (error) {
      if (!(error instanceof ChainAnchorError) || !error.retryable || attempt === maxAttempts) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError ?? new ChainAnchorError("Unable to capture a stable local node anchor");
}

export async function captureChainAnchor(
  node: StacksNodeClient,
  api: StacksApiClient,
): Promise<ChainAnchor> {
  const maxAttempts = 3;
  let lastError: ChainAnchorError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const before = await api.getStatus();
      const nodeInfo = await node.getInfo();
      const sharedStatus = await sharedApiStatus(before, nodeInfo, api);
      let poxInfo: PoxInfo;
      try {
        // Successfully executing the query at the API's stable index block hash is the node's
        // proof that this older position is available locally. This is what makes a node-ahead,
        // API-lagging anchor safe without pretending the two live tips are identical.
        poxInfo = await node.getPoxInfo({ tip: sharedStatus.chain_tip.index_block_hash });
      } catch (error) {
        if (error instanceof UpstreamHttpError && error.status === 404) {
          throw new ChainAnchorError("The shared API anchor is not yet readable from the node", {
            retryable: true,
            tips: {
              node: {
                stacksTipHeight: nodeInfo.stacks_tip_height,
                burnBlockHeight: nodeInfo.burn_block_height,
              },
              api: {
                stacksTipHeight: sharedStatus.chain_tip.block_height,
                burnBlockHeight: sharedStatus.chain_tip.burn_block_height,
              },
              poxBurnBlockHeight: nodeInfo.burn_block_height,
            },
          });
        }
        throw error;
      }
      const after = await api.getStatus();
      if (!sameApiTip(before, after)) {
        throw new ChainAnchorError("Chain tip moved while the anchor was being captured", {
          retryable: true,
          tips: {
            node: {
              stacksTipHeight: nodeInfo.stacks_tip_height,
              burnBlockHeight: nodeInfo.burn_block_height,
            },
            api: {
              stacksTipHeight: after.chain_tip.block_height,
              burnBlockHeight: after.chain_tip.burn_block_height,
            },
            poxBurnBlockHeight: poxInfo.current_burnchain_block_height,
          },
        });
      }
      return createChainAnchor(nodeInfo, sharedStatus, poxInfo);
    } catch (error) {
      if (!(error instanceof ChainAnchorError) || !error.retryable || attempt === maxAttempts) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError ?? new ChainAnchorError("Unable to capture a stable shared chain anchor");
}
