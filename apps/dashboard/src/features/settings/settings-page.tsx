import {
  ArrowSquareOut,
  Check,
  DownloadSimple,
  Key,
  ShieldCheck,
  Warning,
} from "@phosphor-icons/react";
import {
  type DashboardSnapshot,
  type DeploymentRequirement,
  type DeploymentRequirements,
  healthSourceTestResponseSchema,
  type RuntimeSettings,
  runtimeSettingsSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { apiDownload, apiJson } from "../../api-client.js";
import type { SettingsSection } from "../../dashboard-route.js";
import { ErrorCallout, Field, PageHead, StatusBadge } from "../../shared/dashboard-ui.js";
import { DOCUMENT_LINKS } from "../../shared/document-links.js";
import { operatorActionError } from "../../shared/operator-error.js";
import { DeploymentRequirementsPanel } from "./deployment-requirements.js";
import { EngineSettings } from "./engine-settings.js";
import { ManagerSettings } from "./manager-settings.js";

const healthSourceLabels = {
  "node-metrics": "node metrics",
  "signer-monitoring": "signer monitoring",
  "indexed-api": "indexed chain API",
  "hiro-reference": "network comparison API",
} as const;

type HealthSourceKind = keyof typeof healthSourceLabels;
type ApiKeyAction = "keep" | "remove-override" | "replace";
type ConnectionEditor =
  | "node-rpc"
  | "node-metrics"
  | "signer-monitoring"
  | "indexed-api"
  | "hiro-reference";
type SettingsSaveSection = "dataSources" | "forecast";
type SourceTestResult = {
  state: "testing" | "connected" | "failed";
  detail: string;
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
  if (source === "database") return "Saved in Sidekick";
  if (source === "environment") return "Provided by the deployment environment";
  if (source === "indexed-api") return "Reusing the indexed API key (same origin)";
  return "No API key configured";
}

const settingsTargetBySection: Record<SettingsSection, string> = {
  requirements: "requirements",
  attachment: "attachment",
  sources: "connections",
  capabilities: "capabilities",
  observer: "observer",
  auth: "auth",
  support: "support",
};

function ConnectionRow({
  children,
  configured,
  description,
  editing,
  label,
  onEdit,
  status,
  value,
}: {
  children: ReactNode;
  configured: boolean;
  description: string;
  editing: boolean;
  label: string;
  onEdit: () => void;
  status: string;
  value: string;
}) {
  return (
    <article className={`connection-row ${editing ? "editing" : ""}`}>
      <div className="connection-summary">
        <div className="connection-name">
          <h3>{label}</h3>
          <p>{description}</p>
        </div>
        <StatusBadge status={status} />
        <span className={`connection-value mono ${configured ? "" : "muted"}`} title={value}>
          {value}
        </span>
        <button
          aria-expanded={editing}
          className="btn btn-tertiary sm connection-edit"
          onClick={onEdit}
          type="button"
        >
          {editing ? "Close" : "Edit"}
        </button>
      </div>
      {editing ? <div className="connection-editor">{children}</div> : null}
    </article>
  );
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sectionError, setSectionError] = useState<{
    section: SettingsSaveSection;
    message: string;
  } | null>(null);
  const [supportDownloadBusy, setSupportDownloadBusy] = useState(false);
  const [supportDownloadError, setSupportDownloadError] = useState<string | null>(null);
  const [deploymentCheckRevision, setDeploymentCheckRevision] = useState(0);
  const [deploymentRequirements, setDeploymentRequirements] =
    useState<DeploymentRequirements | null>(null);
  const [sourceTests, setSourceTests] = useState<
    Partial<Record<HealthSourceKind, SourceTestResult>>
  >({});
  const [editingSource, setEditingSource] = useState<ConnectionEditor | null>(null);
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
      const result = await apiJson(token, "/api/v1/settings", runtimeSettingsSchema, {
        signal: controller.signal,
      });
      if (settingsLoadController.current === controller) {
        setSettings(result);
        setPersistedSettings(result);
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
    const target = document.getElementById(settingsTargetBySection[initialSection]);
    target?.scrollIntoView({ block: "start" });
  }, [initialSection, settings]);
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
                : {
                    action: section === "dataSources" ? referenceApiKeyAction : "keep",
                  },
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
      setLoadError(null);
      if (section === "dataSources") {
        setApiKey("");
        setApiKeyAction("keep");
        setReferenceApiKey("");
        setReferenceApiKeyAction("keep");
        setIndexedApiDirty(false);
        setReferenceApiDirty(false);
        setDataSourcesDirty(false);
      } else {
        setForecastDirty(false);
      }
      setSavedSection(section);
      if (section === "dataSources") {
        setDeploymentCheckRevision((revision) => revision + 1);
      }
      if (result.display.defaultTheme !== "system") setTheme(result.display.defaultTheme);
      try {
        await onSaved?.();
      } catch (cause) {
        setSectionError({
          section,
          message: operatorActionError(
            cause,
            "Settings were saved, but dashboard status could not be refreshed",
            "The settings are saved; use Refresh in the status bar",
          ),
        });
      }
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

  if (!settings) {
    return (
      <>
        <PageHead title="Settings" lede="Configure this Sidekick deployment." />
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
    }
    setSavedSection(null);
    setSectionError(null);
    if (section === "dataSources") setDataSourcesDirty(true);
    if (section === "forecast") setForecastDirty(true);
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
    if (previousTest) {
      setSourceTests((current) => {
        if (current[previousTest.kind]?.state !== "testing") return current;
        const next = { ...current };
        delete next[previousTest.kind];
        return next;
      });
    }
    const controller = new AbortController();
    sourceTestController.current = { controller, kind };
    setSourceTests((current) => ({
      ...current,
      [kind]: { state: "testing", detail: "Connecting…" },
    }));
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
        [kind]: {
          state: "connected",
          detail: `Connected · ${result.signals} recognized signals`,
        },
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
  const connectionsStatus = deploymentRequirements
    ? deploymentRequirements.status === "ready"
      ? "Connected"
      : "Attention"
    : !data
      ? "Unavailable"
      : data.preflight.status === "pass"
        ? "Connected"
        : data.preflight.status === "warn"
          ? "Attention"
          : "Unavailable";

  return (
    <div className="settings-page">
      <PageHead
        title="Settings"
        lede={readOnly ? "Review this Sidekick deployment." : "Configure this Sidekick deployment."}
      />
      {readOnly ? (
        <div className="callout callout-caution content-notice" role="status">
          Deployment identity does not match. Settings and support evidence remain readable, but
          configuration changes and source tests are disabled.
        </div>
      ) : null}
      {loading ? (
        <div className="callout callout-neutral content-notice" role="status">
          Refreshing settings…
        </div>
      ) : null}
      <ErrorCallout error={loadError} />
      {loadError ? (
        <button type="button" className="btn btn-secondary sm" onClick={() => void loadSettings()}>
          Retry settings
        </button>
      ) : null}
      <fieldset
        className="settings-fields settings-sections"
        disabled={savingSection !== null || readOnly}
      >
        <section className="settings-group" aria-labelledby="deployment-settings-title">
          <div className="settings-group-head">
            <h2 id="deployment-settings-title">Deployment</h2>
            <p>Connections, requirements, and attachment for this running Sidekick instance.</p>
          </div>
          <section className="card-standout set-section connections-panel" id="connections">
            <div className="card-head">
              <div>
                <h2>Connections</h2>
                <p className="muted">
                  Endpoints, credentials, and required runtime features used by this deployment.
                </p>
              </div>
              <StatusBadge status={connectionsStatus} />
            </div>
            <DeploymentRequirementsPanel
              onRequirements={recordDeploymentRequirements}
              readOnly={readOnly}
              refreshRevision={deploymentCheckRevision}
              token={token}
            />
            {data ? (
              <details className="connection-compatibility">
                <summary>
                  Network compatibility: {data.preflight.compatibility.status.replace("-", " ")}
                </summary>
                <p>{data.preflight.compatibility.reason}</p>
                {data.preflight.compatibility.profileId ? (
                  <p className="help">
                    Profile{" "}
                    <span className="mono">
                      {data.preflight.compatibility.profileLabel ??
                        data.preflight.compatibility.profileId}
                    </span>{" "}
                    revision {data.preflight.compatibility.profileRevision ?? "unknown"} ·{" "}
                    {data.preflight.compatibility.origin === "operator-provided"
                      ? "operator-installed"
                      : "built in"}
                  </p>
                ) : null}
                <p className="help">
                  Node{" "}
                  <span className="mono">
                    {data.preflight.node.version ?? data.preflight.node.serverVersion ?? "unknown"}
                    {data.preflight.node.commit ? ` (${data.preflight.node.commit})` : ""}
                  </span>
                </p>
                <div className="stacked-doc-links">
                  <a href={DOCUMENT_LINKS.nodeDocker} target="_blank" rel="noreferrer">
                    Node setup <ArrowSquareOut aria-hidden="true" />
                  </a>
                  <a href={DOCUMENT_LINKS.signerQuickstart} target="_blank" rel="noreferrer">
                    Signer quickstart <ArrowSquareOut aria-hidden="true" />
                  </a>
                  <a href={DOCUMENT_LINKS.signerConfiguration} target="_blank" rel="noreferrer">
                    Signer configuration <ArrowSquareOut aria-hidden="true" />
                  </a>
                </div>
              </details>
            ) : null}
            <div className="connection-list">
              <ConnectionRow
                configured
                description="Current chain state and PoX-5 reads."
                editing={editingSource === "node-rpc"}
                label="Stacks node"
                onEdit={() => setEditingSource(editingSource === "node-rpc" ? null : "node-rpc")}
                status={nodeStatus}
                value={settings.dataSources.nodeRpcUrl}
              >
                <Field label="Stacks node RPC URL" help="Stacks node used by Sidekick.">
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
              </ConnectionRow>

              <ConnectionRow
                configured={Boolean(settings.dataSources.nodeMetricsUrl)}
                description="Prometheus metrics used for local node diagnosis."
                editing={editingSource === "node-metrics"}
                label="Node monitoring"
                onEdit={() =>
                  setEditingSource(editingSource === "node-metrics" ? null : "node-metrics")
                }
                status={nodeMetricsStatus}
                value={settings.dataSources.nodeMetricsUrl || "Not configured"}
              >
                <Field
                  label="Node metrics URL"
                  help="Recommended Prometheus endpoint from stacks-core."
                >
                  <div className="field-inline-action">
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
                    <button
                      type="button"
                      className="btn btn-tertiary"
                      disabled={
                        !settings.dataSources.nodeMetricsUrl ||
                        sourceTests["node-metrics"]?.state === "testing"
                      }
                      onClick={() =>
                        void testHealthSource("node-metrics", settings.dataSources.nodeMetricsUrl)
                      }
                    >
                      Test
                    </button>
                  </div>
                  {sourceTests["node-metrics"] ? (
                    <span
                      className={
                        sourceTests["node-metrics"]?.state === "failed" ? "field-error" : "muted"
                      }
                    >
                      {sourceTests["node-metrics"]?.detail}
                    </span>
                  ) : null}
                </Field>
              </ConnectionRow>

              <ConnectionRow
                configured={Boolean(settings.dataSources.signerMonitoringUrl)}
                description="Signer metrics used for participation and latency diagnosis."
                editing={editingSource === "signer-monitoring"}
                label="Signer monitoring"
                onEdit={() =>
                  setEditingSource(
                    editingSource === "signer-monitoring" ? null : "signer-monitoring",
                  )
                }
                status={signerMonitoringStatus}
                value={settings.dataSources.signerMonitoringUrl || "Not configured"}
              >
                <Field label="Signer monitoring URL" help="Recommended signer monitoring endpoint.">
                  <div className="field-inline-action">
                    <input
                      className="input mono"
                      type="url"
                      placeholder="http://stacks-signer:9153"
                      value={settings.dataSources.signerMonitoringUrl}
                      onChange={(event) =>
                        update("dataSources", {
                          ...settings.dataSources,
                          signerMonitoringUrl: event.target.value,
                        })
                      }
                    />
                    <button
                      type="button"
                      className="btn btn-tertiary"
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
                    >
                      Test
                    </button>
                  </div>
                  {sourceTests["signer-monitoring"] ? (
                    <span
                      className={
                        sourceTests["signer-monitoring"]?.state === "failed"
                          ? "field-error"
                          : "muted"
                      }
                    >
                      {sourceTests["signer-monitoring"]?.detail}
                    </span>
                  ) : null}
                </Field>
              </ConnectionRow>

              <ConnectionRow
                configured
                description="Roster, activity, and historical chain data."
                editing={editingSource === "indexed-api"}
                label="Indexed chain API"
                onEdit={() =>
                  setEditingSource(editingSource === "indexed-api" ? null : "indexed-api")
                }
                status={indexedApiStatus}
                value={settings.dataSources.apiUrl}
              >
                <p className="credential-status-inline">
                  {apiKeyAction === "replace"
                    ? "New key will be saved"
                    : apiKeyAction === "remove-override"
                      ? "Saved key will be removed"
                      : credentialSourceLabel(settings.dataSources.apiKeySource)}
                </p>
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
                      setSavedSection(null);
                      setSectionError(null);
                      setDataSourcesDirty(true);
                      setIndexedApiDirty(true);
                      setSourceTests({});
                      setApiKey(value);
                      setApiKeyAction(value ? "replace" : "keep");
                    }}
                  />
                </Field>
                <div className="api-source-actions">
                  <button
                    type="button"
                    className="btn btn-tertiary"
                    disabled={indexedApiDirty || sourceTests["indexed-api"]?.state === "testing"}
                    onClick={() => void testHealthSource("indexed-api")}
                  >
                    Test saved connection
                  </button>
                  {settings.dataSources.apiKeySource === "database" ? (
                    <button
                      type="button"
                      className="btn btn-tertiary"
                      onClick={() => {
                        setApiKey("");
                        setApiKeyAction("remove-override");
                        setIndexedApiDirty(true);
                        setDataSourcesDirty(true);
                        setSavedSection(null);
                        setSectionError(null);
                        setSourceTests({});
                      }}
                    >
                      Remove saved key
                    </button>
                  ) : null}
                </div>
                {indexedApiDirty ? (
                  <p className="help">Save connections before testing this API.</p>
                ) : null}
                {sourceTests["indexed-api"] ? (
                  <span
                    className={
                      sourceTests["indexed-api"]?.state === "failed" ? "field-error" : "muted"
                    }
                  >
                    {sourceTests["indexed-api"]?.detail}
                  </span>
                ) : null}
                <details className="wallet-operation-advanced api-source-advanced">
                  <summary>Advanced</summary>
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
              </ConnectionRow>

              <ConnectionRow
                configured={Boolean(settings.dataSources.hiroReferenceApiUrl)}
                description="External reference used only to diagnose local node health."
                editing={editingSource === "hiro-reference"}
                label="Network comparison API"
                onEdit={() =>
                  setEditingSource(editingSource === "hiro-reference" ? null : "hiro-reference")
                }
                status={referenceApiStatus}
                value={settings.dataSources.hiroReferenceApiUrl || "Not configured"}
              >
                <p className="credential-status-inline">
                  {referenceApiKeyAction === "replace"
                    ? "New key will be saved"
                    : referenceApiKeyAction === "remove-override"
                      ? "Saved key will be removed"
                      : credentialSourceLabel(settings.dataSources.hiroReferenceApiKeySource)}
                </p>
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
                  help="Optional. A same-origin indexed API key is reused automatically."
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
                      setSavedSection(null);
                      setSectionError(null);
                      setDataSourcesDirty(true);
                      setReferenceApiDirty(true);
                      setSourceTests({});
                      setReferenceApiKey(value);
                      setReferenceApiKeyAction(value ? "replace" : "keep");
                    }}
                  />
                </Field>
                <div className="api-source-actions">
                  <button
                    type="button"
                    className="btn btn-tertiary"
                    disabled={
                      !settings.dataSources.hiroReferenceApiUrl ||
                      referenceApiDirty ||
                      sourceTests["hiro-reference"]?.state === "testing"
                    }
                    onClick={() => void testHealthSource("hiro-reference")}
                  >
                    Test saved connection
                  </button>
                  {settings.dataSources.hiroReferenceApiKeySource === "database" ? (
                    <button
                      type="button"
                      className="btn btn-tertiary"
                      onClick={() => {
                        setReferenceApiKey("");
                        setReferenceApiKeyAction("remove-override");
                        setReferenceApiDirty(true);
                        setDataSourcesDirty(true);
                        setSavedSection(null);
                        setSectionError(null);
                        setSourceTests({});
                      }}
                    >
                      Remove saved key
                    </button>
                  ) : null}
                </div>
                {referenceApiDirty ? (
                  <p className="help">Save connections before testing this API.</p>
                ) : null}
                {sourceTests["hiro-reference"] ? (
                  <span
                    className={
                      sourceTests["hiro-reference"]?.state === "failed" ? "field-error" : "muted"
                    }
                  >
                    {sourceTests["hiro-reference"]?.detail}
                  </span>
                ) : null}
                <details className="wallet-operation-advanced api-source-advanced">
                  <summary>Advanced</summary>
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
            {!readOnly ? (
              <div className="settings-section-actions">
                {dataSourcesDirty ? (
                  <button
                    className="btn btn-tertiary"
                    onClick={discardDataSourceChanges}
                    type="button"
                  >
                    Discard changes
                  </button>
                ) : null}
                <button
                  className="btn btn-accent"
                  disabled={!dataSourcesDirty || savingSection !== null}
                  onClick={() => void saveSection("dataSources")}
                  type="button"
                >
                  {savingSection === "dataSources" ? "Saving" : "Save connections"}
                </button>
              </div>
            ) : null}
          </section>

          {data ? (
            <ManagerSettings
              data={data}
              onRefreshStatus={onRefreshStatus}
              refreshingStatus={refreshingStatus}
              sync={sync}
              syncing={syncing}
              view="attachment"
            />
          ) : (
            <section className="card-standout set-section" id="attachment">
              <div className="card-head">
                <h2>Manager attachment</h2>
                <StatusBadge status="Unavailable" />
              </div>
              <p className="muted">Current attachment evidence is temporarily unavailable.</p>
            </section>
          )}
          <section className="card set-section" id="observer">
            <div className="card-head">
              <h2>Event observer</h2>
              <StatusBadge
                status={
                  data?.alerts.some(({ id }) => id.startsWith("observer:"))
                    ? "Attention"
                    : "Monitored"
                }
              />
            </div>
            <p className="muted">
              Sidekick verifies callback claims against the local node before using them and falls
              back to bounded polling when delivery is delayed. Delivery gaps appear on Overview;
              detailed queue, verification, and reconciliation evidence is included in the support
              bundle.
            </p>
            <div className="statline">
              <span className="k">Verified manager events</span>
              <span className="v mono">{data?.activity.eventCount ?? "Unavailable"}</span>
            </div>
            <div className="statline">
              <span className="k">Latest verified Stacks block</span>
              <span className="v mono">{data?.activity.latestBlockHeight ?? "Unavailable"}</span>
            </div>
          </section>
        </section>

        <section className="settings-group" aria-labelledby="operations-settings-title">
          <div className="settings-group-head">
            <h2 id="operations-settings-title">Operations</h2>
            <p>Manager capabilities, forecast range, and transaction policy.</p>
          </div>
          {data ? (
            <ManagerSettings
              data={data}
              onRefreshStatus={onRefreshStatus}
              refreshingStatus={refreshingStatus}
              sync={sync}
              syncing={syncing}
              view="operations"
            />
          ) : null}
          <section className="card set-section form-grid" id="forecast-settings">
            <div className="card-head">
              <h2>Pool forecast</h2>
            </div>
            <Field label="Forecast horizon">
              <div className="input-group">
                <input
                  inputMode="numeric"
                  value={settings.forecast.horizonCycles}
                  onChange={(event) => {
                    const value = event.target.valueAsNumber;
                    if (Number.isInteger(value)) update("forecast", { horizonCycles: value });
                  }}
                  type="number"
                  min={1}
                  max={96}
                />
                <span className="suffix">cycles</span>
              </div>
            </Field>
            <ErrorCallout
              error={sectionError?.section === "forecast" ? sectionError.message : null}
            />
            {savedSection === "forecast" ? (
              <div className="settings-section-saved" role="status">
                <Check /> Forecast saved.
              </div>
            ) : null}
            {!readOnly ? (
              <div className="settings-section-actions">
                <button
                  className="btn btn-accent"
                  disabled={!forecastDirty || savingSection !== null}
                  onClick={() => void saveSection("forecast")}
                  type="button"
                >
                  {savingSection === "forecast" ? "Saving" : "Save forecast"}
                </button>
              </div>
            ) : null}
          </section>
          <EngineSettings token={token} />
        </section>

        <section className="settings-group" aria-labelledby="access-settings-title">
          <div className="settings-group-head">
            <h2 id="access-settings-title">Access &amp; security</h2>
            <p>Authentication, manager trust, and recent configuration changes.</p>
          </div>
          <section className="card set-section" id="auth">
            <div className="card-head">
              <h2>Authentication &amp; trust</h2>
            </div>
            <div className="statline">
              <span className="k">HTTP access</span>
              <span className="v">Authenticated</span>
            </div>
            <div className="statline">
              <span className="k">Settings revision</span>
              <span className="v mono">{settings.revision}</span>
            </div>
            {data?.manager ? (
              <>
                <div className="statline">
                  <span className="k">Manager trust</span>
                  <span className="v">
                    {data.manager.source.tier === "reference-built-in"
                      ? "Built-in reference"
                      : data.manager.source.tier === "reference-render"
                        ? "Verified reference"
                        : data.manager.source.tier === "custom-observe"
                          ? "Custom manager"
                          : "Unverified manager"}
                  </span>
                </div>
                <div className="statline">
                  <span className="k">Installed profile store</span>
                  <span className="v">
                    {data.manager.installedProfiles.directory
                      ? `${data.manager.installedProfiles.loaded} loaded · ${data.manager.installedProfiles.issues.length} ${data.manager.installedProfiles.issues.length === 1 ? "issue" : "issues"}`
                      : "Not configured"}
                  </span>
                </div>
                <div className="callout callout-info security-note">
                  <ShieldCheck className="ic" />
                  <div className="body">
                    <strong>
                      {data.manager.automationEligible
                        ? "Assist available."
                        : "Assist unavailable."}
                    </strong>{" "}
                    {!data.manager.automationEligible
                      ? data.manager.automationEligibilityReason
                      : null}
                  </div>
                </div>
                {data.manager.installedProfiles.issues.map((issue) => (
                  <div
                    className="callout callout-caution security-note"
                    key={`${issue.fileName ?? "directory"}-${issue.code}`}
                  >
                    <Warning className="ic" />
                    <div className="body">
                      <strong>{issue.fileName ?? "Profile directory"}:</strong> {issue.message}
                    </div>
                  </div>
                ))}
              </>
            ) : null}
            <div className="callout callout-neutral security-note">
              <Key className="ic" />
              <div className="body">
                Sidekick does not store manager-admin or signer private keys.
              </div>
            </div>
            {settings.audit.length ? (
              <div className="settings-audit">
                <h3>Recent changes</h3>
                {settings.audit.slice(0, 5).map((entry) => (
                  <div className="audit-row" key={`${entry.revision}-${entry.changedAt}`}>
                    <span className="mono">r{entry.revision}</span>
                    <span>{entry.changedFields.join(", ")}</span>
                    <time className="mono">{new Date(entry.changedAt).toLocaleString()}</time>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        </section>
      </fieldset>

      <section className="settings-group" aria-labelledby="support-settings-title">
        <div className="settings-group-head">
          <h2 id="support-settings-title">Support</h2>
          <p>Collect diagnostics and find deployment maintenance procedures.</p>
        </div>
        <section className="card set-section" id="support">
          <div className="card-head">
            <h2>Support &amp; maintenance</h2>
            <button
              className="btn btn-secondary sm"
              disabled={supportDownloadBusy}
              onClick={() => void downloadSupportBundle()}
              type="button"
            >
              <DownloadSimple />
              {supportDownloadBusy ? "Collecting support bundle" : "Download support bundle"}
            </button>
          </div>
          <ErrorCallout error={supportDownloadError} />
          <p className="muted">
            Send this redacted snapshot to Stacks Labs support. It combines Sidekick, manager, node,
            signer, observer, reconciliation, and operation evidence without private keys or
            operator credentials.
          </p>
          <p className="muted">
            Database backup, restore, and deployment maintenance procedures are documented for the
            host operator rather than performed from this dashboard.
          </p>
          <a href={DOCUMENT_LINKS.operatorGuide} target="_blank" rel="noreferrer">
            Open the operator guide <ArrowSquareOut aria-hidden="true" />
          </a>
        </section>
      </section>
    </div>
  );
}
