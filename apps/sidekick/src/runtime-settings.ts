import { z } from "zod";
import { StacksApiClient, StacksNodeClient } from "./chain-clients.js";
import {
  hiroReferenceApiCredential,
  isHttpUrl,
  parseApiKeyHeader,
  parseEndpointUrl,
  type SidekickConfig,
} from "./config.js";
import { validateHealthEndpointForSave } from "./health-http.js";
import { indexedWorkflowsReady, runOperatorPreflight } from "./preflight.js";
import { currentInteractiveRequestSignal } from "./request-context.js";
import type { RuntimeApiCredentials } from "./storage/runtime-settings-repository.js";
import type { SidekickStore } from "./storage/store.js";
import type { TransactionFeePolicy } from "./transaction-engine/fee-policy.js";
import { OperatorWorkflowError } from "./workflow-error.js";

const optionalUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((value) => value === "" || isHttpUrl(value), "Expected an HTTP(S) URL");

const supportContactSchema = z
  .string()
  .trim()
  .max(200)
  .refine(
    (value) => value === "" || z.email().safeParse(value).success || isHttpUrl(value),
    "Expected an email address or HTTP(S) URL",
  );

const feeUstxSchema = z.number().int().min(1).max(10_000_000);
/**
 * Reward-run fee band (Settings → Reward runs). The engine pays the local node's estimate for the
 * exact transaction clamped into this band, and the floor when the node has no estimate; the
 * deployment's SIDEKICK_ENGINE_MAXIMUM_FEE_USTX stays the hard cap. The defaults mirror the Leather
 * wallet's standard contract-call band (0.003–0.01 STX), which is what clears on mainnet while
 * bot-driven estimate spikes come and go.
 */
const engineSettingsSchema = z
  .object({ minimumFeeUstx: feeUstxSchema, standardFeeUstx: feeUstxSchema })
  .strict();
export const DEFAULT_ENGINE_SETTINGS = { minimumFeeUstx: 3_000, standardFeeUstx: 10_000 } as const;
export type EngineRuntimeSettings = z.infer<typeof engineSettingsSchema>;

const legacyPersistedRuntimeSettingsSchema = z
  .object({
    schemaVersion: z.literal(1),
    pool: z
      .object({
        displayName: z.string().trim().min(1).max(80),
        websiteUrl: optionalUrlSchema,
        supportContact: supportContactSchema,
        leatherUrl: z.string().refine(isHttpUrl, "Expected an HTTP(S) URL"),
      })
      .strict(),
    display: z
      .object({
        defaultTheme: z.enum(["light", "dark", "system"]),
      })
      .strict(),
    dataSources: z
      .object({
        nodeRpcUrl: z.string(),
        apiUrl: z.string(),
        apiKeyHeader: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
        apiKeyMode: z.enum(["environment", "database", "none"]),
        nodeMetricsUrl: optionalUrlSchema.default(""),
        signerMonitoringUrl: optionalUrlSchema.default(""),
        hiroReferenceApiUrl: optionalUrlSchema.default(""),
      })
      .strict(),
    forecast: z
      .object({
        horizonCycles: z.number().int().min(1).max(96),
      })
      .strict(),
    embed: z
      .object({
        publicApiUrl: z.string(),
      })
      .strict(),
  })
  .strict();

const persistedRuntimeSettingsSchema = z
  .object({
    schemaVersion: z.literal(2),
    pool: legacyPersistedRuntimeSettingsSchema.shape.pool,
    display: legacyPersistedRuntimeSettingsSchema.shape.display,
    dataSources: z
      .object({
        nodeRpcUrl: z.string(),
        apiUrl: z.string(),
        apiKeyHeader: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
        nodeMetricsUrl: optionalUrlSchema.default(""),
        signerMonitoringUrl: optionalUrlSchema.default(""),
        hiroReferenceApiUrl: optionalUrlSchema.default(""),
        hiroReferenceApiKeyHeader: z
          .string()
          .regex(/^[A-Za-z0-9-]{1,100}$/)
          .default("x-api-key"),
      })
      .strict(),
    forecast: legacyPersistedRuntimeSettingsSchema.shape.forecast,
    embed: legacyPersistedRuntimeSettingsSchema.shape.embed,
    // Rows written before the band existed read back with the defaults; no schema bump needed.
    engine: engineSettingsSchema.default({ ...DEFAULT_ENGINE_SETTINGS }),
  })
  .strict();

