import { ArrowClockwise, GearSix, Pulse, WarningCircle } from "@phosphor-icons/react";
import { type HealthSnapshot, healthSnapshotSchema } from "@stx-labs/signer-sidekick-api-contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiJson } from "./api-client.js";
import { CopyableIdentifier } from "./copyable-identifier.js";
import { operatorErrorDetail, operatorErrorSentence } from "./shared/operator-error.js";

export type { HealthSnapshot } from "@stx-labs/signer-sidekick-api-contracts";

type SourceStatus = "healthy" | "unavailable" | "not-configured";

interface Eligibility {
  cycleId: number;
  meetsThreshold: boolean;
  inSignerSet: boolean;
}

export interface SignerHealthContext {
  network: string;
  currentCycle: number;
  registration: null | { registered: boolean; signerKeyGrantValid: boolean | null };
  eligibility: null | { current: Eligibility | null; next: Eligibility | null };
}

export async function fetchHealthSnapshot(
  token: string,
  path = "/api/v1/health",
  init: RequestInit = {},
): Promise<HealthSnapshot> {
  return apiJson(token, path, healthSnapshotSchema, init);
}

function displayNumber(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

function displayDifference(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "Even";
  return `${value > 0 ? "+" : ""}${value.toLocaleString("en-US")}`;
}

function displayTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

function displayStx(ustx: number | null): string {
  if (ustx === null) return "—";
  return `${(ustx / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 })} STX`;
}

function abbreviated(value: string, left = 10, right = 8): string {
  return value.length > left + right + 1 ? `${value.slice(0, left)}…${value.slice(-right)}` : value;
}

function StateBadge({ state }: { state: SourceStatus | HealthSnapshot["overallStatus"] }) {
  const kind =
    state === "healthy"
      ? "success"
      : state === "needs-attention" || state === "unavailable"
        ? "error"
        : "caution";
  return <span className={`badge b-${kind}`}>{state.replaceAll("-", " ")}</span>;
}

function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="statline">
      <span className="k">{label}</span>
      <span className="v">{children}</span>
    </div>
  );
}

function EligibilityState({ value }: { value: Eligibility | null }) {
  if (!value) return <span className="muted">Unavailable</span>;
  if (!value.meetsThreshold) return <span className="badge b-caution">Below threshold</span>;
  return (
    <span className={`badge b-${value.inSignerSet ? "success" : "caution"}`}>
      {value.inSignerSet ? "In signer set" : "Threshold met"}
    </span>
  );
}

