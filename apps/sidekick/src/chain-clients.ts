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

const nodeInfoSchema = z.object({
  server_version: z.string().min(1).optional(),
  network_id: z.number().int(),
  parent_network_id: z.number().int().nonnegative().optional(),
  burn_block_height: z.number().int().nonnegative(),
  stacks_tip_height: z.number().int().nonnegative(),
});

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
export type PoxInfo = z.infer<typeof poxInfoSchema>;
export type ApiStatus = z.infer<typeof apiStatusSchema>;
export type BurnBlockPage = z.infer<typeof burnBlockPageSchema>;
export type ContractSource = z.infer<typeof contractSourceSchema>;
export type ContractInterface = z.infer<typeof contractInterfaceSchema>;
export type SignerStakersPage = z.infer<typeof signerStakersPageSchema>;
export type SmartContractLogPage = z.infer<typeof smartContractLogPageSchema>;
export type TransactionSummary = z.infer<typeof transactionSummarySchema>;
export type StacksBlockSummary = z.infer<typeof stacksBlockSummarySchema>;

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
  ) {
    super(message, 429);
    this.name = "RateLimitedError";
  }
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

async function sleep(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
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
  const endpoint = sanitizedEndpoint(url);
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...request,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      if (attempt === maxAttempts) {
        throw new UpstreamUnavailableError(
          `${endpoint} was unavailable after ${attempt} attempts`,
          {
            cause: error,
          },
        );
      }
      await sleep(retryDelay(attempt));
      continue;
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      const retryAfterMs = retryAfterMilliseconds(response.headers.get("retry-after"));
      if (retryable && attempt < maxAttempts) {
        await cancelResponse(response);
        await sleep(Math.min(30_000, retryAfterMs ?? retryDelay(attempt)));
        continue;
      }
      await cancelResponse(response);
      if (response.status === 429) {
        throw new RateLimitedError(
          `${endpoint} remained rate limited after ${attempt} attempts`,
          retryAfterMs,
        );
      }
      if (response.status >= 500) {
        throw new UpstreamUnavailableError(
          `${endpoint} returned HTTP ${response.status} after ${attempt} attempts`,
        );
      }
      throw new UpstreamHttpError(`${endpoint} returned HTTP ${response.status}`, response.status);
    }

    try {
      return schema.parse(await response.json());
    } catch (error) {
      throw new UpstreamSchemaError(`${endpoint} returned an unexpected response shape`, {
        cause: error,
      });
    }
  }
  throw new UpstreamUnavailableError(`${endpoint} was unavailable`);
}

export class StacksNodeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  getInfo(): Promise<NodeInfo> {
    return fetchJson(this.fetchImpl, `${this.baseUrl}/v2/info`, nodeInfoSchema);
  }

  getPoxInfo(options?: ChainReadOptions): Promise<PoxInfo> {
    return fetchJson(
      this.fetchImpl,
      appendQuery(`${this.baseUrl}/v2/pox`, { tip: readTip(options) }),
      poxInfoSchema,
    );
  }

  async getContractSource(principal: string): Promise<ContractSource> {
    const { address, contractName } = parseContractPrincipal(principal);
    return await fetchJson(
      this.fetchImpl,
      `${this.baseUrl}/v2/contracts/source/${encodeURIComponent(address)}/${encodeURIComponent(contractName)}?proof=0`,
      contractSourceSchema,
    );
  }

  async getContractInterface(principal: string): Promise<ContractInterface> {
    const { address, contractName } = parseContractPrincipal(principal);
    return await fetchJson(
      this.fetchImpl,
      `${this.baseUrl}/v2/contracts/interface/${encodeURIComponent(address)}/${encodeURIComponent(contractName)}`,
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

  getNodeInfo(): Promise<NodeInfo> {
    return fetchJson(
      this.fetchImpl,
      `${this.baseUrl}/v2/info`,
      nodeInfoSchema,
      this.headers ? { headers: this.headers } : {},
    );
  }

  getStatus(): Promise<ApiStatus> {
    return fetchJson(
      this.fetchImpl,
      `${this.baseUrl}/extended/v1/status`,
      apiStatusSchema,
      this.headers ? { headers: this.headers } : {},
    );
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

export class ChainAnchorError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = "ChainAnchorError";
    this.retryable = options.retryable ?? false;
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

export function createChainAnchor(
  nodeInfo: NodeInfo,
  apiStatus: ApiStatus,
  poxInfo: PoxInfo,
): ChainAnchor {
  const apiTip = apiStatus.chain_tip;
  if (
    nodeInfo.stacks_tip_height !== apiTip.block_height ||
    nodeInfo.burn_block_height !== apiTip.burn_block_height ||
    poxInfo.current_burnchain_block_height !== apiTip.burn_block_height
  ) {
    throw new ChainAnchorError("Node, API, and PoX tips do not describe one chain position", {
      retryable: true,
    });
  }
  const nextCycle = poxInfo.next_cycle;
  if (!nextCycle || nextCycle.id !== poxInfo.reward_cycle_id + 1) {
    throw new ChainAnchorError("PoX response does not expose the next-cycle boundary");
  }
  const currentCycleStart = nextCycle.reward_phase_start_block_height - poxInfo.reward_cycle_length;
  const cyclePosition = poxInfo.current_burnchain_block_height - currentCycleStart;
  if (cyclePosition < 0 || cyclePosition >= poxInfo.reward_cycle_length) {
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
    rewardCycle: poxInfo.reward_cycle_id,
    rewardCycleLength: poxInfo.reward_cycle_length,
    prepareCycleLength: poxInfo.prepare_cycle_length,
    cyclePosition,
    phase,
    checkpoint,
  });
}

export async function captureChainAnchor(
  node: StacksNodeClient,
  api: StacksApiClient,
): Promise<ChainAnchor> {
  const before = await api.getStatus();
  const [nodeInfo, poxInfo] = await Promise.all([
    node.getInfo(),
    node.getPoxInfo({ tip: before.chain_tip.index_block_hash }),
  ]);
  const after = await api.getStatus();
  if (!sameApiTip(before, after)) {
    throw new ChainAnchorError("Chain tip moved while the anchor was being captured", {
      retryable: true,
    });
  }
  return createChainAnchor(nodeInfo, after, poxInfo);
}