export type PersistedRuntimeSettings = z.infer<typeof persistedRuntimeSettingsSchema>;

const apiKeyActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("keep") }).strict(),
  z.object({ action: z.literal("remove-override") }).strict(),
  z.object({ action: z.literal("replace"), value: z.string().min(1).max(2_000) }).strict(),
]);

export const runtimeSettingsUpdateSchema = persistedRuntimeSettingsSchema
  .omit({ schemaVersion: true })
  .extend({
    dataSources: persistedRuntimeSettingsSchema.shape.dataSources
      .extend({
        apiKeyAction: apiKeyActionSchema.default({ action: "keep" }),
        hiroReferenceApiKeyAction: apiKeyActionSchema.default({ action: "keep" }),
      })
      .strict(),
    // Omitted by older dashboards: keep the stored band rather than resetting it to the default.
    engine: engineSettingsSchema.optional(),
  })
  .strict();

export type RuntimeSettingsSourceValidator = (
  config: SidekickConfig,
  node: StacksNodeClient,
  api: StacksApiClient,
) => Promise<void>;

export interface PublicRuntimeSettings {
  schemaVersion: 2;
  revision: number;
  updatedAt: string | null;
  pool: PersistedRuntimeSettings["pool"];
  display: PersistedRuntimeSettings["display"];
  dataSources: PersistedRuntimeSettings["dataSources"] & {
    apiKeyConfigured: boolean;
    apiKeySource: "environment" | "database" | "none";
    hiroReferenceApiKeyConfigured: boolean;
    hiroReferenceApiKeySource: "environment" | "database" | "indexed-api" | "none";
  };
  forecast: PersistedRuntimeSettings["forecast"];
  embed: PersistedRuntimeSettings["embed"];
  /** Stored fee band plus the deployment's hard cap, so the UI can show the whole policy. */
  engine: EngineRuntimeSettings & { maximumFeeUstx: number };
  audit: Array<{ revision: number; changedFields: string[]; changedAt: string }>;
}

function publicApiDefault(config: SidekickConfig): string {
  if (config.network === "mainnet") return "https://api.mainnet.hiro.so";
  if (config.network === "testnet") return "https://api.testnet-pox5.hiro.so";
  return config.apiUrl;
}

function defaults(config: SidekickConfig): PersistedRuntimeSettings {
  return {
    schemaVersion: 2,
    pool: {
      displayName: "Stacks Pool",
      websiteUrl: "",
      supportContact: "",
      leatherUrl: "https://earn.leather.io",
    },
    display: {
      defaultTheme: "system",
    },
    dataSources: {
      nodeRpcUrl: config.nodeRpcUrl,
      apiUrl: config.apiUrl,
      apiKeyHeader: config.apiKeyHeader,
      nodeMetricsUrl: config.nodeMetricsUrl ?? "",
      signerMonitoringUrl: config.signerMonitoringUrl ?? "",
      hiroReferenceApiUrl: config.hiroReferenceApiUrl ?? "",
      hiroReferenceApiKeyHeader: config.hiroReferenceApiKeyHeader,
    },
    forecast: { horizonCycles: config.forecastHorizonCycles },
    embed: { publicApiUrl: publicApiDefault(config) },
    engine: { ...DEFAULT_ENGINE_SETTINGS },
  };
}

