import {
  ArrowClockwise,
  Coins,
  Gauge,
  GearSix,
  Heartbeat,
  ListChecks,
  Moon,
  SealCheck,
  ShareNetwork,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  UsersThree,
  WarningCircle,
} from "@phosphor-icons/react";
import {
  type DashboardSnapshot,
  onboardingEnvelopeSchema,
  type ReconciliationOperation,
  statusResponseSchema,
  syncResponseSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../../design/tokens/tokens.css";
import "./base.css";
import "./styles.css";
import { AUTH_REJECTED_EVENT, apiJson } from "./api-client.js";
import { type DashboardPage, dashboardHash, parseDashboardHash } from "./dashboard-route.js";
import { EnrollmentPage } from "./features/enrollment/enrollment-page.js";
import { Manager } from "./features/manager/manager-page.js";
import { Operations } from "./features/operations/operations-page.js";
import { Overview } from "./features/overview/overview-page.js";
import { Pool } from "./features/pool/pool-page.js";
import { Rewards } from "./features/rewards/rewards-page.js";
import { SettingsPage } from "./features/settings/settings-page.js";
import { SetupPage } from "./features/setup/setup-page.js";
import { number } from "./shared/format.js";
import { SignerHealthPage } from "./signer-health.js";

type Snapshot = DashboardSnapshot;
const nav: Array<{ group?: string; id?: DashboardPage; label?: string; icon?: typeof Gauge }> = [
  { group: "Operate" },
  { id: "overview", label: "Overview", icon: Gauge },
  { id: "manager", label: "Manager", icon: SealCheck },
  { id: "pool", label: "Pool", icon: UsersThree },
  { id: "rewards", label: "Rewards", icon: Coins },
  { id: "operations", label: "Operations", icon: ListChecks },
  { id: "health", label: "Signer Health", icon: Heartbeat },
  { group: "Configure" },
  { id: "setup", label: "Initial Setup", icon: SlidersHorizontal },
  { id: "settings", label: "Settings", icon: GearSix },
  { id: "enrollment", label: "Public Pool Page", icon: ShareNetwork },
];

function StacksGlyph() {
  return (
    <svg viewBox="0 0 17 18" fill="currentColor" aria-hidden="true">
      <path d="M5.09 5.385c-.023.052-.069.082-.131.082H.496C.212 5.507 0 5.735 0 6.025v.948c0 .3.235.558.551.558h14.998c.302 0 .551-.244.551-.558v-.948c0-.3-.235-.558-.551-.558h-4.407c-.056 0-.102-.025-.133-.084-.029-.051-.026-.11.005-.154L13.902.865c.095-.157.123-.368.024-.559C13.834.111 13.633 0 13.436 0h-1.121c-.172 0-.36.086-.464.255L8.508 5.349a.293.293 0 0 1-.238.127h-.423a.282.282 0 0 1-.236-.124L4.247.261A.58.58 0 0 0 3.785.008H2.664a.554.554 0 0 0-.487.292.56.56 0 0 0 .023.568l2.882 4.347c.037.057.037.12.012.163Z" />
      <path d="m8.663 12.001 3.197 4.838c.104.169.292.255.464.255h1.121c.203 0 .388-.115.486-.289a.56.56 0 0 0-.024-.574l-2.87-4.343c-.035-.054-.039-.11-.01-.166.035-.06.086-.087.134-.087h4.39c.302 0 .551-.244.551-.558v-.948c0-.3-.235-.558-.551-.558h-15C.249 9.571 0 9.815 0 10.129v.948c0 .3.235.558.551.558h4.398c.069 0 .107.028.128.075.035.068.029.121-.001.163l-2.888 4.364a.57.57 0 0 0-.025.563c.097.185.283.302.488.302h1.121c.187 0 .353-.09.454-.244l3.363-5.09a.282.282 0 0 1 .236-.125h.423c.095 0 .182.048.239.129l.173.229Z" />
    </svg>
  );
}

const STATUS_POLL_MS = 30_000;
const STATUS_STALE_AFTER_MS = 60_000;
const SYNC_POLL_MS = 1_000;

function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = window.setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

function Login({ onLogin, error }: { onLogin: (token: string) => void; error: string | null }) {
  const [token, setToken] = useState("");
  return (
    <main className="login-shell">
      <div className="card-standout login-card">
        <div className="brand-mark">
          <ShieldCheck />
        </div>
        <p className="eyebrow">SIGNER SIDEKICK</p>
        <h1>Operator access</h1>
        <p>
          Enter the local bootstrap credential configured as{" "}
          <span className="mono">SIDEKICK_AUTH_TOKEN</span>.
        </p>
        {error ? (
          <div className="callout callout-critical" role="alert">
            {error}
          </div>
        ) : null}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (token.length >= 24) onLogin(token);
          }}
        >
          <label htmlFor="token">Operator credential</label>
          <input
            id="token"
            className="input mono"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <button className="btn btn-accent" type="submit" disabled={token.length < 24}>
            Open console
          </button>
        </form>
        <small>Stored in this browser tab only. Sidekick remains loopback-bound.</small>
      </div>
    </main>
  );
}

