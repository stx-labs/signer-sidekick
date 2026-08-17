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
  readOnly,
  refreshRevision,
  token,
}: {
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
        if (controller.current === nextController) setRequirements(result);
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
    [token],
  );

  useEffect(() => {
    void load(refreshRevision > 0);
    return () => controller.current?.abort();
  }, [load, refreshRevision]);

  const incomplete = requirements?.checks.filter(({ status }) => status !== "pass").length ?? 0;
  const incompleteChecks = requirements?.checks.filter(({ status }) => status !== "pass") ?? [];
  const passingChecks = requirements?.checks.filter(({ status }) => status === "pass") ?? [];
  return (
    <section className="card-standout set-section deployment-requirements" id="requirements">
      <div className="card-head">
        <div>
          <span className="eyebrow">Read-only deployment assessment</span>
          <h2>Node &amp; signer requirements</h2>
        </div>
        <div className="settings-inline-actions">
          {requirements ? (
            <StatusBadge
              status={
                requirements.status === "ready"
                  ? "Ready"
                  : requirements.status === "blocked"
                    ? "Blocked"
                    : "Attention"
              }
            />
          ) : null}
          <button
            className="btn btn-secondary sm"
            disabled={loading || readOnly}
            onClick={() => void load(true)}
            type="button"
          >
            <ArrowClockwise /> {loading ? "Checking" : "Refresh checks"}
          </button>
        </div>
      </div>
      <p className="muted">
        Sidekick tests the live endpoints and required Stacks Core features. It reports exact
        remediation, but never edits configuration or restarts the node or signer.
      </p>
      <ErrorCallout error={error} />
      {requirements ? (
        <>
          <div
            className={`callout ${requirements.requiredReady ? "callout-info" : "callout-caution"}`}
            role="status"
          >
            <div className="body">
              <strong>
                {requirements.requiredReady
                  ? "Required features are ready."
                  : "A required feature needs attention."}
              </strong>{" "}
              {incomplete === 0
                ? "Recommended monitoring and observer checks are also ready."
                : `${incomplete} ${incomplete === 1 ? "check needs" : "checks need"} review.`}
            </div>
          </div>
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
                {passingChecks.length} successful {passingChecks.length === 1 ? "check" : "checks"}
              </summary>
              <div className="deployment-requirement-list">
                {passingChecks.map((check) => (
                  <RequirementCard check={check} key={check.id} />
                ))}
              </div>
            </details>
          ) : null}
          <p className="help">
            Last checked {new Date(requirements.checkedAt).toLocaleString()}. Required failures
            block only the features that need them; recommended checks improve diagnosis and
            event-driven freshness.
          </p>
        </>
      ) : loading ? (
        <div className="loading-state">Checking deployment requirements</div>
      ) : null}
    </section>
  );
}
