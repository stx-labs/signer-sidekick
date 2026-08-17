import { ArrowClockwise, GearSix, Pulse, WarningCircle } from "@phosphor-icons/react";
import { type HealthSnapshot, healthSnapshotSchema } from "@stx-labs/signer-sidekick-api-contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiJson } from "./api-client.js";
import { CopyableIdentifier } from "./copyable-identifier.js";
import type { DomainSection } from "./dashboard-route.js";
import { useDomainSection } from "./shared/domain-section.js";
import { stx } from "./shared/format.js";
import { operatorErrorDetail, operatorErrorSentence } from "./shared/operator-error.js";

export type { HealthSnapshot } from "@stx-labs/signer-sidekick-api-contracts";

type SourceStatus =
  | "healthy"
  | "monitoring"
  | "needs-attention"
  | "partial"
  | "collecting"
  | "unavailable"
  | "unsupported"
  | "not-configured";

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
  return `${stx(String(ustx))} STX`;
}

function abbreviated(value: string, left = 10, right = 8): string {
  return value.length > left + right + 1 ? `${value.slice(0, left)}…${value.slice(-right)}` : value;
}

function StateBadge({ state }: { state: SourceStatus }) {
  const kind =
    state === "healthy"
      ? "success"
      : state === "needs-attention" || state === "unavailable"
        ? "error"
        : "caution";
  const label = state === "partial" ? "monitoring" : state.replaceAll("-", " ");
  return <span className={`badge b-${kind}`}>{label}</span>;
}

function classificationLabel(value: HealthSnapshot["diagnosis"]["classification"]): string {
  const labels: Record<HealthSnapshot["diagnosis"]["classification"], string> = {
    healthy: "No active issue",
    "likely-local-node": "This node",
    "likely-local-signer": "This signer",
    "source-disagreement": "Sources disagree",
    "suspected-network-wide": "Stacks network",
    "insufficient-evidence": "Undetermined",
  };
  return labels[value];
}

function displayDuration(startedAt: string, endedAt: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3_600).toFixed(1)}h`;
}

// Interpolated latency measurements read to a single decimal (e.g. "4.8s"); "—" for not-measured.
function displaySeconds(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}s`;
}

