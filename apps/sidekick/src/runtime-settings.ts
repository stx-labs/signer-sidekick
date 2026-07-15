import {
  parseContractPrincipal,
  validatePrincipal,
} from "@stx-labs/signer-sidekick-protocol/principals";
import { z } from "zod";
import { StacksApiClient, StacksNodeClient } from "./chain-clients.js";
import { isHttpUrl, parseEndpointUrl, type SidekickConfig } from "./config.js";
import { runOperatorPreflight } from "./preflight.js";
import type { SidekickStore } from "./storage/store.js";

const optionalUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((value) => value === "" || isHttpUrl(value), "Expected an HTTP(S) URL");

const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
      return true;
    } catch {
      return false;
    }
  }, "Expected an IANA time zone");

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
        timezone: timeZoneSchema,
        timeFormat: z.enum(["relative", "absolute", "both"]),
        numberFormat: z.enum(["1,234.5678", "1 234,5678"]),
        defaultTheme: z.enum(["light", "dark", "system"]),
      })
      .strict(),
    dataSources: z
      .object({
        nodeRpcUrl: z.string(),
        apiUrl: z.string(),
        apiKeyHeader: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
        apiKeyMode: z.enum(["environment", "database", "none"]),
      })
      .strict(),
    forecast: z
      .object({
        horizonCycles: z.number().int().min(1).max(96),
      })
      .strict(),
    embed: z
      .object({
        type: z.enum(["live", "static"]),
        publicApiUrl: z.string(),
      })
      .strict(),
    payoutPolicy: z
      .object({
        minimumDirectSbtcSats: z.string().regex(/^(0|[1-9][0-9]*)$/),
        maxTransactionFeeUstx: z.string().regex(/^(0|[1-9][0-9]*)$/),
        rollingGasBudgetUstx: z.string().regex(/^(0|[1-9][0-9]*)$/),
      })
      .strict(),
    automation: z
      .object({
        mode: z.literal("observe"),
        gasPayerPrincipal: z
          .string()
          .trim()
          .max(64)
          .refine(
            (value) => value === "" || (!value.includes(".") && validatePrincipal(value)),
            "Expected a standard Stacks principal",
          ),
      })
      .strict(),
    alerts: z
      .object({
        webhookUrl: optionalUrlSchema,
        criticalOnly: z.boolean(),
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
  payoutPolicy: PersistedRuntimeSettings["payoutPolicy"];
  automation: PersistedRuntimeSettings["automation"];
  alerts: PersistedRuntimeSettings["alerts"];
  audit: Array<{ revision: number; changedFields: string[]; changedAt: string }>;
}

function publicApiDefault(config: SidekickConfig): string {
  if (config.network === "mainnet") return "https://api.mainnet.hiro.so";
  if (config.network === "testnet") return "https://api.testnet.hiro.so";
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
      timezone: "UTC",
      timeFormat: "relative",
      numberFormat: "1,234.5678",
      defaultTheme: "system",
    },
    dataSources: {
      nodeRpcUrl: config.nodeRpcUrl,
      apiUrl: config.apiUrl,
      apiKeyHeader: config.apiKeyHeader,
      apiKeyMode: config.apiKey ? "environment" : "none",
    },
    forecast: { horizonCycles: config.forecastHorizonCycles },
    embed: { type: "live", publicApiUrl: publicApiDefault(config) },
    payoutPolicy: {
      minimumDirectSbtcSats: "0",
      maxTransactionFeeUstx: "100000",
      rollingGasBudgetUstx: "10000000",
    },
    automation: { mode: "observe", gasPayerPrincipal: "" },
    alerts: { webhookUrl: "", criticalOnly: false },
  };
}

function changedFields(
  previous: PersistedRuntimeSettings,
  next: PersistedRuntimeSettings,
  secretChanged: boolean,
): string[] {
  const fields: string[] = [];
  for (const section of [
    "pool",
    "display",
    "dataSources",
    "forecast",
    "embed",
    "payoutPolicy",
    "automation",
    "alerts",
  ] as const) {
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
    private readonly managerPrincipal: string,
    private readonly validateSources: RuntimeSettingsSourceValidator = async (
      config,
      node,
      api,
    ) => {
      const preflight = await runOperatorPreflight(config, node, api);
      if (preflight.status === "fail") {
        const reason = preflight.checks.find(({ status }) => status === "fail")?.message;
        throw new Error(reason ?? "Candidate node and API failed preflight");
      }
    },
  ) {
    const stored = store.getRuntimeSettings();
    this.settings = stored
      ? persistedRuntimeSettingsSchema.parse(stored.settings)
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
      },
      forecast: this.settings.forecast,
      embed: this.settings.embed,
      payoutPolicy: this.settings.payoutPolicy,
      automation: this.settings.automation,
      alerts: this.settings.alerts,
      audit: this.store.listSettingsAudit(),
    };
  }

  async update(
    input: unknown,
    observedAt = new Date().toISOString(),
  ): Promise<PublicRuntimeSettings> {
    const value = runtimeSettingsUpdateSchema.parse(input);
    if (value.automation.gasPayerPrincipal) {
      const manager = parseContractPrincipal(this.managerPrincipal);
      const expectedNetwork = this.baseConfig.network === "mainnet" ? "mainnet" : "testnet";
      const gasPayerNetwork =
        value.automation.gasPayerPrincipal.startsWith("SP") ||
        value.automation.gasPayerPrincipal.startsWith("SM")
          ? "mainnet"
          : "testnet";
      if (gasPayerNetwork !== expectedNetwork) {
        throw new Error("Gas-payer principal does not match the configured network");
      }
      if (value.automation.gasPayerPrincipal === manager.address) {
        throw new Error("Gas-payer principal must not be the manager admin principal");
      }
    }
    const nodeRpcUrl = parseEndpointUrl(value.dataSources.nodeRpcUrl, "Stacks node RPC URL");
    const apiUrl = parseEndpointUrl(value.dataSources.apiUrl, "Stacks API URL");
    const publicApiUrl = parseEndpointUrl(value.embed.publicApiUrl, "Public embed API URL");
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
      },
      embed: { ...value.embed, publicApiUrl },
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