export function SignerHealthPage({
  token,
  context,
}: {
  token: string;
  context: SignerHealthContext | null;
}) {
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);

  const load = useCallback(
    async (force = false) => {
      if (!force && activeRequest.current) return;
      activeRequest.current?.abort();
      const controller = new AbortController();
      activeRequest.current = controller;
      setRefreshing(force);
      try {
        setSnapshot(
          await fetchHealthSnapshot(token, force ? "/api/v1/health/refresh" : "/api/v1/health", {
            method: force ? "POST" : "GET",
            signal: controller.signal,
          }),
        );
        setError(null);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(operatorErrorDetail(cause, "Sidekick returned no error detail"));
      } finally {
        if (activeRequest.current === controller) {
          activeRequest.current = null;
          setRefreshing(false);
        }
      }
    },
    [token],
  );

  useEffect(() => {
    void load();
    const interval = setInterval(() => void load(), 30_000);
    return () => {
      clearInterval(interval);
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, [load]);

  if (!snapshot) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1>Signer Health</h1>
            <p className="lede">Live operational state from the configured node and signer.</p>
          </div>
        </div>
        <div className={`callout ${error ? "callout-critical" : "callout-neutral"}`}>
          <div className="body">
            {error
              ? `Could not load signer health: ${operatorErrorSentence(error)}`
              : "Collecting the first health sample…"}
            {error ? (
              <div className="actions">
                <button type="button" className="btn btn-secondary sm" onClick={() => void load()}>
                  Retry health
                </button>
                <button
                  type="button"
                  className="btn btn-tertiary sm"
                  onClick={() => {
                    location.hash = "settings";
                  }}
                >
                  Open settings
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </>
    );
  }

  const signerConfigured = snapshot.signer.infoSource.configured;
  const nodeMetricsConfigured = snapshot.node.metrics.configured;
  const baseline = snapshot.signer.lastHour.collectingBaseline;
  return (
    <>
      <div className="page-head health-head">
        <div>
          <h1>Signer Health</h1>
          <p className="lede">Node and signer state useful during day-to-day pool operation.</p>
        </div>
        <div className="actions health-actions">
          <StateBadge state={snapshot.overallStatus} />
          <span className="muted">
            {snapshot.coverage.available}/{snapshot.coverage.total} signals ·{" "}
            {displayTime(snapshot.generatedAt)}
          </span>
          <button
            type="button"
            className="btn btn-tertiary"
            onClick={() => void load(true)}
            disabled={refreshing}
          >
            <ArrowClockwise className={refreshing ? "spin" : ""} />
            {refreshing ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </div>

      {error ? (
        <div className="callout callout-info">
          Could not refresh signer health: {operatorErrorSentence(error)} Showing the last sample.
        </div>
      ) : null}
      {!signerConfigured || !nodeMetricsConfigured ? (
        <div className="callout callout-neutral health-setup-note">
          <GearSix className="ic" />
          <div className="body">
            <strong>More health signals are available.</strong>
            <span>
              Configure {!nodeMetricsConfigured ? "node metrics" : ""}
              {!nodeMetricsConfigured && !signerConfigured ? " and " : ""}
              {!signerConfigured ? "signer monitoring" : ""} in Settings. Core node RPC health works
              without them.
            </span>
          </div>
          <button
            type="button"
            className="btn btn-tertiary sm"
            onClick={() => (location.hash = "settings")}
          >
            Open settings
          </button>
        </div>
      ) : null}

      {snapshot.findings.length > 0 ? (
        <section className="health-findings" aria-label="Health findings">
          {snapshot.findings.map((finding) => (
            <div className="callout callout-info" key={finding.id}>
              <WarningCircle className="ic" />
              <div className="body">
                <strong>{finding.title}</strong>
                <span>{finding.detail}</span>
              </div>
            </div>
          ))}
        </section>
      ) : null}

      <div className="grid cols-2 health-primary-grid">
        <section className="card">
          <div className="card-head">
            <h2>Stacks node</h2>
            <StateBadge state={snapshot.node.rpc.status} />
          </div>
          <Metric label="RPC response">
            {snapshot.node.rpc.latencyMs === null ? "—" : `${snapshot.node.rpc.latencyMs} ms`}
          </Metric>
          <Metric label="Version">
            <span className="mono">{snapshot.node.version ?? "—"}</span>
          </Metric>
          <Metric label="Network">
            <span className="mono">
              {snapshot.node.networkId === null
                ? (context?.network ?? snapshot.signer.network ?? "unknown")
                : `${context?.network ?? snapshot.signer.network ?? "network"} · 0x${snapshot.node.networkId.toString(16).padStart(8, "0")}`}
            </span>
          </Metric>
          <Metric label="Stacks tip">
            <span className="mono">{displayNumber(snapshot.node.stacksTipHeight)}</span>
          </Metric>
          <Metric label="Bitcoin tip">
            <span className="mono">{displayNumber(snapshot.node.burnBlockHeight)}</span>
          </Metric>
          <Metric label="Last Stacks tip advance">
            <span className="mono">{displayTime(snapshot.node.lastTipAdvanceAt)}</span>
          </Metric>
          <Metric label="Peers">
            {snapshot.node.inboundPeers === null && snapshot.node.outboundPeers === null
              ? "—"
              : `${displayNumber(snapshot.node.inboundPeers)} inbound · ${displayNumber(snapshot.node.outboundPeers)} outbound`}
          </Metric>
          <Metric label="Node log counters · 1h">
            {snapshot.node.lastHour.warnings === null && snapshot.node.lastHour.errors === null
              ? "Collecting baseline"
              : `${displayNumber(snapshot.node.lastHour.warnings)} warnings · ${displayNumber(snapshot.node.lastHour.errors)} errors`}
          </Metric>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Reference API</h2>
            <StateBadge state={snapshot.hiro.source.status} />
          </div>
          <Metric label="Reference Stacks tip">
            <span className="mono">{displayNumber(snapshot.hiro.stacksTipHeight)}</span>
          </Metric>
          <Metric label="Local difference">
            <span className="mono">{displayDifference(snapshot.hiro.localStacksDifference)}</span>
          </Metric>
          <Metric label="Reference Bitcoin tip">
            <span className="mono">{displayNumber(snapshot.hiro.burnBlockHeight)}</span>
          </Metric>
          <Metric label="Local difference">
            <span className="mono">{displayDifference(snapshot.hiro.localBurnDifference)}</span>
          </Metric>
          <p className="tertiary health-card-note">
            Brief differences are normal while sources update.
          </p>
        </section>
      </div>

      <section className="card health-signer-card">
        <div className="card-head">
          <h2>
            <Pulse /> Signer
          </h2>
          <StateBadge state={snapshot.signer.heartbeat.status} />
        </div>
        <div className="grid cols-2 health-detail-grid">
          <div>
            <Metric label="Version">
              <span className="mono">{snapshot.signer.version ?? "—"}</span>
            </Metric>
            <Metric label="Network">
              <span className="mono">{snapshot.signer.network ?? "—"}</span>
            </Metric>
            <Metric label="Public key">
              {snapshot.signer.publicKey ? (
                <CopyableIdentifier
                  value={snapshot.signer.publicKey}
                  display={abbreviated(snapshot.signer.publicKey, 12, 8)}
                  label="signer public key"
                  className="mono"
                />
              ) : (
                "—"
              )}
            </Metric>
            <Metric label="STX address">
              {snapshot.signer.stxAddress ? (
                <CopyableIdentifier
                  value={snapshot.signer.stxAddress}
                  display={abbreviated(snapshot.signer.stxAddress, 10, 6)}
                  label="signer STX address"
                  className="mono"
                />
              ) : (
                "—"
              )}
            </Metric>
            <Metric label="Observed Stacks node height">
              <span className="mono">{displayNumber(snapshot.signer.observedNodeHeight)}</span>
            </Metric>
            <Metric label="Stacks node difference">
              <span className="mono">
                {displayDifference(snapshot.signer.nodeHeightDifference)}
              </span>
            </Metric>
            <Metric label="Reward cycle">
              <span className="mono">
                {displayNumber(snapshot.signer.rewardCycle)} observed ·{" "}
                {context?.currentCycle ?? "—"} current
              </span>
            </Metric>
            <Metric label="Signer STX balance">{displayStx(snapshot.signer.stxBalanceUstx)}</Metric>
          </div>
          <div>
            <Metric label="Manager registration">
              <span
                className={`badge b-${context?.registration?.registered ? "success" : "caution"}`}
              >
                {context
                  ? context.registration?.registered
                    ? "Confirmed"
                    : "Missing"
                  : "Unavailable"}
              </span>
            </Metric>
            <Metric label="Signer-key grant">
              <span
                className={`badge b-${context?.registration?.signerKeyGrantValid ? "success" : "caution"}`}
              >
                {context
                  ? context.registration?.signerKeyGrantValid
                    ? "Valid"
                    : "Needs attention"
                  : "Unavailable"}
              </span>
            </Metric>
            <Metric label="Current cycle">
              <EligibilityState value={context?.eligibility?.current ?? null} />
            </Metric>
            <Metric label="Next cycle">
              <EligibilityState value={context?.eligibility?.next ?? null} />
            </Metric>
            <div className="section-title health-window-title">Last hour</div>
            <Metric label="Stacks block proposals">
              {baseline ? "Collecting baseline" : displayNumber(snapshot.signer.lastHour.proposals)}
            </Metric>
            <Metric label="Responses">
              {baseline
                ? "Collecting baseline"
                : `${displayNumber(snapshot.signer.lastHour.accepted)} accepted · ${displayNumber(snapshot.signer.lastHour.rejected)} rejected`}
            </Metric>
            <Metric label="Rejection rate">
              {snapshot.signer.lastHour.rejectionPercent === null
                ? "—"
                : `${snapshot.signer.lastHour.rejectionPercent.toFixed(1)}%`}
            </Metric>
            <Metric label="Response p95">
              {snapshot.signer.lastHour.responseP95Seconds === null
                ? "—"
                : `${snapshot.signer.lastHour.responseP95Seconds}s`}
            </Metric>
            <Metric label="Agreement conflicts">
              {displayNumber(snapshot.signer.lastHour.disagreements)}
            </Metric>
          </div>
        </div>
      </section>

      <details className="card health-advanced">
        <summary>Advanced source details</summary>
        <div className="grid cols-2 health-source-grid">
          {(
            [
              ["Node RPC", snapshot.node.rpc],
              ["Node metrics", snapshot.node.metrics],
              ["Reference API", snapshot.hiro.source],
              ["Signer info", snapshot.signer.infoSource],
              ["Signer heartbeat", snapshot.signer.heartbeat],
              ["Signer metrics", snapshot.signer.metrics],
            ] as const
          ).map(([label, source]) => (
            <div className="health-source" key={label}>
              <strong>{label}</strong>
              <StateBadge state={source.status} />
              <span className="mono muted">last success {displayTime(source.lastSuccessAt)}</span>
              {source.errorCode ? <span className="mono">{source.errorCode}</span> : null}
            </div>
          ))}
        </div>
      </details>
    </>
  );
}
