import { ArrowClockwise, ArrowSquareOut, CheckCircle, WarningCircle } from "@phosphor-icons/react";
import {
  type DeploymentRequirement,
  type DeploymentRequirements,
  deploymentRequirementsSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiJson } from "../../api-client.js";
import { ErrorCallout, StatusBadge } from "../../shared/dashboard-ui.js";
import { operatorActionError } from "../../shared/operator-error.js";

function statusLabel(status: DeploymentRequirement["status"]): string {
  if (status === "pass") return "Ready";
  if (status === "not-configured") return "Not configured";
  if (status === "unavailable") return "Unavailable";
  return "Attention";
}

function RequirementCard({ check }: { check: DeploymentRequirement }) {
  return (
    <article className={`deployment-requirement requirement-${check.status}`}>
      <div className="deployment-requirement-head">
        <span className="deployment-requirement-icon" aria-hidden="true">
          {check.status === "pass" ? (
            <CheckCircle weight="fill" />
          ) : (
            <WarningCircle weight="fill" />
          )}
        </span>
        <div>
          <div className="deployment-requirement-title">
            <h3>{check.title}</h3>
            <span className="badge b-neutral">{check.importance}</span>
          </div>
          <p>{check.summary}</p>
          {check.observed ? (
            <p className="help mono requirement-observed">{check.observed}</p>
          ) : null}
        </div>
        <StatusBadge status={statusLabel(check.status)} />
      </div>
      {check.remediation ? (
        <details className="deployment-remediation">
          <summary>How to resolve</summary>
          <ol>
            {check.remediation.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {check.remediation.configuration.map((entry) => (
            <div className="deployment-config" key={`${entry.label}-${entry.format}`}>
              <strong>{entry.label}</strong>
              <pre className="code command-code">{entry.content}</pre>
            </div>
          ))}
          {check.remediation.restartServices.length ? (
            <p className="help">
              Restart after changing configuration: {check.remediation.restartServices.join(", ")}.
            </p>
          ) : null}
          {check.remediation.docsUrl ? (
            <a href={check.remediation.docsUrl} target="_blank" rel="noreferrer">
              Full node and signer requirements <ArrowSquareOut aria-hidden="true" />
            </a>
          ) : null}
        </details>
      ) : null}
    </article>
  );
}

export function DeploymentRequirementsPanel({
  onRequirements,
  readOnly,
  refreshRevision,
  token,
}: {
  onRequirements?: (requirements: DeploymentRequirements) => void;
  readOnly: boolean;
  refreshRevision: number;
  token: string;
}) {
  const [requirements, setRequirements] = useState<DeploymentRequirements | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(
    async (force = false) => {
      controller.current?.abort();
      const nextController = new AbortController();
      controller.current = nextController;
      setLoading(true);
      setError(null);
      try {
        const result = await apiJson(
          token,
          force ? "/api/v1/deployment-requirements/refresh" : "/api/v1/deployment-requirements",
          deploymentRequirementsSchema,
          {
            method: force ? "POST" : "GET",
            signal: nextController.signal,
            timeoutMs: 30_000,
          },
        );
        if (controller.current === nextController) {
          setRequirements(result);
          onRequirements?.(result);
        }
      } catch (cause) {
        if (nextController.signal.aborted || controller.current !== nextController) return;
        setError(
          operatorActionError(
            cause,
            "Could not check node and signer requirements",
            "Retrying is safe; this check never changes service configuration",
          ),
        );
      } finally {
        if (controller.current === nextController) {
          controller.current = null;
          setLoading(false);
        }
      }
    },
    [onRequirements, token],
  );

  useEffect(() => {
    void load(refreshRevision > 0);
    return () => controller.current?.abort();
  }, [load, refreshRevision]);

  const connectionCheckIds = new Set([
    "node-rpc",
    "node-metrics",
    "signer-monitoring",
    "hiro-reference",
  ]);
  const runtimeChecks = requirements?.checks.filter(({ id }) => !connectionCheckIds.has(id)) ?? [];
  const incompleteChecks = runtimeChecks.filter(({ status }) => status !== "pass");
  const passingChecks = runtimeChecks.filter(({ status }) => status === "pass");
  return (
    <div className="connection-assessment" id="requirements">
      <div className="connection-assessment-head">
        <div>
          <strong>Runtime requirements</strong>
          <p className="help">
            {requirements
              ? `Last checked ${new Date(requirements.checkedAt).toLocaleString()}`
              : "Transaction indexing and event delivery"}
          </p>
        </div>
        <button
          className="btn btn-secondary sm"
          disabled={loading || readOnly}
          onClick={() => void load(true)}
          type="button"
        >
          <ArrowClockwise /> {loading ? "Checking" : "Refresh checks"}
        </button>
      </div>
      <ErrorCallout error={error} />
      {requirements ? (
        <>
          {incompleteChecks.length ? (
            <div className="deployment-requirement-list">
              {incompleteChecks.map((check) => (
                <RequirementCard check={check} key={check.id} />
              ))}
            </div>
          ) : null}
          {passingChecks.length ? (
            <details className="deployment-passing-checks">
              <summary>
                {passingChecks.length} runtime{" "}
                {passingChecks.length === 1 ? "requirement" : "requirements"} ready
              </summary>
              <div className="deployment-requirement-list">
                {passingChecks.map((check) => (
                  <RequirementCard check={check} key={check.id} />
                ))}
              </div>
            </details>
          ) : null}
        </>
      ) : loading ? (
        <div className="loading-state">Checking runtime requirements</div>
      ) : null}
    </div>
  );
}
