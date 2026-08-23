import { Warning } from "@phosphor-icons/react";
import type {
  EngineStatus,
  GasWalletStatus,
  OperationReadiness,
} from "@stx-labs/signer-sidekick-api-contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { activityHash, settingsHash } from "../../dashboard-route.js";
import { Badge, ErrorCallout } from "../../shared/dashboard-ui.js";
import { operatorActionError } from "../../shared/operator-error.js";
import {
  disableEngineAdapter,
  forceEngineObserve,
  loadEngineStatus,
  loadOperationReadiness,
} from "../operations/engine-api.js";
import { GasWalletSettings } from "./gas-wallet-settings.js";
import { SettingsRow, SettingsSectionTitle } from "./settings-ui.js";

type EngineControlAction = "force-observe" | `disable:${string}`;

const operationChips = [
  ["pox5-calculate-rewards", "calculate"],
  ["reference-manager-claim-rewards", "collect"],
  ["reference-manager-claim-staker-rewards", "distribute"],
  ["reference-manager-settle-accepted-withdrawal", "settle"],
  ["reference-manager-reclaim-failed-withdrawal", "reclaim"],
] as const;

function readinessReview(
  check: OperationReadiness["checks"][number],
): { href: string; label: string } | null {
  if (check.status === "ready") return null;
  if (check.id === "manager" || check.id === "signer" || check.id === "setup") {
    return { href: settingsHash("attachment"), label: "Review manager" };
  }
  if (check.id === "control-plane") {
    return { href: settingsHash("sources"), label: "Review connections" };
  }
  return null;
}

function adapterTone(availability: EngineStatus["adapters"][number]["availability"]) {
  if (availability === "available") return "success" as const;
  if (availability === "disabled") return "error" as const;
  return "caution" as const;
}