function migratePersistedSettings(
  input: unknown,
  config: SidekickConfig,
): PersistedRuntimeSettings {
  const current = persistedRuntimeSettingsSchema.safeParse(input);
  if (current.success) return current.data;
  const legacy = legacyPersistedRuntimeSettingsSchema.parse(input);
  return persistedRuntimeSettingsSchema.parse({
    schemaVersion: 2,
    pool: legacy.pool,
    display: legacy.display,
    dataSources: {
      nodeRpcUrl: legacy.dataSources.nodeRpcUrl,
      apiUrl: legacy.dataSources.apiUrl,
      apiKeyHeader: legacy.dataSources.apiKeyHeader,
      nodeMetricsUrl: legacy.dataSources.nodeMetricsUrl,
      signerMonitoringUrl: legacy.dataSources.signerMonitoringUrl,
      hiroReferenceApiUrl: legacy.dataSources.hiroReferenceApiUrl,
      hiroReferenceApiKeyHeader: config.hiroReferenceApiKeyHeader,
    },
    forecast: legacy.forecast,
    embed: legacy.embed,
  });
}

function sameOrigin(left: string, right: string): boolean {
  return new URL(left).origin === new URL(right).origin;
}

function storedCredentialForUrl(
  credential: RuntimeApiCredentials[keyof RuntimeApiCredentials],
  url: string,
) {
  return credential && sameOrigin(credential.boundUrl, url) ? credential : undefined;
}

function changedFields(
  previous: PersistedRuntimeSettings,
  next: PersistedRuntimeSettings,
  changedCredentialSources: ReadonlySet<keyof RuntimeApiCredentials>,
): string[] {
  const fields: string[] = [];
  for (const section of [
    "pool",
    "display",
    "dataSources",
    "forecast",
    "embed",
    "engine",
  ] as const) {
    const before = previous[section] as Record<string, unknown>;
    const after = next[section] as Record<string, unknown>;
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key]))
        fields.push(`${section}.${key}`);
    }
  }
  if (changedCredentialSources.has("indexed-api")) fields.push("dataSources.apiKey");
  if (changedCredentialSources.has("reference-api")) fields.push("dataSources.hiroReferenceApiKey");
  return fields;
}

export class RuntimeSettingsController {
  private settings: PersistedRuntimeSettings;
  private apiCredentials: RuntimeApiCredentials;
  private revision: number;
  private updatedAt: string | null;

  constructor(
    private readonly baseConfig: SidekickConfig,
    private readonly store: SidekickStore,
    _managerPrincipal: string,
    private readonly validateSources: RuntimeSettingsSourceValidator = async (
      config,
      node,
      api,
    ) => {
      const preflight = await runOperatorPreflight(config, node, api);
      if (!indexedWorkflowsReady(preflight)) {
        const reason = preflight.checks.find(
          ({ id, status }) =>
            status === "fail" ||
            (["api-availability", "api-network", "api-version", "api-status"].includes(id) &&
              status !== "pass"),
        )?.message;
        throw new OperatorWorkflowError(
          422,
          "runtime_settings_sources_rejected",
          reason ?? "Candidate node and API failed preflight",
        );
      }
    },
    /** Deployment bounds the stored settings may not exceed. */
    private readonly bounds: { engineMaximumFeeUstx: bigint } = { engineMaximumFeeUstx: 100_000n },
  ) {
    const stored = store.runtimeSettings.get();
    this.settings = stored
      ? migratePersistedSettings(stored.settings, baseConfig)
      : defaults(baseConfig);
    this.apiCredentials = stored?.apiCredentials ?? {};
    this.revision = stored?.revision ?? 0;
    this.updatedAt = stored?.updatedAt ?? null;
  }

  effectiveConfig(): SidekickConfig {
    return this.configFor(this.settings, this.apiCredentials);
  }

  /** Live reward-run fee policy: the stored band under the deployment's hard cap. */
  feePolicy(): TransactionFeePolicy {
    return {
      minimumFeeUstx: BigInt(this.settings.engine.minimumFeeUstx),
      standardFeeUstx: BigInt(this.settings.engine.standardFeeUstx),
      maximumFeeUstx: this.bounds.engineMaximumFeeUstx,
    };
  }

