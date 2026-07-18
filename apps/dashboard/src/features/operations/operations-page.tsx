import { Eye } from "@phosphor-icons/react";
import type { DashboardSnapshot } from "@stx-labs/signer-sidekick-api-contracts";
import { lazy, Suspense } from "react";
import { AlertActionButton } from "../../shared/alert-action-button.js";
import { Badge, PageHead, StatLine } from "../../shared/dashboard-ui.js";
import { number } from "../../shared/format.js";

const EngineOperations = lazy(async () => {
  const module = await import("./engine-operations.js");
  return { default: module.EngineOperations };
});

type Snapshot = DashboardSnapshot;

export function Operations({
  data,
  token,
  sync,
  syncing,
}: {
  data: Snapshot;
  token: string;
  sync: () => void;
  syncing: boolean;
}) {
  return (
    <>
      <PageHead
        title="Operations"
        lede="Review durable transaction jobs, exact approvals, ingestion, alerts, and authoritative reconciliation evidence."
      />
      <Suspense fallback={<div className="loading-state">Loading transaction engine</div>}>
        <EngineOperations token={token} />
      </Suspense>
      <div className="card-standout operation-mode">
        <div>
          <span className="muted">Observation</span>
          <h2>
            <Eye /> Monitoring active
          </h2>
        </div>
        <div>
          <span className="muted">Circuit breaker</span>
          <p>
            <Badge state={data.preflight.status === "fail" ? "error" : "success"}>
              {data.preflight.status === "fail" ? "Open" : "Closed"}
            </Badge>
          </p>
        </div>
        <div>
          <span className="muted">Ingestion</span>
          <p>
            <Badge state={data.forecast?.ingestion ? "success" : "caution"}>
              {data.forecast?.ingestion ? "Synchronized" : "Not run"}
            </Badge>
          </p>
        </div>
        <p className="tertiary">
          Monitoring ingests, reconciles, displays, and alerts independently of transaction-engine
          availability. Admin-only calls always remain offline.
        </p>
      </div>
      <div className="grid cols-2 operation-grid">
        <div className="card">
          <div className="card-head">
            <h2>Alerts</h2>
            <span className="muted">{data.alerts.length} active</span>
          </div>
          {data.alerts.map((alert) => (
            <div className="alert-row" key={alert.id}>
              <span className={`sev sev-${alert.severity}`} />
              <div className="body">
                <div className="t">{alert.title}</div>
                <div className="m">{alert.detail}</div>
                {alert.action ? (
                  <div className="actions">
                    <AlertActionButton alert={alert} sync={sync} syncing={syncing} />
                  </div>
                ) : null}
              </div>
              <div className="meta">{alert.severity}</div>
            </div>
          ))}
          {data.alerts.length === 0 ? <p className="muted">No active alerts.</p> : null}
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Ingestion evidence</h2>
          </div>
          <StatLine label="Roster">
            <span className="src src-api">{data.rosterTotal ?? data.roster.length} stakers</span>
          </StatLine>
          <StatLine label="Manager events">
            <span className="src src-api">{data.activity.eventCount}</span>
          </StatLine>
          <StatLine label="Latest event Stacks block">
            <span className="mono">{number(data.activity.latestBlockHeight)}</span>
          </StatLine>
          <StatLine label="Last roster sync">
            <span className="mono">
              {data.forecast?.ingestion
                ? new Date(data.forecast.ingestion.completedAt).toLocaleString()
                : "never"}
            </span>
          </StatLine>
        </div>
      </div>
    </>
  );
}
