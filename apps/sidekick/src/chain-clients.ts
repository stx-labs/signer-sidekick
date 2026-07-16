import {
  type ClarityValue,
  decodeClarityHex,
} from "@stx-labs/signer-sidekick-protocol/clarity-codecs";
import {
  parseContractPrincipal,
  validatePrincipal,
} from "@stx-labs/signer-sidekick-protocol/principals";
import { z } from "zod";

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
  .transform((value) => value.toLowerCase());

const apiStatusSchema = z.object({
  server_version: z.string(),
  status: z.string(),
  chain_tip: z.object({
    block_height: z.number().int().nonnegative(),
    block_hash: z.string(),
    index_block_hash: z.string(),
    burn_block_height: z.number().int().nonnegative(),
  }),
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

export type NodeInfo = z.infer<typeof nodeInfoSchema>;
export type PoxInfo = z.infer<typeof poxInfoSchema>;
export type ApiStatus = z.infer<typeof apiStatusSchema>;
export type ContractSource = z.infer<typeof contractSourceSchema>;
export type ContractInterface = z.infer<typeof contractInterfaceSchema>;
export type SignerStakersPage = z.infer<typeof signerStakersPageSchema>;
export type SmartContractLogPage = z.infer<typeof smartContractLogPageSchema>;
export type TransactionSummary = z.infer<typeof transactionSummarySchema>;

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

  getPoxInfo(): Promise<PoxInfo> {
    return fetchJson(this.fetchImpl, `${this.baseUrl}/v2/pox`, poxInfoSchema);
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

  async getDataVar(principal: string, variableName: string): Promise<ClarityValue> {
    const { address, contractName } = parseContractPrincipal(principal);
    if (!clarityFunctionNamePattern.test(variableName)) {
      throw new Error("Invalid Clarity data variable name");
    }
    const response = await fetchJson(
      this.fetchImpl,
      `${this.baseUrl}/v2/data_var/${encodeURIComponent(address)}/${encodeURIComponent(contractName)}/${encodeURIComponent(variableName)}?proof=0`,
      clarityDataResponseSchema,
    );
    return decodeClarityHex(response.data);
  }

  async getMapEntry(principal: string, mapName: string, key: string): Promise<ClarityValue> {
    const { address, contractName } = parseContractPrincipal(principal);
    if (!clarityFunctionNamePattern.test(mapName)) throw new Error("Invalid Clarity map name");
    if (!clarityHexPattern.test(key)) {
      throw new Error("Map key must be a hex-encoded Clarity value");
    }
    const response = await fetchJson(
      this.fetchImpl,
      `${this.baseUrl}/v2/map_entry/${encodeURIComponent(address)}/${encodeURIComponent(contractName)}/${encodeURIComponent(mapName)}?proof=0`,
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
      `${this.baseUrl}/v2/contracts/call-read/${encodeURIComponent(address)}/${encodeURIComponent(contractName)}/${encodeURIComponent(functionName)}`,
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
}