  private configFor(
    settings: PersistedRuntimeSettings,
    apiCredentials: RuntimeApiCredentials,
  ): SidekickConfig {
    const indexedStoredCredential = storedCredentialForUrl(
      apiCredentials["indexed-api"],
      settings.dataSources.apiUrl,
    );
    const indexedEnvironmentCredential =
      this.baseConfig.apiKey &&
      this.baseConfig.apiKeyOrigin &&
      new URL(settings.dataSources.apiUrl).origin === this.baseConfig.apiKeyOrigin
        ? this.baseConfig.apiKey
        : undefined;
    const referenceStoredCredential = settings.dataSources.hiroReferenceApiUrl
      ? storedCredentialForUrl(
          apiCredentials["reference-api"],
          settings.dataSources.hiroReferenceApiUrl,
        )
      : undefined;
    const referenceEnvironmentCredential =
      this.baseConfig.hiroReferenceApiKey &&
      this.baseConfig.hiroReferenceApiKeyOrigin &&
      settings.dataSources.hiroReferenceApiUrl &&
      new URL(settings.dataSources.hiroReferenceApiUrl).origin ===
        this.baseConfig.hiroReferenceApiKeyOrigin
        ? this.baseConfig.hiroReferenceApiKey
        : undefined;
    const apiKey = indexedStoredCredential?.value ?? indexedEnvironmentCredential;
    const hiroReferenceApiKey = referenceStoredCredential?.value ?? referenceEnvironmentCredential;
    const {
      apiKey: _baseApiKey,
      apiKeyOrigin: _baseApiKeyOrigin,
      hiroReferenceApiKey: _baseHiroReferenceApiKey,
      hiroReferenceApiKeyOrigin: _baseHiroReferenceApiKeyOrigin,
      nodeMetricsUrl: _baseNodeMetricsUrl,
      signerMonitoringUrl: _baseSignerMonitoringUrl,
      hiroReferenceApiUrl: _baseHiroReferenceApiUrl,
      ...baseConfig
    } = this.baseConfig;
    return {
      ...baseConfig,
      nodeRpcUrl: settings.dataSources.nodeRpcUrl,
      apiUrl: settings.dataSources.apiUrl,
      ...(apiKey ? { apiKey } : {}),
      ...(apiKey ? { apiKeyOrigin: new URL(settings.dataSources.apiUrl).origin } : {}),
      apiKeyHeader: parseApiKeyHeader(
        settings.dataSources.apiKeyHeader,
        "Indexed chain API key header",
      ),
      forecastHorizonCycles: settings.forecast.horizonCycles,
      ...(settings.dataSources.nodeMetricsUrl
        ? { nodeMetricsUrl: settings.dataSources.nodeMetricsUrl }
        : {}),
      ...(settings.dataSources.signerMonitoringUrl
        ? { signerMonitoringUrl: settings.dataSources.signerMonitoringUrl }
        : {}),
      ...(settings.dataSources.hiroReferenceApiUrl
        ? { hiroReferenceApiUrl: settings.dataSources.hiroReferenceApiUrl }
        : {}),
      ...(hiroReferenceApiKey ? { hiroReferenceApiKey } : {}),
      ...(hiroReferenceApiKey && settings.dataSources.hiroReferenceApiUrl
        ? {
            hiroReferenceApiKeyOrigin: new URL(settings.dataSources.hiroReferenceApiUrl).origin,
          }
        : {}),
      hiroReferenceApiKeyHeader: parseApiKeyHeader(
        settings.dataSources.hiroReferenceApiKeyHeader,
        "Network comparison API key header",
      ),
    };
  }

