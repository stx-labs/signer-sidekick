import { z } from "zod";
import { StacksApiClient, StacksNodeClient } from "./chain-clients.js";
import { isHttpUrl, parseEndpointUrl, type SidekickConfig } from "./config.js";
import { validateHealthEndpointForSave } from "./health-http.js";
import { indexedApiCompatible, runOperatorPreflight } from "./preflight.js";
import { currentInteractiveRequestSignal } from "./request-context.js";
import type { SidekickStore } from "./storage/store.js";
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

const persistedRuntimeSettingsSchema = z
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

export type PersistedRuntimeSettings = z.infer<typeof persistedRuntimeSettingsSchema>;

export const runtimeSettingsUpdateSchema = persistedRuntimeSettingsSchema
  .omit({ schemaVersion: true })
  .extend({
    dataSources: persistedRuntimeSettingsSchema.shape.dataSources
      .omit({ apiKeyMode: true })
      .extend({
        apiKeyAction: z.discriminatedUnion("action", [
          z.object({ action: z.literal("keep") }).strict(),
          z.object({ action: z.literal("clear") }).strict(),
          z.object({ action: z.literal("replace"), value: z.string().min(1).max(2_000) }).strict(),
        ]),
      })
      .strict(),
  })
  .strict();

export type RuntimeSettingsUpdate = z.infer<typeof runtimeSettingsUpdateSchema>;

export type RuntimeSettingsSourceValidator = (
  config: SidekickConfig,
  node: StacksNodeClient,
  api: StacksApiClient,
) => Promise<void>;

export interface PublicRuntimeSettings {
  schemaVersion: 1;
  revision: number;
  updatedAt: string | null;
  pool: PersistedRuntimeSettings["pool"];
  display: PersistedRuntimeSettings["display"];
  dataSources: Omit<PersistedRuntimeSettings["dataSources"], "apiKeyMode"> & {
    apiKeyConfigured: boolean;
    apiKeySource: "environment" | "database" | "none";
  };
  forecast: PersistedRuntimeSettings["forecast"];
  embed: PersistedRuntimeSettings["embed"];
  audit: Array<{ revision: number; changedFields: string[]; changedAt: string }>;
}

function withoutLegacySettings(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const {
    payoutPolicy: _payoutPolicy,
    automation: _automation,
    alerts: _alerts,
    ...settings
  } = input as Record<string, unknown>;
  const display = settings.display;
  const embed = settings.embed;
  return {
    ...settings,
    ...(display && typeof display === "object" && !Array.isArray(display)
      ? {
          display: {
            defaultTheme: (display as Record<string, unknown>).defaultTheme,
          },
        }
      : {}),
    ...(embed && typeof embed === "object" && !Array.isArray(embed)
      ? {
          embed: {
            publicApiUrl: (embed as Record<string, unknown>).publicApiUrl,
          },
        }
      : {}),
  };
}

function publicApiDefault(config: SidekickConfig): string {
  if (config.network === "mainnet") return "https://api.mainnet.hiro.so";
  if (config.network === "testnet") return "https://api.testnet-pox5.hiro.so";
  return config.apiUrl;
}

function defaults(config: SidekickConfig): PersistedRuntimeSettings {
  return {
    schemaVersion: 1,
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
      apiKeyMode: config.apiKey ? "environment" : "none",
      nodeMetricsUrl: config.nodeMetricsUrl ?? "",
      signerMonitoringUrl: config.signerMonitoringUrl ?? "",
      hiroReferenceApiUrl: config.hiroReferenceApiUrl ?? "",
    },
    forecast: { horizonCycles: config.forecastHorizonCycles },
    embed: { publicApiUrl: publicApiDefault(config) },
  };
}

function changedFields(
  previous: PersistedRuntimeSettings,
  next: PersistedRuntimeSettings,
  secretChanged: boolean,
): string[] {
  const fields: string[] = [];
  for (const section of ["pool", "display", "dataSources", "forecast", "embed"] as const) {
    const before = previous[section] as Record<string, unknown>;
    const after = next[section] as Record<string, unknown>;
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key]))
        fields.push(`${section}.${key}`);
    }
  }
  if (secretChanged && !fields.includes("dataSources.apiKey")) fields.push("dataSources.apiKey");
  return fields;
}

