import { resolve } from "node:path";
import { parseContractPrincipal } from "@stx-labs/signer-sidekick-protocol/principals";
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

const networkDefaults: Partial<
  Record<SidekickNetwork, { apiUrl: string; hiroReferenceApiUrl: string }>
> = {
  mainnet: {
    apiUrl: "https://api.mainnet.hiro.so",
    hiroReferenceApiUrl: "https://api.mainnet.hiro.so",
  },
  testnet: {
    apiUrl: "https://api.testnet-pox5.hiro.so",
    hiroReferenceApiUrl: "https://api.testnet-pox5.hiro.so",
  },
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
  "SIDEKICK_GAS_PAYER_KEY",
  "SIDEKICK_GAS_PAYER_PRIVATE_KEY",
  "SIDEKICK_GAS_PAYER_MNEMONIC",
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
  apiKeyOrigin?: string;
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
  hiroReferenceApiKey?: string;
  hiroReferenceApiKeyOrigin?: string;
  hiroReferenceApiKeyHeader: string;
}

export interface ApiCredential {
  headerName: string;
  value: string;
}

const defaultNetworkIds: Record<SidekickNetwork, number> = {
  mainnet: 1,
  testnet: 0x80000005,
  devnet: 0x80000000,
  regtest: 0x80000000,
};

export function configuredNetworkId(
  config: Pick<SidekickConfig, "network" | "expectedNetworkId">,
): number {
  return config.expectedNetworkId ?? defaultNetworkIds[config.network];
}

export function loadManagerPrincipal(env: NodeJS.ProcessEnv): string {
  const managerPrincipal = env.SIDEKICK_MANAGER_PRINCIPAL?.trim();
  if (!managerPrincipal) throw new Error("SIDEKICK_MANAGER_PRINCIPAL is required");
  try {
    parseContractPrincipal(managerPrincipal);
  } catch {
    throw new Error("SIDEKICK_MANAGER_PRINCIPAL must be a valid contract principal");
  }
  return managerPrincipal;
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

const apiKeyHeaderSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{1,100}$/)
  .refine(
    (value) =>
      !["connection", "content-length", "host", "transfer-encoding", "upgrade"].includes(
        value.toLowerCase(),
      ),
    "API key header cannot override HTTP transport headers",
  );

export function parseApiKeyHeader(value: string, name: string): string {
  try {
    return apiKeyHeaderSchema.parse(value);
  } catch (error) {
    throw new Error(`${name} is invalid`, { cause: error });
  }
}

export function indexedApiCredential(config: SidekickConfig): ApiCredential | undefined {
  return config.apiKey &&
    config.apiKeyOrigin &&
    new URL(config.apiUrl).origin === config.apiKeyOrigin
    ? { headerName: config.apiKeyHeader, value: config.apiKey }
    : undefined;
}

export function hiroReferenceApiCredential(config: SidekickConfig): ApiCredential | undefined {
  if (
    config.hiroReferenceApiKey &&
    config.hiroReferenceApiKeyOrigin &&
    config.hiroReferenceApiUrl &&
    new URL(config.hiroReferenceApiUrl).origin === config.hiroReferenceApiKeyOrigin
  ) {
    return {
      headerName: config.hiroReferenceApiKeyHeader,
      value: config.hiroReferenceApiKey,
    };
  }
  if (
    config.hiroReferenceApiUrl &&
    new URL(config.apiUrl).origin === new URL(config.hiroReferenceApiUrl).origin
  ) {
    return indexedApiCredential(config);
  }
  return undefined;
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

  const apiUrl = env.STACKS_API_URL?.trim() || networkDefaults[network]?.apiUrl;
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
    ...(env.STACKS_API_KEY
      ? { apiKey: env.STACKS_API_KEY, apiKeyOrigin: new URL(apiUrl).origin }
      : {}),
    apiKeyHeader: parseApiKeyHeader(
      env.STACKS_API_KEY_HEADER ?? "x-api-key",
      "STACKS_API_KEY_HEADER",
    ),
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
    ...(env.HIRO_REFERENCE_API_URL?.trim() || networkDefaults[network]?.hiroReferenceApiUrl
      ? {
          hiroReferenceApiUrl: parseEndpointUrl(
            env.HIRO_REFERENCE_API_URL?.trim() ||
              networkDefaults[network]?.hiroReferenceApiUrl ||
              "",
            "HIRO_REFERENCE_API_URL",
          ),
        }
      : {}),
    ...(env.HIRO_REFERENCE_API_KEY
      ? {
          hiroReferenceApiKey: env.HIRO_REFERENCE_API_KEY,
          hiroReferenceApiKeyOrigin: new URL(
            env.HIRO_REFERENCE_API_URL?.trim() ||
              networkDefaults[network]?.hiroReferenceApiUrl ||
              apiUrl,
          ).origin,
        }
      : {}),
    hiroReferenceApiKeyHeader: parseApiKeyHeader(
      env.HIRO_REFERENCE_API_KEY_HEADER ?? "x-api-key",
      "HIRO_REFERENCE_API_KEY_HEADER",
    ),
  };
}

export function redactConfig(config: SidekickConfig): Omit<
  SidekickConfig,
  "apiKey" | "apiKeyOrigin" | "hiroReferenceApiKey" | "hiroReferenceApiKeyOrigin"
> & {
  apiKeyConfigured: boolean;
  hiroReferenceApiKeyConfigured: boolean;
} {
  const {
    apiKey,
    apiKeyOrigin: _apiKeyOrigin,
    hiroReferenceApiKey,
    hiroReferenceApiKeyOrigin: _hiroReferenceApiKeyOrigin,
    ...publicConfig
  } = config;
  return {
    ...publicConfig,
    apiKeyConfigured: Boolean(indexedApiCredential(config)),
    hiroReferenceApiKeyConfigured: Boolean(hiroReferenceApiCredential(config)),
  };
}