  clients(): { config: SidekickConfig; node: StacksNodeClient; api: StacksApiClient } {
    const config = this.effectiveConfig();
    return {
      config,
      node: new StacksNodeClient(config.nodeRpcUrl),
      api: new StacksApiClient(config.apiUrl, config.apiKey, config.apiKeyHeader),
    };
  }

  publicSettings(): PublicRuntimeSettings {
    const config = this.effectiveConfig();
    const indexedStoredCredential = storedCredentialForUrl(
      this.apiCredentials["indexed-api"],
      this.settings.dataSources.apiUrl,
    );
    const referenceStoredCredential = this.settings.dataSources.hiroReferenceApiUrl
      ? storedCredentialForUrl(
          this.apiCredentials["reference-api"],
          this.settings.dataSources.hiroReferenceApiUrl,
        )
      : undefined;
    const referenceCredential = hiroReferenceApiCredential(config);
    const referenceCredentialSource = referenceStoredCredential
      ? "database"
      : config.hiroReferenceApiKey
        ? "environment"
        : referenceCredential
          ? "indexed-api"
          : "none";
    return {
      schemaVersion: 2,
      revision: this.revision,
      updatedAt: this.updatedAt,
      pool: this.settings.pool,
      display: this.settings.display,
      dataSources: {
        nodeRpcUrl: this.settings.dataSources.nodeRpcUrl,
        apiUrl: this.settings.dataSources.apiUrl,
        apiKeyHeader: this.settings.dataSources.apiKeyHeader,
        apiKeyConfigured: Boolean(config.apiKey),
        apiKeySource: indexedStoredCredential ? "database" : config.apiKey ? "environment" : "none",
        nodeMetricsUrl: this.settings.dataSources.nodeMetricsUrl,
        signerMonitoringUrl: this.settings.dataSources.signerMonitoringUrl,
        hiroReferenceApiUrl: this.settings.dataSources.hiroReferenceApiUrl,
        hiroReferenceApiKeyHeader: this.settings.dataSources.hiroReferenceApiKeyHeader,
        hiroReferenceApiKeyConfigured: Boolean(referenceCredential),
        hiroReferenceApiKeySource: referenceCredentialSource,
      },
      forecast: this.settings.forecast,
      embed: this.settings.embed,
      engine: {
        ...this.settings.engine,
        maximumFeeUstx: Number(this.bounds.engineMaximumFeeUstx),
      },
      audit: this.store.runtimeSettings.listAudit(),
    };
  }

