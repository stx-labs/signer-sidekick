import { ArrowClockwise, Eye, ShieldWarning, Warning } from "@phosphor-icons/react";
import type { EngineStatus, OperationReadiness } from "@stx-labs/signer-sidekick-api-contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { activityHash, settingsHash } from "../../dashboard-route.js";
import { Badge, ErrorCallout, StatusBadge } from "../../shared/dashboard-ui.js";
import { operatorActionError } from "../../shared/operator-error.js";
import {
  disableEngineAdapter,
  forceEngineObserve,
  loadEngineStatus,
  loadOperationReadiness,
} from "../operations/engine-api.js";

type EngineControlAction = "force-observe" | `disable:${string}`;

function stateLabel(value: string): string {
  return value.replaceAll("_", " ").replaceAll("-", " ");
}

function readinessHref(check: OperationReadiness["checks"][number]): string | null {
  if (check.status === "ready") return null;
  if (check.id === "manager" || check.id === "signer" || check.id === "setup") {
    return settingsHash("attachment");
  }
  if (check.id === "control-plane") return settingsHash("sources");
  return null;
}

export function EngineSettings({ token }: { token: string }) {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [readiness, setReadiness] = useState<OperationReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<EngineControlAction | null>(null);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    setError(null);
    try {
      const [nextStatus, nextReadiness] = await Promise.all([
        loadEngineStatus(token, request.signal),
        loadOperationReadiness(token, request.signal),
      ]);
      if (request.signal.aborted) return;
      setStatus(nextStatus);
      setReadiness(nextReadiness);
      setUnavailable(nextStatus === null);
    } catch (cause) {
      if (request.signal.aborted) return;
      setError(
        operatorActionError(
          cause,
          "Could not load transaction policy controls",
          "Retrying is safe",
        ),
      );
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
    return () => controller.current?.abort();
  }, [load]);

  const forceObserve = async () => {
    if (!status || action) return;
    if (
      !window.confirm(
        "Force the transaction engine into Observe mode? New signing and broadcasts will stop while result verification continues.",
      )
    ) {
      return;
    }
    setAction("force-observe");
    setError(null);
    try {
      const result = await forceEngineObserve(token, {
        decision: "force-observe",
        reason: "Operator confirmed emergency force-Observe from Settings",
      });
      setStatus(result.status);
    } catch (cause) {
      setError(
        operatorActionError(
          cause,
          "Could not confirm Force Observe",
          "Refresh policy controls before trying again; Observe mode may already be active",
        ),
      );
    } finally {
      setAction(null);
    }
  };

  const disableAdapter = async (adapterId: string) => {
    if (!status || action) return;
    if (
      !window.confirm(
        `Disable ${adapterId}? New jobs and broadcasts for this adapter will stop while existing attempts remain observable.`,
      )
    ) {
      return;
    }
    setAction(`disable:${adapterId}`);
    setError(null);
    try {
      const result = await disableEngineAdapter(token, adapterId, {
        decision: "disable",
        reason: "Operator disabled adapter from Settings",
      });
      setStatus(result.status);
    } catch (cause) {
      setError(
        operatorActionError(
          cause,
          `Could not confirm that ${adapterId} was disabled`,
          "Refresh policy controls before trying again; the adapter may already be disabled",
        ),
      );
    } finally {
      setAction(null);
    }
  };

  return (
    <section className="card-standout set-section engine-settings" id="transaction-capabilities">
      <div className="card-head">
        <div>
          <span className="eyebrow">Execution policy</span>
          <h2>Transaction capabilities</h2>
        </div>
        <button
          className="btn btn-tertiary sm"
          disabled={loading || action !== null}
          onClick={() => void load()}
          type="button"
        >
          <ArrowClockwise className={loading ? "spin" : ""} /> Refresh controls
        </button>
      </div>
      <ErrorCallout error={error} />
      {loading && !status ? <div className="loading-state">Loading transaction policy</div> : null}
      {unavailable ? (
        <div className="callout callout-neutral" role="status">
          <div className="body">
            The transaction engine is unavailable. Monitoring and wallet-signed operations remain
            separate from this policy surface.
          </div>
        </div>
      ) : null}
      {status ? (
        <>
          {readiness ? (
            <div className="card engine-readiness-card">
              <div className="card-head">
                <h3>Operation readiness</h3>
                <StatusBadge status={readiness.status} />
              </div>
              {readiness.checks
                .filter((check) => check.status !== "ready")
                .map((check) => {
                  const href = readinessHref(check);
                  return (
                    <div className="engine-readiness-check" key={check.id}>
                      <p className="muted">{check.detail}</p>
                      {href ? (
                        <a className="btn btn-tertiary sm" href={href}>
                          Review {check.id === "control-plane" ? "sources" : "attachment"}
                        </a>
                      ) : null}
                    </div>
                  );
                })}
            </div>
          ) : null}
          <div className="engine-status-grid settings-engine-grid">
            <div className="card engine-mode-card">
              <span className="muted">Engine mode</span>
              <h3>
                <Eye /> {stateLabel(status.mode)}
              </h3>
              <p className="muted">
                {status.mode === "observe"
                  ? "Plans transactions but cannot sign or submit them."
                  : status.mode === "assist"
                    ? "Each submission requires approval."
                    : "Only enabled, capped operations can submit transactions."}
              </p>
            </div>
            <div className="card engine-job-counts">
              <div>
                <strong>{status.jobs.active}</strong>
                <span>active jobs</span>
              </div>
              <div>
                <strong>{status.jobs.awaitingApproval}</strong>
                <span>awaiting approval</span>
              </div>
              <div>
                <strong>{status.jobs.ambiguous}</strong>
                <span>ambiguous</span>
              </div>
              <a className="btn btn-tertiary sm" href={activityHash(null, "type=actions")}>
                Review Activity
              </a>
            </div>
            <div className="card engine-emergency-card">
              <div className="card-head">
                <h3>Emergency control</h3>
                <Badge state={status.forcedObserve.active ? "error" : "success"}>
                  {status.forcedObserve.active ? "Forced Observe" : "Normal policy"}
                </Badge>
              </div>
              {status.forcedObserve.active ? (
                <p className="muted">
                  {status.forcedObserve.reason} · {status.forcedObserve.actor}
                </p>
              ) : (
                <button
                  className="btn btn-secondary"
                  disabled={status.mode === "observe" || action !== null}
                  onClick={() => void forceObserve()}
                  type="button"
                >
                  <ShieldWarning />
                  {action === "force-observe" ? "Forcing Observe" : "Force Observe"}
                </button>
              )}
            </div>
          </div>
          <div className="card engine-adapters">
            <div className="card-head">
              <h3>Reviewed adapters</h3>
              <span className="muted">Enabled independently</span>
            </div>
            {status.adapters.map((adapter) => (
              <div className="engine-adapter-row" key={adapter.adapter.id}>
                <div>
                  <strong>{adapter.label}</strong>
                  <span className="mono">
                    {adapter.adapter.id} · revision {adapter.adapter.revision}
                  </span>
                  {adapter.blockReason ? (
                    <span className="muted">{adapter.blockReason}</span>
                  ) : null}
                </div>
                <Badge
                  state={
                    adapter.availability === "available"
                      ? "success"
                      : adapter.availability === "disabled"
                        ? "error"
                        : "caution"
                  }
                >
                  {adapter.availability}
                </Badge>
                {adapter.enabled ? (
                  <button
                    className="btn btn-tertiary"
                    disabled={action !== null}
                    onClick={() => void disableAdapter(adapter.adapter.id)}
                    type="button"
                  >
                    <Warning />
                    {action === `disable:${adapter.adapter.id}` ? "Disabling" : "Disable adapter"}
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}
