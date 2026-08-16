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

const MODE_DESCRIPTION: Record<EngineStatus["mode"], string> = {
  observe: "Plans transactions but never signs or submits them.",
  assist: "Prepares each transaction and waits for your approval before submitting.",
};

function stateLabel(value: string): string {
  return value.replaceAll("_", " ").replaceAll("-", " ");
}

function readinessReview(
  check: OperationReadiness["checks"][number],
): { href: string; label: string } | null {
  if (check.status === "ready") return null;
  if (check.id === "manager" || check.id === "signer" || check.id === "setup") {
    return { href: settingsHash("attachment"), label: "Review attachment" };
  }
  if (check.id === "control-plane")
    return { href: settingsHash("sources"), label: "Review sources" };
  return null;
}

function adapterBadgeState(
  availability: EngineStatus["adapters"][number]["availability"],
): "success" | "error" | "caution" {
  if (availability === "available") return "success";
  if (availability === "disabled") return "error";
  return "caution";
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

  const blockingChecks = readiness?.checks.filter((check) => check.status !== "ready") ?? [];
  const blockerDetails = new Set(blockingChecks.map((check) => check.detail));
  const jobTotal = status
    ? status.jobs.active + status.jobs.awaitingApproval + status.jobs.ambiguous
    : 0;
  // Engine job counts and the emergency brake are only meaningful in Assist mode or while work
  // remains active, so keep them out of the default Observe view.
  const showEngineControls = Boolean(
    status && (status.mode !== "observe" || jobTotal > 0 || status.forcedObserve.active),
  );
  const canForceObserve = Boolean(
    status && status.mode !== "observe" && !status.forcedObserve.active,
  );

  return (
    <section className="card set-section engine-settings" id="transaction-capabilities">
      <div className="card-head">
        <div>
          <h2>Transaction capabilities</h2>
          <p className="engine-settings-subtitle">
            How Sidekick prepares and submits manager operations.
          </p>
        </div>
        <button
          className="btn btn-tertiary sm"
          disabled={loading || action !== null}
          onClick={() => void load()}
          type="button"
        >
          <ArrowClockwise className={loading ? "spin" : ""} /> Refresh
        </button>
      </div>
      <ErrorCallout error={error} />
      {loading && !status ? <div className="loading-state">Loading transaction policy</div> : null}
      {unavailable ? (
        <p className="muted">
          The transaction engine is unavailable. Monitoring and wallet-signed operations are
          unaffected.
        </p>
      ) : null}
      {status ? (
        <>
          <div className="engine-mode">
            <Eye />
            <div>
              <strong>{stateLabel(status.mode)}</strong>{" "}
              <span className="muted">{MODE_DESCRIPTION[status.mode]}</span>
            </div>
            {status.forcedObserve.active ? <Badge state="error">Forced Observe</Badge> : null}
          </div>

          {blockingChecks.length ? (
            <div className="engine-block">
              <div className="engine-block-head">
                <h3>Operation readiness</h3>
                {readiness ? <StatusBadge status={readiness.status} /> : null}
              </div>
              {blockingChecks.map((check) => {
                const review = readinessReview(check);
                return (
                  <div className="engine-block-item" key={check.id}>
                    <p className="muted">{check.detail}</p>
                    {review ? (
                      <a className="btn btn-tertiary sm" href={review.href}>
                        {review.label}
                      </a>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}

          {status.adapters.length ? (
            <div className="engine-block">
              <div className="engine-block-head">
                <h3>Operations</h3>
                <a className="btn btn-tertiary sm" href={activityHash(null, "type=actions")}>
                  Review activity
                </a>
              </div>
              {status.adapters.map((adapter) => (
                <div className="engine-operation" key={adapter.adapter.id}>
                  <div className="engine-operation-name">
                    <strong>{adapter.label}</strong>{" "}
                    <span className="mono">
                      {adapter.adapter.id} · rev {adapter.adapter.revision}
                    </span>
                    {adapter.blockReason && !blockerDetails.has(adapter.blockReason) ? (
                      <span className="muted">{adapter.blockReason}</span>
                    ) : null}
                  </div>
                  <Badge state={adapterBadgeState(adapter.availability)}>
                    {adapter.availability}
                  </Badge>
                  {adapter.enabled ? (
                    <button
                      className="btn btn-tertiary sm"
                      disabled={action !== null}
                      onClick={() => void disableAdapter(adapter.adapter.id)}
                      type="button"
                    >
                      <Warning />
                      {action === `disable:${adapter.adapter.id}` ? "Disabling" : "Disable"}
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {showEngineControls ? (
            <div className="engine-block">
              <div className="engine-block-head">
                <h3>Engine controls</h3>
                {canForceObserve ? (
                  <button
                    className="btn btn-secondary sm"
                    disabled={action !== null}
                    onClick={() => void forceObserve()}
                    type="button"
                  >
                    <ShieldWarning />
                    {action === "force-observe" ? "Forcing Observe" : "Force Observe"}
                  </button>
                ) : null}
              </div>
              <div className="engine-jobs">
                <span>
                  <strong>{status.jobs.active}</strong> active
                </span>
                <span>
                  <strong>{status.jobs.awaitingApproval}</strong> awaiting approval
                </span>
                <span>
                  <strong>{status.jobs.ambiguous}</strong> ambiguous
                </span>
              </div>
              {status.forcedObserve.active ? (
                <p className="muted">
                  Forced into Observe — {status.forcedObserve.reason} · {status.forcedObserve.actor}
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
