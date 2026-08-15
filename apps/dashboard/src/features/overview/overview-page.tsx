import {
  ArrowClockwise,
  CheckCircle,
  Clock,
  Pulse,
  Warning,
  WarningCircle,
} from "@phosphor-icons/react";
import {
  type ContextualAction,
  type OverviewAttentionItem,
  type OverviewEvidence,
  type OverviewPage,
  overviewPageSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiJson } from "../../api-client.js";
import type { DomainSection } from "../../dashboard-route.js";
import { ContextualActionControl } from "../../shared/contextual-action.js";
import { Badge, PageHead } from "../../shared/dashboard-ui.js";
import { useDomainSection } from "../../shared/domain-section.js";
import { compactDuration, number, sbtc, stx } from "../../shared/format.js";
import { operatorErrorDetail, operatorErrorSentence } from "../../shared/operator-error.js";

const OVERVIEW_POLL_MS = 15_000;
const INITIAL_ATTENTION_COUNT = 5;

type RecheckTarget = Extract<ContextualAction, { kind: "recheck" }>["target"];
type Tone = "success" | "caution" | "error" | "neutral" | "info";

function statusLabel(value: string): string {
  return value.replaceAll("-", " ");
}

function statusTone(value: string): Tone {
  return ["advancing", "aligned", "healthy", "ready", "current", "completed"].includes(value)
    ? "success"
    : ["needs-attention", "behind", "unavailable"].includes(value)
      ? "error"
      : ["insufficient-evidence", "collecting", "not-configured", "pending", "unknown"].includes(
            value,
          )
        ? "caution"
        : "neutral";
}

function rewardNetSats(gross: string | null, fee: string | null): string | null {
  return gross === null || fee === null ? null : (BigInt(gross) - BigInt(fee)).toString();
}

function evidenceStatus(evidence: readonly OverviewEvidence[]): OverviewEvidence["status"] {
  const order: OverviewEvidence["status"][] = [
    "unavailable",
    "delayed",
    "not-configured",
    "current",
  ];
  return order.find((status) => evidence.some((item) => item.status === status)) ?? "unavailable";
}

function latestEvidenceTime(evidence: readonly OverviewEvidence[]): string | null {
  return (
    evidence
      .map(({ observedAt }) => observedAt)
      .filter((value): value is string => value !== null)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null
  );
}

function EvidenceLine({ evidence }: { evidence: readonly OverviewEvidence[] }) {
  const state = evidenceStatus(evidence);
  const observedAt = latestEvidenceTime(evidence);
  const reason = evidence.find((item) => item.status === state)?.reason ?? null;
  return (
    <div className={`overview-evidence evidence-${state}`}>
      <span className="overview-evidence-dot" />
      <span>{statusLabel(state)}</span>
      {observedAt ? <span>· {new Date(observedAt).toLocaleString()}</span> : null}
      {reason ? <span className="overview-evidence-reason">· {reason}</span> : null}
    </div>
  );
}

function ProtocolMoment({
  label,
  moment,
}: {
  label: string;
  moment: OverviewPage["cycle"]["nextRewardCalculation"];
}) {
  const relativeEstimate = (() => {
    if (!moment.estimatedAt) return null;
    const seconds = Math.round((Date.parse(moment.estimatedAt) - Date.now()) / 1_000);
    return seconds > 0
      ? `in about ${compactDuration(seconds)}`
      : seconds < 0
        ? `about ${compactDuration(Math.abs(seconds))} ago`
        : "about now";
  })();
  return (
    <div className="overview-moment">
      <span>{label}</span>
      <strong>
        {moment.status === "unavailable"
          ? "Unavailable"
          : moment.status === "due"
            ? "Due now"
            : `${number(moment.blocksRemaining)} Bitcoin blocks`}
      </strong>
      <small>
        {moment.burnBlockHeight === null
          ? "No verified checkpoint"
          : `Bitcoin #${number(moment.burnBlockHeight)}`}
        {relativeEstimate ? ` · ${relativeEstimate}` : ""}
      </small>
    </div>
  );
}

function deadlineLabel(deadline: OverviewAttentionItem["deadline"]): string | null {
  if (!deadline) return null;
  if (deadline.kind === "burn-block") {
    return `Before Bitcoin #${number(deadline.burnBlockHeight)}${deadline.estimatedAt ? ` · ~${new Date(deadline.estimatedAt).toLocaleString()}` : ""}`;
  }
  if (deadline.kind === "reward-cycle") {
    return `Cycle ${deadline.rewardCycleId} · ${statusLabel(deadline.phase)}`;
  }
  return `By ${new Date(deadline.at).toLocaleString()}`;
}

