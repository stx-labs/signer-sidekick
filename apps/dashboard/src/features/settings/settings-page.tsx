import { ArrowSquareOut, Check, Key, Plugs, ShieldCheck, Warning } from "@phosphor-icons/react";
import {
  type DashboardSnapshot,
  healthSourceTestResponseSchema,
  type RuntimeSettings,
  runtimeSettingsSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiJson } from "../../api-client.js";
import { CopyIdentifierButton } from "../../copyable-identifier.js";
import { ErrorCallout, Field, PageHead, StatusBadge } from "../../shared/dashboard-ui.js";
import { DOCUMENT_LINKS } from "../../shared/document-links.js";
import { operatorActionError } from "../../shared/operator-error.js";

const healthSourceLabels = {
  "node-metrics": "node metrics",
  "signer-monitoring": "signer monitoring",
  "hiro-reference": "reference API",
} as const;

export function SettingsPage({
  data,
  token,
  setTheme,
  onSaved,
}: {
  data: DashboardSnapshot | null;
  token: string;
  setTheme: (theme: "light" | "dark") => void;
  onSaved?: () => void | Promise<void>;
}) {
  const [settings, setSettings] = useState<RuntimeSettings | null>(() =>
    data?.freshness?.status === "stale" ? null : (data?.runtimeSettings ?? null),
  );
  const [loading, setLoading] = useState(settings === null);
  const [apiKeyAction, setApiKeyAction] = useState<"keep" | "clear" | "replace">("keep");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceTest, setSourceTest] = useState<{
    kind: "node-metrics" | "signer-monitoring" | "hiro-reference";
    state: "testing" | "connected" | "failed";
    detail: string;
  } | null>(null);
  const [activeSection, setActiveSection] = useState("identity");
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
      if (settingsLoadController.current === controller) setSettings(result);
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
            apiKeyAction:
              apiKeyAction === "replace"
                ? { action: "replace", value: apiKey }
                : { action: apiKeyAction },
          },
        }),
      });
      setSettings(result);
      setLoadError(null);
      setApiKey("");
      setApiKeyAction("keep");
      setSaved(true);
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
    setSettings({ ...settings, [section]: value });
  };
  const testHealthSource = async (
    kind: "node-metrics" | "signer-monitoring" | "hiro-reference",
    url: string,
  ) => {
    sourceTestController.current?.abort();
    const controller = new AbortController();
    sourceTestController.current = controller;
    setSourceTest({ kind, state: "testing", detail: "Connecting…" });
    try {
      const result = await apiJson(
        token,
        "/api/v1/health/test-source",
        healthSourceTestResponseSchema,
        { method: "POST", body: JSON.stringify({ kind, url }), signal: controller.signal },
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

  return (
    <div className="settings-page">
      <PageHead
        title="Settings"
        lede="Configure this Sidekick deployment."
        actions={
          <button
            type="button"
            className="btn btn-accent"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? "Saving" : "Save changes"}
          </button>
        }
      />
      {loading ? (
        <div className="callout callout-neutral" role="status">
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
      <div className="grid cols-1-2 settings-grid">
        <nav className="set-nav">
          {(
            [
              ["identity", "Pool identity"],
              ["display", "Display"],
              ["sources", "Data sources"],
              ["security", "Access & security"],
              ["maintenance", "About & maintenance"],
            ] as const
          ).map(([id, label]) => (
            <button
              type="button"
              className={activeSection === id ? "active" : ""}
              key={id}
              onClick={() => {
                setActiveSection(id);
                document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        <fieldset className="settings-scroll settings-fields" disabled={busy}>
          <section className="card-standout set-section form-grid" id="identity">
            <div className="card-head">
              <h2>Pool identity</h2>
              <span className="muted">shown in the dashboard and generated pool card</span>
            </div>
            <Field label="Manager principal">
              <span className="copyable-input">
                <input
                  className="input mono"
                  readOnly
                  value={data?.managerPrincipal ?? "Operator state temporarily unavailable"}
                />
                <CopyIdentifierButton value={data?.managerPrincipal} label="manager principal" />
              </span>
            </Field>
            <Field label="Display name">
              <input
                className="input"
                value={settings.pool.displayName}
                onChange={(event) =>
                  update("pool", { ...settings.pool, displayName: event.target.value })
                }
              />
            </Field>
            <Field label="Website URL">
              <input
                className="input"
                type="url"
                value={settings.pool.websiteUrl}
                onChange={(event) =>
                  update("pool", { ...settings.pool, websiteUrl: event.target.value })
                }
              />
            </Field>
            <Field label="Support email or URL">
              <input
                className="input"
                value={settings.pool.supportContact}
                onChange={(event) =>
                  update("pool", { ...settings.pool, supportContact: event.target.value })
                }
              />
            </Field>
            <Field label="Leather enrollment URL">
              <input
                className="input"
                type="url"
                value={settings.pool.leatherUrl}
                onChange={(event) =>
                  update("pool", { ...settings.pool, leatherUrl: event.target.value })
                }
              />
            </Field>
          </section>

          <section className="card-standout set-section form-grid" id="display">
            <div className="card-head">
              <h2>Display preferences</h2>
            </div>
            <Field label="Default theme">
              <select
                className="input"
                value={settings.display.defaultTheme}
                onChange={(event) =>
                  update("display", {
                    ...settings.display,
                    defaultTheme: event.target.value as RuntimeSettings["display"]["defaultTheme"],
                  })
                }
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </Field>
          </section>

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
                  update("dataSources", { ...settings.dataSources, nodeRpcUrl: event.target.value })
                }
              />
            </Field>
            <Field label="Node metrics URL" help="Optional Prometheus endpoint from stacks-core.">
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
                  disabled={!settings.dataSources.nodeMetricsUrl || sourceTest?.state === "testing"}
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
            <Field label="Signer monitoring URL" help="Optional signer monitoring endpoint.">
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
            <Field label="Reference API URL" help="Public API used to compare chain height.">
              <div className="field-inline-action">
                <input
                  className="input mono"
                  type="url"
                  value={settings.dataSources.hiroReferenceApiUrl}
                  onChange={(event) =>
                    update("dataSources", {
                      ...settings.dataSources,
                      hiroReferenceApiUrl: event.target.value,
                    })
                  }
                />
                <button
                  type="button"
                  className="btn btn-tertiary"
                  disabled={
                    !settings.dataSources.hiroReferenceApiUrl || sourceTest?.state === "testing"
                  }
                  onClick={() =>
                    void testHealthSource(
                      "hiro-reference",
                      settings.dataSources.hiroReferenceApiUrl,
                    )
                  }
                >
                  Test
                </button>
              </div>
              {sourceTest?.kind === "hiro-reference" ? (
                <span className={sourceTest.state === "failed" ? "field-error" : "muted"}>
                  {sourceTest.detail}
                </span>
              ) : null}
            </Field>
            <Field label="Stacks API URL" help="Stacks API used for chain data.">
              <input
                className="input mono"
                type="url"
                value={settings.dataSources.apiUrl}
                onChange={(event) =>
                  update("dataSources", { ...settings.dataSources, apiUrl: event.target.value })
                }
              />
            </Field>
            <Field label="API key header">
              <input
                className="input mono"
                value={settings.dataSources.apiKeyHeader}
                onChange={(event) =>
                  update("dataSources", {
                    ...settings.dataSources,
                    apiKeyHeader: event.target.value,
                  })
                }
              />
            </Field>
            <Field
              label="API key"
              help={`Status: ${settings.dataSources.apiKeyConfigured ? `configured from ${settings.dataSources.apiKeySource}` : "not configured"}.`}
            >
              <select
                className="input"
                value={apiKeyAction}
                onChange={(event) => {
                  setSaved(false);
                  setSourceTest(null);
                  setApiKeyAction(event.target.value as typeof apiKeyAction);
                }}
              >
                <option value="keep">Keep current</option>
                <option value="replace">Replace</option>
                <option value="clear">Clear</option>
              </select>
            </Field>
            {apiKeyAction === "replace" ? (
              <Field label="New API key">
                <input
                  className="input mono"
                  type="password"
                  autoComplete="new-password"
                  value={apiKey}
                  onChange={(event) => {
                    setSaved(false);
                    setSourceTest(null);
                    setApiKey(event.target.value);
                  }}
                />
              </Field>
            ) : null}
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

          <section className="card set-section" id="security">
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
                    </strong>
                    {!data.manager.automationEligible ? (
                      <> {data.manager.automationEligibilityReason}</>
                    ) : null}
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

          <section className="card set-section" id="maintenance">
            <div className="card-head">
              <h2>About &amp; maintenance</h2>
            </div>
            <div className="statline">
              <span className="k">Backup</span>
              <span className="v">Online SQLite backup with integrity verification</span>
            </div>
            <pre className="code command-code">
              sidekick database backup /backups/sidekick.sqlite
            </pre>
            <div className="statline">
              <span className="k">Restore</span>
              <span className="v">
                Stop Sidekick, preserve the current database, replace it with the verified backup,
                then restart
              </span>
            </div>
            <div className="statline">
              <span className="k">Existing deployment</span>
              <span className="v">
                Keep the same manager principal and database path; re-run Attach Existing after
                changing providers or restoring
              </span>
            </div>
          </section>
        </fieldset>
      </div>
    </div>
  );
}
