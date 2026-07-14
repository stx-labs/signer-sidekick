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
  contract_versions: z.array(
    z.object({
      contract_id: z.string(),
      activation_burnchain_block_height: z.number().int().nonnegative(),
      first_reward_cycle_id: z.number().int().nonnegative(),
    }),
  ),
});

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

export type NodeInfo = z.infer<typeof nodeInfoSchema>;
export type PoxInfo = z.infer<typeof poxInfoSchema>;
export type ApiStatus = z.infer<typeof apiStatusSchema>;

type Fetch = typeof fetch;

async function fetchJson<T>(
  fetchImpl: Fetch,
  url: string,
  schema: z.ZodType<T>,
  headers?: Record<string, string>,
): Promise<T> {
  const request: RequestInit = {
    signal: AbortSignal.timeout(10_000),
  };
  if (headers) request.headers = headers;

  const response = await fetchImpl(url, request);
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
    return fetchJson(this.fetchImpl, `${this.baseUrl}/v2/info`, nodeInfoSchema, this.headers);
  }

  getStatus(): Promise<ApiStatus> {
    return fetchJson(
      this.fetchImpl,
      `${this.baseUrl}/extended/v1/status`,
      apiStatusSchema,
      this.headers,
    );
  }
}
