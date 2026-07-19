import { ArrowClockwise, Eye, ShieldWarning, Warning } from "@phosphor-icons/react";
import type {
  EngineApprovalRequest,
  EngineJobDetail,
  EngineJobPage,
  EngineStatus,
} from "@stx-labs/signer-sidekick-api-contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError } from "../../api-client.js";
import { Badge, ErrorCallout } from "../../shared/dashboard-ui.js";
import { operatorActionError, operatorErrorDetail } from "../../shared/operator-error.js";
import {
  approveEngineJob,
  disableEngineAdapter,
  forceEngineObserve,
  invalidateEngineApproval,
  loadEngineJob,
  loadEngineJobs,
  loadEngineStatus,
} from "./engine-api.js";
import { EngineJobReview } from "./engine-job-review.js";
import { EngineWalletClaim } from "./engine-wallet-claim.js";
import { engineJobBadgeState } from "./job-state.js";

type SurfaceState = "loading" | "ready" | "unavailable" | "error";
type EngineAction = "approve" | "invalidate" | "force-observe" | `disable:${string}`;

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "";
  if (error instanceof ApiRequestError && error.kind === "authentication") {
    return "The operator credential was rejected. Approval controls were invalidated.";
  }
  return operatorErrorDetail(error, "Sidekick returned no error detail");
}

function engineActionError(error: unknown, summary: string, recovery: string): string {
  const cause =
    error instanceof ApiRequestError && error.kind === "http" ? error : errorMessage(error);
  return operatorActionError(cause, summary, recovery);
}

function stateLabel(value: string): string {
  return value.replaceAll("_", " ").replaceAll("-", " ");
}

function updateJobPage(page: EngineJobPage, job: EngineJobDetail): EngineJobPage {
  return {
    ...page,
    items: page.items.map((item) =>
      item.jobId === job.jobId
        ? {
            ...item,
            state: job.state,
            blockReason: job.blockReason,
            approvalState: job.approval
              ? job.approval.invalidatedAt
                ? "invalidated"
                : "approved"
              : job.approvalWindow.eligible
                ? "awaiting"
                : "not-required",
            updatedAt: job.updatedAt,
          }
        : item,
    ),
  };
}

