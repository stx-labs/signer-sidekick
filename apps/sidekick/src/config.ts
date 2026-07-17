import { resolve } from "node:path";
import { z } from "zod";

export const sidekickNetworkSchema = z.enum(["mainnet", "testnet", "devnet", "regtest"]);
export type SidekickNetwork = z.infer<typeof sidekickNetworkSchema>;

function parseConfiguredNetwork(value: string | undefined): SidekickNetwork {
  const configured = value ?? "mainnet";
  if (configured === "pox5-testnet") return "testnet";
  if (configured === "testnet") {
    throw new Error(
      "SIDEKICK_NETWORK=testnet refers to the PoX-4 Stacks testnet, which Sidekick does not support; use pox5-testnet for the dedicated PoX-5 Testnet",
    );
  }
  return sidekickNetworkSchema.parse(configured);
}

const defaults: Partial<Record<SidekickNetwork, string>> = {
  mainnet: "https://api.mainnet.hiro.so",
  testnet: "https://api.testnet-pox5.hiro.so",
};

const hiroReferenceDefaults: Partial<Record<SidekickNetwork, string>> = {
  mainnet: "https://api.mainnet.hiro.so",
  testnet: "https://api.testnet-pox5.hiro.so",
};

const forbiddenKeyMaterialEnvironmentVariables = [
  "SIDEKICK_ADMIN_KEY",
  "SIDEKICK_ADMIN_PRIVATE_KEY",
  "SIDEKICK_SIGNER_PRIVATE_KEY",
  "MANAGER_ADMIN_KEY",
  "MANAGER_ADMIN_PRIVATE_KEY",
  "SIGNER_PRIVATE_KEY",
  "STACKS_ADMIN_KEY",
  "STACKS_ADMIN_PRIVATE_KEY",
  "STACKS_PRIVATE_KEY",
  "STACKS_SIGNER_PRIVATE_KEY",
  "ADMIN_MNEMONIC",
  "SIGNER_MNEMONIC",
  "STACKS_MNEMONIC",
  "MNEMONIC",
  "SEED_PHRASE",
] as const;

export interface SidekickConfig {
  network: SidekickNetwork;
  nodeRpcUrl: string;
  apiUrl: string;
  apiKey?: string;
  apiKeyHeader: string;
  maxApiBurnBlockLag: number;
  forecastHorizonCycles: number;
  stakerPageLimit: number;
  eventPageLimit: number;
  databasePath: string;
  expectedNetworkId?: number;
  trustedManagerProfilesDirectory?: string;
  compatibilityProfilesDirectory?: string;
  nodeMetricsUrl?: string;
  signerMonitoringUrl?: string;
  hiroReferenceApiUrl?: string;
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(z.url().parse(value));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function parseEndpointUrl(value: string, name: string): string {
  const parsed = z.url().parse(value);
  const url = new URL(parsed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  if (url.username || url.password) throw new Error(`${name} must not contain credentials`);
  if (url.search || url.hash) {
    throw new Error(`${name} must not contain query parameters or a fragment`);
  }
  return url.toString().replace(/\/$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv): SidekickConfig {
  const forbiddenName = forbiddenKeyMaterialEnvironmentVariables.find((name) => env[name]?.trim());
  if (forbiddenName) {
    throw new Error(
      `${forbiddenName} is forbidden: Sidekick never accepts manager admin or signer key material`,
    );
  }
  const network = parseConfiguredNetwork(env.SIDEKICK_NETWORK);
  const nodeRpcUrl = env.STACKS_NODE_RPC_URL;
  if (!nodeRpcUrl) throw new Error("STACKS_NODE_RPC_URL is required");

  const apiUrl = env.STACKS_API_URL?.trim() || defaults[network];
  if (!apiUrl) throw new Error(`STACKS_API_URL is required for ${network}`);

  const maxApiBurnBlockLag = z.coerce
    .number()
    .int()
    .nonnegative()
    .default(12)
    .parse(env.SIDEKICK_MAX_API_BURN_BLOCK_LAG);
  const forecastHorizonCycles = z.coerce
    .number()
    .int()
    .min(1)
    .max(96)
    .default(6)
    .parse(env.SIDEKICK_FORECAST_HORIZON_CYCLES);
  const expectedNetworkId = env.SIDEKICK_NETWORK_ID?.trim()
    ? z.coerce.number().int().nonnegative().max(0xffff_ffff).parse(env.SIDEKICK_NETWORK_ID)
    : undefined;
  const stakerPageLimit = z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .default(200)
    .parse(env.SIDEKICK_STAKER_PAGE_LIMIT);
  const eventPageLimit = z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(100)
    .parse(env.SIDEKICK_EVENT_PAGE_LIMIT);

  return {
    network,
    nodeRpcUrl: parseEndpointUrl(nodeRpcUrl, "STACKS_NODE_RPC_URL"),
    apiUrl: parseEndpointUrl(apiUrl, "STACKS_API_URL"),
    ...(env.STACKS_API_KEY ? { apiKey: env.STACKS_API_KEY } : {}),
    apiKeyHeader: env.STACKS_API_KEY_HEADER ?? "x-api-key",
    maxApiBurnBlockLag,
    forecastHorizonCycles,
    stakerPageLimit,
    eventPageLimit,
    databasePath:
      env.SIDEKICK_DATABASE_PATH === ":memory:"
        ? ":memory:"
        : resolve(env.SIDEKICK_DATABASE_PATH ?? "data/sidekick.sqlite"),
    ...(expectedNetworkId !== undefined ? { expectedNetworkId } : {}),
    ...(env.SIDEKICK_TRUSTED_MANAGER_PROFILES_DIR?.trim()
      ? {
          trustedManagerProfilesDirectory: resolve(
            env.SIDEKICK_TRUSTED_MANAGER_PROFILES_DIR.trim(),
          ),
        }
      : {}),
    ...(env.SIDEKICK_COMPATIBILITY_PROFILES_DIR?.trim()
      ? {
          compatibilityProfilesDirectory: resolve(env.SIDEKICK_COMPATIBILITY_PROFILES_DIR.trim()),
        }
      : {}),
    ...(env.STACKS_NODE_METRICS_URL?.trim()
      ? {
          nodeMetricsUrl: parseEndpointUrl(
            env.STACKS_NODE_METRICS_URL.trim(),
            "STACKS_NODE_METRICS_URL",
          ),
        }
      : {}),
    ...(env.STACKS_SIGNER_MONITORING_URL?.trim()
      ? {
          signerMonitoringUrl: parseEndpointUrl(
            env.STACKS_SIGNER_MONITORING_URL.trim(),
            "STACKS_SIGNER_MONITORING_URL",
          ),
        }
      : {}),
    ...(env.HIRO_REFERENCE_API_URL?.trim() || hiroReferenceDefaults[network]
      ? {
          hiroReferenceApiUrl: parseEndpointUrl(
            env.HIRO_REFERENCE_API_URL?.trim() || hiroReferenceDefaults[network] || "",
            "HIRO_REFERENCE_API_URL",
          ),
        }
      : {}),
  };
}

export function redactConfig(config: SidekickConfig): Omit<SidekickConfig, "apiKey"> & {
  apiKeyConfigured: boolean;
} {
  const { apiKey, ...publicConfig } = config;
  return { ...publicConfig, apiKeyConfigured: Boolean(apiKey) };
}