function AttentionCard({
  item,
  onRecheck,
  rechecking,
}: {
  item: OverviewAttentionItem;
  onRecheck: (target: RecheckTarget) => void;
  rechecking: boolean;
}) {
  const tone =
    item.tier === "urgent" ? "critical" : item.tier === "action-required" ? "caution" : "info";
  const deadline = deadlineLabel(item.deadline);
  return (
    <article className={`overview-attention callout callout-${tone}`}>
      {item.tier === "urgent" ? <Warning /> : <WarningCircle />}
      <div className="body">
        <div className="overview-attention-head">
          <strong>{item.title}</strong>
          <Badge state={item.tier === "urgent" ? "error" : "caution"}>
            {statusLabel(item.tier)}
          </Badge>
        </div>
        <p>{item.summary}</p>
        <p className="overview-impact">Impact: {item.impact}</p>
        {deadline ? (
          <p className="overview-deadline">
            <Clock /> {deadline}
          </p>
        ) : null}
        <EvidenceLine evidence={item.evidence} />
        <div className="actions">
          <ContextualActionControl
            action={item.primaryAction}
            emphasis={item.tier === "needs-attention" ? "secondary" : "primary"}
            onRecheck={onRecheck}
            rechecking={rechecking}
          />
          {item.detailsAction ? (
            <ContextualActionControl
              action={item.detailsAction}
              emphasis="tertiary"
              onRecheck={onRecheck}
              rechecking={rechecking}
            />
          ) : null}
        </div>
      </div>
    </article>
  );
}

