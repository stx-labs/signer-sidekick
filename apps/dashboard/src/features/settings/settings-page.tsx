import {
  ArrowSquareOut,
  CaretDown,
  Check,
  DownloadSimple,
  Key,
  Plugs,
  ShieldCheck,
  Warning,
} from "@phosphor-icons/react";
import {
  type DashboardSnapshot,
  healthSourceTestResponseSchema,
  type RuntimeSettings,
  runtimeSettingsSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { useCallback, useEffect, useRef, useState } from "react";
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

function credentialSourceLabel(
  source: "environment" | "database" | "indexed-api" | "none",
): string {
  if (source === "database") return "Saved in Sidekick";
  if (source === "environment") return "Provided by the deployment environment";
  if (source === "indexed-api") return "Reusing the indexed API key (same origin)";
  return "No API key configured";
}

const settingsTabs = [
  ["deployment", "Deployment"],
  ["data-sources", "Data sources"],
  ["operations", "Operations"],
  ["support-security", "Support & security"],
] as const;
type SettingsTab = (typeof settingsTabs)[number][0];

function settingsTabForSection(section: SettingsSection | null): SettingsTab {
  if (section === "sources") return "data-sources";
  if (section === "capabilities") return "operations";
  if (section === "auth" || section === "support") return "support-security";
  return "deployment";
}

function SettingsMobilePicker({
  activeTab,
  onSelect,
}: {
  activeTab: SettingsTab;
  onSelect: (tab: SettingsTab) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const activeLabel = settingsTabs.find(([id]) => id === activeTab)?.[1] ?? "Choose section";

  useEffect(() => {
    if (!open) return;
    const closeFromOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromKeyboard);
    };
  }, [open]);

  return (
    <div className="settings-mobile-picker" ref={rootRef}>
      <span id="settings-section-label">Settings section</span>
      <button
        aria-controls="settings-section-menu"
        aria-expanded={open}
        aria-labelledby="settings-section-label settings-section-current"
        className="mobile-page-menu-trigger"
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
        type="button"
      >
        <span className="mobile-page-menu-current" id="settings-section-current">
          <span>{activeLabel}</span>
        </span>
        <CaretDown className="mobile-page-menu-chevron" />
      </button>
      <nav
        aria-label="Settings sections"
        className="mobile-page-menu-popover settings-mobile-picker-popover"
        hidden={!open}
        id="settings-section-menu"
      >
        {settingsTabs.map(([id, label]) => (
          <button
            aria-current={activeTab === id ? "page" : undefined}
            className={`mobile-page-menu-item ${activeTab === id ? "active" : ""}`}
            key={id}
            onClick={() => {
              onSelect(id);
              setOpen(false);
              triggerRef.current?.focus();
            }}
            type="button"
          >
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
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
  const [loading, setLoading] = useState(settings === null);
  const [apiKeyAction, setApiKeyAction] = useState<ApiKeyAction>("keep");
  const [apiKey, setApiKey] = useState("");
  const [referenceApiKeyAction, setReferenceApiKeyAction] = useState<ApiKeyAction>("keep");
  const [referenceApiKey, setReferenceApiKey] = useState("");
  const [indexedApiDirty, setIndexedApiDirty] = useState(false);
  const [referenceApiDirty, setReferenceApiDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [supportDownloadBusy, setSupportDownloadBusy] = useState(false);
  const [supportDownloadError, setSupportDownloadError] = useState<string | null>(null);
  const [deploymentCheckRevision, setDeploymentCheckRevision] = useState(0);
  const [sourceTest, setSourceTest] = useState<{
    kind: HealthSourceKind;
    state: "testing" | "connected" | "failed";
    detail: string;
  } | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>(() =>
    settingsTabForSection(initialSection),
  );
  const settingsLoadController = useRef<AbortController | null>(null);
  const sourceTestController = useRef<AbortController | null>(null);

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
        setDirty(false);
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
      sourceTestController.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (!initialSection || !settings) return;
    setActiveTab(settingsTabForSection(initialSection));
  }, [initialSection, settings]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const save = async () => {
    if (!settings) return;
    sourceTestController.current?.abort();
    sourceTestController.current = null;
    setSourceTest(null);
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      const {
        audit: _audit,
        revision: _revision,
        schemaVersion: _schemaVersion,
        updatedAt: _updatedAt,
        ...editable
      } = settings;
      const result = await apiJson(token, "/api/v1/settings", runtimeSettingsSchema, {
        method: "PUT",
        body: JSON.stringify({
          ...editable,
          dataSources: {
            nodeRpcUrl: editable.dataSources.nodeRpcUrl,
            apiUrl: editable.dataSources.apiUrl,
            apiKeyHeader: editable.dataSources.apiKeyHeader,
            nodeMetricsUrl: editable.dataSources.nodeMetricsUrl,
            signerMonitoringUrl: editable.dataSources.signerMonitoringUrl,
            hiroReferenceApiUrl: editable.dataSources.hiroReferenceApiUrl,
            hiroReferenceApiKeyHeader: editable.dataSources.hiroReferenceApiKeyHeader,
            apiKeyAction:
              apiKeyAction === "replace"
                ? { action: "replace", value: apiKey }
                : { action: apiKeyAction },
            hiroReferenceApiKeyAction:
              referenceApiKeyAction === "replace"
                ? { action: "replace", value: referenceApiKey }
                : { action: referenceApiKeyAction },
          },
        }),
      });
      setSettings(result);
      setLoadError(null);
      setApiKey("");
      setApiKeyAction("keep");
      setReferenceApiKey("");
      setReferenceApiKeyAction("keep");
      setIndexedApiDirty(false);
      setReferenceApiDirty(false);
      setSaved(true);
      setDirty(false);
      setDeploymentCheckRevision((revision) => revision + 1);
      if (result.display.defaultTheme !== "system") setTheme(result.display.defaultTheme);
      try {
        await onSaved?.();
      } catch (cause) {
        setError(
          operatorActionError(
            cause,
            "Settings were saved, but dashboard status could not be refreshed",
            "The settings are saved; use Refresh in the status bar",
          ),
        );
      }
    } catch (cause) {
      setError(
        operatorActionError(
          cause,
          "Could not save settings",
          "Review the fields, then retry; saving again is safe",
        ),
      );
    } finally {
      setBusy(false);
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
    sourceTestController.current?.abort();
    sourceTestController.current = null;
    setSaved(false);
    setSourceTest(null);
    setDirty(true);
    setSettings({ ...settings, [section]: value });
  };
  const testHealthSource = async (kind: HealthSourceKind, url?: string) => {
    sourceTestController.current?.abort();
    const controller = new AbortController();
    sourceTestController.current = controller;
    setSourceTest({ kind, state: "testing", detail: "Connecting…" });
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
      if (sourceTestController.current !== controller) return;
      setSourceTest({
        kind,
        state: "connected",
        detail: `Connected · ${result.signals} recognized signals`,
      });
    } catch (cause) {
      if (controller.signal.aborted || sourceTestController.current !== controller) return;
      setSourceTest({
        kind,
        state: "failed",
        detail: operatorActionError(
          cause,
          `Could not connect to ${healthSourceLabels[kind]}`,
          "Check the URL, then retry; this test does not save settings",
        ),
      });
    } finally {
      if (sourceTestController.current === controller) sourceTestController.current = null;
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

  return (
    <div className="settings-page">
      <PageHead
        title="Settings"
        lede={readOnly ? "Review this Sidekick deployment." : "Configure this Sidekick deployment."}
        actions={
          readOnly ? (
            <button
              className="btn btn-secondary"
              disabled={supportDownloadBusy}
              onClick={() => void downloadSupportBundle()}
              type="button"
            >
              <DownloadSimple />
              {supportDownloadBusy ? "Collecting support bundle" : "Download support bundle"}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-accent"
              disabled={busy || !dirty}
              onClick={() => void save()}
            >
              {busy ? "Saving" : "Save changes"}
            </button>
          )
        }
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
      <ErrorCallout error={error} />
      {saved ? (
        <div className="callout callout-info settings-saved">
          <Check className="ic" />
          <div className="body">Settings saved.</div>
        </div>
      ) : null}
      <SettingsMobilePicker activeTab={activeTab} onSelect={setActiveTab} />
      <div className="settings-grid">
        <nav className="set-nav" aria-label="Settings sections">
          {settingsTabs.map(([id, label]) => (
            <button
              type="button"
              className={activeTab === id ? "active" : ""}
              key={id}
              onClick={() => setActiveTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <fieldset className="settings-scroll settings-fields" disabled={busy || readOnly}>
          {activeTab === "deployment" ? (
            <>
              <DeploymentRequirementsPanel
                readOnly={readOnly}
                refreshRevision={deploymentCheckRevision}
                token={token}
              />
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
            </>
          ) : null}

          {activeTab === "data-sources" ? (
            <section className="card-standout set-section form-grid" id="sources">
              <div className="card-head">
                <h2>
                  <Plugs /> Data sources
                </h2>
                <StatusBadge
                  status={
                    !data
                      ? "Unavailable"
                      : data.preflight.status === "pass"
                        ? "Connected"
                        : data.preflight.status === "warn"
                          ? "Attention"
                          : "Unavailable"
                  }
                />
              </div>
              {data ? (
                <div className="archive-guidance" role="note">
                  <div>
                    <strong>
                      Network compatibility: {data.preflight.compatibility.status.replace("-", " ")}
                    </strong>
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
                        {data.preflight.node.version ??
                          data.preflight.node.serverVersion ??
                          "unknown"}
                        {data.preflight.node.commit ? ` (${data.preflight.node.commit})` : ""}
                      </span>
                    </p>
                  </div>
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
                </div>
              ) : (
                <div className="callout callout-caution" role="status">
                  Compatibility details are temporarily unavailable. You can still update data
                  sources.
                </div>
              )}
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
                      !settings.dataSources.nodeMetricsUrl || sourceTest?.state === "testing"
                    }
                    onClick={() =>
                      void testHealthSource("node-metrics", settings.dataSources.nodeMetricsUrl)
                    }
                  >
                    Test
                  </button>
                </div>
                {sourceTest?.kind === "node-metrics" ? (
                  <span className={sourceTest.state === "failed" ? "field-error" : "muted"}>
                    {sourceTest.detail}
                  </span>
                ) : null}
              </Field>
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
                      !settings.dataSources.signerMonitoringUrl || sourceTest?.state === "testing"
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
                {sourceTest?.kind === "signer-monitoring" ? (
                  <span className={sourceTest.state === "failed" ? "field-error" : "muted"}>
                    {sourceTest.detail}
                  </span>
                ) : null}
              </Field>
              <div className="api-source-grid">
                <section className="api-source-card" aria-labelledby="indexed-api-title">
                  <div className="api-source-head">
                    <div>
                      <h3 id="indexed-api-title">Indexed chain API</h3>
                      <p>Roster, activity, and historical chain data.</p>
                    </div>
                    <span className="credential-status">
                      {apiKeyAction === "replace"
                        ? "New key will be saved"
                        : apiKeyAction === "remove-override"
                          ? "Saved key will be removed"
                          : credentialSourceLabel(settings.dataSources.apiKeySource)}
                    </span>
                  </div>
                  <Field label="URL">
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
                  <Field
                    label="API key"
                    help="Write-only. Leave blank to keep the current deployment or saved key."
                  >
                    <input
                      className="input mono"
                      type="password"
                      autoComplete="new-password"
                      placeholder={
                        settings.dataSources.apiKeyConfigured ? "Configured" : "Optional"
                      }
                      value={apiKey}
                      onChange={(event) => {
                        const value = event.target.value;
                        setSaved(false);
                        setDirty(true);
                        setIndexedApiDirty(true);
                        setSourceTest(null);
                        setApiKey(value);
                        setApiKeyAction(value ? "replace" : "keep");
                      }}
                    />
                  </Field>
                  <div className="api-source-actions">
                    <button
                      type="button"
                      className="btn btn-tertiary"
                      disabled={indexedApiDirty || sourceTest?.state === "testing"}
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
                          setDirty(true);
                          setSaved(false);
                          setSourceTest(null);
                        }}
                      >
                        Remove saved key
                      </button>
                    ) : null}
                  </div>
                  {indexedApiDirty ? (
                    <p className="help">Save changes before testing this connection.</p>
                  ) : null}
                  {sourceTest?.kind === "indexed-api" ? (
                    <span className={sourceTest.state === "failed" ? "field-error" : "muted"}>
                      {sourceTest.detail}
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
                </section>

                <section className="api-source-card" aria-labelledby="reference-api-title">
                  <div className="api-source-head">
                    <div>
                      <h3 id="reference-api-title">Network comparison API</h3>
                      <p>External reference used only to diagnose local node health.</p>
                    </div>
                    <span className="credential-status">
                      {referenceApiKeyAction === "replace"
                        ? "New key will be saved"
                        : referenceApiKeyAction === "remove-override"
                          ? "Saved key will be removed"
                          : credentialSourceLabel(settings.dataSources.hiroReferenceApiKeySource)}
                    </span>
                  </div>
                  <Field label="URL">
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
                        settings.dataSources.hiroReferenceApiKeyConfigured
                          ? "Configured"
                          : "Optional"
                      }
                      value={referenceApiKey}
                      onChange={(event) => {
                        const value = event.target.value;
                        setSaved(false);
                        setDirty(true);
                        setReferenceApiDirty(true);
                        setSourceTest(null);
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
                        sourceTest?.state === "testing"
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
                          setDirty(true);
                          setSaved(false);
                          setSourceTest(null);
                        }}
                      >
                        Remove saved key
                      </button>
                    ) : null}
                  </div>
                  {referenceApiDirty ? (
                    <p className="help">Save changes before testing this connection.</p>
                  ) : null}
                  {sourceTest?.kind === "hiro-reference" ? (
                    <span className={sourceTest.state === "failed" ? "field-error" : "muted"}>
                      {sourceTest.detail}
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
                </section>
              </div>
            </section>
          ) : null}

          {activeTab === "operations" ? (
            <>
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
              </section>
              <EngineSettings token={token} />
            </>
          ) : null}

          {activeTab === "deployment" ? (
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
          ) : null}

          {activeTab === "support-security" ? (
            <>
              <section className="card set-section" id="auth">
                <div className="card-head">
                  <h2>Access &amp; security</h2>
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
                  Send this redacted snapshot to Stacks Labs support. It combines Sidekick, manager,
                  node, signer, observer, reconciliation, and operation evidence without private
                  keys or operator credentials.
                </p>
                <p className="muted">
                  Database backup, restore, and deployment maintenance procedures are documented for
                  the host operator rather than performed from this dashboard.
                </p>
                <a href={DOCUMENT_LINKS.operatorGuide} target="_blank" rel="noreferrer">
                  Open the operator guide <ArrowSquareOut aria-hidden="true" />
                </a>
              </section>
            </>
          ) : null}
        </fieldset>
      </div>
    </div>
  );
}