export class RuntimeSettingsController {
  private settings: PersistedRuntimeSettings;
  private apiKeySecret: string | null;
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
      if (preflight.status === "fail" || !indexedApiCompatible(preflight)) {
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
  ) {
    const stored = store.getRuntimeSettings();
    this.settings = stored
      ? persistedRuntimeSettingsSchema.parse(withoutLegacySettings(stored.settings))
      : defaults(baseConfig);
    this.apiKeySecret = stored?.apiKeySecret ?? null;
    this.revision = stored?.revision ?? 0;
    this.updatedAt = stored?.updatedAt ?? null;
  }

  effectiveConfig(): SidekickConfig {
    return this.configFor(this.settings, this.apiKeySecret);
  }

  private configFor(
    settings: PersistedRuntimeSettings,
    apiKeySecret: string | null,
  ): SidekickConfig {
    const apiKey =
      settings.dataSources.apiKeyMode === "database"
        ? (apiKeySecret ?? undefined)
        : settings.dataSources.apiKeyMode === "environment"
          ? this.baseConfig.apiKey
          : undefined;
    const { apiKey: _baseApiKey, ...baseConfig } = this.baseConfig;
    return {
      ...baseConfig,
      nodeRpcUrl: settings.dataSources.nodeRpcUrl,
      apiUrl: settings.dataSources.apiUrl,
      ...(apiKey ? { apiKey } : {}),
      apiKeyHeader: settings.dataSources.apiKeyHeader,
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
    return {
      schemaVersion: 1,
      revision: this.revision,
      updatedAt: this.updatedAt,
      pool: this.settings.pool,
      display: this.settings.display,
      dataSources: {
        nodeRpcUrl: this.settings.dataSources.nodeRpcUrl,
        apiUrl: this.settings.dataSources.apiUrl,
        apiKeyHeader: this.settings.dataSources.apiKeyHeader,
        apiKeyConfigured: Boolean(config.apiKey),
        apiKeySource: this.settings.dataSources.apiKeyMode,
        nodeMetricsUrl: this.settings.dataSources.nodeMetricsUrl,
        signerMonitoringUrl: this.settings.dataSources.signerMonitoringUrl,
        hiroReferenceApiUrl: this.settings.dataSources.hiroReferenceApiUrl,
      },
      forecast: this.settings.forecast,
      embed: this.settings.embed,
      audit: this.store.listSettingsAudit(),
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
    let nodeRpcUrl: string;
    let apiUrl: string;
    let publicApiUrl: string;
    try {
      nodeRpcUrl = parseEndpointUrl(value.dataSources.nodeRpcUrl, "Stacks node RPC URL");
      apiUrl = parseEndpointUrl(value.dataSources.apiUrl, "Stacks API URL");
      publicApiUrl = parseEndpointUrl(value.embed.publicApiUrl, "Public embed API URL");
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
    const action = value.dataSources.apiKeyAction;
    const nextSecret =
      action.action === "replace"
        ? action.value
        : action.action === "clear"
          ? null
          : this.apiKeySecret;
    const apiKeyMode =
      action.action === "replace"
        ? "database"
        : action.action === "clear"
          ? "none"
          : this.settings.dataSources.apiKeyMode;
    const next = persistedRuntimeSettingsSchema.parse({
      schemaVersion: 1,
      ...value,
      dataSources: {
        nodeRpcUrl,
        apiUrl,
        apiKeyHeader: value.dataSources.apiKeyHeader,
        apiKeyMode,
        nodeMetricsUrl,
        signerMonitoringUrl,
        hiroReferenceApiUrl,
      },
      embed: { publicApiUrl },
    });
    const fields = changedFields(this.settings, next, action.action !== "keep");
    if (fields.length === 0) return this.publicSettings();
    if (fields.some((field) => field.startsWith("dataSources."))) {
      const candidateConfig = this.configFor(next, nextSecret);
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
    const stored = this.store.putRuntimeSettings({
      settings: next,
      apiKeySecret: nextSecret,
      changedFields: fields,
      observedAt,
    });
    this.settings = next;
    this.apiKeySecret = nextSecret;
    this.revision = stored.revision;
    this.updatedAt = stored.updatedAt;
    return this.publicSettings();
  }
}