export function EngineSettings({
  onGasWalletStatus,
  onStatus,
  readOnly,
  token,
}: {
  onGasWalletStatus?: (status: GasWalletStatus | null) => void;
  onStatus?: (status: EngineStatus | null) => void;
  readOnly: boolean;
  token: string;
}) {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [readiness, setReadiness] = useState<OperationReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<EngineControlAction | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
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
      onStatus?.(nextStatus);
      setReadiness(nextReadiness);
      setUnavailable(nextStatus === null);
    } catch (cause) {
      if (request.signal.aborted) return;
      setError(
        operatorActionError(cause, "Could not load reward-run controls", "Retrying is safe"),
      );
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }, [onStatus, token]);

  useEffect(() => {
    void load();
    return () => controller.current?.abort();
  }, [load]);

  const forceObserve = async () => {
    if (!status || action || readOnly) return;
    if (
      !window.confirm(
        "Force the transaction engine into Observe mode? New signing and broadcasts will stop while result verification continues.",
      )
    )
      return;
    setAction("force-observe");
    setError(null);
    try {
      const result = await forceEngineObserve(token, {
        decision: "force-observe",
        reason: "Operator confirmed emergency force-Observe from Settings",
      });
      setStatus(result.status);
      onStatus?.(result.status);
    } catch (cause) {
      setError(
        operatorActionError(
          cause,
          "Could not confirm Force Observe",
          "Refresh before trying again; Observe mode may already be active",
        ),
      );
    } finally {
      setAction(null);
    }
  };

  const disableAdapter = async (adapterId: string) => {
    if (!status || action || readOnly) return;
    if (
      !window.confirm(
        `Disable ${adapterId}? New jobs and broadcasts for this adapter will stop while existing attempts remain observable.`,
      )
    )
      return;
    setAction(`disable:${adapterId}`);
    setError(null);
    try {
      const result = await disableEngineAdapter(token, adapterId, {
        decision: "disable",
        reason: "Operator disabled adapter from Settings",
      });
      setStatus(result.status);
      onStatus?.(result.status);
    } catch (cause) {
      setError(
        operatorActionError(
          cause,
          `Could not confirm that ${adapterId} was disabled`,
          "Refresh before trying again; the adapter may already be disabled",
        ),
      );
    } finally {
      setAction(null);
    }
  };

  const blockers = readiness?.checks.filter((check) => check.status !== "ready") ?? [];
  const modeLabel = unavailable
    ? "Unavailable"
    : status?.forcedObserve.active
      ? "Forced Observe"
      : status?.mode === "operator-run"
        ? "Operator-run"
        : "Observe";
  const modeDetail = status
    ? status.forcedObserve.active
      ? `${status.forcedObserve.reason ?? "emergency brake active"}${status.forcedObserve.actor ? ` · ${status.forcedObserve.actor}` : ""}`
      : status.mode === "operator-run"
        ? `${status.jobs.active} runs active · ${status.jobs.awaitingApproval} awaiting approval · ${status.jobs.ambiguous} ambiguous`
        : "set SIDEKICK_ENGINE_MODE=operator-run and restart to run reward calls from here"
    : "engine status unavailable";
  // The five reviewed reward adapters are a closed registry executed by the run engine. The legacy
  // `/api/v1/engine` adapter list knows only the collect adapter (the one with a disable control),
  // so availability comes from the engine mode, with collect honouring its own control.
  const operatorRun = Boolean(
    status && status.mode === "operator-run" && !status.forcedObserve.active,
  );
  const collectAdapter =
    status?.adapters.find((item) => item.adapter.id === "reference-manager-claim-rewards") ?? null;
  const chipState = (id: (typeof operationChips)[number][0]): "ok" | "off" | "" => {
    if (!operatorRun) return "";
    if (id === "reference-manager-claim-rewards" && collectAdapter) {
      return collectAdapter.availability === "available" ? "ok" : "off";
    }
    return "ok";
  };
  const operationStatus = unavailable
    ? "Unavailable"
    : !operatorRun
      ? "Observe only"
      : collectAdapter?.availability === "disabled"
        ? "Collect disabled"
        : collectAdapter?.availability === "blocked"
          ? "Attention"
          : "Available";

  return (
    <>
      <SettingsSectionTitle hint="how Sidekick signs the permissionless reward calls" id="st-runs">
        Reward runs
      </SettingsSectionTitle>
      <section className="card st-card" aria-label="Reward runs">
        <ErrorCallout error={error} />
        <div className="st-rows">
          <SettingsRow
            actions={
              status?.mode === "operator-run" && !status.forcedObserve.active ? (
                <button
                  className="btn btn-tertiary sm"
                  disabled={readOnly || action !== null}
                  onClick={() => void forceObserve()}
                  type="button"
                >
                  {action === "force-observe" ? "Forcing Observe" : "Force Observe"}
                </button>
              ) : null
            }
            detail={modeDetail}
            help="Set by the deployment. Observe never signs; operator-run signs only a sealed recipe you approve with the gas wallet."
            name="Engine mode"
            statusNode={
              <Badge
                state={
                  status?.forcedObserve.active
                    ? "error"
                    : status?.mode === "operator-run"
                      ? "accent"
                      : "neutral"
                }
              >
                {loading && !status ? "Loading" : modeLabel}
              </Badge>
            }
            value={<span className="mono">{modeLabel}</span>}
          />
        </div>
        <GasWalletSettings
          {...(onGasWalletStatus ? { onStatus: onGasWalletStatus } : {})}
          token={token}
          readOnly={readOnly}
        />
        <div className="st-rows">
          <SettingsRow
            actions={
              <>
                {status?.adapters.length ? (
                  <button
                    aria-expanded={manageOpen}
                    className="btn btn-tertiary sm"
                    onClick={() => setManageOpen((value) => !value)}
                    type="button"
                  >
                    {manageOpen ? "Close" : "Manage"}
                  </button>
                ) : null}
                <a className="btn btn-tertiary sm" href={activityHash(null, "type=actions")}>
                  Activity
                </a>
              </>
            }
            help="Five reviewed reward adapters, each with one explicit signer method and no generic signing path. Force Observe stops all of them; collect also has its own disable control."
            name="Operations"
            status={operationStatus}
            value={
              <span className="st-chips">
                {operationChips.map(([id, label]) => (
                  <span className={`st-chip ${chipState(id)}`} key={id}>
                    {label}
                  </span>
                ))}
              </span>
            }
          >
            {blockers.length ? (
              <div className="st-operation-blockers">
                {blockers.map((check) => {
                  const review = readinessReview(check);
                  return (
                    <div key={check.id}>
                      <span>{check.detail}</span>
                      {review ? <a href={review.href}>{review.label}</a> : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
            {manageOpen && status?.adapters.length ? (
              <div className="st-manage-adapters">
                {status.adapters.map((adapter) => (
                  <div className="st-manage-adapter" key={adapter.adapter.id}>
                    <span>
                      <strong>{adapter.label}</strong>
                      <small className="mono">{adapter.adapter.id}</small>
                    </span>
                    <Badge state={adapterTone(adapter.availability)}>{adapter.availability}</Badge>
                    {adapter.enabled ? (
                      <button
                        className="btn btn-tertiary sm"
                        disabled={readOnly || action !== null}
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
          </SettingsRow>
        </div>
      </section>
    </>
  );
}