function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem("sidekick-token") ?? "");
  const [route, setRoute] = useState(() => parseDashboardHash(location.hash));
  const page = route.page;
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  const settingsThemeApplied = useRef(false);
  const activeStatusRequests = useRef(0);
  const statusRequestGeneration = useRef(0);
  const syncController = useRef<AbortController | null>(null);
  const [data, setData] = useState<Snapshot | null>(null);
  const [onboardingStarted, setOnboardingStarted] = useState<boolean | null>(null);
  const [dismissedSetupNoticeKey, setDismissedSetupNoticeKey] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncOperation, setSyncOperation] = useState<ReconciliationOperation | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const loadOnboardingState = useCallback(async () => {
    if (!token) return;
    try {
      const result = await apiJson(token, "/api/v1/onboarding", onboardingEnvelopeSchema);
      setOnboardingStarted(result.onboarding !== null);
    } catch {
      // Setup guidance is optional UI state; do not hide the operator dashboard if it is unavailable.
      setOnboardingStarted(null);
    }
  }, [token]);
  const load = useCallback(
    async (background = false, includeOnboarding = false) => {
      if (!token || (background && activeStatusRequests.current > 0)) return false;
      const requestGeneration = ++statusRequestGeneration.current;
      activeStatusRequests.current += 1;
      try {
        const snapshot = await apiJson(token, "/api/v1/status", statusResponseSchema);
        if (requestGeneration !== statusRequestGeneration.current) return false;
        setData(snapshot);
        if (includeOnboarding) await loadOnboardingState();
        setStatusError(null);
        return true;
      } catch (cause) {
        if (requestGeneration !== statusRequestGeneration.current) return false;
        setData((current) =>
          current
            ? {
                ...current,
                freshness: {
                  status: "stale",
                  snapshotGeneratedAt: current.generatedAt,
                  servedAt: current.freshness?.servedAt ?? current.generatedAt,
                  reason: "refresh-failed",
                },
              }
            : current,
        );
        setStatusError(cause instanceof Error ? cause.message : String(cause));
        return false;
      } finally {
        activeStatusRequests.current = Math.max(0, activeStatusRequests.current - 1);
      }
    },
    [loadOnboardingState, token],
  );
  useEffect(() => {
    void load(false, true);
  }, [load]);
  useEffect(() => {
    const rejectAuth = () => {
      statusRequestGeneration.current += 1;
      syncController.current?.abort();
      setLoginError("The operator credential was rejected. Check it and try again.");
      setData(null);
      setStatusError(null);
      setSyncError(null);
      setSyncOperation(null);
      setSyncing(false);
      setOnboardingStarted(null);
      settingsThemeApplied.current = false;
      setToken("");
    };
    window.addEventListener(AUTH_REJECTED_EVENT, rejectAuth);
    return () => window.removeEventListener(AUTH_REJECTED_EVENT, rejectAuth);
  }, []);
  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") void load(true);
    };
    const interval = window.setInterval(refreshIfVisible, STATUS_POLL_MS);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [load]);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(interval);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    if (settingsThemeApplied.current || !data?.runtimeSettings) return;
    settingsThemeApplied.current = true;
    const preference = data.runtimeSettings.display.defaultTheme;
    setTheme(
      preference === "system"
        ? matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : preference,
    );
  }, [data]);
  useEffect(() => {
    const handler = () => {
      const next = parseDashboardHash(location.hash);
      if (next.legacy) history.replaceState(null, "", dashboardHash("manager"));
      setRoute({ ...next, legacy: false });
    };
    handler();
    addEventListener("hashchange", handler);
    return () => removeEventListener("hashchange", handler);
  }, []);
  const login = (value: string) => {
    statusRequestGeneration.current += 1;
    syncController.current?.abort();
    sessionStorage.setItem("sidekick-token", value);
    setLoginError(null);
    setData(null);
    setStatusError(null);
    setSyncError(null);
    setSyncOperation(null);
    setSyncing(false);
    setOnboardingStarted(null);
    settingsThemeApplied.current = false;
    setToken(value);
  };
  const monitorSync = useCallback(
    async (initial: ReconciliationOperation, controller: AbortController) => {
      let operation = initial;
      setSyncOperation(operation);
      const operationId = operation.operationId;
      if (operation.status === "running" && !operationId) {
        setSyncError("Reconciliation tracking is missing an operation ID. Retry reconciliation.");
        return;
      }
      while (operation.status === "running" && !controller.signal.aborted) {
        await waitFor(SYNC_POLL_MS, controller.signal);
        if (controller.signal.aborted) return;
        const next = (
          await apiJson(token, "/api/v1/sync", syncResponseSchema, {
            signal: controller.signal,
          })
        ).operation;
        if (next.status === "idle" || (operationId !== null && next.operationId !== operationId)) {
          setSyncOperation(next);
          setSyncError(
            "Reconciliation tracking was reset, likely because Sidekick restarted. Start reconciliation again.",
          );
          return;
        }
        operation = next;
        setSyncOperation(operation);
      }
      if (controller.signal.aborted) return;
      if (operation.status === "succeeded") {
        setSyncError(null);
        await load();
        return;
      }
      if (operation.status === "failed") {
        const code = operation.error?.error.replaceAll("_", " ") ?? "unknown error";
        setSyncError(
          `Reconciliation failed: ${code}.${operation.error?.retryable ? " Retry when the chain sources are available." : " Review Settings and the operator logs before retrying."}`,
        );
      }
    },
    [load, token],
  );
  const sync = async () => {
    if (syncing) return;
    syncController.current?.abort();
    const controller = new AbortController();
    syncController.current = controller;
    setSyncing(true);
    setSyncError(null);
    try {
      const operation = (
        await apiJson(token, "/api/v1/sync", syncResponseSchema, {
          method: "POST",
          signal: controller.signal,
        })
      ).operation;
      if (operation.status === "idle") {
        setSyncOperation(operation);
        setSyncError("Reconciliation did not start. Retry the operation.");
        return;
      }
      await monitorSync(operation, controller);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setSyncError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (syncController.current === controller) setSyncing(false);
    }
  };
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    syncController.current?.abort();
    syncController.current = controller;
    void apiJson(token, "/api/v1/sync", syncResponseSchema, { signal: controller.signal })
      .then(async ({ operation }) => {
        setSyncOperation(operation);
        if (operation.status !== "running") return;
        setSyncing(true);
        try {
          await monitorSync(operation, controller);
        } catch (cause) {
          if (!controller.signal.aborted) {
            setSyncError(cause instanceof Error ? cause.message : String(cause));
          }
        } finally {
          if (syncController.current === controller) setSyncing(false);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setSyncError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => controller.abort();
  }, [monitorSync, token]);
  const refreshOperatorState = useCallback(async () => {
    const refreshed = await load();
    if (!refreshed) throw new Error("The latest operator state is not available yet.");
  }, [load]);
  const markOnboardingStarted = useCallback(() => setOnboardingStarted(true), []);
  const setupNoticeKey = data
    ? `sidekick-setup-notice:${data.network}:${data.managerPrincipal}`
    : null;
  const setupNoticeDismissed = setupNoticeKey
    ? dismissedSetupNoticeKey === setupNoticeKey ||
      localStorage.getItem(setupNoticeKey) === "dismissed"
    : false;
  const dismissSetupNotice = () => {
    if (!setupNoticeKey) return;
    localStorage.setItem(setupNoticeKey, "dismissed");
    setDismissedSetupNoticeKey(setupNoticeKey);
  };
  const lastStatusAt = data
    ? Date.parse(data.freshness?.snapshotGeneratedAt ?? data.generatedAt)
    : Number.NaN;
  const ageMs = Number.isFinite(lastStatusAt) ? Math.max(0, now - lastStatusAt) : null;
  const stale = Boolean(
    data &&
      (data.freshness?.status === "stale" ||
        statusError ||
        ageMs === null ||
        ageMs > STATUS_STALE_AFTER_MS),
  );
  const ageLabel =
    ageMs === null
      ? "age unavailable"
      : ageMs < 60_000
        ? `${Math.floor(ageMs / 1_000)}s old`
        : `${Math.floor(ageMs / 60_000)}m old`;
  const content = (() => {
    if (page === "health") {
      return (
        <SignerHealthPage
          token={token}
          context={
            data
              ? {
                  network: data.preflight.compatibility.profileLabel ?? data.network,
                  currentCycle: data.preflight.cycle.currentId,
                  registration: data.registration,
                  eligibility: data.setup?.eligibility ?? null,
                }
              : null
          }
        />
      );
    }
    if (page === "settings") {
      return (
        <SettingsPage
          data={data}
          token={token}
          setTheme={setTheme}
          onSaved={refreshOperatorState}
        />
      );
    }
    if (!data) return null;
    switch (page) {
      case "overview":
        return (
          <Overview
            data={data}
            token={token}
            sync={sync}
            syncing={syncing}
            showSetupNotice={onboardingStarted === false && !setupNoticeDismissed}
            dismissSetupNotice={dismissSetupNotice}
          />
        );
      case "manager":
        return (
          <Manager
            action={route.action}
            data={data}
            operatorStateStale={stale}
            token={token}
            onOperatorStateChanged={refreshOperatorState}
          />
        );
      case "pool":
        return <Pool data={data} token={token} />;
      case "rewards":
        return <Rewards data={data} operatorStateStale={stale} token={token} />;
      case "operations":
        return <Operations data={data} token={token} sync={sync} syncing={syncing} />;
      case "setup":
        return (
          <SetupPage
            data={data}
            token={token}
            onOnboardingStarted={markOnboardingStarted}
            onOperatorStateChanged={refreshOperatorState}
          />
        );
      case "enrollment":
        return <EnrollmentPage token={token} />;
      default:
        return null;
    }
  })();
  if (!token) return <Login onLogin={login} error={loginError} />;
  return (
    <div className="app" data-network={data?.network ?? "mainnet"}>
      <aside className="sidebar">
        <div className="brand">
          <div className="glyph">
            <StacksGlyph />
          </div>
          <div className="name">
            Signer Sidekick<small>PoX-5 · v1</small>
          </div>
        </div>
        <nav>
          {nav.map((item) =>
            item.group ? (
              <div className="nav-label" key={item.group}>
                {item.group}
              </div>
            ) : (
              <a
                className={`item ${page === item.id ? "active" : ""}`}
                href={`#${item.id}`}
                key={item.id}
              >
                {item.icon ? <item.icon /> : null}
                {item.label}
                {item.id === "operations" && data?.alerts.length ? (
                  <span className="count alert">{data.alerts.length}</span>
                ) : null}
              </a>
            ),
          )}
        </nav>
        <div className="spacer" />
      </aside>
      <div className={`content ${page === "settings" ? "content-settings" : ""}`}>
        <div className="topbar">
          <select
            aria-label="Dashboard page"
            className="mobile-page-picker"
            value={page}
            onChange={(event) => {
              location.hash = event.target.value;
            }}
          >
            {nav
              .filter((item): item is (typeof nav)[number] & { id: DashboardPage; label: string } =>
                Boolean(item.id && item.label),
              )
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
          </select>
          <div className="crumbs">
            Signer Sidekick / <strong>{nav.find((item) => item.id === page)?.label}</strong>
          </div>
          <div className="right">
            <span className={`net ${data?.network === "mainnet" ? "net-mainnet" : "net-testnet"}`}>
              <span className="dot" />
              {data?.network ?? "Connecting"}
            </span>
            <button
              type="button"
              className="chip-btn"
              aria-label="Toggle theme"
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            >
              {theme === "light" ? <Moon /> : <Sun />}
            </button>
          </div>
        </div>
        <div className={`freshness ${stale || data?.preflight.status === "fail" ? "stale" : ""}`}>
          <span className="dot" />
          <span>
            {!data
              ? "Connecting"
              : stale
                ? "Last successful state"
                : data.preflight.status === "fail"
                  ? "Chain sources need attention"
                  : "Live"}
          </span>
          <span className="sep">·</span>
          <span className="mono">
            {data
              ? `Bitcoin tip ${number(data.preflight.node.burnBlockHeight)} · API difference ${data.preflight.api.burnBlockLag} Bitcoin blocks · ${ageLabel}`
              : "loading operator state"}
          </span>
          {stale ? (
            <button type="button" className="btn btn-tertiary sm" onClick={() => void load()}>
              Refresh state
            </button>
          ) : null}
          <span className="right">
            <span className="hint-dot-legend">
              <span className="src src-chain">contract read-only</span>
              <span className="src src-api">indexed / estimated</span>
              <span className="src src-local">locally derived</span>
            </span>
          </span>
        </div>
        <main className={`main ${page === "settings" ? "main-settings" : ""}`}>
          {syncOperation?.status === "running" ? (
            <div className="callout callout-info" role="status" aria-live="polite">
              <ArrowClockwise className="ic spin" />
              <div className="body">
                <strong>Reconciliation in progress</strong>
                <br />
                {syncOperation.progress.message} · step {syncOperation.progress.completedSteps + 1}
                of {syncOperation.progress.totalSteps}
                {syncOperation.progress.itemsCompleted !== null ? (
                  <>
                    {" "}
                    · {number(syncOperation.progress.itemsCompleted)}
                    {syncOperation.progress.itemsTotal !== null
                      ? ` of ${number(syncOperation.progress.itemsTotal)}`
                      : ""}{" "}
                    items
                  </>
                ) : null}
              </div>
            </div>
          ) : null}
          {syncOperation?.status === "failed" && !syncError ? (
            <div className="callout callout-critical" role="alert">
              <WarningCircle className="ic" />
              <div className="body">
                <strong>Reconciliation failed</strong>
                <br />
                {(syncOperation.error?.error ?? "unknown error").replaceAll("_", " ")}.{" "}
                {syncOperation.error?.retryable
                  ? "Retry when the chain sources are available."
                  : "Review Settings and the operator logs before retrying."}
              </div>
            </div>
          ) : null}
          {syncError ? (
            <div className="callout callout-critical" role="alert">
              <WarningCircle className="ic" />
              <div className="body">
                <strong>Reconciliation needs attention</strong>
                <br />
                {syncError}
              </div>
            </div>
          ) : null}
          {statusError ? (
            <div className="callout callout-critical error-banner">
              <WarningCircle className="ic" />
              <div className="body">
                <strong>
                  {data ? "Latest operator-state refresh failed" : "Unable to load operator state"}
                </strong>
                <br />
                {statusError}
                {data ? (
                  <>
                    <br />
                    Showing the last successful snapshot from{" "}
                    {new Date(data.generatedAt).toLocaleString()}.
                  </>
                ) : null}
                <div className="actions">
                  <button
                    type="button"
                    className="btn btn-secondary sm"
                    onClick={() => void load()}
                  >
                    Retry
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          {content ??
            (!statusError ? (
              <div className="loading-state">
                <ArrowClockwise />
                <p>Loading operator state</p>
              </div>
            ) : (
              <div className="callout callout-neutral">
                <div className="body">
                  Settings and Signer Health remain available while operator state recovers.
                  <div className="actions">
                    <button
                      type="button"
                      className="btn btn-secondary sm"
                      onClick={() => {
                        location.hash = dashboardHash("settings");
                      }}
                    >
                      Open settings
                    </button>
                    <button
                      type="button"
                      className="btn btn-tertiary sm"
                      onClick={() => {
                        location.hash = dashboardHash("health");
                      }}
                    >
                      Open Signer Health
                    </button>
                  </div>
                </div>
              </div>
            ))}
        </main>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
