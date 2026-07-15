import { resolve } from "node:path";
import { z } from "zod";

export const sidekickNetworkSchema = z.enum(["mainnet", "testnet", "devnet", "regtest"]);
export type SidekickNetwork = z.infer<typeof sidekickNetworkSchema>;

const defaults: Partial<Record<SidekickNetwork, string>> = {
  mainnet: "https://api.mainnet.hiro.so",
  testnet: "https://api.testnet.hiro.so",
};

export interface SidekickConfig {
  network: SidekickNetwork;
  nodeRpcUrl: string;
  apiUrl: string;
  apiKey?: string;
  apiKeyHeader: string;
  maxApiBurnBlockLag: number;
  databasePath: string;
}

function parseUrl(value: string, name: string): string {
  const parsed = z.url().parse(value);
  const url = new URL(parsed);
  if (url.username || url.password) throw new Error(`${name} must not contain credentials`);
  if (url.search || url.hash) {
    throw new Error(`${name} must not contain query parameters or a fragment`);
  }
  return url.toString().replace(/\/$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv): SidekickConfig {
  const network = sidekickNetworkSchema.parse(env.SIDEKICK_NETWORK ?? "mainnet");
  const nodeRpcUrl = env.STACKS_NODE_RPC_URL;
  if (!nodeRpcUrl) throw new Error("STACKS_NODE_RPC_URL is required");

  const apiUrl = env.STACKS_API_URL ?? defaults[network];
  if (!apiUrl) throw new Error(`STACKS_API_URL is required for ${network}`);

  const maxApiBurnBlockLag = z.coerce
    .number()
    .int()
    .nonnegative()
    .default(12)
    .parse(env.SIDEKICK_MAX_API_BURN_BLOCK_LAG);

  return {
    network,
    nodeRpcUrl: parseUrl(nodeRpcUrl, "STACKS_NODE_RPC_URL"),
    apiUrl: parseUrl(apiUrl, "STACKS_API_URL"),
    ...(env.STACKS_API_KEY ? { apiKey: env.STACKS_API_KEY } : {}),
    apiKeyHeader: env.STACKS_API_KEY_HEADER ?? "x-api-key",
    maxApiBurnBlockLag,
    databasePath:
      env.SIDEKICK_DATABASE_PATH === ":memory:"
        ? ":memory:"
        : resolve(env.SIDEKICK_DATABASE_PATH ?? "data/sidekick.sqlite"),
  };
}

export function redactConfig(config: SidekickConfig): Omit<SidekickConfig, "apiKey"> & {
  apiKeyConfigured: boolean;
} {
  const { apiKey, ...publicConfig } = config;
  return { ...publicConfig, apiKeyConfigured: Boolean(apiKey) };
}