function HealthCard({
  title,
  status,
  detail,
  facts,
  evidence,
  action,
  onRecheck,
  rechecking,
}: {
  title: string;
  status: string;
  detail: string;
  facts: Array<{ label: string; value: string }>;
  evidence: readonly OverviewEvidence[];
  action: ContextualAction;
  onRecheck: (target: RecheckTarget) => void;
  rechecking: boolean;
}) {
  return (
    <article className="card overview-health-card">
      <div className="card-head">
        <h2>{title}</h2>
        <Badge state={statusTone(status)}>{statusLabel(status)}</Badge>
      </div>
      <p>{detail}</p>
      <dl>
        {facts.map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
      <EvidenceLine evidence={evidence} />
      <ContextualActionControl
        action={action}
        emphasis="tertiary"
        onRecheck={onRecheck}
        rechecking={rechecking}
      />
    </article>
  );
}

function feeUnavailableLabel(
  reason: OverviewPage["rewards"]["operatorFeeUnavailableReason"],
): string {
  switch (reason) {
    case "reviewed-fee-capability-unavailable":
      return "Manager fee semantics have not been reviewed";
    case "forecast-unavailable":
      return "A checkpoint forecast is not available yet";
    case "authoritative-roster-unavailable":
      return "The authoritative roster is unavailable";
    case "per-staker-shares-incomplete":
      return "Per-staker share evidence is incomplete";
    case "anchored-fee-inputs-unavailable":
      return "Anchored fee inputs are unavailable";
    default:
      return "The reward outlook is unavailable";
  }
}

export function Overview({
  token,
  section,
  connectionUnavailable,
  onConnectionRecheck,
  onLoaded,
}: {
  token: string;
  section: DomainSection | null;
  connectionUnavailable: boolean;
  onConnectionRecheck: () => Promise<void>;
  onLoaded: (summary: { network: string; attentionCount: number }) => void;
}) {
  const [data, setData] = useState<OverviewPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showAllAttention, setShowAllAttention] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);
  const hasData = useRef(false);
  useDomainSection("overview", section);

  const load = useCallback(
    async (force = false, indicateRefresh = false) => {
      if (!force && activeRequest.current) return;
      activeRequest.current?.abort();
      const controller = new AbortController();
      activeRequest.current = controller;
      if (indicateRefresh) setRefreshing(true);
      if (!hasData.current) setLoading(true);
      try {
        const result = await apiJson(
          token,
          force ? "/api/v1/overview?refresh=1" : "/api/v1/overview",
          overviewPageSchema,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        hasData.current = true;
        setData(result);
        setError(null);
        onLoaded({ network: result.monitoring.network, attentionCount: result.attention.length });
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(operatorErrorDetail(cause, "Sidekick returned no Overview error detail"));
        }
      } finally {
        if (activeRequest.current === controller) {
          activeRequest.current = null;
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [onLoaded, token],
  );

  useEffect(() => {
    void load();
    const refreshIfVisible = () => {
      // The server keeps the operator snapshot current without a browser. Visible-page polling
      // should read that retained snapshot; only an explicit operator refresh should force another
      // full chain read.
      if (document.visibilityState === "visible") void load();
    };
    const interval = window.setInterval(refreshIfVisible, OVERVIEW_POLL_MS);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshIfVisible);
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, [load]);

  const recheck = async (target: RecheckTarget) => {
    if (target === "connection") await onConnectionRecheck();
    await load(true, true);
  };

  if (!data && loading) {
    return (
      <div className="overview-loading" aria-live="polite" role="status">
        <ArrowClockwise className="spin" />
        <div>
          <strong>Loading Overview</strong>
          <span>Other pages remain independently available.</span>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <>
        <PageHead title="Overview" lede="What needs attention and what is happening next." />
        <div className="callout callout-critical" role="alert">
          <WarningCircle className="ic" />
          <div className="body">
            <strong>Could not load Overview</strong>
            <span>{operatorErrorSentence(error ?? "Overview is unavailable")}</span>
            <div className="actions">
              <button
                className="btn btn-secondary sm"
                onClick={() => void load(true, true)}
                type="button"
              >
                Retry Overview
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  const visibleAttention = showAllAttention
    ? data.attention
    : data.attention.slice(0, INITIAL_ATTENTION_COUNT);
  const checkedAgeSeconds = Math.max(
    0,
    Math.round((Date.now() - Date.parse(data.generatedAt)) / 1_000),
  );
  const pool = data.pool;
  const rewards = data.rewards;
  const forecastConfidence =
    rewards.confidence === "contract-exact"
      ? "Contract-exact now"
      : rewards.confidence === "unavailable"
        ? "Unavailable"
        : `${statusLabel(rewards.confidence)} confidence`;

  return (
    <>
      <PageHead
        title="Overview"
        lede="What needs attention, what is in progress, and what happens next."
        actions={
          <button
            className="btn btn-tertiary sm"
            disabled={refreshing}
            onClick={() => void load(true, true)}
            type="button"
          >
            <ArrowClockwise className={refreshing ? "spin" : undefined} />
            {refreshing ? "Refreshing" : "Refresh current state"}
          </button>
        }
      />
      {error ? (
        <div className="callout callout-info content-notice" role="status">
          <WarningCircle className="ic" />
          <div className="body">
            <strong>Could not refresh Overview</strong>
            <span>{operatorErrorSentence(error)} Showing the last successful projection.</span>
          </div>
        </div>
      ) : null}
      {connectionUnavailable ? (
        <div className="callout callout-caution content-notice" role="status">
          <WarningCircle className="ic" />
          <div className="body">
            <strong>Local node unavailable · actions paused</strong>
            <span>Retained domain evidence remains visible while Sidekick rechecks the node.</span>
          </div>
        </div>
      ) : null}

      <section
        className="overview-identity card"
        id="overview-cycle"
        aria-label="Current operation"
      >
        <div>
          <span>Reward cycle</span>
          <strong>
            {data.cycle.rewardCycleId === null ? "—" : `#${data.cycle.rewardCycleId}`}
          </strong>
          <small>
            {data.monitoring.network}
            {data.cycle.phase ? ` · ${data.cycle.phase} phase` : " · phase unavailable"}
          </small>
        </div>
        <ProtocolMoment label="Next reward calculation" moment={data.cycle.nextRewardCalculation} />
        <ProtocolMoment label="Next prepare phase" moment={data.cycle.nextPreparePhase} />
      </section>
      <EvidenceLine evidence={data.cycle.evidence} />

      <section id="overview-health" aria-labelledby="overview-health-heading">
        <div className="section-title overview-section-title">
          <span id="overview-health-heading">Node, signer &amp; network</span>
          <span className="hint">Independent evidence; no inferred network-wide verdict.</span>
        </div>
        <div className="grid cols-3 overview-health-grid">
          <HealthCard
            action={data.network.detailsAction}
            detail={data.network.detail}
            evidence={data.network.evidence}
            facts={[
              { label: "Reference", value: data.network.reference ?? "Not configured" },
              { label: "Stacks tip", value: number(data.network.stacksTipHeight) },
              { label: "Bitcoin tip", value: number(data.network.burnBlockHeight) },
            ]}
            onRecheck={(target) => void recheck(target)}
            rechecking={refreshing}
            status={data.network.status}
            title="Network reference"
          />
          <HealthCard
            action={data.node.detailsAction}
            detail={data.node.detail}
            evidence={data.node.evidence}
            facts={[
              { label: "Stacks tip", value: number(data.node.stacksTipHeight) },
              { label: "Bitcoin tip", value: number(data.node.burnBlockHeight) },
              {
                label: "Peer difference",
                value:
                  data.node.peerHeightDifference === null
                    ? "—"
                    : `${data.node.peerHeightDifference > 0 ? "+" : ""}${data.node.peerHeightDifference}`,
              },
            ]}
            onRecheck={(target) => void recheck(target)}
            rechecking={refreshing}
            status={data.node.status}
            title="Local node"
          />
          <HealthCard
            action={data.signer.detailsAction}
            detail={data.signer.detail}
            evidence={data.signer.evidence}
            facts={[
              { label: "Proposals · 1h", value: number(data.signer.proposalsLastHour) },
              {
                label: "Accepted / rejected",
                value: `${number(data.signer.acceptedLastHour)} / ${number(data.signer.rejectedLastHour)}`,
              },
              {
                label: "Response p95",
                value:
                  data.signer.responseP95Seconds === null
                    ? "—"
                    : `${data.signer.responseP95Seconds.toFixed(1)}s`,
              },
            ]}
            onRecheck={(target) => void recheck(target)}
            rechecking={refreshing}
            status={data.signer.status}
            title="Signer"
          />
        </div>
      </section>

      <section id="overview-attention" aria-labelledby="overview-attention-heading">
        <div className="section-title overview-section-title">
          <span id="overview-attention-heading">Attention</span>
          <span className="hint">
            {data.attention.length === 0
              ? "No operator decisions right now"
              : `${data.attention.length} current ${data.attention.length === 1 ? "item" : "items"}`}
          </span>
        </div>
        {data.attention.length === 0 ? (
          <div className="callout callout-neutral overview-clear-state">
            <CheckCircle className="ic" />
            <div className="body">
              <strong>No action is required right now.</strong>
              <span>
                Current evidence was checked {compactDuration(checkedAgeSeconds)} ago. Scheduled
                work remains on Pool and Rewards until it becomes actionable.
              </span>
            </div>
          </div>
        ) : (
          <div className="overview-attention-list">
            {visibleAttention.map((item) => (
              <AttentionCard
                item={item}
                key={item.attentionId}
                onRecheck={(target) => void recheck(target)}
                rechecking={refreshing}
              />
            ))}
            {data.attention.length > INITIAL_ATTENTION_COUNT ? (
              <button
                className="btn btn-tertiary overview-show-all"
                aria-expanded={showAllAttention}
                onClick={() => {
                  if (!showAllAttention) setShowAllAttention(true);
                }}
                type="button"
              >
                {showAllAttention
                  ? `All ${data.attention.length} items shown`
                  : `Show all ${data.attention.length} items`}
              </button>
            ) : null}
          </div>
        )}
      </section>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {data.attention.length === 0
          ? "No current attention items."
          : `${visibleAttention.length} of ${data.attention.length} current attention items shown.`}
      </span>

      {data.inProgress.length > 0 ? (
        <section aria-labelledby="overview-progress-heading">
          <div className="section-title overview-section-title">
            <span id="overview-progress-heading">In progress</span>
            <span className="hint">Durable work continues without this browser.</span>
          </div>
          <div className="overview-progress-list">
            {data.inProgress.map((item) => (
              <article className="card overview-progress" key={item.activityId}>
                <Pulse />
                <div>
                  <strong>{item.title}</strong>
                  <span>{statusLabel(item.stage)}</span>
                  <EvidenceLine evidence={item.evidence} />
                </div>
                <ContextualActionControl
                  action={item.primaryAction}
                  onRecheck={(target) => void recheck(target)}
                  rechecking={refreshing}
                />
              </article>
            ))}
          </div>
          <ContextualActionControl
            action={{
              kind: "open-domain",
              page: "activity",
              section: "active",
              label: "View all in Activity",
            }}
            emphasis="tertiary"
            onRecheck={(target) => void recheck(target)}
          />
        </section>
      ) : null}

      <div className="grid cols-2 overview-domain-grid">
        <section
          className="card overview-domain"
          id="overview-pool"
          aria-labelledby="overview-pool-heading"
        >
          <div className="card-head">
            <h2 id="overview-pool-heading">Pool</h2>
            <Badge state={statusTone(pool.status)}>{statusLabel(pool.status)}</Badge>
          </div>
          <div className="overview-domain-primary">
            <span>Current</span>
            <strong>{pool.current ? `${stx(pool.current.amountUstx)} STX` : "Unavailable"}</strong>
            <small>
              {pool.current
                ? `Cycle ${pool.current.rewardCycleId} · ${pool.current.inSignerSet ? "in signer set" : "not in signer set"}`
                : "Current pool state unavailable"}
            </small>
          </div>
          <dl>
            <div>
              <dt>Next cycle</dt>
              <dd>{pool.next ? `${stx(pool.next.amountUstx)} STX` : "—"}</dd>
            </div>
            <div>
              <dt>Next-cycle eligibility</dt>
              <dd>{pool.next ? (pool.next.inSignerSet ? "Eligible" : "Not eligible") : "—"}</dd>
            </div>
            <div>
              <dt>STX-only / bonds</dt>
              <dd>
                {pool.participants
                  ? `${pool.participants.stxOnly} / ${pool.participants.bitcoinBond}`
                  : "—"}
              </dd>
            </div>
          </dl>
          {pool.nextChange ? (
            <p className="overview-domain-note">
              Next change: {statusLabel(pool.nextChange.kind)} in cycle{" "}
              {pool.nextChange.rewardCycleId}
              {pool.nextChange.amountDeltaUstx === null
                ? ""
                : ` · ${stx(pool.nextChange.amountDeltaUstx)} STX`}
            </p>
          ) : null}
          <EvidenceLine evidence={pool.evidence} />
          <ContextualActionControl
            action={pool.detailsAction}
            emphasis="tertiary"
            onRecheck={(target) => void recheck(target)}
            rechecking={refreshing}
          />
        </section>

        <section
          className="card overview-domain"
          id="overview-rewards"
          aria-labelledby="overview-rewards-heading"
        >
          <div className="card-head">
            <h2 id="overview-rewards-heading">Rewards</h2>
            <Badge state={statusTone(rewards.status)}>{statusLabel(rewards.status)}</Badge>
          </div>
          <div className="overview-domain-primary">
            <span>
              {rewards.estimateKind === "checkpoint-forecast"
                ? "Projected next allocation"
                : rewards.estimateKind === "if-calculated-now"
                  ? "Accrued so far — pool gross"
                  : "Pool estimate"}
            </span>
            <strong>
              {rewards.estimatedPoolRewardSats === null
                ? "Unavailable"
                : `${sbtc(rewards.estimatedPoolRewardSats)} sBTC`}
            </strong>
            <small>{forecastConfidence}</small>
          </div>
          <dl>
            <div>
              <dt title="Total sBTC accumulated by PoX-5 for the next network calculation, shared across eligible signers and pools.">
                Network-wide rewards
              </dt>
              <dd>
                {rewards.globalAccruedSats === null
                  ? "Unavailable"
                  : `${sbtc(rewards.globalAccruedSats)} sBTC`}
              </dd>
            </div>
            <div>
              <dt title="Estimated portion earned by this pool operator, using per-staker and per-bucket integer rounding.">
                Operator fee estimate
              </dt>
              <dd>
                {rewards.operatorFeeSats === null
                  ? feeUnavailableLabel(rewards.operatorFeeUnavailableReason)
                  : `${sbtc(rewards.operatorFeeSats)} sBTC`}
              </dd>
            </div>
            <div>
              <dt title="Estimated amount remaining for this pool's stakers after operator fees.">
                Net for your stakers
              </dt>
              <dd>
                {rewardNetSats(rewards.estimatedPoolRewardSats, rewards.operatorFeeSats) === null
                  ? "Unavailable"
                  : `${sbtc(rewardNetSats(rewards.estimatedPoolRewardSats, rewards.operatorFeeSats) ?? "0")} sBTC`}
              </dd>
            </div>
          </dl>
          <p className="overview-domain-note">
            {number(rewards.actionableClaims)} stakers ready for payout · Reward calculation:{" "}
            {statusLabel(rewards.calculationState ?? "unavailable")}
          </p>
          <EvidenceLine evidence={rewards.evidence} />
          <ContextualActionControl
            action={rewards.detailsAction}
            emphasis="tertiary"
            onRecheck={(target) => void recheck(target)}
            rechecking={refreshing}
          />
        </section>
      </div>
    </>
  );
}