export function EngineOperations({
  chainId,
  network,
  token,
}: {
  chainId: number;
  network: string;
  token: string;
}) {
  const [surface, setSurface] = useState<SurfaceState>("loading");
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [jobs, setJobs] = useState<EngineJobPage | null>(null);
  const [selectedJob, setSelectedJob] = useState<EngineJobDetail | null>(null);
  const [actionsEnabled, setActionsEnabled] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [previousCursors, setPreviousCursors] = useState<Array<string | null>>([]);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<EngineAction | null>(null);
  const loadController = useRef<AbortController | null>(null);
  const detailController = useRef<AbortController | null>(null);
  const approvalPromise = useRef<Promise<void> | null>(null);

  const invalidateActions = useCallback(() => {
    detailController.current?.abort();
    setActionsEnabled(false);
    setSelectedJob(null);
  }, []);

  const loadSurface = useCallback(
    async (pageCursor: string | null) => {
      loadController.current?.abort();
      const controller = new AbortController();
      loadController.current = controller;
      invalidateActions();
      setError(null);
      setSurface("loading");
      try {
        const nextStatus = await loadEngineStatus(token, controller.signal);
        if (nextStatus === null) {
          setStatus(null);
          setJobs(null);
          setSurface("unavailable");
          return;
        }
        const nextJobs = await loadEngineJobs(token, pageCursor, controller.signal);
        setStatus(nextStatus);
        setJobs(nextJobs);
        setSurface("ready");
      } catch (cause) {
        if (controller.signal.aborted) return;
        setStatus(null);
        setJobs(null);
        setError(
          engineActionError(
            cause,
            "Could not load transaction engine status and jobs",
            "Retrying is safe",
          ),
        );
        setSurface("error");
      }
    },
    [invalidateActions, token],
  );

  useEffect(() => {
    void loadSurface(cursor);
    return () => {
      loadController.current?.abort();
      detailController.current?.abort();
    };
  }, [cursor, loadSurface]);

  const selectJob = async (jobId: string) => {
    invalidateActions();
    const controller = new AbortController();
    detailController.current = controller;
    setError(null);
    try {
      const job = await loadEngineJob(token, jobId, controller.signal);
      if (controller.signal.aborted) return;
      setSelectedJob(job);
      setActionsEnabled(true);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setSelectedJob(null);
      setError(
        engineActionError(cause, `Could not load transaction job ${jobId}`, "Retrying is safe"),
      );
    }
  };

  const approve = () => {
    if (approvalPromise.current || !actionsEnabled || !selectedJob) return;
    const expiresAt = selectedJob.approvalWindow.expiresAt;
    if (!expiresAt) return;
    const jobId = selectedJob.jobId;
    const request: EngineApprovalRequest = {
      decision: "approve",
      intentSha256: selectedJob.review.hashes.intentSha256,
      policySha256: selectedJob.review.hashes.policySha256,
      expiresAt,
    };
    setAction("approve");
    setActionsEnabled(false);
    setError(null);
    const pending = approveEngineJob(token, jobId, request)
      .then((result) => {
        setSelectedJob(result.job);
        setJobs((current) => (current ? updateJobPage(current, result.job) : current));
        setActionsEnabled(true);
      })
      .catch((cause) => {
        invalidateActions();
        setError(
          engineActionError(
            cause,
            `Could not confirm approval for job ${jobId}`,
            "Refresh the job before approving again; the approval may already be recorded",
          ),
        );
      })
      .finally(() => {
        setAction(null);
        approvalPromise.current = null;
      });
    approvalPromise.current = pending;
  };

  const invalidateApproval = async () => {
    if (!actionsEnabled || !selectedJob?.approval || action) return;
    if (!window.confirm("Invalidate this exact approval? It cannot be restored.")) return;
    const jobId = selectedJob.jobId;
    setAction("invalidate");
    setActionsEnabled(false);
    setError(null);
    try {
      const result = await invalidateEngineApproval(token, jobId, {
        decision: "invalidate",
        reason: "Operator invalidated approval from the dashboard",
      });
      setSelectedJob(result.job);
      setJobs((current) => (current ? updateJobPage(current, result.job) : current));
      setActionsEnabled(true);
    } catch (cause) {
      invalidateActions();
      setError(
        engineActionError(
          cause,
          `Could not confirm approval invalidation for job ${jobId}`,
          "Refresh the job before trying again; the approval may already be invalidated",
        ),
      );
    } finally {
      setAction(null);
    }
  };

  const forceObserve = async () => {
    if (!status || action) return;
    if (
      !window.confirm(
        "Force the transaction engine into Observe mode? New signing and broadcasts will stop while result verification continues.",
      )
    ) {
      return;
    }
    invalidateActions();
    setAction("force-observe");
    setError(null);
    try {
      const result = await forceEngineObserve(token, {
        decision: "force-observe",
        reason: "Operator confirmed emergency force-Observe from the dashboard",
      });
      setStatus(result.status);
      setSurface("ready");
      try {
        setJobs(await loadEngineJobs(token, cursor));
      } catch (cause) {
        setError(
          engineActionError(
            cause,
            "Force Observe succeeded, but transaction jobs could not be refreshed",
            "Observe mode is active; retry the engine refresh",
          ),
        );
      }
    } catch (cause) {
      setError(
        engineActionError(
          cause,
          "Could not confirm Force Observe",
          "Refresh engine status before trying again; Observe mode may already be active",
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
    invalidateActions();
    setAction(`disable:${adapterId}`);
    setError(null);
    try {
      const result = await disableEngineAdapter(token, adapterId, {
        decision: "disable",
        reason: "Operator disabled adapter from the dashboard",
      });
      setStatus(result.status);
      setSurface("ready");
      try {
        setJobs(await loadEngineJobs(token, cursor));
      } catch (cause) {
        setError(
          engineActionError(
            cause,
            `${adapterId} was disabled, but transaction jobs could not be refreshed`,
            "The adapter is disabled; retry the engine refresh",
          ),
        );
      }
    } catch (cause) {
      setError(
        engineActionError(
          cause,
          `Could not confirm that ${adapterId} was disabled`,
          "Refresh engine status before trying again; the adapter may already be disabled",
        ),
      );
    } finally {
      setAction(null);
    }
  };

  if (surface === "unavailable") {
    return (
      <section className="card engine-unavailable" aria-label="Transaction engine">
        <div className="card-head">
          <h2>Transaction engine</h2>
          <Badge state="neutral">Unavailable</Badge>
        </div>
        <p className="muted">
          Transaction execution is unavailable. Monitoring, chain data, and alerts remain available.
        </p>
      </section>
    );
  }

  return (
    <section className="engine-operations" aria-label="Transaction engine">
      <div className="card-head engine-surface-head">
        <div>
          <span className="eyebrow">Transaction engine</span>
          <h2>Transaction jobs</h2>
        </div>
        <button
          type="button"
          className="btn btn-tertiary"
          disabled={surface === "loading" || action !== null}
          onClick={() => void loadSurface(cursor)}
        >
          <ArrowClockwise className={surface === "loading" ? "spin" : ""} /> Refresh engine
        </button>
      </div>
      <ErrorCallout error={error} />

      {surface === "loading" && !status ? (
        <div className="loading-state">Loading transaction engine</div>
      ) : null}

      {status ? (
        <>
          <div className="engine-status-grid">
            <div className="card-standout engine-mode-card">
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
                  type="button"
                  className="btn btn-secondary"
                  disabled={status.mode === "observe" || action !== null}
                  onClick={() => void forceObserve()}
                >
                  <ShieldWarning />
                  {action === "force-observe" ? "Forcing Observe" : "Force Observe"}
                </button>
              )}
            </div>
          </div>

          <div className="card engine-adapters">
            <div className="card-head">
              <h3>Adapters</h3>
              <span className="muted">Individually reviewed and enabled</span>
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
                    type="button"
                    className="btn btn-tertiary"
                    disabled={action !== null}
                    onClick={() => void disableAdapter(adapter.adapter.id)}
                  >
                    <Warning />
                    {action === `disable:${adapter.adapter.id}` ? "Disabling" : "Disable adapter"}
                  </button>
                ) : null}
              </div>
            ))}
          </div>

          <div className="engine-workspace">
            <div className="card engine-job-list">
              <div className="card-head">
                <h3>Transaction jobs</h3>
                <span className="muted">{jobs?.total ?? 0} total</span>
              </div>
              {jobs?.items.map((job) => (
                <button
                  type="button"
                  className="engine-job-row"
                  aria-pressed={selectedJob?.jobId === job.jobId}
                  key={job.jobId}
                  onClick={() => void selectJob(job.jobId)}
                >
                  <span>
                    <strong>{job.functionName}</strong>
                    <small className="mono">
                      {job.adapter.id} r{job.adapter.revision} · cycle {job.rewardCycle}
                    </small>
                  </span>
                  <span>
                    <Badge state={engineJobBadgeState(job.state)}>{stateLabel(job.state)}</Badge>
                    <small>{stateLabel(job.approvalState)}</small>
                  </span>
                </button>
              ))}
              {jobs?.items.length === 0 ? <p className="muted">No transaction jobs yet.</p> : null}
              {jobs ? (
                <div className="pagination engine-pagination">
                  <button
                    type="button"
                    className="btn btn-tertiary"
                    disabled={previousCursors.length === 0 || surface === "loading"}
                    onClick={() => {
                      const history = previousCursors.slice();
                      const previous = history.pop() ?? null;
                      setPreviousCursors(history);
                      setCursor(previous);
                    }}
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    className="btn btn-tertiary"
                    disabled={!jobs.nextCursor || surface === "loading"}
                    onClick={() => {
                      if (!jobs.nextCursor) return;
                      setPreviousCursors((history) => [...history, cursor]);
                      setCursor(jobs.nextCursor);
                    }}
                  >
                    Next
                  </button>
                </div>
              ) : null}
            </div>

            <div className="card engine-detail-host">
              {selectedJob ? (
                <>
                  <EngineJobReview
                    job={selectedJob}
                    actionsEnabled={actionsEnabled}
                    action={action === "approve" || action === "invalidate" ? action : null}
                    onApprove={approve}
                    onInvalidate={() => void invalidateApproval()}
                  />
                  {status ? (
                    <EngineWalletClaim
                      chainId={chainId}
                      job={selectedJob}
                      network={network}
                      status={status}
                      token={token}
                    />
                  ) : null}
                </>
              ) : (
                <div className="engine-empty-detail">
                  <ShieldWarning />
                  <h3>Select a transaction job</h3>
                  <p className="muted">
                    Sidekick validates the current details before showing approval controls.
                    Refreshing or signing out clears them.
                  </p>
                </div>
              )}
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