  async update(
    input: unknown,
    observedAt = new Date().toISOString(),
  ): Promise<PublicRuntimeSettings> {
    const requestSignal = currentInteractiveRequestSignal();
    requestSignal?.throwIfAborted();
    const parsed = runtimeSettingsUpdateSchema.safeParse(input);
    if (!parsed.success) {
      throw new OperatorWorkflowError(
        400,
        "invalid_runtime_settings",
        parsed.error.issues[0]?.message ?? "Invalid runtime settings",
      );
    }
    const value = parsed.data;
    const engine = value.engine ?? this.settings.engine;
    if (
      engine.minimumFeeUstx > engine.standardFeeUstx ||
      BigInt(engine.standardFeeUstx) > this.bounds.engineMaximumFeeUstx
    ) {
      throw new OperatorWorkflowError(
        400,
        "invalid_runtime_settings",
        `Fee band must satisfy minimum ≤ standard ≤ the deployment cap of ${Number(this.bounds.engineMaximumFeeUstx) / 1_000_000} STX`,
      );
    }
    let nodeRpcUrl: string;
    let apiUrl: string;
    let publicApiUrl: string;
    let apiKeyHeader: string;
    let hiroReferenceApiKeyHeader: string;
    try {
      nodeRpcUrl = parseEndpointUrl(value.dataSources.nodeRpcUrl, "Stacks node RPC URL");
      apiUrl = parseEndpointUrl(value.dataSources.apiUrl, "Stacks API URL");
      publicApiUrl = parseEndpointUrl(value.embed.publicApiUrl, "Public embed API URL");
      apiKeyHeader = parseApiKeyHeader(
        value.dataSources.apiKeyHeader,
        "Indexed chain API key header",
      );
      hiroReferenceApiKeyHeader = parseApiKeyHeader(
        value.dataSources.hiroReferenceApiKeyHeader,
        "Network comparison API key header",
      );
    } catch (error) {
      throw new OperatorWorkflowError(
        400,
        "invalid_runtime_settings",
        error instanceof Error ? error.message : "Invalid runtime settings",
      );
    }
    const nodeMetricsUrl = value.dataSources.nodeMetricsUrl
      ? await validateHealthEndpointForSave(
          value.dataSources.nodeMetricsUrl,
          "Node metrics URL",
          requestSignal,
        )
      : "";
    const signerMonitoringUrl = value.dataSources.signerMonitoringUrl
      ? await validateHealthEndpointForSave(
          value.dataSources.signerMonitoringUrl,
          "Signer monitoring URL",
          requestSignal,
        )
      : "";
    const hiroReferenceApiUrl = value.dataSources.hiroReferenceApiUrl
      ? await validateHealthEndpointForSave(
          value.dataSources.hiroReferenceApiUrl,
          "Hiro reference API URL",
          requestSignal,
        )
      : "";
    if (value.dataSources.hiroReferenceApiKeyAction.action === "replace" && !hiroReferenceApiUrl) {
      throw new OperatorWorkflowError(
        400,
        "invalid_runtime_settings",
        "Configure the network comparison API URL before adding its key",
      );
    }
    const nextCredentials: RuntimeApiCredentials = { ...this.apiCredentials };
    const changedCredentialSources = new Set<keyof RuntimeApiCredentials>();
    const applyCredentialAction = (
      source: keyof RuntimeApiCredentials,
      action: z.infer<typeof apiKeyActionSchema>,
      boundUrl: string,
    ) => {
      if (action.action === "keep") {
        const current = nextCredentials[source];
        if (!current || (boundUrl && sameOrigin(current.boundUrl, boundUrl))) return;
      }
      const previous = nextCredentials[source];
      if (action.action === "replace") nextCredentials[source] = { value: action.value, boundUrl };
      else delete nextCredentials[source];
      if (JSON.stringify(previous) !== JSON.stringify(nextCredentials[source]))
        changedCredentialSources.add(source);
    };
    applyCredentialAction("indexed-api", value.dataSources.apiKeyAction, apiUrl);
    applyCredentialAction(
      "reference-api",
      value.dataSources.hiroReferenceApiKeyAction,
      hiroReferenceApiUrl,
    );
    const next = persistedRuntimeSettingsSchema.parse({
      schemaVersion: 2,
      ...value,
      dataSources: {
        nodeRpcUrl,
        apiUrl,
        apiKeyHeader,
        nodeMetricsUrl,
        signerMonitoringUrl,
        hiroReferenceApiUrl,
        hiroReferenceApiKeyHeader,
      },
      embed: { publicApiUrl },
      engine,
    });
    const fields = changedFields(this.settings, next, changedCredentialSources);
    if (fields.length === 0) return this.publicSettings();
    if (fields.some((field) => field.startsWith("dataSources."))) {
      const candidateConfig = this.configFor(next, nextCredentials);
      await this.validateSources(
        candidateConfig,
        new StacksNodeClient(candidateConfig.nodeRpcUrl),
        new StacksApiClient(
          candidateConfig.apiUrl,
          candidateConfig.apiKey,
          candidateConfig.apiKeyHeader,
        ),
      );
    }
    requestSignal?.throwIfAborted();
    const stored = this.store.runtimeSettings.put({
      settings: next,
      apiCredentials: nextCredentials,
      changedFields: fields,
      observedAt,
    });
    this.settings = next;
    this.apiCredentials = nextCredentials;
    this.revision = stored.revision;
    this.updatedAt = stored.updatedAt;
    return this.publicSettings();
  }
}
