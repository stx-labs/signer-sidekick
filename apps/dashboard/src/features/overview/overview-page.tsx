import {
  ArrowClockwise,
  CheckCircle,
  DownloadSimple,
  SlidersHorizontal,
  Warning,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import type { DashboardSnapshot, HealthSnapshot } from "@stx-labs/signer-sidekick-api-contracts";
import { useEffect, useState } from "react";
import { CopyableIdentifier } from "../../copyable-identifier.js";
import { AlertActionButton } from "../../shared/alert-action-button.js";
import { Badge, PageHead, StatLine } from "../../shared/dashboard-ui.js";
import { downloadJson } from "../../shared/download.js";
import { compactDuration, number, sbtc, short, stx } from "../../shared/format.js";
import { PipelineStage } from "../../shared/pipeline-stage.js";
import { fetchHealthSnapshot } from "../../signer-health.js";

type Snapshot = DashboardSnapshot;

type HealthLight = "green" | "yellow" | "red";

function sourceHealthLight(
  snapshot: HealthSnapshot | null,
  source: "node" | "signer",
  transportFailed: boolean,
): HealthLight {
  if (transportFailed) return "yellow";
  if (!snapshot) return "yellow";
  const findings = snapshot.findings.filter((finding) => finding.source === source);
  if (findings.some(({ severity }) => severity === "critical")) return "red";
  if (findings.length > 0) return "yellow";
  const states =
    source === "node"
      ? [snapshot.node.rpc, ...(snapshot.node.metrics.configured ? [snapshot.node.metrics] : [])]
      : [snapshot.signer.infoSource, snapshot.signer.heartbeat, snapshot.signer.metrics];
  if (
    states.some(
      ({ status, consecutiveFailures }) => status === "unavailable" && consecutiveFailures >= 3,
    )
  ) {
    return "red";
  }
  return states.every(({ status }) => status === "healthy") ? "green" : "yellow";
}

function healthLightLabel(light: HealthLight): string {
  return light === "green" ? "healthy" : light === "yellow" ? "needs attention" : "unavailable";
}

export function Overview({
  data,
  token,
  sync,
  syncing,
  showSetupNotice,
  dismissSetupNotice,
}: {
  data: Snapshot;
  token: string;
  sync: () => void;
  syncing: boolean;
  showSetupNotice: boolean;
  dismissSetupNotice: () => void;
}) {
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [healthUnavailable, setHealthUnavailable] = useState(false);
  useEffect(() => {
    let active = true;
    const loadHealth = async () => {
      try {
        const snapshot = await fetchHealthSnapshot(token);
        if (!active) return;
        setHealth(snapshot);
        setHealthUnavailable(false);
      } catch {
        if (active) setHealthUnavailable(true);
      }
    };
    void loadHealth();
    const interval = setInterval(() => void loadHealth(), 30_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [token]);
  const current = data.forecast?.cycles[0];
  const next = data.forecast?.cycles[1];
  const rewards = data.rewards;
  const requiredAlerts = data.alerts.filter(({ action }) => Boolean(action));
  const blocksUntilPrepare = data.preflight.cycle.blocksUntilPreparePhase;
  const prepareEta =
    blocksUntilPrepare === null || !health?.burnBlockTiming
      ? null
      : compactDuration(blocksUntilPrepare * health.burnBlockTiming.averageSeconds);
  const nodeHealth = sourceHealthLight(health, "node", healthUnavailable);
  const signerHealth = sourceHealthLight(health, "signer", healthUnavailable);
  const nodeHealthLabel = healthUnavailable
    ? "unknown; latest health read failed"
    : healthLightLabel(nodeHealth);
  const signerHealthLabel = healthUnavailable
    ? "unknown; latest health read failed"
    : healthLightLabel(signerHealth);
  return (
    <>
      <PageHead
        title="Overview"
        lede="Current pool status and required actions."
        actions={
          <>
            <button type="button" className="btn btn-tertiary sm" onClick={sync} disabled={syncing}>
              <ArrowClockwise />
              {syncing ? "Syncing" : "Sync now"}
            </button>
            <button
              type="button"
              className="btn btn-secondary sm"
              onClick={() => downloadJson("signer-sidekick-status.json", data)}
            >
              <DownloadSimple />
              Support snapshot
            </button>
          </>
        }
      />
      {showSetupNotice ? (
        <section className="card-standout setup-notice" aria-labelledby="setup-notice-title">
          <div className="setup-notice-icon" aria-hidden="true">
            <SlidersHorizontal />
          </div>
          <div className="setup-notice-body">
            <p className="eyebrow">GET STARTED</p>
            <h2 id="setup-notice-title">Start with Initial Setup</h2>
            <p>Complete Initial Setup before operating this pool.</p>
            <div className="actions">
              <button
                type="button"
                className="btn btn-accent"
                onClick={() => {
                  location.hash = "setup";
                }}
              >
                Open Initial Setup
              </button>
              <button type="button" className="btn btn-tertiary" onClick={dismissSetupNotice}>
                Dismiss
              </button>
            </div>
          </div>
          <button
            type="button"
            className="setup-notice-close"
            aria-label="Dismiss initial setup notice"
            onClick={dismissSetupNotice}
          >
            <X />
          </button>
        </section>
      ) : null}
      <div className="cycle-clock card">
        <div>
          <span>Reward cycle</span>
          <strong>#{data.preflight.cycle.currentId}</strong>
          <small className="src src-chain">PoX-5 contract</small>
        </div>
        <div>
          <span>Bitcoin block height</span>
          <strong>{number(data.preflight.node.burnBlockHeight)}</strong>
          <small className="src src-chain">Reported by Stacks node</small>
        </div>
        <div>
          <span>Next prepare phase</span>
          <strong>
            {number(blocksUntilPrepare)}{" "}
            <em>Bitcoin blocks (#{number(data.preflight.cycle.preparePhaseStartBurnHeight)})</em>
          </strong>
          <small className="prepare-eta">{prepareEta ? `~${prepareEta}` : "ETA unavailable"}</small>
        </div>
        <a className="cycle-health" href="#health" aria-label="Open Node and Signer Health">
          <span>Node &amp; Signer Health</span>
          <div className="cycle-health-states">
            <span role="img" aria-label={`Node health: ${nodeHealthLabel}`} title={nodeHealthLabel}>
              <i className={`health-light ${nodeHealth}`} aria-hidden="true" /> Node
            </span>
            <span
              role="img"
              aria-label={`Signer health: ${signerHealthLabel}`}
              title={signerHealthLabel}
            >
              <i className={`health-light ${signerHealth}`} aria-hidden="true" /> Signer
            </span>
          </div>
          <small>
            {healthUnavailable ? "Latest read failed · open details" : "Open health details"}
          </small>
        </a>
      </div>
      <div className="section-title">
        <WarningCircle color="var(--status-caution)" />
        Required actions{" "}
        <span className="hint">
          {requiredAlerts.length === 0
            ? "No items need attention"
            : requiredAlerts.length === 1
              ? "1 item needs attention"
              : `${requiredAlerts.length} items need attention`}
        </span>
      </div>
      {requiredAlerts.length ? (
        <div className="grid cols-3 action-grid">
          {requiredAlerts.slice(0, 3).map((alert) => (
            <div
              className={`callout callout-${alert.severity === "critical" ? "critical" : alert.severity === "warning" ? "caution" : "info"}`}
              key={alert.id}
            >
              <Warning className="ic" />
              <div className="body">
                <strong>{alert.title}</strong>
                <br />
                {alert.detail}
                <div className="actions">
                  <AlertActionButton alert={alert} sync={sync} syncing={syncing} />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="callout callout-neutral">
          <CheckCircle className="ic" />
          <div className="body">
            <strong>No action is required right now.</strong>
          </div>
        </div>
      )}
      <div className="section-title">Pool at a glance</div>
      <div className="kpi">
        <div className="tile hero">
          <div className="l">
            Stacked this cycle <span className="src src-chain" />
          </div>
          <div className="v">
            {stx(current?.contract.pendingStxUstx)} <span className="u">STX</span>
          </div>
          <div className={current?.threshold.meetsThreshold ? "d up" : "d down"}>
            {current
              ? `${stx(current.threshold.marginUstx)} STX threshold margin`
              : "Roster not synced"}
          </div>
        </div>
        <div className="tile">
          <div className="l">
            Next cycle <span className="src src-local" />
          </div>
          <div className="v">
            {stx(next?.contract.pendingStxUstx)} <span className="u">STX</span>
          </div>
          <div className="d">cycle {next?.cycleId ?? "—"} projection</div>
        </div>
        <div className="tile">
          <div className="l">
            Unclaimed rewards <span className="src src-chain" />
          </div>
          <div className="v btc-value">
            {sbtc(rewards?.manager.unclaimedStakerRewardsSats)} <span className="u">sBTC</span>
          </div>
          <div className="d">{rewards?.totals.actionableClaims ?? 0} actionable claims</div>
        </div>
        <div className="tile">
          <div className="l">
            Registration <span className="src src-chain" />
          </div>
          <div className="v status-value">
            {data.registration?.signerKeyGrantValid ? "Valid" : "Attention"}
          </div>
          <div className="d">
            {data.registration?.registered ? "manager registered" : "registration missing"}
          </div>
        </div>
      </div>
      <div className="section-title">
        Reward pipeline <span className="hint">cycle {data.preflight.cycle.currentId}</span>
      </div>
      <div className="card-standout pipeline-wrap">
        <div className="pipeline">
          <PipelineStage
            done={BigInt(rewards?.global.lastRewardComputeBurnHeight ?? 0) > 0n}
            title="Global calculated"
            value={
              rewards?.global.lastRewardComputeBurnHeight === "0"
                ? "Waiting"
                : `Bitcoin block #${number(rewards?.global.lastRewardComputeBurnHeight)}`
            }
            detail="last calculation"
          />
          <PipelineStage
            done={BigInt(rewards?.global.signerEarnedBeforeManagerClaimSats ?? 0) === 0n}
            title="Manager claim"
            value={`${sbtc(rewards?.global.signerEarnedBeforeManagerClaimSats)} sBTC`}
            detail="unclaimed by manager"
          />
          <PipelineStage
            done={(rewards?.totals.actionableClaims ?? 0) === 0}
            title="Stakers paid"
            value={`${data.activity.claimTotal} recorded`}
            detail={`${rewards?.totals.actionableClaims ?? 0} currently actionable`}
          />
          <PipelineStage
            done={data.activity.withdrawals.every(({ state }) => state !== "pending")}
            title="Bitcoin withdrawals"
            value={`${data.activity.withdrawalTotal - data.activity.pendingWithdrawalTotal} / ${data.activity.withdrawalTotal}`}
            detail="completed requests"
          />
        </div>
      </div>
      <div className="grid cols-2-1 overview-bottom">
        <div className="card">
          <div className="card-head">
            <h2>Registration &amp; eligibility</h2>
            <Badge state={data.setup?.status === "ready" ? "success" : "caution"}>
              {data.setup?.status ?? "Unavailable"}
            </Badge>
          </div>
          <StatLine label="Manager">
            <CopyableIdentifier
              value={data.managerPrincipal}
              display={short(data.managerPrincipal)}
              label="manager principal"
              className="identifier"
            />
          </StatLine>
          <StatLine label="Grant">
            <Badge state={data.registration?.signerKeyGrantValid ? "success" : "error"}>
              {data.registration?.signerKeyGrantValid ? "Valid" : "Invalid"}
            </Badge>
          </StatLine>
          <StatLine label={`Signer set · ${current?.cycleId ?? "—"}`}>
            <Badge state={current?.contract.inSignerSet ? "success" : "error"}>
              {current?.contract.inSignerSet ? "Eligible" : "Not eligible"}
            </Badge>
          </StatLine>
          <StatLine label="Source hash">
            <CopyableIdentifier
              value={data.manager.source.sha256}
              display={short(data.manager.source.sha256)}
              label="manager source hash"
              className="identifier src src-chain"
            />
          </StatLine>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Recent activity</h2>
          </div>
          <div className="timeline">
            {data.activity.claims.slice(0, 4).map((claim) => (
              <div className="ev ok" key={`${claim.txId}:${claim.eventIndex}`}>
                <div className="t">Staker reward claimed</div>
                <div className="m">
                  {sbtc(claim.amountSats)} sBTC ·{" "}
                  <CopyableIdentifier
                    value={claim.stakerPrincipal}
                    display={short(claim.stakerPrincipal)}
                    label="staker principal"
                    className="mono"
                  />
                </div>
                <div className="h">
                  Stacks block {number(claim.blockHeight)} ·{" "}
                  <CopyableIdentifier
                    value={claim.txId}
                    display={short(claim.txId)}
                    label="transaction ID"
                    className="mono"
                  />
                </div>
              </div>
            ))}
            {data.activity.claims.length === 0 ? (
              <div className="ev">
                <div className="t">No manager claims yet</div>
                <div className="m">Sync chain data to update event history.</div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