function pluralized(count: number, singular: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? singular : `${singular}s`}`;
}

function healthyChainView(snapshot: HealthSnapshot): string {
  const difference = snapshot.signer.nodeHeightDifference;
  if (difference === null) return "Not reported";
  if (difference === 0) return "Aligned";
  return `${pluralized(Math.abs(difference), "block")} ${difference > 0 ? "ahead" : "behind"}`;
}

function healthyParticipation(snapshot: HealthSnapshot): string {
  const recent = snapshot.signer.last15Minutes;
  if (recent.collectingBaseline) return "Collecting baseline";
  if (recent.proposals === null) return "Not reported";
  if (recent.proposals === 0) return "No opportunities observed";
  const proposals = pluralized(recent.proposals, "proposal");
  if (recent.responseGap === 0) return `${proposals} · no response gaps`;
  if (recent.responseGap === null) return `${proposals} observed`;
  return `${proposals} · ${pluralized(recent.responseGap, "response gap")}`;
}

function healthySummary(snapshot: HealthSnapshot): string {
  const recent = snapshot.signer.last15Minutes;
  if (recent.collectingBaseline) {
    return "The signer and local node are connected and aligned. Sidekick is collecting recent participation data.";
  }
  if (recent.proposals === 0) {
    return "The signer and local node are connected and aligned. No signing opportunities were observed in the last 15 minutes.";
  }
  if (recent.proposals !== null && recent.responseGap === 0) {
    return `The signer responded as expected to all ${pluralized(recent.proposals, "observed proposal")} in the last 15 minutes.`;
  }
  return "The signer and local node are connected and aligned. Recent signing activity remains within expected health bounds.";
}

function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="statline">
      <span className="k">{label}</span>
      <span className="v">{children}</span>
    </div>
  );
}

function ExpectedParticipation({ expected }: { expected: boolean | null }) {
  if (expected === null) return <span className="muted">Unavailable</span>;
  return (
    <span className={`badge b-${expected ? "success" : "neutral"}`}>
      {expected ? "Expected to sign" : "Not expected"}
    </span>
  );
}

export function SignerHealthPage({
  token,
  context,
  section,
  readOnly = false,
}: {
  token: string;
  context: SignerHealthContext | null;
  section: DomainSection | null;
  readOnly?: boolean;
}) {
  useDomainSection("health", section);
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
    const refreshVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    const interval = setInterval(refreshVisible, 15_000);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshVisible);
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
  const operator = snapshot.operator;
  const currentParticipation = operator
    ? operator.expectedCurrentParticipation
    : (context?.eligibility?.current?.inSignerSet ?? null);
  const nextParticipation = operator
    ? operator.expectedNextParticipation
    : (context?.eligibility?.next?.inSignerSet ?? null);
  const registered = operator?.registered ?? context?.registration?.registered ?? null;
  const signerKeyGrantValid =
    operator?.signerKeyGrantValid ?? context?.registration?.signerKeyGrantValid ?? null;
  const comparisonSources = [
    snapshot.hiro.source,
    ...(snapshot.configuredApi.distinctFromReference ? [snapshot.configuredApi.source] : []),
  ].filter(({ configured }) => configured);
  const networkComparisonStatus: SourceStatus =
    comparisonSources.length === 0
      ? "not-configured"
      : comparisonSources.every(({ status }) => status === "healthy")
        ? "healthy"
        : comparisonSources.some(({ status }) => status === "healthy")
          ? "partial"
          : "unavailable";
  const healthyDiagnosis = snapshot.diagnosis.status === "healthy";
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
            disabled={refreshing || readOnly}
          >
            <ArrowClockwise className={refreshing ? "spin" : ""} />
            {refreshing ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </div>

      {error ? (
        <div className="callout callout-info content-notice">
          Could not refresh signer health: {operatorErrorSentence(error)} Showing the last sample.
        </div>
      ) : null}
      {readOnly ? (
        <div className="callout callout-caution content-notice" role="status">
          Deployment identity does not match. Retained health evidence remains readable, but forced
          collection and operator actions are disabled until the configured and stored identities
          agree.
        </div>
      ) : null}
      <section
        className={`card health-diagnosis health-diagnosis-${snapshot.diagnosis.status}`}
        aria-label={healthyDiagnosis ? "Signer operating status" : "Current diagnosis"}
      >
        <div className="health-diagnosis-copy">
          <div className="card-head">
            <h2>{healthyDiagnosis ? "Signer is operating as expected" : "Current diagnosis"}</h2>
            <StateBadge state={snapshot.diagnosis.status} />
          </div>
          {healthyDiagnosis ? (
            <p>{healthySummary(snapshot)}</p>
          ) : (
            <>
              <strong>{snapshot.diagnosis.title}</strong>
              <p>{snapshot.diagnosis.summary}</p>
            </>
          )}
        </div>
        <dl className="health-diagnosis-evidence">
          {healthyDiagnosis ? (
            <>
              <div>
                <dt>Connection</dt>
                <dd>Node and signer connected</dd>
              </div>
              <div>
                <dt>Chain view</dt>
                <dd>{healthyChainView(snapshot)}</dd>
              </div>
              <div>
                <dt>Recent signing</dt>
                <dd>{healthyParticipation(snapshot)}</dd>
              </div>
              <div>
                <dt>Validation p95</dt>
                <dd>
                  {snapshot.signer.last15Minutes.validationP95Seconds === null
                    ? "Not enough samples"
                    : displaySeconds(snapshot.signer.last15Minutes.validationP95Seconds)}
                </dd>
              </div>
            </>
          ) : (
            <>
              <div>
                <dt>Likely source</dt>
                <dd>{classificationLabel(snapshot.diagnosis.classification)}</dd>
              </div>
              <div>
                <dt>Confidence</dt>
                <dd>{snapshot.diagnosis.confidence}</dd>
              </div>
            </>
          )}
          <div>
            <dt>Evidence window</dt>
            <dd>
              {snapshot.diagnosis.evidenceWindow.sampleCount} samples ·{" "}
              {displayDuration(
                snapshot.diagnosis.evidenceWindow.startedAt,
                snapshot.diagnosis.evidenceWindow.endedAt,
              )}
              {snapshot.diagnosis.evidenceWindow.distinctSources > 0
                ? ` · ${snapshot.diagnosis.evidenceWindow.distinctSources} sources`
                : ""}
            </dd>
          </div>
          {!healthyDiagnosis ? (
            <div>
              <dt>Durable evidence</dt>
              <dd>
                {snapshot.history.observationCount.toLocaleString("en-US")} samples since{" "}
                {displayTime(snapshot.history.observedSince)}
              </dd>
            </div>
          ) : null}
        </dl>
      </section>
      {!signerConfigured || !nodeMetricsConfigured ? (
        <div className="callout callout-neutral health-setup-note">
          <GearSix className="ic" />
          <div className="body">
            <strong>More health signals are available.</strong>{" "}
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

      <div className="domain-section-anchor" id="health-findings">
        {snapshot.findings.length > 0 ? (
          <section className="health-findings" aria-label="Health findings">
            {snapshot.findings.map((finding) => (
              <div
                className={`callout ${finding.severity === "critical" ? "callout-critical" : "callout-info"}`}
                key={finding.episodeId ?? finding.id}
              >
                <WarningCircle className="ic" />
                <div className="body">
                  <div className="health-finding-title">
                    <strong>{finding.title}</strong>{" "}
                    <span className="badge b-neutral">{finding.confidence} confidence</span>
                  </div>
                  <span>{finding.detail}</span>
                  <span className="mono muted">
                    Likely source: {classificationLabel(finding.classification)} ·{" "}
                    {finding.evidenceWindow.sampleCount} samples over{" "}
                    {displayDuration(
                      finding.evidenceWindow.startedAt,
                      finding.evidenceWindow.endedAt,
                    )}
                  </span>
                  <ul className="health-finding-evidence">
                    {finding.evidence.map((item) => (
                      <li key={`${item.code}:${item.source}`}>
                        <span className={`health-evidence-state health-evidence-${item.status}`} />
                        <span>{item.detail}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </section>
        ) : null}
      </div>

      <div className="grid cols-2 health-primary-grid">
        <section className="card domain-section-anchor" id="health-node">
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
                ? (context?.network ?? operator?.network ?? snapshot.signer.network ?? "unknown")
                : `${context?.network ?? operator?.network ?? snapshot.signer.network ?? "network"} · 0x${snapshot.node.networkId.toString(16).padStart(8, "0")}`}
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

        <section className="card domain-section-anchor" id="health-network">
          <div className="card-head">
            <h2>Network comparisons</h2>
            <StateBadge state={networkComparisonStatus} />
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
            The public reference is comparison evidence, never authority over a healthy local node.
          </p>
          {snapshot.configuredApi.distinctFromReference ? (
            <div className="health-comparison-source">
              <div className="card-head">
                <strong>Configured indexed API</strong>
                <StateBadge state={snapshot.configuredApi.source.status} />
              </div>
              <Metric label="Stacks tip">
                <span className="mono">
                  {displayNumber(snapshot.configuredApi.stacksTipHeight)} · local{" "}
                  {displayDifference(snapshot.configuredApi.localStacksDifference)}
                </span>
              </Metric>
              <Metric label="Bitcoin tip">
                <span className="mono">
                  {displayNumber(snapshot.configuredApi.burnBlockHeight)} · local{" "}
                  {displayDifference(snapshot.configuredApi.localBurnDifference)}
                </span>
              </Metric>
            </div>
          ) : null}
        </section>
      </div>

      <section className="card health-signer-card domain-section-anchor" id="health-signer">
        <div className="card-head">
          <h2>
            <Pulse /> Signer
          </h2>
          <StateBadge state={snapshot.signer.heartbeat.status} />
        </div>
        <div className="grid cols-2 health-detail-grid">
          <div className="health-signer-details">
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
                {operator?.currentRewardCycle ?? context?.currentCycle ?? "—"} current
              </span>
            </Metric>
            <Metric label="Signer STX balance">{displayStx(snapshot.signer.stxBalanceUstx)}</Metric>
            <Metric label="Manager registration">
              <span className={`badge b-${registered ? "success" : "caution"}`}>
                {registered === null ? "Unavailable" : registered ? "Confirmed" : "Missing"}
              </span>
            </Metric>
            <Metric label="Signer-key grant">
              <span className={`badge b-${signerKeyGrantValid ? "success" : "caution"}`}>
                {signerKeyGrantValid === null
                  ? "Unavailable"
                  : signerKeyGrantValid
                    ? "Valid"
                    : "Needs attention"}
              </span>
            </Metric>
            <Metric label="Current cycle">
              <ExpectedParticipation expected={currentParticipation} />
            </Metric>
            <Metric label="Next cycle">
              <ExpectedParticipation expected={nextParticipation} />
            </Metric>
          </div>
          <div className="health-signer-window">
            <div className="section-title health-window-title">Last 15 minutes</div>
            <Metric label="Stacks block proposals">
              {snapshot.signer.last15Minutes.collectingBaseline
                ? "Collecting baseline"
                : displayNumber(snapshot.signer.last15Minutes.proposals)}
            </Metric>
            <Metric label="Proposal response gap">
              {snapshot.signer.last15Minutes.collectingBaseline
                ? "Collecting baseline"
                : displayNumber(snapshot.signer.last15Minutes.responseGap)}
            </Metric>
            <Metric label="Signer responses">
              {snapshot.signer.last15Minutes.collectingBaseline
                ? "Collecting baseline"
                : `${displayNumber(snapshot.signer.last15Minutes.accepted)} accepted · ${displayNumber(snapshot.signer.last15Minutes.rejected)} rejected`}
            </Metric>
            <Metric label="Node validation">
              {snapshot.signer.last15Minutes.collectingBaseline
                ? "Collecting baseline"
                : `${displayNumber(snapshot.signer.last15Minutes.validationAccepted)} accepted · ${displayNumber(snapshot.signer.last15Minutes.validationRejected)} rejected`}
            </Metric>
            <Metric label="Pre-commits">
              {snapshot.signer.last15Minutes.collectingBaseline
                ? "Collecting baseline"
                : displayNumber(snapshot.signer.last15Minutes.preCommits)}
            </Metric>
            <Metric label="Rejection rate">
              {snapshot.signer.last15Minutes.rejectionPercent === null
                ? "—"
                : `${snapshot.signer.last15Minutes.rejectionPercent.toFixed(1)}%`}
            </Metric>
            <Metric label="Response p95 estimate (diagnostic)">
              {displaySeconds(snapshot.signer.last15Minutes.responseP95Seconds)}
            </Metric>
            <Metric label="Node RPC p95">
              {displaySeconds(snapshot.signer.last15Minutes.nodeRpcP95Seconds)}
            </Metric>
            <Metric label="Validation p95 estimate">
              {displaySeconds(snapshot.signer.last15Minutes.validationP95Seconds)}
            </Metric>
            <Metric label="Capitulation p95">
              {displaySeconds(snapshot.signer.last15Minutes.capitulationP95Seconds)}
            </Metric>
            <Metric label="Agreement conflicts">
              {displayNumber(snapshot.signer.last15Minutes.disagreements)}
            </Metric>
          </div>
        </div>
      </section>

      <section className="card health-history" aria-label="Recent health history">
        <div className="card-head">
          <div>
            <h2>Incident history</h2>
            <p className="tertiary">Durable finding episodes survive a Sidekick restart.</p>
          </div>
          <span className="mono muted">
            {snapshot.history.rawRetentionHours}h raw · {snapshot.history.rollupRetentionDays}d
            trends
          </span>
        </div>
        {snapshot.history.recentEpisodes.length > 0 ? (
          <div className="health-episode-list">
            {snapshot.history.recentEpisodes.slice(0, 10).map((episode) => (
              <div className="health-episode" key={episode.episodeId}>
                <span
                  className={`badge ${
                    episode.status === "resolved"
                      ? "b-neutral"
                      : episode.severity === "critical"
                        ? "b-error"
                        : episode.severity === "warning"
                          ? "b-caution"
                          : "b-info"
                  }`}
                >
                  {episode.status === "resolved"
                    ? "resolved"
                    : episode.severity === "info"
                      ? "monitoring"
                      : "active"}
                </span>
                <div>
                  <strong>{episode.title}</strong>{" "}
                  <span className="mono muted">
                    Opened {displayTime(episode.firstObservedAt)} · last seen{" "}
                    {displayTime(episode.lastObservedAt)} · {episode.occurrences} observations
                  </span>
                </div>
                <span className="mono">
                  Likely source: {classificationLabel(episode.classification)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="tertiary">No finding episodes recorded for this configuration.</p>
        )}
        {snapshot.history.recentRollups.length > 0 ? (
          <div className="health-rollup-summary">
            <Metric label="Recent 5-minute windows">
              {snapshot.history.recentRollups.length.toLocaleString("en-US")}
            </Metric>
            <Metric label="Lowest node availability">
              {Math.min(
                ...snapshot.history.recentRollups.map(
                  (rollup) => rollup.nodeRpcAvailabilityPercent,
                ),
              ).toFixed(1)}
              %
            </Metric>
          </div>
        ) : null}
      </section>

      <details className="card health-advanced domain-section-anchor" id="health-sources">
        <summary>Advanced source details</summary>
        <div className="grid cols-2 health-source-grid">
          {(
            [
              ["Node RPC", snapshot.node.rpc],
              ["Node metrics", snapshot.node.metrics],
              ["Reference API", snapshot.hiro.source],
              ...(snapshot.configuredApi.distinctFromReference
                ? ([["Configured indexed API", snapshot.configuredApi.source]] as const)
                : []),
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
