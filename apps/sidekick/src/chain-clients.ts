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
  network_id: z.number().int(),
  burn_block_height: z.number().int().nonnegative(),
  stacks_tip_height: z.number().int().nonnegative(),
});

const poxInfoSchema = z.object({
  current_burnchain_block_height: z.number().int().nonnegative(),
  reward_cycle_id: z.number().int().nonnegative(),
  reward_cycle_length: z.number().int().positive(),
  prepare_cycle_length: z.number().int().nonnegative(),
  contract_id: z.string(),
  current_cycle: z
    .object({
      id: z.number().int().nonnegative(),
      min_threshold_ustx: z.number().int().nonnegative(),
      stacked_ustx: z.number().int().nonnegative(),
      is_pox_active: z.boolean(),
    })
    .optional(),
  next_cycle: z
    .object({
      id: z.number().int().nonnegative(),
      min_threshold_ustx: z.number().int().nonnegative(),
      min_increment_ustx: z.number().int().nonnegative(),
      stacked_ustx: z.number().int().nonnegative(),
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

export type NodeInfo = z.infer<typeof nodeInfoSchema>;
export type PoxInfo = z.infer<typeof poxInfoSchema>;
export type ApiStatus = z.infer<typeof apiStatusSchema>;
export type ContractSource = z.infer<typeof contractSourceSchema>;
export type ContractInterface = z.infer<typeof contractInterfaceSchema>;
export type SignerStakersPage = z.infer<typeof signerStakersPageSchema>;

type Fetch = typeof fetch;

async function fetchJson<T>(
  fetchImpl: Fetch,
  url: string,
  schema: z.ZodType<T>,
  request: RequestInit = {},
): Promise<T> {
  const requestWithTimeout: RequestInit = {
    ...request,
    signal: AbortSignal.timeout(10_000),
  };

  const response = await fetchImpl(url, requestWithTimeout);
  if (!response.ok) {
    throw new Error(
      `${new URL(url).origin}${new URL(url).pathname} returned HTTP ${response.status}`,
    );
  }
  return schema.parse(await response.json());
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
}
