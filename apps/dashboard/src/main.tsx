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
  statusResponseSchema,
  syncResponseSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../../design/tokens/tokens.css";
import "./base.css";
import "./styles.css";
import { AUTH_REJECTED_EVENT, apiJson } from "./api-client.js";
import { EnrollmentPage } from "./features/enrollment/enrollment-page.js";
import { Operations } from "./features/operations/operations-page.js";
import { Overview } from "./features/overview/overview-page.js";
import { Pool } from "./features/pool/pool-page.js";
import { Registration } from "./features/registration/registration-page.js";
import { Rewards } from "./features/rewards/rewards-page.js";
import { SettingsPage } from "./features/settings/settings-page.js";
import { SetupPage } from "./features/setup/setup-page.js";
import { number } from "./shared/format.js";
import { SignerHealthPage } from "./signer-health.js";

type Page =
  | "overview"
  | "health"
  | "registration"
  | "pool"
  | "rewards"
  | "operations"
  | "setup"
  | "enrollment"
  | "settings";

type Snapshot = DashboardSnapshot;
const nav: Array<{ group?: string; id?: Page; label?: string; icon?: typeof Gauge }> = [
  { group: "Operate" },
  { id: "overview", label: "Overview", icon: Gauge },
  { id: "registration", label: "Registration", icon: SealCheck },
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

function Login({ onLogin }: { onLogin: (token: string) => void }) {
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
  const [page, setPage] = useState<Page>(() => {
    const hash = location.hash.slice(1) as Page;
    return nav.some((item) => item.id === hash) ? hash : "overview";
  });
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  const settingsThemeApplied = useRef(false);
  const [data, setData] = useState<Snapshot | null>(null);
  const [onboardingStarted, setOnboardingStarted] = useState<boolean | null>(null);
  const [dismissedSetupNoticeKey, setDismissedSetupNoticeKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
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
    async (force = false) => {
      if (!token) return;
      try {
        const snapshot = force
          ? (
              await apiJson(token, "/api/v1/sync", syncResponseSchema, {
                method: "POST",
              })
            ).snapshot
          : await apiJson(token, "/api/v1/status", statusResponseSchema);
        setData(snapshot);
        await loadOnboardingState();
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [loadOnboardingState, token],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const rejectAuth = () => setToken("");
    window.addEventListener(AUTH_REJECTED_EVENT, rejectAuth);
    return () => window.removeEventListener(AUTH_REJECTED_EVENT, rejectAuth);
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
      const hash = location.hash.slice(1) as Page;
      if (nav.some((item) => item.id === hash)) setPage(hash);
    };
    addEventListener("hashchange", handler);
    return () => removeEventListener("hashchange", handler);
  }, []);
  const login = (value: string) => {
    sessionStorage.setItem("sidekick-token", value);
    setToken(value);
  };
  const sync = async () => {
    setSyncing(true);
    await load(true);
    setSyncing(false);
  };
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
  const content = data
    ? {
        overview: (
          <Overview
            data={data}
            token={token}
            sync={sync}
            syncing={syncing}
            showSetupNotice={onboardingStarted === false && !setupNoticeDismissed}
            dismissSetupNotice={dismissSetupNotice}
          />
        ),
        registration: <Registration data={data} />,
        pool: <Pool data={data} token={token} />,
        rewards: <Rewards data={data} token={token} />,
        health: (
          <SignerHealthPage
            token={token}
            context={{
              network: data.preflight.compatibility.profileLabel ?? data.network,
              currentCycle: data.preflight.cycle.currentId,
              registration: data.registration,
              eligibility: data.setup?.eligibility ?? null,
            }}
          />
        ),
        operations: <Operations data={data} token={token} sync={sync} syncing={syncing} />,
        setup: <SetupPage data={data} token={token} onOnboardingStarted={markOnboardingStarted} />,
        enrollment: <EnrollmentPage token={token} />,
        settings: <SettingsPage data={data} token={token} setTheme={setTheme} />,
      }[page]
    : null;
  if (!token) return <Login onLogin={login} />;
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
              .filter((item): item is (typeof nav)[number] & { id: Page; label: string } =>
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
        <div className={`freshness ${data?.preflight.status === "fail" ? "stale" : ""}`}>
          <span className="dot" />
          <span>{data?.preflight.status === "fail" ? "Chain sources need attention" : "Live"}</span>
          <span className="sep">·</span>
          <span className="mono">
            {data
              ? `Bitcoin tip ${number(data.preflight.node.burnBlockHeight)} · API difference ${data.preflight.api.burnBlockLag} Bitcoin blocks · ${new Date(data.generatedAt).toLocaleTimeString()}`
              : "loading operator state"}
          </span>
          <span className="right">
            <span className="hint-dot-legend">
              <span className="src src-chain">contract read-only</span>
              <span className="src src-api">indexed / estimated</span>
              <span className="src src-local">locally derived</span>
            </span>
          </span>
        </div>
        <main className={`main ${page === "settings" ? "main-settings" : ""}`}>
          {error ? (
            <div className="callout callout-critical error-banner">
              <WarningCircle className="ic" />
              <div className="body">
                <strong>Unable to load operator state</strong>
                <br />
                {error}
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
            (!error ? (
              <div className="loading-state">
                <ArrowClockwise />
                <p>Loading operator state</p>
              </div>
            ) : null)}
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
