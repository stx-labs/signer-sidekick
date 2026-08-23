import { ArrowClockwise, ArrowSquareOut, Check, DownloadSimple } from "@phosphor-icons/react";
import {
  type DashboardSnapshot,
  type DeploymentRequirement,
  type DeploymentRequirements,
  type EngineStatus,
  type GasWalletStatus,
  healthSourceTestResponseSchema,
  type RuntimeSettings,
  runtimeSettingsSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { apiDownload, apiJson, type ResponseSchema } from "../../api-client.js";
import { CopyableIdentifier } from "../../copyable-identifier.js";
import type { SettingsSection } from "../../dashboard-route.js";
import { Badge, ErrorCallout, Field, PageHead } from "../../shared/dashboard-ui.js";
import { DOCUMENT_LINKS } from "../../shared/document-links.js";
import { shortUtc } from "../../shared/format.js";
import { operatorActionError } from "../../shared/operator-error.js";
import { DeploymentRequirementsPanel } from "./deployment-requirements.js";
import { EngineSettings } from "./engine-settings.js";
import { ManagerSettings } from "./manager-settings.js";
import { SettingsRow, SettingsSectionTitle } from "./settings-ui.js";

const healthSourceLabels = {
  "node-metrics": "node monitoring",
  "signer-monitoring": "signer monitoring",
  "indexed-api": "indexed chain API",
  "hiro-reference": "network comparison API",
} as const;

const settingsAnchors = [
  ["st-deployment", "Deployment"],
  ["st-connections", "Connections"],
  ["st-requirements", "Requirements"],
  ["st-manager", "Manager"],
  ["st-runs", "Reward runs"],
  ["st-preferences", "Preferences"],
  ["st-access", "Access"],
] as const;
type SettingsAnchor = (typeof settingsAnchors)[number][0];
type HealthSourceKind = keyof typeof healthSourceLabels;
type ApiKeyAction = "keep" | "remove-override" | "replace";
type ConnectionEditor =
  | "node-rpc"
  | "node-metrics"
  | "signer-monitoring"
  | "indexed-api"
  | "hiro-reference";
type SettingsSaveSection = "dataSources" | "forecast";
type SourceTestResult = { state: "testing" | "connected" | "failed"; detail: string };

type AuthSession = {
  authenticated: boolean;
  method: "bearer" | "trusted-header" | "basic" | null;
};
const authSessionSchema: ResponseSchema<AuthSession> = {
  safeParse(value: unknown) {
    if (!value || typeof value !== "object") {
      return { success: false as const, error: { message: "Expected an authentication session" } };
    }
    const record = value as Record<string, unknown>;
    const method = record.method ?? null;
    if (
      typeof record.authenticated !== "boolean" ||
      (method !== null && method !== "bearer" && method !== "trusted-header" && method !== "basic")
    ) {
      return { success: false as const, error: { message: "Invalid authentication session" } };
    }
    return {
      success: true as const,
      data: { authenticated: record.authenticated, method },
    };
  },
};

function requirementStatus(check: DeploymentRequirement | undefined, configured: boolean): string {
  if (!configured) return "Not configured";
  if (!check) return "Configured";
  if (check.status === "pass") return "Connected";
  if (check.status === "unavailable") return "Unavailable";
  if (check.status === "not-configured") return "Not configured";
  return "Attention";
}

function testedSourceStatus(test: SourceTestResult | undefined, fallback: string): string {
  if (!test) return fallback;
  if (test.state === "connected") return "Connected";
  if (test.state === "testing") return "Checking";
  return "Unavailable";
}

function credentialSourceLabel(
  source: "environment" | "database" | "indexed-api" | "none",
): string {
  if (source === "database") return "key saved in Sidekick";
  if (source === "environment") return "provided by the environment";
  if (source === "indexed-api") return "reusing the indexed API key";
  return "no API key configured";
}

const settingsTargetBySection: Record<SettingsSection, SettingsAnchor> = {
  requirements: "st-requirements",
  attachment: "st-manager",
  sources: "st-connections",
  capabilities: "st-manager",
  "gas-wallet": "st-runs",
  observer: "st-requirements",
  auth: "st-access",
  support: "st-deployment",
};

function ConnectionRow({
  children,
  configured,
  credential,
  editing,
  help,
  label,
  onEdit,
  status,
  value,
}: {
  children: ReactNode;
  configured: boolean;
  credential?: ReactNode;
  editing: boolean;
  help: string;
  label: string;
  onEdit: () => void;
  status: string;
  value: string;
}) {
  return (
    <div className="st-connection">
      <SettingsRow
        actions={
          <button
            aria-expanded={editing}
            className="btn btn-tertiary sm"
            onClick={onEdit}
            type="button"
          >
            {editing ? "Close" : configured ? "Edit" : "Add"}
          </button>
        }
        className={editing ? "is-editing" : ""}
        detail={credential}
        help={help}
        name={label}
        status={status}
        value={
          <span className={`mono ${configured ? "" : "muted"}`} title={value}>
            {configured ? value : "—"}
          </span>
        }
      >
        {editing ? <div className="st-editor">{children}</div> : null}
      </SettingsRow>
    </div>
  );
}

function networkLabel(network: string): string {
  if (network === "mainnet") return "Mainnet";
  if (network === "testnet" || network === "pox5-testnet") return "PoX-5 Testnet";
  return network;
}

function chainId(value: number): string {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

function resolvedTheme(preference: RuntimeSettings["display"]["defaultTheme"]): "light" | "dark" {
  if (preference !== "system") return preference;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function SettingsPage({
  data,
  initialSection,
  readOnly = false,
  onRefreshStatus,
  token,
  setTheme,
  onSaved,
  refreshingStatus,
  sync,
  syncing,
}: {
  data: DashboardSnapshot | null;
  initialSection: SettingsSection | null;
  readOnly?: boolean;
  onRefreshStatus?: (() => void | Promise<void>) | undefined;
  token: string;
  setTheme: (theme: "light" | "dark") => void;
  onSaved?: () => void | Promise<void>;
  refreshingStatus: boolean;
  sync: () => void;
  syncing: boolean;
}) {
  const [settings, setSettings] = useState<RuntimeSettings | null>(() =>
    data?.freshness?.status === "stale" ? null : (data?.runtimeSettings ?? null),
  );
  const [persistedSettings, setPersistedSettings] = useState<RuntimeSettings | null>(settings);
  const [loading, setLoading] = useState(settings === null);
  const [apiKeyAction, setApiKeyAction] = useState<ApiKeyAction>("keep");
  const [apiKey, setApiKey] = useState("");
  const [referenceApiKeyAction, setReferenceApiKeyAction] = useState<ApiKeyAction>("keep");
  const [referenceApiKey, setReferenceApiKey] = useState("");
  const [indexedApiDirty, setIndexedApiDirty] = useState(false);
  const [referenceApiDirty, setReferenceApiDirty] = useState(false);
  const [savingSection, setSavingSection] = useState<SettingsSaveSection | null>(null);
  const [savedSection, setSavedSection] = useState<SettingsSaveSection | null>(null);
  const [dataSourcesDirty, setDataSourcesDirty] = useState(false);
  const [forecastDirty, setForecastDirty] = useState(false);
  const [themeBusy, setThemeBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [themeError, setThemeError] = useState<string | null>(null);
  const [sectionError, setSectionError] = useState<{
    section: SettingsSaveSection;
    message: string;
  } | null>(null);
  const [supportDownloadBusy, setSupportDownloadBusy] = useState(false);
  const [supportDownloadError, setSupportDownloadError] = useState<string | null>(null);
  const [deploymentCheckRevision, setDeploymentCheckRevision] = useState(0);
  const [runningChecks, setRunningChecks] = useState(false);
  const [deploymentRequirements, setDeploymentRequirements] =
    useState<DeploymentRequirements | null>(null);
  const [sourceTests, setSourceTests] = useState<
    Partial<Record<HealthSourceKind, SourceTestResult>>
  >({});
  const [editingSource, setEditingSource] = useState<ConnectionEditor | null>(null);
  const [activeAnchor, setActiveAnchor] = useState<SettingsAnchor>("st-deployment");
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null);
  const [gasWalletStatus, setGasWalletStatus] = useState<GasWalletStatus | null>(null);
  const [authMethod, setAuthMethod] = useState<"bearer" | "trusted-header" | "basic" | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const settingsLoadController = useRef<AbortController | null>(null);
  const sourceTestController = useRef<{
    controller: AbortController;
    kind: HealthSourceKind;
  } | null>(null);

  const recordDeploymentRequirements = useCallback((requirements: DeploymentRequirements) => {
    setDeploymentRequirements(requirements);
    setSourceTests((current) => {
      if (!current["node-metrics"] && !current["signer-monitoring"] && !current["hiro-reference"])
        return current;
      const next = { ...current };
      delete next["node-metrics"];
      delete next["signer-monitoring"];
      delete next["hiro-reference"];
      return next;
    });
  }, []);

  const loadSettings = useCallback(async () => {
    settingsLoadController.current?.abort();
    const controller = new AbortController();
    settingsLoadController.current = controller;
    setLoading(true);
    setLoadError(null);
    try {
      const [result, session] = await Promise.all([
        apiJson(token, "/api/v1/settings", runtimeSettingsSchema, { signal: controller.signal }),
        apiJson(token, "/api/v1/auth/session", authSessionSchema, { signal: controller.signal }),
      ]);
      if (settingsLoadController.current === controller) {
        setSettings(result);
        setPersistedSettings(result);
        setAuthMethod(session.method);
        setDataSourcesDirty(false);
        setForecastDirty(false);
        setApiKey("");
        setApiKeyAction("keep");
        setReferenceApiKey("");
        setReferenceApiKeyAction("keep");
        setIndexedApiDirty(false);
        setReferenceApiDirty(false);
      }
    } catch (cause) {
      if (controller.signal.aborted || settingsLoadController.current !== controller) return;
      setLoadError(operatorActionError(cause, "Could not load settings", "Retrying is safe"));
    } finally {
      if (settingsLoadController.current === controller) {
        settingsLoadController.current = null;
        setLoading(false);
      }
    }
  }, [token]);

  useEffect(() => {
    if (!settings) void loadSettings();
  }, [loadSettings, settings]);
  useEffect(
    () => () => {
      settingsLoadController.current?.abort();
      sourceTestController.current?.controller.abort();
    },
    [],
  );
  useEffect(() => {
    if (!initialSection || !settings) return;
    const id = settingsTargetBySection[initialSection];
    setActiveAnchor(id);
    document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [initialSection, settings]);
  useEffect(() => {
    if (!settings) return;
    const updateActive = () => {
      let current: SettingsAnchor = "st-deployment";
      for (const [id] of settingsAnchors) {
        const element = document.getElementById(id);
        if (element && element.getBoundingClientRect().top <= 180) current = id;
      }
      setActiveAnchor(current);
    };
    window.addEventListener("scroll", updateActive, { passive: true });
    updateActive();
    return () => window.removeEventListener("scroll", updateActive);
  }, [settings]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dataSourcesDirty && !forecastDirty) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dataSourcesDirty, forecastDirty]);

  const saveSection = async (section: SettingsSaveSection) => {
    if (!settings || !persistedSettings) return;
    if (section === "dataSources") {
      sourceTestController.current?.controller.abort();
      sourceTestController.current = null;
      setSourceTests({});
    }
    setSavingSection(section);
    setSavedSection(null);
    setSectionError(null);
    try {
      const dataSources =
        section === "dataSources" ? settings.dataSources : persistedSettings.dataSources;
      const forecast = section === "forecast" ? settings.forecast : persistedSettings.forecast;
      const result = await apiJson(token, "/api/v1/settings", runtimeSettingsSchema, {
        method: "PUT",
        body: JSON.stringify({
          pool: persistedSettings.pool,
          display: persistedSettings.display,
          dataSources: {
            nodeRpcUrl: dataSources.nodeRpcUrl,
            apiUrl: dataSources.apiUrl,
            apiKeyHeader: dataSources.apiKeyHeader,
            nodeMetricsUrl: dataSources.nodeMetricsUrl,
            signerMonitoringUrl: dataSources.signerMonitoringUrl,
            hiroReferenceApiUrl: dataSources.hiroReferenceApiUrl,
            hiroReferenceApiKeyHeader: dataSources.hiroReferenceApiKeyHeader,
            apiKeyAction:
              section === "dataSources" && apiKeyAction === "replace"
                ? { action: "replace", value: apiKey }
                : { action: section === "dataSources" ? apiKeyAction : "keep" },
            hiroReferenceApiKeyAction:
              section === "dataSources" && referenceApiKeyAction === "replace"
                ? { action: "replace", value: referenceApiKey }
                : { action: section === "dataSources" ? referenceApiKeyAction : "keep" },
          },
          forecast,
          embed: persistedSettings.embed,
        }),
      });
      setPersistedSettings(result);
      setSettings((current) => {
        if (!current) return result;
        return {
          ...result,
          ...(section === "dataSources" && forecastDirty ? { forecast: current.forecast } : {}),
          ...(section === "forecast" && dataSourcesDirty
            ? { dataSources: current.dataSources }
            : {}),
        };
      });
      if (section === "dataSources") {
        setApiKey("");
        setApiKeyAction("keep");
        setReferenceApiKey("");
        setReferenceApiKeyAction("keep");
        setIndexedApiDirty(false);
        setReferenceApiDirty(false);
        setDataSourcesDirty(false);
        setDeploymentCheckRevision((revision) => revision + 1);
      } else {
        setForecastDirty(false);
      }
      setSavedSection(section);
      await onSaved?.();
    } catch (cause) {
      setSectionError({
        section,
        message: operatorActionError(
          cause,
          section === "dataSources" ? "Could not save connections" : "Could not save forecast",
          "Review the fields, then retry; saving again is safe",
        ),
      });
    } finally {
      setSavingSection(null);
    }
  };

  const saveTheme = async (preference: RuntimeSettings["display"]["defaultTheme"]) => {
    if (!settings || !persistedSettings || themeBusy || readOnly) return;
    const previous = settings.display.defaultTheme;
    setThemeError(null);
    setThemeBusy(true);
    setTheme(resolvedTheme(preference));
    setSettings({ ...settings, display: { defaultTheme: preference } });
    try {
      const result = await apiJson(token, "/api/v1/settings", runtimeSettingsSchema, {
        method: "PUT",
        body: JSON.stringify({
          pool: persistedSettings.pool,
          display: { defaultTheme: preference },
          dataSources: {
            nodeRpcUrl: persistedSettings.dataSources.nodeRpcUrl,
            apiUrl: persistedSettings.dataSources.apiUrl,
            apiKeyHeader: persistedSettings.dataSources.apiKeyHeader,
            nodeMetricsUrl: persistedSettings.dataSources.nodeMetricsUrl,
            signerMonitoringUrl: persistedSettings.dataSources.signerMonitoringUrl,
            hiroReferenceApiUrl: persistedSettings.dataSources.hiroReferenceApiUrl,
            hiroReferenceApiKeyHeader: persistedSettings.dataSources.hiroReferenceApiKeyHeader,
            apiKeyAction: { action: "keep" },
            hiroReferenceApiKeyAction: { action: "keep" },
          },
          forecast: persistedSettings.forecast,
          embed: persistedSettings.embed,
        }),
      });
      setPersistedSettings(result);
      setSettings((current) =>
        current
          ? {
              ...result,
              ...(dataSourcesDirty ? { dataSources: current.dataSources } : {}),
              ...(forecastDirty ? { forecast: current.forecast } : {}),
            }
          : result,
      );
    } catch (cause) {
      setSettings((current) =>
        current ? { ...current, display: { defaultTheme: previous } } : current,
      );
      setTheme(resolvedTheme(previous));
      setThemeError(operatorActionError(cause, "Could not save theme", "Retrying is safe"));
    } finally {
      setThemeBusy(false);
    }
  };

  if (!settings) {
    return (
      <>
        <PageHead title="Settings" />
        <ErrorCallout error={loadError} />
        {loading ? <div className="loading-state">Loading settings</div> : null}
        {!loading && loadError ? (
          <button type="button" className="btn btn-secondary" onClick={() => void loadSettings()}>
            Retry settings
          </button>
        ) : null}
      </>
    );
  }

  const update = <K extends keyof RuntimeSettings>(section: K, value: RuntimeSettings[K]) => {
    if (section === "dataSources") {
      sourceTestController.current?.controller.abort();
      sourceTestController.current = null;
      setSourceTests({});
      setDataSourcesDirty(true);
    }
    if (section === "forecast") setForecastDirty(true);
    setSavedSection(null);
    setSectionError(null);
    setSettings({ ...settings, [section]: value });
  };
  const discardDataSourceChanges = () => {
    if (!persistedSettings) return;
    sourceTestController.current?.controller.abort();
    sourceTestController.current = null;
    setSettings({ ...settings, dataSources: persistedSettings.dataSources });
    setApiKey("");
    setApiKeyAction("keep");
    setReferenceApiKey("");
    setReferenceApiKeyAction("keep");
    setIndexedApiDirty(false);
    setReferenceApiDirty(false);
    setDataSourcesDirty(false);
    setSavedSection(null);
    setSectionError(null);
    setSourceTests({});
  };
  const testHealthSource = async (kind: HealthSourceKind, url?: string) => {
    const previousTest = sourceTestController.current;
    previousTest?.controller.abort();
    const controller = new AbortController();
    sourceTestController.current = { controller, kind };
    setSourceTests((current) => {
      const next = { ...current };
      if (previousTest) delete next[previousTest.kind];
      next[kind] = { state: "testing", detail: "Connecting…" };
      return next;
    });
    try {
      const result = await apiJson(
        token,
        "/api/v1/health/test-source",
        healthSourceTestResponseSchema,
        {
          method: "POST",
          body: JSON.stringify(url === undefined ? { kind } : { kind, url }),
          signal: controller.signal,
        },
      );
      if (sourceTestController.current?.controller !== controller) return;
      setSourceTests((current) => ({
        ...current,
        [kind]: { state: "connected", detail: `Connected · ${result.signals} recognized signals` },
      }));
    } catch (cause) {
      if (controller.signal.aborted || sourceTestController.current?.controller !== controller)
        return;
      setSourceTests((current) => ({
        ...current,
        [kind]: {
          state: "failed",
          detail: operatorActionError(
            cause,
            `Could not connect to ${healthSourceLabels[kind]}`,
            "Check the URL, then retry; this test does not save settings",
          ),
        },
      }));
    } finally {
      if (sourceTestController.current?.controller === controller)
        sourceTestController.current = null;
    }
  };
  const downloadSupportBundle = async () => {
    setSupportDownloadBusy(true);
    setSupportDownloadError(null);
    try {
      await apiDownload(token, "/api/v1/support-bundle", {
        expectedContentTypes: ["application/json"],
        fallbackFilename: "signer-sidekick-support.json",
        timeoutMs: 90_000,
      });
    } catch (cause) {
      setSupportDownloadError(
        operatorActionError(cause, "Could not download the support bundle", "Retrying is safe"),
      );
    } finally {
      setSupportDownloadBusy(false);
    }
  };

  const requirementById = new Map(
    deploymentRequirements?.checks.map((check) => [check.id, check]) ?? [],
  );
  const nodeStatus = requirementById.has("node-rpc")
    ? requirementStatus(requirementById.get("node-rpc"), true)
    : !data
      ? "Unavailable"
      : data.preflight.status === "fail"
        ? "Attention"
        : "Connected";
  const nodeMetricsConfigured = Boolean(settings.dataSources.nodeMetricsUrl);
  const nodeMetricsStatus = testedSourceStatus(
    sourceTests["node-metrics"],
    requirementStatus(requirementById.get("node-metrics"), nodeMetricsConfigured),
  );
  const signerMonitoringConfigured = Boolean(settings.dataSources.signerMonitoringUrl);
  const signerMonitoringStatus = testedSourceStatus(
    sourceTests["signer-monitoring"],
    requirementStatus(requirementById.get("signer-monitoring"), signerMonitoringConfigured),
  );
  const indexedApiStatus = testedSourceStatus(
    sourceTests["indexed-api"],
    !data || data.preflight.api.available === false ? "Unavailable" : "Connected",
  );
  const referenceApiConfigured = Boolean(settings.dataSources.hiroReferenceApiUrl);
  const referenceApiStatus = testedSourceStatus(
    sourceTests["hiro-reference"],
    requirementStatus(requirementById.get("hiro-reference"), referenceApiConfigured),
  );
  const failingChecks =
    deploymentRequirements?.checks.filter(({ status }) => status !== "pass") ?? [];
  const attachmentFailed = data ? !data.manager.attachAllowed : true;
  const attentionCount = failingChecks.length + (attachmentFailed ? 1 : 0);
  const deploymentReason =
    failingChecks[0]?.summary ??
    (attachmentFailed
      ? "The configured manager attachment needs attention."
      : "All deployment checks passed.");
  const latestAudit = settings.audit[0] ?? null;
  const observerAttention = Boolean(data?.alerts.some(({ id }) => id.startsWith("observer:")));
  const authLabel = authMethod
    ? authMethod.replace("trusted-header", "trusted header")
    : "authenticated session";

  return (
    <div className="settings-page settings-v2">
      <PageHead
        title="Settings"
        actions={
          <>
            <button
              className="btn btn-secondary"
              disabled={readOnly || runningChecks}
              onClick={() => setDeploymentCheckRevision((revision) => revision + 1)}
              type="button"
            >
              <ArrowClockwise className={`rw-ico ${runningChecks ? "spin" : ""}`} />
              {runningChecks ? "Running checks" : "Run checks"}
            </button>
            <button
              className="btn btn-secondary"
              disabled={supportDownloadBusy}
              onClick={() => void downloadSupportBundle()}
              title="Redacted Sidekick, manager, node, signer, observer, reconciliation, and operation evidence"
              type="button"
            >
              <DownloadSimple className="rw-ico" />
              {supportDownloadBusy ? "Collecting bundle" : "Support bundle"}
            </button>
            <a
              className="btn btn-tertiary"
              href={DOCUMENT_LINKS.operatorGuide}
              target="_blank"
              rel="noreferrer"
            >
              Operator guide <ArrowSquareOut className="rw-ico" aria-hidden="true" />
            </a>
          </>
        }
      />
      <ErrorCallout error={supportDownloadError} />
      {readOnly ? (
        <div className="callout callout-caution content-notice" role="status">
          Deployment identity does not match. Settings remain readable, but changes and source tests
          are disabled.
        </div>
      ) : null}
      {loading ? (
        <div className="callout callout-neutral content-notice">Refreshing settings…</div>
      ) : null}
      <ErrorCallout error={loadError} />
      <nav className="st-jump" aria-label="Settings sections">
        {settingsAnchors.map(([id, label]) => (
          <button
            className={activeAnchor === id ? "on" : ""}
            key={id}
            onClick={() => {
              setActiveAnchor(id);
              document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            type="button"
          >
            {label}
          </button>
        ))}
      </nav>

      <fieldset
        className="settings-fields settings-v2-fields"
        disabled={savingSection !== null || themeBusy || readOnly}
      >
        <section
          className="card-standout st-deploy"
          id="st-deployment"
          aria-labelledby="st-deploy-title"
        >
          <div className="st-deploy-grid">
            <div className="st-deploy-id">
              <div className="rw-eyebrow">
                This deployment{" "}
                <Badge state={attentionCount === 0 ? "success" : "caution"}>
                  {attentionCount === 0
                    ? "Ready"
                    : `${attentionCount} ${attentionCount === 1 ? "item" : "items"} need attention`}
                </Badge>
              </div>
              <h2 id="st-deploy-title">
                <CopyableIdentifier
                  className="identifier"
                  display={data?.managerPrincipal ?? "Manager unavailable"}
                  label="manager principal"
                  value={data?.managerPrincipal}
                />
              </h2>
              <p className="st-deploy-when">{deploymentReason}</p>
            </div>
            <dl className="st-deploy-facts">
              <div>
                <dt>Network</dt>
                <dd>
                  {data ? networkLabel(data.network) : "Unavailable"}
                  <small>
                    {data
                      ? `chain ${chainId(data.preflight.node.networkId)} · PoX-5 ${data.preflight.pox.pox5ContractId ?? "unavailable"}`
                      : "chain evidence unavailable"}
                  </small>
                </dd>
              </div>
              <div>
                <dt>Engine</dt>
                <dd>
                  {engineStatus?.forcedObserve.active
                    ? "Forced Observe"
                    : engineStatus?.mode === "operator-run"
                      ? "Operator-run"
                      : engineStatus?.mode === "observe"
                        ? "Observe"
                        : "Unavailable"}
                  <small>
                    {engineStatus?.mode === "operator-run"
                      ? "signs only a sealed recipe you approve"
                      : "signs nothing · reward calls use your own wallet"}
                  </small>
                </dd>
              </div>
              <div>
                <dt>Sidekick</dt>
                <dd>
                  {data?.preflight.compatibility.profileLabel ??
                    data?.preflight.compatibility.profileId ??
                    "Compatibility unavailable"}
                  <small>
                    {data
                      ? `Stacks node ${data.preflight.node.version ?? data.preflight.node.serverVersion ?? "unknown"}${data.preflight.node.commit ? ` (${data.preflight.node.commit})` : ""} · revision ${data.preflight.compatibility.profileRevision ?? "unknown"} · ${data.preflight.compatibility.origin === "operator-provided" ? "operator-installed" : "built in"}`
                      : "node evidence unavailable"}
                  </small>
                </dd>
              </div>
              <div>
                <dt>Last check</dt>
                <dd>
                  {deploymentRequirements ? shortUtc(deploymentRequirements.checkedAt) : "Pending"}
                  <small>connections, requirements, and manager attachment</small>
                </dd>
              </div>
            </dl>
          </div>
        </section>

        <SettingsSectionTitle hint="what Sidekick reads" id="st-connections">
          Connections
        </SettingsSectionTitle>
        <section className="card st-card" aria-label="Connections">
          <div className="st-rows">
            <ConnectionRow
              configured
              editing={editingSource === "node-rpc"}
              help="Current chain state and PoX-5 reads. Required."
              label="Stacks node"
              onEdit={() => setEditingSource(editingSource === "node-rpc" ? null : "node-rpc")}
              status={nodeStatus}
              value={settings.dataSources.nodeRpcUrl}
            >
              <div className="st-editor-grid st-editor-single">
                <Field label="Stacks node RPC URL">
                  <input
                    className="input mono"
                    type="url"
                    value={settings.dataSources.nodeRpcUrl}
                    onChange={(event) =>
                      update("dataSources", {
                        ...settings.dataSources,
                        nodeRpcUrl: event.target.value,
                      })
                    }
                  />
                </Field>
              </div>
            </ConnectionRow>
            <ConnectionRow
              configured={nodeMetricsConfigured}
              editing={editingSource === "node-metrics"}
              help="Prometheus metrics from stacks-core, used for local node diagnosis. Recommended."
              label="Node monitoring"
              onEdit={() =>
                setEditingSource(editingSource === "node-metrics" ? null : "node-metrics")
              }
              status={nodeMetricsStatus}
              value={settings.dataSources.nodeMetricsUrl}
            >
              <div className="st-editor-grid st-editor-single">
                <Field label="Node metrics URL">
                  <input
                    className="input mono"
                    type="url"
                    placeholder="http://stacks-node:9153"
                    value={settings.dataSources.nodeMetricsUrl}
                    onChange={(event) =>
                      update("dataSources", {
                        ...settings.dataSources,
                        nodeMetricsUrl: event.target.value,
                      })
                    }
                  />
                </Field>
              </div>
              <div className="st-editor-foot">
                <span
                  className={
                    sourceTests["node-metrics"]?.state === "failed" ? "field-error" : "muted"
                  }
                >
                  {sourceTests["node-metrics"]?.detail ?? "Recommended local metrics endpoint"}
                </span>
                <button
                  className="btn btn-tertiary sm"
                  disabled={
                    !settings.dataSources.nodeMetricsUrl ||
                    sourceTests["node-metrics"]?.state === "testing"
                  }
                  onClick={() =>
                    void testHealthSource("node-metrics", settings.dataSources.nodeMetricsUrl)
                  }
                  type="button"
                >
                  Test
                </button>
              </div>
            </ConnectionRow>
            <ConnectionRow
              configured={signerMonitoringConfigured}
              editing={editingSource === "signer-monitoring"}
              help="Signer metrics for participation and latency diagnosis. Recommended."
              label="Signer monitoring"
              onEdit={() =>
                setEditingSource(editingSource === "signer-monitoring" ? null : "signer-monitoring")
              }
              status={signerMonitoringStatus}
              value={settings.dataSources.signerMonitoringUrl}
            >
              <div className="st-editor-grid st-editor-single">
                <Field label="Signer monitoring URL">
                  <input
                    className="input mono"
                    type="url"
                    placeholder="http://stacks-signer:30001"
                    value={settings.dataSources.signerMonitoringUrl}
                    onChange={(event) =>
                      update("dataSources", {
                        ...settings.dataSources,
                        signerMonitoringUrl: event.target.value,
                      })
                    }
                  />
                </Field>
              </div>
              <div className="st-editor-foot">
                <span
                  className={
                    sourceTests["signer-monitoring"]?.state === "failed" ? "field-error" : "muted"
                  }
                >
                  {sourceTests["signer-monitoring"]?.detail ??
                    "Recommended signer metrics endpoint"}
                </span>
                <button
                  className="btn btn-tertiary sm"
                  disabled={
                    !settings.dataSources.signerMonitoringUrl ||
                    sourceTests["signer-monitoring"]?.state === "testing"
                  }
                  onClick={() =>
                    void testHealthSource(
                      "signer-monitoring",
                      settings.dataSources.signerMonitoringUrl,
                    )
                  }
                  type="button"
                >
                  Test
                </button>
              </div>
            </ConnectionRow>
            <ConnectionRow
              configured
              credential={
                apiKeyAction === "replace"
                  ? "new key will be saved"
                  : apiKeyAction === "remove-override"
                    ? "saved key will be removed"
                    : credentialSourceLabel(settings.dataSources.apiKeySource)
              }
              editing={editingSource === "indexed-api"}
              help="Roster, activity, and historical chain data. A Hiro key avoids public rate limits."
              label="Indexed chain API"
              onEdit={() =>
                setEditingSource(editingSource === "indexed-api" ? null : "indexed-api")
              }
              status={indexedApiStatus}
              value={settings.dataSources.apiUrl}
            >
              <div className="st-editor-grid">
                <Field label="Indexed chain API URL">
                  <input
                    className="input mono"
                    type="url"
                    value={settings.dataSources.apiUrl}
                    onChange={(event) => {
                      setIndexedApiDirty(true);
                      update("dataSources", {
                        ...settings.dataSources,
                        apiUrl: event.target.value,
                      });
                    }}
                  />
                </Field>
                <Field label="API key" help="Write-only. Leave blank to keep the current key.">
                  <input
                    className="input mono"
                    type="password"
                    autoComplete="new-password"
                    placeholder={settings.dataSources.apiKeyConfigured ? "Configured" : "Optional"}
                    value={apiKey}
                    onChange={(event) => {
                      const value = event.target.value;
                      setDataSourcesDirty(true);
                      setIndexedApiDirty(true);
                      setSourceTests({});
                      setApiKey(value);
                      setApiKeyAction(value ? "replace" : "keep");
                    }}
                  />
                </Field>
              </div>
              <div className="st-editor-foot">
                <span className="muted">
                  {credentialSourceLabel(settings.dataSources.apiKeySource)} ·{" "}
                  {settings.dataSources.apiKeySource === "database" ? (
                    <button
                      className="st-link-button"
                      onClick={() => {
                        setApiKey("");
                        setApiKeyAction("remove-override");
                        setIndexedApiDirty(true);
                        setDataSourcesDirty(true);
                        setSourceTests({});
                      }}
                      type="button"
                    >
                      remove
                    </button>
                  ) : null}
                  {" · "}
                  <details className="st-advanced-inline">
                    <summary>advanced: header {settings.dataSources.apiKeyHeader}</summary>
                    <Field label="API key header">
                      <input
                        className="input mono"
                        value={settings.dataSources.apiKeyHeader}
                        onChange={(event) => {
                          setIndexedApiDirty(true);
                          update("dataSources", {
                            ...settings.dataSources,
                            apiKeyHeader: event.target.value,
                          });
                        }}
                      />
                    </Field>
                  </details>
                </span>
                <button
                  className="btn btn-tertiary sm"
                  disabled={indexedApiDirty || sourceTests["indexed-api"]?.state === "testing"}
                  onClick={() => void testHealthSource("indexed-api")}
                  type="button"
                >
                  Test saved connection
                </button>
              </div>
            </ConnectionRow>
            <ConnectionRow
              configured={referenceApiConfigured}
              credential={
                referenceApiKeyAction === "replace"
                  ? "new key will be saved"
                  : referenceApiKeyAction === "remove-override"
                    ? "saved key will be removed"
                    : credentialSourceLabel(settings.dataSources.hiroReferenceApiKeySource)
              }
              editing={editingSource === "hiro-reference"}
              help="External reference used only to diagnose local node health. Optional."
              label="Network comparison API"
              onEdit={() =>
                setEditingSource(editingSource === "hiro-reference" ? null : "hiro-reference")
              }
              status={referenceApiStatus}
              value={settings.dataSources.hiroReferenceApiUrl}
            >
              <div className="st-editor-grid">
                <Field label="Network comparison API URL">
                  <input
                    className="input mono"
                    type="url"
                    value={settings.dataSources.hiroReferenceApiUrl}
                    onChange={(event) => {
                      setReferenceApiDirty(true);
                      update("dataSources", {
                        ...settings.dataSources,
                        hiroReferenceApiUrl: event.target.value,
                      });
                    }}
                  />
                </Field>
                <Field
                  label="API key"
                  help="Optional. A same-origin indexed key is reused automatically."
                >
                  <input
                    className="input mono"
                    type="password"
                    autoComplete="new-password"
                    placeholder={
                      settings.dataSources.hiroReferenceApiKeyConfigured ? "Configured" : "Optional"
                    }
                    value={referenceApiKey}
                    onChange={(event) => {
                      const value = event.target.value;
                      setDataSourcesDirty(true);
                      setReferenceApiDirty(true);
                      setSourceTests({});
                      setReferenceApiKey(value);
                      setReferenceApiKeyAction(value ? "replace" : "keep");
                    }}
                  />
                </Field>
              </div>
              <div className="st-editor-foot">
                <span className="muted">
                  {credentialSourceLabel(settings.dataSources.hiroReferenceApiKeySource)} ·{" "}
                  {settings.dataSources.hiroReferenceApiKeySource === "database" ? (
                    <button
                      className="st-link-button"
                      onClick={() => {
                        setReferenceApiKey("");
                        setReferenceApiKeyAction("remove-override");
                        setReferenceApiDirty(true);
                        setDataSourcesDirty(true);
                        setSourceTests({});
                      }}
                      type="button"
                    >
                      remove
                    </button>
                  ) : null}
                  {" · "}
                  <details className="st-advanced-inline">
                    <summary>
                      advanced: header {settings.dataSources.hiroReferenceApiKeyHeader}
                    </summary>
                    <Field label="API key header">
                      <input
                        className="input mono"
                        value={settings.dataSources.hiroReferenceApiKeyHeader}
                        onChange={(event) => {
                          setReferenceApiDirty(true);
                          update("dataSources", {
                            ...settings.dataSources,
                            hiroReferenceApiKeyHeader: event.target.value,
                          });
                        }}
                      />
                    </Field>
                  </details>
                </span>
                <button
                  className="btn btn-tertiary sm"
                  disabled={
                    !settings.dataSources.hiroReferenceApiUrl ||
                    referenceApiDirty ||
                    sourceTests["hiro-reference"]?.state === "testing"
                  }
                  onClick={() => void testHealthSource("hiro-reference")}
                  type="button"
                >
                  Test saved connection
                </button>
              </div>
            </ConnectionRow>
          </div>
          <ErrorCallout
            error={sectionError?.section === "dataSources" ? sectionError.message : null}
          />
          {savedSection === "dataSources" ? (
            <div className="settings-section-saved" role="status">
              <Check /> Connections saved.
            </div>
          ) : null}
          {dataSourcesDirty ? (
            <div className="st-foot is-dirty">
              <span>Changes not saved · take effect after preflight passes</span>
              <span className="st-foot-actions">
                <button
                  className="btn btn-tertiary sm"
                  onClick={discardDataSourceChanges}
                  type="button"
                >
                  Discard
                </button>
                <button
                  className="btn btn-primary sm"
                  onClick={() => void saveSection("dataSources")}
                  type="button"
                >
                  {savingSection === "dataSources" ? "Saving" : "Save connections"}
                </button>
              </span>
            </div>
          ) : null}
        </section>

        <DeploymentRequirementsPanel
          eventCount={data?.activity.eventCount ?? null}
          latestBlockHeight={data?.activity.latestBlockHeight ?? null}
          observerAttention={observerAttention}
          onLoadingChange={setRunningChecks}
          onRequirements={recordDeploymentRequirements}
          readOnly={readOnly}
          refreshRevision={deploymentCheckRevision}
          token={token}
        />

        {data ? (
          <ManagerSettings
            data={data}
            onRefreshStatus={onRefreshStatus}
            readOnly={readOnly}
            refreshingStatus={refreshingStatus}
            sync={sync}
            syncing={syncing}
          />
        ) : (
          <>
            <SettingsSectionTitle id="st-manager">Manager</SettingsSectionTitle>
            <section className="card st-card">
              <SettingsRow
                name="Manager attachment"
                status="Unavailable"
                value="Current evidence unavailable"
              />
            </section>
          </>
        )}

        <EngineSettings
          onGasWalletStatus={setGasWalletStatus}
          onStatus={setEngineStatus}
          readOnly={readOnly}
          token={token}
        />

        <SettingsSectionTitle id="st-preferences">Preferences</SettingsSectionTitle>
        <section className="card st-card" aria-label="Preferences">
          <div className="st-rows">
            <SettingsRow
              actions={
                <button
                  className="btn btn-tertiary sm"
                  disabled={!forecastDirty}
                  onClick={() => void saveSection("forecast")}
                  type="button"
                >
                  {savingSection === "forecast" ? "Saving" : "Save"}
                </button>
              }
              help="How many future cycles the pool forecast projects. 1–96."
              name="Forecast horizon"
              value={
                <span className="input-group st-inline-input">
                  <input
                    aria-label="Forecast horizon"
                    inputMode="numeric"
                    max={96}
                    min={1}
                    type="number"
                    value={settings.forecast.horizonCycles}
                    onChange={(event) => {
                      const value = event.target.valueAsNumber;
                      if (Number.isInteger(value)) update("forecast", { horizonCycles: value });
                    }}
                  />
                  <span className="suffix">cycles</span>
                </span>
              }
            />
            <SettingsRow
              name="Theme"
              value={
                <span className="seg">
                  {(["system", "light", "dark"] as const).map((preference) => (
                    <button
                      aria-pressed={settings.display.defaultTheme === preference}
                      aria-label={`${preference} theme`}
                      className={settings.display.defaultTheme === preference ? "on" : ""}
                      disabled={themeBusy}
                      key={preference}
                      onClick={() => void saveTheme(preference)}
                      type="button"
                    >
                      {preference[0]?.toUpperCase()}
                      {preference.slice(1)}
                    </button>
                  ))}
                </span>
              }
            />
          </div>
          <ErrorCallout
            error={sectionError?.section === "forecast" ? sectionError.message : themeError}
          />
          {savedSection === "forecast" ? (
            <div className="settings-section-saved" role="status">
              <Check /> Forecast saved.
            </div>
          ) : null}
        </section>

        <SettingsSectionTitle id="st-access">Access &amp; audit</SettingsSectionTitle>
        <section className="card st-card" aria-label="Access and audit">
          <div className="st-rows">
            <SettingsRow
              help="Bearer token, trusted-header, and Basic authentication are configured by the deployment."
              name="Dashboard access"
              status="Authenticated"
              value={<span className="mono">{authLabel}</span>}
            />
            <SettingsRow
              help="Sidekick never stores signer or manager-admin keys; the only private key it may hold is the gas wallet."
              name="Keys held"
              value={
                <span className="mono">
                  {gasWalletStatus?.configured ? "gas wallet only" : "none"}
                </span>
              }
            />
            <SettingsRow
              actions={
                settings.audit.length ? (
                  <button
                    aria-expanded={auditOpen}
                    className="btn btn-tertiary sm"
                    onClick={() => setAuditOpen((value) => !value)}
                    type="button"
                  >
                    {auditOpen ? "Close" : "History"}
                  </button>
                ) : null
              }
              detail={
                latestAudit
                  ? `last change ${shortUtc(latestAudit.changedAt)} · ${latestAudit.changedFields.join(", ")}`
                  : "no recorded changes"
              }
              name="Settings revision"
              value={<span className="mono">r{settings.revision}</span>}
            >
              {auditOpen ? (
                <div className="st-audit-history">
                  {settings.audit.slice(0, 10).map((entry) => (
                    <div className="audit-row" key={`${entry.revision}-${entry.changedAt}`}>
                      <span className="mono">r{entry.revision}</span>
                      <span>{entry.changedFields.join(", ")}</span>
                      <time className="mono">{shortUtc(entry.changedAt)}</time>
                    </div>
                  ))}
                </div>
              ) : null}
            </SettingsRow>
          </div>
        </section>
      </fieldset>
    </div>
  );
}
