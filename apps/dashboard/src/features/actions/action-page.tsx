import { ArrowClockwise, ArrowLeft, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import type {
  DashboardSnapshot,
  EngineApprovalRequest,
  EngineJobDetail,
  EngineStatus,
  OperatorOperationCode,
} from "@stx-labs/signer-sidekick-api-contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CopyableIdentifier } from "../../copyable-identifier.js";
import {
  type ActionContext,
  activityHash,
  dashboardHash,
  isManagerActionId,
} from "../../dashboard-route.js";
import { ErrorCallout, Field, PageHead, StatLine } from "../../shared/dashboard-ui.js";
import { managerActionAvailability } from "../../shared/manager-action-availability.js";
import { operatorActionError, operatorErrorDetail } from "../../shared/operator-error.js";
import { standardManagerActionPrincipal } from "../manager/manager-action-principal.js";
import {
  ManagerActionWorkspace,
  managerActionCopy,
  managerCapabilityIdForAction,
} from "../manager/manager-page.js";
import { BrowserWalletActionPanel } from "../operations/browser-wallet-action.js";
import {
  approveEngineJob,
  invalidateEngineApproval,
  loadEngineJob,
  loadEngineStatus,
} from "../operations/engine-api.js";
import { EngineJobReview } from "../operations/engine-job-review.js";
import { EngineWalletClaim } from "../operations/engine-wallet-claim.js";
import { rewardManagerCapabilityId } from "../rewards/reward-action-capabilities.js";

type Snapshot = DashboardSnapshot;

const operationCopy: Record<
  OperatorOperationCode,
  { title: string; detail: string; returnPage: "settings" | "rewards" }
> = {
  "register-self": { ...managerActionCopy["register-self"], returnPage: "settings" },
  "add-admin": { ...managerActionCopy["add-admin"], returnPage: "settings" },
  "remove-admin": { ...managerActionCopy["remove-admin"], returnPage: "settings" },
  "update-fees": { ...managerActionCopy["update-fees"], returnPage: "rewards" },
  "withdraw-fees": { ...managerActionCopy["withdraw-fees"], returnPage: "rewards" },
  "sweep-fee-refunds": {
    ...managerActionCopy["sweep-fee-refunds"],
    returnPage: "rewards",
  },
  "claim-rewards": {
    title: "Claim manager rewards",
    detail: "Review and execute one previously prepared manager reward claim.",
    returnPage: "rewards",
  },
  "claim-staker-rewards": {
    title: "Settle staker reward",
    detail: "Review and settle one exact staker, cycle, and reward bucket.",
    returnPage: "rewards",
  },
  "calculate-rewards": {
    title: "Calculate PoX-5 rewards",
    detail: "Review the current permissionless reward-calculation checkpoint.",
    returnPage: "rewards",
  },
};

function ActionBack({ operation }: { operation: OperatorOperationCode }) {
  const fallback = operationCopy[operation].returnPage;
  return (
    <a className="activity-back action-back" href={dashboardHash(fallback)}>
      <ArrowLeft /> Return to {fallback === "settings" ? "Settings" : "Rewards"}
    </a>
  );
}

function UnavailableAction({ reason }: { reason: string }) {
  return (
    <div className="callout callout-caution" role="status">
      <WarningCircle className="ic" />
      <div className="body">
        <strong>This operation is not currently available.</strong>
        <br />
        {reason}
        <div className="actions">
          <a className="btn btn-secondary sm" href={dashboardHash("settings")}>
            Review capabilities
          </a>
        </div>
      </div>
    </div>
  );
}

function ManagerOperation({
  data,
  operation,
  operatorStateStale,
  onOperatorStateChanged,
  onRefreshStatus,
  refreshingStatus,
  token,
}: {
  data: Snapshot;
  operation: Extract<OperatorOperationCode, keyof typeof managerActionCopy>;
  operatorStateStale: boolean;
  onOperatorStateChanged: () => void | Promise<void>;
  onRefreshStatus: () => void | Promise<void>;
  refreshingStatus: boolean;
  token: string;
}) {
  const availability = managerActionAvailability(
    data,
    managerCapabilityIdForAction(operation),
    operatorStateStale,
  );
  const currentCycle = data.preflight.cycle.currentId;
  const establishedSignerParticipation = Boolean(
    data.registration?.registered ||
      data.forecast?.cycles.some(
        (cycle) =>
          (cycle.cycleId === currentCycle || cycle.cycleId === currentCycle + 1) &&
          cycle.contract.inSignerSet,
      ),
  );
  const repairUnavailable = operation === "register-self" && !establishedSignerParticipation;
  if (!availability.available || repairUnavailable) {
    return (
      <>
        <UnavailableAction
          reason={
            repairUnavailable
              ? "Signer registration is available here only for an established signer repair or key rotation. Use Zero to Signing for first-time setup."
              : availability.reason
          }
        />
        {(operatorStateStale || data.freshness?.status === "stale") && (
          <button
            className="btn btn-secondary action-recheck"
            disabled={refreshingStatus}
            onClick={() => void onRefreshStatus()}
            type="button"
          >
            <ArrowClockwise className={refreshingStatus ? "spin" : ""} />
            {refreshingStatus ? "Refreshing operation evidence" : "Refresh operation evidence"}
          </button>
        )}
      </>
    );
  }
  return (
    <>
      {availability.warning ? (
        <div className="callout callout-caution" role="status">
          <WarningCircle className="ic" />
          <div className="body">{availability.warning}</div>
        </div>
      ) : null}
      <ManagerActionWorkspace
        action={operation}
        closeHref={dashboardHash(operationCopy[operation].returnPage)}
        data={data}
        onOperatorStateChanged={onOperatorStateChanged}
        showHeading={false}
        token={token}
      />
    </>
  );
}

function EngineClaimOperation({
  chainId,
  context,
  network,
  token,
}: {
  chainId: number;
  context: ActionContext;
  network: string;
  token: string;
}) {
  const jobId = context.kind === "engine-job" ? context.jobId : null;
  const [job, setJob] = useState<EngineJobDetail | null>(null);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [loading, setLoading] = useState(jobId !== null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<"approve" | "invalidate" | null>(null);
  const [revision, setRevision] = useState(0);
  const actionPending = useRef(false);

  const load = useCallback(async () => {
    if (!jobId) return;
    setLoading(true);
    setError(null);
    try {
      const [nextJob, nextStatus] = await Promise.all([
        loadEngineJob(token, jobId),
        loadEngineStatus(token),
      ]);
      if (!nextStatus) throw new Error("The transaction engine is unavailable.");
      if (
        nextJob.review.call.functionName !== "claim-rewards" ||
        nextJob.review.adapter.id !== "reference-manager-claim-rewards"
      ) {
        throw new Error("The selected job is not a reviewed manager reward claim.");
      }
      setJob(nextJob);
      setStatus(nextStatus);
    } catch (cause) {
      setJob(null);
      setStatus(null);
      setError(operatorErrorDetail(cause, "Sidekick returned no engine job error detail"));
    } finally {
      setLoading(false);
    }
  }, [jobId, token]);

  useEffect(() => {
    void revision;
    void load();
  }, [load, revision]);

  const approve = async () => {
    if (!job?.approvalWindow.expiresAt || action !== null || actionPending.current) return;
    const request: EngineApprovalRequest = {
      decision: "approve",
      intentSha256: job.review.hashes.intentSha256,
      policySha256: job.review.hashes.policySha256,
      expiresAt: job.approvalWindow.expiresAt,
    };
    actionPending.current = true;
    setAction("approve");
    setError(null);
    try {
      setJob((await approveEngineJob(token, job.jobId, request)).job);
    } catch (cause) {
      setError(
        operatorActionError(
          cause,
          "Could not confirm transaction approval",
          "Refresh the exact job before approving again",
        ),
      );
    } finally {
      actionPending.current = false;
      setAction(null);
    }
  };

  const invalidate = async () => {
    if (!job?.approval || action !== null || actionPending.current) return;
    if (!window.confirm("Invalidate this exact approval? It cannot be restored.")) return;
    actionPending.current = true;
    setAction("invalidate");
    setError(null);
    try {
      setJob(
        (
          await invalidateEngineApproval(token, job.jobId, {
            decision: "invalidate",
            reason: "Operator invalidated approval from the action workspace",
          })
        ).job,
      );
    } catch (cause) {
      setError(
        operatorActionError(
          cause,
          "Could not confirm approval invalidation",
          "Refresh the exact job before trying again",
        ),
      );
    } finally {
      actionPending.current = false;
      setAction(null);
    }
  };

  if (!jobId) {
    return (
      <UnavailableAction reason="Open the exact active reward claim from Activity so Sidekick can bind this workspace to its reviewed engine job." />
    );
  }
  if (loading && !job) return <div className="loading-state">Loading transaction review</div>;
  if (!job || !status) {
    return (
      <>
        <ErrorCallout error={error} />
        <button
          className="btn btn-secondary"
          onClick={() => setRevision((value) => value + 1)}
          type="button"
        >
          <ArrowClockwise /> Retry transaction review
        </button>
      </>
    );
  }
  return (
    <section className="card-standout action-engine-review">
      <ErrorCallout error={error} />
      <EngineJobReview
        action={action}
        actionsEnabled={!loading && action === null}
        job={job}
        onApprove={() => void approve()}
        onInvalidate={() => void invalidate()}
      />
      <EngineWalletClaim
        chainId={chainId}
        job={job}
        network={network}
        status={status}
        token={token}
      />
      <button
        className="btn btn-tertiary sm action-recheck"
        disabled={loading || action !== null}
        onClick={() => setRevision((value) => value + 1)}
        type="button"
      >
        <ArrowClockwise className={loading ? "spin" : ""} /> Refresh exact job
      </button>
    </section>
  );
}

function StakerRewardOperation({
  context,
  data,
  operatorStateStale,
  onOperatorStateChanged,
  token,
}: {
  context: ActionContext;
  data: Snapshot;
  operatorStateStale: boolean;
  onOperatorStateChanged: () => void | Promise<void>;
  token: string;
}) {
  const [actorPrincipal, setActorPrincipal] = useState("");
  const actor = actorPrincipal.trim().toUpperCase();
  const actorValid = standardManagerActionPrincipal(actor, data.network);
  const availability = managerActionAvailability(
    data,
    rewardManagerCapabilityId("claim-staker-rewards"),
    operatorStateStale,
  );
  const request = useMemo(
    () =>
      context.kind === "staker-reward" && actorValid
        ? {
            action: "claim-staker-rewards" as const,
            actorPrincipal: actor,
            stakerPrincipal: context.stakerPrincipal,
            rewardCycle: context.rewardCycle,
            bondIndex: context.bondIndex,
          }
        : null,
    [actor, actorValid, context],
  );
  if (!availability.available) return <UnavailableAction reason={availability.reason} />;
  if (context.kind !== "staker-reward") {
    return (
      <UnavailableAction reason="Select one exact staker settlement from Rewards before opening the transaction workspace." />
    );
  }
  return (
    <section className="card-standout action-staker-reward">
      <div className="card-head">
        <div>
          <span className="eyebrow">EXACT SETTLEMENT</span>
          <h2>Review staker reward inputs</h2>
        </div>
      </div>
      <StatLine label="Staker">
        <CopyableIdentifier value={context.stakerPrincipal} label="staker principal" />
      </StatLine>
      <StatLine label="Reward cycle">{context.rewardCycle}</StatLine>
      <StatLine label="Reward bucket">
        {context.bondIndex === null ? "STX-only" : `Bitcoin bond ${context.bondIndex}`}
      </StatLine>
      <p className="muted">
        One transaction settles this tuple. The call pays the named staker, and the sealed review
        pins the manager's exact sBTC outflow before the wallet opens.
      </p>
      <Field
        label="Signing account"
        help="This permissionless caller pays the transaction fee; manager-admin authority is not required."
      >
        <input
          autoComplete="off"
          className="input mono"
          placeholder={data.network === "mainnet" ? "SP…" : "ST…"}
          value={actorPrincipal}
          onChange={(event) => setActorPrincipal(event.target.value.toUpperCase())}
        />
        {actorPrincipal && !actorValid ? (
          <span className="field-error">Enter a valid Stacks account principal.</span>
        ) : null}
      </Field>
      {request ? (
        <BrowserWalletActionPanel
          chainId={data.preflight.node.networkId}
          createRequest={request}
          managerPrincipal={data.managerPrincipal}
          network={data.network}
          onVerified={onOperatorStateChanged}
          token={token}
        />
      ) : (
        <div className="callout callout-neutral" role="status">
          <ShieldCheck className="ic" />
          <div className="body">
            Enter the public signing account to request a fresh anchored transaction review.
          </div>
        </div>
      )}
    </section>
  );
}

function CalculateRewardsOperation({
  data,
  operatorStateStale,
  onOperatorStateChanged,
  token,
}: {
  data: Snapshot;
  operatorStateStale: boolean;
  onOperatorStateChanged: () => void | Promise<void>;
  token: string;
}) {
  const [actorPrincipal, setActorPrincipal] = useState("");
  const actor = actorPrincipal.trim().toUpperCase();
  const actorValid = standardManagerActionPrincipal(actor, data.network);
  const calculation = data.rewardOutlook?.calculation ?? data.rewards?.calculation ?? null;
  const pox5ContractId = data.preflight.pox.pox5ContractId;
  if (operatorStateStale) {
    return (
      <UnavailableAction reason="Reward-calculation evidence is stale. Refresh status before preparing a transaction." />
    );
  }
  if (!pox5ContractId || data.preflight.compatibility.status !== "matched") {
    return (
      <UnavailableAction reason="The active PoX-5 source must match an installed reviewed network profile before Sidekick can prepare this transaction." />
    );
  }
  if (calculation?.state !== "pending") {
    return (
      <UnavailableAction reason="The current PoX-5 reward-calculation checkpoint is not pending." />
    );
  }
  const request = actorValid
    ? { action: "calculate-rewards" as const, actorPrincipal: actor }
    : null;
  return (
    <section className="card-standout action-calculate-rewards">
      <div className="card-head">
        <div>
          <span className="eyebrow">PERMISSIONLESS CHECKPOINT</span>
          <h2>Review reward-calculation inputs</h2>
        </div>
      </div>
      <StatLine label="Reward cycle">{calculation.targetRewardCycle ?? "—"}</StatLine>
      <StatLine label="Checkpoint">{calculation.targetCheckpoint ?? "—"}</StatLine>
      <StatLine label="Calculation Bitcoin block">
        {calculation.expectedLastRewardComputeBurnHeight ?? "—"}
      </StatLine>
      <p className="muted">
        Sidekick re-reads the complete ordered active-bond list and accrued global rewards at one
        node anchor before sealing the wallet request. Any standard account may pay the fee.
      </p>
      <Field
        label="Signing account"
        help="This permissionless caller pays only the transaction fee; manager-admin authority is not required."
      >
        <input
          autoComplete="off"
          className="input mono"
          placeholder={data.network === "mainnet" ? "SP…" : "ST…"}
          value={actorPrincipal}
          onChange={(event) => setActorPrincipal(event.target.value.toUpperCase())}
        />
        {actorPrincipal && !actorValid ? (
          <span className="field-error">Enter a valid Stacks account principal.</span>
        ) : null}
      </Field>
      {request ? (
        <BrowserWalletActionPanel
          chainId={data.preflight.node.networkId}
          createRequest={request}
          managerPrincipal={pox5ContractId}
          network={data.network}
          onVerified={onOperatorStateChanged}
          token={token}
        />
      ) : (
        <div className="callout callout-neutral" role="status">
          <ShieldCheck className="ic" />
          <div className="body">
            Enter the public signing account to request a fresh anchored transaction review.
          </div>
        </div>
      )}
    </section>
  );
}

export function ActionPage({
  context,
  data,
  operation,
  operatorStateStale,
  onOperatorStateChanged,
  onRefreshStatus,
  refreshingStatus,
  token,
}: {
  context: ActionContext;
  data: Snapshot;
  operation: OperatorOperationCode;
  operatorStateStale: boolean;
  onOperatorStateChanged: () => void | Promise<void>;
  onRefreshStatus: () => void | Promise<void>;
  refreshingStatus: boolean;
  token: string;
}) {
  const copy = operationCopy[operation];
  return (
    <>
      <ActionBack operation={operation} />
      <PageHead title={copy.title} lede={copy.detail} />
      <section className="card action-why">
        <div>
          <span className="eyebrow">WHY THIS ACTION</span>
          <h2>Sidekick will revalidate current evidence before creating anything</h2>
          <p className="muted">
            Opening this workspace is read-only. A sealed transaction intent is created only after
            you supply the required public inputs and select Review transaction.
          </p>
        </div>
        <a
          className="btn btn-tertiary sm"
          href={activityHash(
            null,
            `domain=${isManagerActionId(operation) ? "manager" : "rewards"}`,
          )}
        >
          View related Activity
        </a>
      </section>
      {isManagerActionId(operation) ? (
        <ManagerOperation
          data={data}
          operation={operation}
          operatorStateStale={operatorStateStale}
          onOperatorStateChanged={onOperatorStateChanged}
          onRefreshStatus={onRefreshStatus}
          refreshingStatus={refreshingStatus}
          token={token}
        />
      ) : operation === "claim-rewards" ? (
        <EngineClaimOperation
          chainId={data.preflight.node.networkId}
          context={context}
          network={data.network}
          token={token}
        />
      ) : operation === "claim-staker-rewards" ? (
        <StakerRewardOperation
          context={context}
          data={data}
          operatorStateStale={operatorStateStale}
          onOperatorStateChanged={onOperatorStateChanged}
          token={token}
        />
      ) : operation === "calculate-rewards" ? (
        <CalculateRewardsOperation
          data={data}
          operatorStateStale={operatorStateStale}
          onOperatorStateChanged={onOperatorStateChanged}
          token={token}
        />
      ) : (
        <UnavailableAction reason="Sidekick does not yet have a reviewed execution adapter for this permissionless operation. Review its current checkpoint on Rewards." />
      )}
    </>
  );
}
