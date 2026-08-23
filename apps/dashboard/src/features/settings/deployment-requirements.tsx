import { ArrowSquareOut } from "@phosphor-icons/react";
import {
  type DeploymentRequirement,
  type DeploymentRequirements,
  deploymentRequirementsSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiJson } from "../../api-client.js";
import { ErrorCallout } from "../../shared/dashboard-ui.js";
import { number, shortUtc } from "../../shared/format.js";
import { operatorActionError } from "../../shared/operator-error.js";
import { SettingsRow, SettingsSectionTitle } from "./settings-ui.js";

function statusLabel(status: DeploymentRequirement["status"]): string {
  if (status === "pass") return "Ready";
  if (status === "not-configured") return "Not configured";
  if (status === "unavailable") return "Unavailable";
  return "Attention";
}

function RequirementRow({ check }: { check: DeploymentRequirement }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="st-requirement">
      <SettingsRow
        actions={
          check.remediation ? (
            <button
              aria-expanded={open}
              className="btn btn-tertiary sm"
              onClick={() => setOpen((value) => !value)}
              type="button"
            >
              {open ? "Close" : "Resolve"}
            </button>
          ) : null
        }
        className={check.remediation ? "has-more" : ""}
        help={check.summary}
        importance={check.importance}
        name={check.title}
        status={statusLabel(check.status)}
        value={<span className="mono">{check.observed ?? check.summary}</span>}
      >
        {open && check.remediation ? (
          <div className="st-resolve">
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
                Restart after changing configuration: {check.remediation.restartServices.join(", ")}
                .
              </p>
            ) : null}
            {check.remediation.docsUrl ? (
              <a href={check.remediation.docsUrl} target="_blank" rel="noreferrer">
                Full node and signer requirements <ArrowSquareOut aria-hidden="true" />
              </a>
            ) : null}
          </div>
        ) : null}
      </SettingsRow>
    </div>
  );
}

export function DeploymentRequirementsPanel({
  eventCount,
  latestBlockHeight,
  observerAttention,
  onLoadingChange,
  onRequirements,
  readOnly,
  refreshRevision,
  token,
}: {
  eventCount: number | null;
  latestBlockHeight: number | null;
  observerAttention: boolean;
  onLoadingChange?: (loading: boolean) => void;
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
      onLoadingChange?.(true);
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
          onLoadingChange?.(false);
        }
      }
    },
    [onLoadingChange, onRequirements, token],
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
  const observerValue =
    eventCount === null && latestBlockHeight === null
      ? "Evidence unavailable"
      : `${number(eventCount)} events · latest block ${number(latestBlockHeight)}`;

  return (
    <>
      <SettingsSectionTitle
        hint={
          requirements
            ? `what the host must provide · checked ${shortUtc(requirements.checkedAt)}`
            : "what the host must provide"
        }
        id="st-requirements"
      >
        Node &amp; signer requirements
      </SettingsSectionTitle>
      <section className="card st-card" aria-label="Node and signer requirements">
        <ErrorCallout error={error} />
        {loading && !requirements ? (
          <div className="loading-state">Checking runtime requirements</div>
        ) : null}
        <div className="st-rows">
          {runtimeChecks.map((check) => (
            <RequirementRow check={check} key={check.id} />
          ))}
          <SettingsRow
            detail="callbacks from the node · polling covers gaps"
            help="Verified node callbacks accelerate reconciliation; bounded polling covers delivery gaps. Recommended."
            importance="recommended"
            name="Event observer"
            status={observerAttention ? "Attention" : "Verified"}
            value={<span className="mono">{observerValue}</span>}
          />
          {!loading && runtimeChecks.length === 0 ? (
            <SettingsRow
              name="Runtime checks"
              status={readOnly ? "Unavailable" : "Attention"}
              value={<span className="muted">No requirement evidence returned</span>}
            />
          ) : null}
        </div>
      </section>
    </>
  );
}
