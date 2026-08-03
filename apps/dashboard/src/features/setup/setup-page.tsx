import {
  ArrowClockwise,
  ArrowSquareOut,
  Check,
  DownloadSimple,
  Key,
  ShieldCheck,
  Warning,
} from "@phosphor-icons/react";
import {
  type ActivationStep,
  type DashboardSnapshot,
  freshRefreshResponseSchema,
  type OnboardingState,
  type OnboardingWizardState,
  type OperatorSnapshot,
  onboardingActionResponseSchema,
  onboardingEnvelopeSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiDownload, apiJson } from "../../api-client.js";
import { CopyableIdentifier, CopyIdentifierButton } from "../../copyable-identifier.js";
import { dashboardHash } from "../../dashboard-route.js";
import { ErrorCallout, Field, PageHead, StatusBadge } from "../../shared/dashboard-ui.js";
import { DOCUMENT_LINKS } from "../../shared/document-links.js";
import { formatUstx } from "../../shared/format.js";
import { operatorActionError } from "../../shared/operator-error.js";
import { BrowserWalletActionPanel } from "./browser-wallet-action.js";
import {
  attachLabels,
  attachWorkflowSteps,
  freshLabels,
  freshWorkflowSteps,
  randomAuthId,
  signerActivationView,
  workflowStepId,
} from "./setup-workflow.js";

export function SetupPage({
  data,
  token,
  onOnboardingStarted,
  onOperatorStateChanged,
}: {
  data: DashboardSnapshot;
  token: string;
  onOnboardingStarted: () => void;
  onOperatorStateChanged?: (() => void | Promise<void>) | undefined;
}) {
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [wizard, setWizard] = useState<OnboardingWizardState>({
    dismissed: false,
    dismissedAt: null,
    updatedAt: null,
    audit: [],
  });
  const [path, setPath] = useState<"attach" | "fresh">("attach");
  const [selectedStep, setSelectedStep] = useState<string>("preflight");
  const [busy, setBusy] = useState(true);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const managerParts = useMemo(() => {
    const index = data.managerPrincipal.indexOf(".");
    return {
      adminPrincipal: data.managerPrincipal.slice(0, index),
      contractName: data.managerPrincipal.slice(index + 1),
    };
  }, [data.managerPrincipal]);
  const [fresh, setFresh] = useState({
    ...managerParts,
    authId: randomAuthId(),
    signerConfigPath: "<SIGNER_CONFIG_PATH>",
  });
  const [signerOutput, setSignerOutput] = useState("");
  const initialLoadGeneration = useRef(0);
  const automaticRefreshController = useRef<AbortController | null>(null);
  const [activationSnapshot, setActivationSnapshot] = useState<{
    preflight: OperatorSnapshot["preflight"];
    setup: OperatorSnapshot["setup"];
  }>({
    preflight: data.preflight,
    setup: data.setup,
  });

  useEffect(() => {
    setActivationSnapshot({ preflight: data.preflight, setup: data.setup });
  }, [data.preflight, data.setup]);

  const requestFresh = useCallback(
    async (signal?: AbortSignal) =>
      await apiJson(token, "/api/v1/onboarding/fresh/refresh", freshRefreshResponseSchema, {
        method: "POST",
        ...(signal ? { signal } : {}),
      }),
    [token],
  );

  const refreshFresh = useCallback(async () => {
    const automatic = automaticRefreshController.current;
    automaticRefreshController.current = null;
    automatic?.abort();
    const result = await requestFresh();
    setActivationSnapshot({ preflight: result.preflight, setup: result.setup });
    return result;
  }, [requestFresh]);

  const load = useCallback(async () => {
    const generation = ++initialLoadGeneration.current;
    setBusy(true);
    setError(null);
    try {
      const result = await apiJson(token, "/api/v1/onboarding", onboardingEnvelopeSchema);
      if (generation !== initialLoadGeneration.current) return;
      setWizard(result.wizard);
      if (result.onboarding) {
        onOnboardingStarted();
        setOnboarding(result.onboarding);
        setPath(result.onboarding.path);
        setSelectedStep(workflowStepId(result.onboarding.path, result.onboarding.currentStep));
        if (result.onboarding.freshInput) setFresh(result.onboarding.freshInput);
      }
      setInitialLoaded(true);
    } catch (cause) {
      if (generation !== initialLoadGeneration.current) return;
      setInitialLoaded(false);
      setError(operatorActionError(cause, "Could not load setup progress", "Retrying is safe"));
    } finally {
      if (generation === initialLoadGeneration.current) setBusy(false);
    }
  }, [onOnboardingStarted, token]);

  useEffect(() => {
    void load();
    return () => {
      initialLoadGeneration.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (
      busy ||
      path !== "fresh" ||
      !onboarding?.activationPlan ||
      !["deploy-manager", "register-manager", "final-verification"].includes(selectedStep)
    ) {
      return;
    }
    let active = true;
    let timeout: number | undefined;
    const followedStep = workflowStepId(onboarding.path, onboarding.currentStep);
    const poll = async () => {
      const controller = new AbortController();
      automaticRefreshController.current = controller;
      try {
        const result = await requestFresh(controller.signal);
        if (!active || automaticRefreshController.current !== controller) return;
        setActivationSnapshot({ preflight: result.preflight, setup: result.setup });
        setOnboarding(result.onboarding);
        setPath(result.onboarding.path);
        setSelectedStep((current) =>
          current === followedStep
            ? workflowStepId(result.onboarding.path, result.onboarding.currentStep)
            : current,
        );
        setError(null);
      } catch {
        // The manager may not be deployed yet; the visible manual refresh reports errors.
      } finally {
        if (automaticRefreshController.current === controller) {
          automaticRefreshController.current = null;
        }
        if (active) timeout = window.setTimeout(() => void poll(), 20_000);
      }
    };
    timeout = window.setTimeout(() => void poll(), 20_000);
    return () => {
      active = false;
      if (timeout !== undefined) window.clearTimeout(timeout);
      const controller = automaticRefreshController.current;
      automaticRefreshController.current = null;
      controller?.abort();
    };
  }, [
    onboarding?.activationPlan,
    onboarding?.currentStep,
    onboarding?.path,
    busy,
    path,
    requestFresh,
    selectedStep,
  ]);

  const run = async (action: () => Promise<{ onboarding: OnboardingState }>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      onOnboardingStarted();
      setOnboarding(result.onboarding);
      setPath(result.onboarding.path);
      setSelectedStep(workflowStepId(result.onboarding.path, result.onboarding.currentStep));
      try {
        await onOperatorStateChanged?.();
      } catch (cause) {
        setError(
          operatorActionError(
            cause,
            "Setup advanced, but dashboard status could not be refreshed",
            "The setup change is saved; use Refresh in the status bar",
          ),
        );
      }
    } catch (cause) {
      setError(
        operatorActionError(
          cause,
          "Could not update setup",
          "Refresh setup progress before retrying; it may already have updated",
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  const start = async (nextPath: "attach" | "fresh") => {
    if (busy) return;
    if (onboarding?.path === nextPath) {
      setPath(nextPath);
      return;
    }
    const reset = Boolean(onboarding);
    if (
      reset &&
      !window.confirm(
        "Switch onboarding paths? This resets the saved wizard progress for the current path.",
      )
    ) {
      return;
    }
    setPath(nextPath);
    await run(() =>
      apiJson(token, "/api/v1/onboarding/start", onboardingActionResponseSchema, {
        method: "POST",
        body: JSON.stringify({ path: nextPath, reset }),
      }),
    );
  };

  const rawSteps = onboarding?.activationPlan?.steps ?? [];
  const steps = rawSteps.length
    ? path === "fresh"
      ? freshWorkflowSteps(rawSteps)
      : attachWorkflowSteps(rawSteps)
    : [];
  const visibleLabels = path === "attach" ? attachLabels : freshLabels;
  const active = steps.find(({ id }) => id === selectedStep) ?? steps[0] ?? null;
  const attachNeedsRepair = rawSteps.some(
    ({ id, status }) =>
      ["verify-registration", "verify-signer-grant"].includes(id) && status === "blocked",
  );
  const attachBlocked = rawSteps.some(({ status }) => status === "blocked");
  const attachAttention = rawSteps.some(({ status }) => status === "attention");
  const activation = signerActivationView(activationSnapshot.setup, activationSnapshot.preflight);
  const activationSetup = activationSnapshot.setup;
  const targetEligibility =
    activation.kind === "active"
      ? activationSetup?.eligibility.current
      : (activationSetup?.eligibility.next ?? activationSetup?.eligibility.current);
  const foundationChecks =
    activationSetup?.checks.filter(({ id }) =>
      ["manager-attachment", "manager-artifact", "signer-registration", "signer-grant"].includes(
        id,
      ),
    ) ?? [];
  const initialSetupComplete = Boolean(
    activationSetup &&
      (activationSetup.status === "ready" ||
        (foundationChecks.length === 4 &&
          foundationChecks.every(({ status }) => status === "pass"))),
  );
  const enrollmentCloseHeight =
    activationSetup?.enrollmentWindow.preparePhaseStartBurnHeight ??
    activationSnapshot.preflight.cycle.preparePhaseStartBurnHeight;
  const blocksUntilEnrollmentClose =
    activationSetup?.enrollmentWindow.blocksUntilPreparePhase ??
    activationSnapshot.preflight.cycle.blocksUntilPreparePhase;
  const signingStartHeight = activationSnapshot.preflight.cycle.rewardPhaseStartBurnHeight;

  const selectStep = async (step: ActivationStep) => {
    if (busy) return;
    setSelectedStep(step.id);
    if (
      onboarding &&
      !["attach-verification", "signer-grant-ceremony", "final-verification"].includes(step.id)
    ) {
      try {
        const result = await apiJson(
          token,
          "/api/v1/onboarding/progress",
          onboardingActionResponseSchema,
          { method: "PATCH", body: JSON.stringify({ currentStep: step.id }) },
        );
        setOnboarding(result.onboarding);
        setError(null);
      } catch (cause) {
        setError(
          operatorActionError(
            cause,
            "Could not save the selected setup step",
            "The step is open but may reset after reload; select it again to retry",
          ),
        );
      }
    }
  };

  const verifySignerOutput = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(signerOutput);
    } catch {
      setError("Paste the complete valid JSON object printed by the signer command.");
      return;
    }
    void run(() =>
      apiJson(token, "/api/v1/onboarding/fresh/grant/verify", onboardingActionResponseSchema, {
        method: "POST",
        body: JSON.stringify({ signerOutput: parsed }),
      }),
    );
  };

  const downloadArtifact = async (kind: "source" | "manifest") => {
    setError(null);
    try {
      await apiDownload(token, `/api/v1/onboarding/artifacts/${kind}`, {
        expectedContentTypes: kind === "source" ? ["text/plain"] : ["application/json"],
        fallbackFilename:
          kind === "source" ? "signer-manager.clar" : "signer-manager.deployment.json",
      });
    } catch (cause) {
      setError(
        operatorActionError(cause, `Could not download the manager ${kind}`, "Retrying is safe"),
      );
    }
  };

  const setWizardDismissed = async (dismissed: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiJson(
        token,
        dismissed ? "/api/v1/onboarding/dismiss" : "/api/v1/onboarding/resume",
        onboardingEnvelopeSchema,
        { method: "POST" },
      );
      setWizard(result.wizard);
      if (result.onboarding) {
        setOnboarding(result.onboarding);
        setPath(result.onboarding.path);
        setSelectedStep(workflowStepId(result.onboarding.path, result.onboarding.currentStep));
      }
    } catch (cause) {
      setError(
        operatorActionError(
          cause,
          `Could not ${dismissed ? "dismiss" : "resume"} setup guidance`,
          "Refresh setup progress before retrying",
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  if (!initialLoaded) {
    return (
      <>
        <PageHead title="Initial Setup" lede="Load saved setup progress." />
        <ErrorCallout error={error} />
        {busy ? (
          <div className="loading-state">Loading setup progress</div>
        ) : (
          <button type="button" className="btn btn-secondary" onClick={() => void load()}>
            Retry setup
          </button>
        )}
      </>
    );
  }

  if (wizard.dismissed) {
    return (
      <>
        <PageHead title="Initial Setup" lede="Guided setup is currently skipped." />
        <ErrorCallout error={error} />
        <div className="card-standout setup-action-card manual-setup-card">
          <div className="card-head">
            <h2>Using manual configuration</h2>
            <StatusBadge status="Wizard skipped" />
          </div>
          <p className="muted">
            Sidekick will continue using the configured manager, node, and API.
          </p>
          {wizard.dismissedAt ? (
            <p className="help">Skipped {new Date(wizard.dismissedAt).toLocaleString()}</p>
          ) : null}
          <button
            type="button"
            className="btn btn-accent"
            disabled={busy}
            onClick={() => void setWizardDismissed(false)}
          >
            Open guided setup
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Initial Setup"
        lede="Connect an existing manager or deploy a new one."
        actions={
          <div className="setup-head-actions">
            <div className="seg">
              <button
                type="button"
                className={path === "attach" ? "on" : ""}
                disabled={busy}
                onClick={() => void start("attach")}
              >
                Attach Existing Manager
              </button>
              <button
                type="button"
                className={path === "fresh" ? "on" : ""}
                disabled={busy}
                onClick={() => void start("fresh")}
              >
                Deploy New Manager
              </button>
            </div>
            <button
              type="button"
              className="btn btn-tertiary"
              disabled={busy}
              onClick={() => void setWizardDismissed(true)}
            >
              Skip guided setup
            </button>
          </div>
        }
      />
      <ErrorCallout error={error} />
      <div className="wizard setup-wizard">
        <div className="steps">
          {(steps.length
            ? steps
            : visibleLabels.map(
                (title, index) =>
                  ({
                    id: `placeholder-${index}`,
                    title,
                    detail: "Not started",
                    status: index === 0 ? "ready" : "pending",
                    command: null,
                  }) as ActivationStep,
              )
          ).map((step, index) => (
            <button
              type="button"
              className={`step ${step.status === "complete" ? "done" : ""} ${step.id === selectedStep || (!steps.length && index === 0) ? "active" : ""}`}
              key={step.id}
              disabled={busy}
              onClick={() => void selectStep(step)}
            >
              <span className="num">{step.status === "complete" ? <Check /> : index + 1}</span>
              <span className="lbl">
                {step.title}
                <small>{step.detail}</small>
              </span>
            </button>
          ))}
        </div>
        <div>
          {!onboarding || !steps.length ? (
            <div className="card-standout setup-action-card">
              <div className="card-head">
                <h2>{path === "attach" ? "Verify existing manager" : "Prepare fresh manager"}</h2>
                <StatusBadge status={data.preflight.status} />
              </div>
              {path === "attach" ? (
                <>
                  <div className="callout callout-info" role="note">
                    <ShieldCheck className="ic" />
                    <div className="body">
                      Verify the configured manager, signer registration, and eligibility without
                      making changes.
                    </div>
                  </div>
                  <Field
                    label="Signer-manager principal"
                    help="Must match the manager configured for this Sidekick deployment."
                  >
                    <span className="copyable-input">
                      <input className="input mono" readOnly value={data.managerPrincipal} />
                      <CopyIdentifierButton
                        value={data.managerPrincipal}
                        label="manager principal"
                      />
                    </span>
                  </Field>
                  <button
                    type="button"
                    className="btn btn-accent"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        if (onboarding?.path !== "attach") {
                          await apiJson(
                            token,
                            "/api/v1/onboarding/start",
                            onboardingActionResponseSchema,
                            { method: "POST", body: JSON.stringify({ path: "attach" }) },
                          );
                        }
                        return apiJson(
                          token,
                          "/api/v1/onboarding/attach/verify",
                          onboardingActionResponseSchema,
                          {
                            method: "POST",
                            body: JSON.stringify({ managerPrincipal: data.managerPrincipal }),
                          },
                        );
                      })
                    }
                  >
                    <ShieldCheck /> Run attach checks
                  </button>
                </>
              ) : (
                <div className="form-grid setup-entry-form">
                  <div className="callout callout-info" role="note">
                    <ShieldCheck className="ic" />
                    <div className="body">
                      <strong>Prepare a new signer-manager</strong>
                      <div>
                        Sidekick prepares the manager deployment and signer registration. Sign with
                        a browser wallet or use the manual transaction details.
                      </div>
                    </div>
                  </div>
                  <div className="archive-guidance" role="note">
                    <div>
                      <strong>Check prerequisites.</strong>
                      <p>
                        Confirm the node, API, and signer are running and the manager-admin wallet
                        is funded.
                      </p>
                    </div>
                    <div className="stacked-doc-links">
                      <a href={DOCUMENT_LINKS.nodeDocker} target="_blank" rel="noreferrer">
                        Node setup <ArrowSquareOut aria-hidden="true" />
                      </a>
                      <a href={DOCUMENT_LINKS.signerQuickstart} target="_blank" rel="noreferrer">
                        Signer quickstart <ArrowSquareOut aria-hidden="true" />
                      </a>
                      <a
                        href={DOCUMENT_LINKS.hiroChainstateArchive}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Hiro Archive guide <ArrowSquareOut aria-hidden="true" />
                      </a>
                    </div>
                  </div>
                  {data.preflight.checks.some(({ status }) => status !== "pass") ? (
                    <div
                      className={`callout ${data.preflight.status === "fail" ? "callout-critical" : "callout-caution"}`}
                    >
                      <Warning className="ic" />
                      <div className="body">
                        <strong>Connected preflight needs attention.</strong>
                        <ul className="compact-check-list">
                          {data.preflight.checks
                            .filter(({ status }) => status !== "pass")
                            .map((check) => (
                              <li key={check.id}>{check.message}</li>
                            ))}
                        </ul>
                      </div>
                    </div>
                  ) : null}
                  <Field
                    label="Manager admin principal"
                    help="The funded wallet that will deploy and administer this manager. Public address only."
                  >
                    <span className="copyable-input">
                      <input className="input mono" readOnly value={fresh.adminPrincipal} />
                      <CopyIdentifierButton
                        value={fresh.adminPrincipal}
                        label="manager admin principal"
                      />
                    </span>
                  </Field>
                  <Field
                    label="Contract name"
                    help="Together with the admin address, this forms the configured manager principal."
                  >
                    <span className="copyable-input">
                      <input className="input mono" readOnly value={fresh.contractName} />
                      <CopyIdentifierButton value={fresh.contractName} label="contract name" />
                    </span>
                  </Field>
                  <Field
                    label="Signer grant auth ID"
                    help="A one-time ID for this signer authorization. Keep it unchanged through registration."
                  >
                    <div className="field-inline-action">
                      <input
                        className="input mono"
                        inputMode="numeric"
                        value={fresh.authId}
                        onChange={(event) => setFresh({ ...fresh, authId: event.target.value })}
                      />
                      <button
                        type="button"
                        className="btn btn-tertiary"
                        onClick={() => setFresh({ ...fresh, authId: randomAuthId() })}
                      >
                        <ArrowClockwise /> Regenerate
                      </button>
                    </div>
                  </Field>
                  <Field
                    label="Signer configuration path"
                    help="Absolute path to the signer configuration file."
                  >
                    <input
                      className="input mono"
                      value={fresh.signerConfigPath}
                      onChange={(event) =>
                        setFresh({ ...fresh, signerConfigPath: event.target.value })
                      }
                    />
                  </Field>
                  <button
                    type="button"
                    className="btn btn-accent"
                    disabled={busy || data.preflight.status === "fail"}
                    onClick={() =>
                      void run(async () => {
                        if (onboarding?.path !== "fresh") {
                          await apiJson(
                            token,
                            "/api/v1/onboarding/start",
                            onboardingActionResponseSchema,
                            { method: "POST", body: JSON.stringify({ path: "fresh" }) },
                          );
                        }
                        return apiJson(
                          token,
                          "/api/v1/onboarding/fresh/prepare",
                          onboardingActionResponseSchema,
                          { method: "POST", body: JSON.stringify(fresh) },
                        );
                      })
                    }
                  >
                    Generate deployment files
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="card-standout setup-action-card">
              <div className="card-head">
                <h2>{active?.title ?? "Setup complete"}</h2>
                <StatusBadge
                  status={
                    active?.id === "final-verification"
                      ? activation.badge
                      : (active?.status ?? onboarding.status)
                  }
                />
              </div>
              {active?.id !== "final-verification" ? (
                <p className="muted setup-copy">
                  {active?.id === "render-manager"
                    ? "The manager contract records pool registration, rewards, and fee settings."
                    : active?.detail}
                </p>
              ) : null}
              {path === "attach" ? (
                <div className="checklist">
                  <div
                    className={`callout ${attachBlocked || attachAttention ? "callout-caution" : "callout-info"}`}
                  >
                    {attachBlocked || attachAttention ? (
                      <Warning className="ic" />
                    ) : (
                      <Check className="ic" />
                    )}
                    <div className="body">
                      <strong>
                        {attachBlocked
                          ? "Manager attached with operational blockers."
                          : attachAttention
                            ? "Manager attached with items to review."
                            : "Manager attached and operational checks passed."}
                      </strong>{" "}
                      Review items allow monitoring; blocked items prevent pool operation.
                    </div>
                  </div>
                  {rawSteps.map((step) => (
                    <div className="check-item" key={step.id}>
                      <span
                        className={`box ${step.status === "complete" ? "ok" : step.status === "blocked" ? "bad" : "wait"}`}
                      >
                        {step.status === "complete" ? <Check /> : <Warning />}
                      </span>
                      <div className="body">
                        <strong>
                          {step.id === "publish-enrollment-info"
                            ? "Public pool information (optional)"
                            : step.title}
                        </strong>
                        <div className="m">{step.detail}</div>
                      </div>
                    </div>
                  ))}
                  {attachNeedsRepair ? (
                    <div className="callout callout-caution">
                      <Warning className="ic" />
                      <div className="body">
                        <strong>Signer authorization needs repair.</strong> Use Manager to prepare
                        and verify a fresh signer-host grant and{" "}
                        <span className="mono">register-self</span> transaction, then re-check here.
                        <div className="actions">
                          <button
                            type="button"
                            className="btn btn-secondary sm"
                            onClick={() => {
                              location.hash = dashboardHash("manager", "register-self");
                            }}
                          >
                            Review repair ceremony
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : null}
                  <div className="setup-result-actions">
                    <button
                      type="button"
                      className="btn btn-accent"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          apiJson(
                            token,
                            "/api/v1/onboarding/attach/verify",
                            onboardingActionResponseSchema,
                            {
                              method: "POST",
                              body: JSON.stringify({ managerPrincipal: data.managerPrincipal }),
                            },
                          ),
                        )
                      }
                    >
                      <ArrowClockwise /> Re-run verification
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => {
                        location.hash = "enrollment";
                      }}
                    >
                      Open Public Pool Page
                    </button>
                  </div>
                </div>
              ) : null}

              {path === "fresh" && active?.id === "preflight" ? (
                <div className="setup-review-panel">
                  <div className="callout callout-info">
                    <ShieldCheck className="ic" />
                    <div className="body">
                      Node, API, network, and PoX-5 checks are complete. Confirm the signer and
                      admin wallet separately.
                    </div>
                  </div>
                  <div className="checklist">
                    {data.preflight.checks.map((check) => (
                      <div className="check-item" key={check.id}>
                        <span
                          className={`box ${check.status === "pass" ? "ok" : check.status === "fail" ? "bad" : "wait"}`}
                        >
                          {check.status === "pass" ? <Check /> : <Warning />}
                        </span>
                        <div className="body">
                          <div className="m">{check.message}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      location.hash = "operations";
                    }}
                  >
                    Open Operations
                  </button>
                  {active.command ? (
                    <details className="setup-advanced">
                      <summary>CLI equivalent (advanced)</summary>
                      <pre className="code command-code">{active.command}</pre>
                    </details>
                  ) : null}
                </div>
              ) : null}

              {path === "fresh" && active?.id === "render-manager" ? (
                <div className="setup-review-panel">
                  <div className="callout callout-info">
                    <ShieldCheck className="ic" />
                    <div className="body">
                      Download the contract source and deployment manifest, then deploy them with
                      your wallet, Explorer, or CLI.
                    </div>
                  </div>
                  <div className="artifact-actions">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => void downloadArtifact("source")}
                    >
                      <DownloadSimple /> Download .clar
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => void downloadArtifact("manifest")}
                    >
                      <DownloadSimple /> Download manifest
                    </button>
                    {onboarding.artifact.manifest ? (
                      <p className="help mono src src-chain">
                        source {onboarding.artifact.manifest.artifact.sourceSha256}
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="btn btn-accent"
                    onClick={() => setSelectedStep("deploy-manager")}
                  >
                    Review deployment instructions
                  </button>
                  {active.command ? (
                    <details className="setup-advanced">
                      <summary>CLI equivalent (advanced)</summary>
                      <pre className="code command-code">{active.command}</pre>
                    </details>
                  ) : null}
                </div>
              ) : null}

              {path === "fresh" && active?.id === "deploy-manager" ? (
                <div className="deployment-handoff">
                  <div className="artifact-actions">
                    <button
                      type="button"
                      className="btn btn-accent"
                      onClick={() => void downloadArtifact("source")}
                    >
                      <DownloadSimple /> Download .clar
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => void downloadArtifact("manifest")}
                    >
                      <DownloadSimple /> Download manifest
                    </button>
                    {onboarding.artifact.manifest ? (
                      <p className="help mono src src-chain">
                        source {onboarding.artifact.manifest.artifact.sourceSha256}
                      </p>
                    ) : null}
                  </div>

                  {onboarding.artifact.manifest ? (
                    <>
                      <BrowserWalletActionPanel
                        chainId={data.preflight.node.networkId}
                        createRequest={{ action: "deploy-manager" }}
                        managerPrincipal={onboarding.managerPrincipal}
                        network={onboarding.artifact.manifest.network}
                        onVerified={onOperatorStateChanged}
                        token={token}
                      />
                      <div className="deploy-instructions">
                        <h3>Manager contract</h3>
                        <p>
                          This contract represents your pool: it registers your signer, manages
                          rewards, and records pool fees. The deploying wallet is its first admin.
                        </p>
                        <p>
                          Deploy the generated Stacks Core reference manager, or deploy a compatible
                          manager and attach it later. It starts at 0%; set your pool fee in Manager
                          before claims begin (100 basis points = 1%).
                        </p>
                        <p className="help">
                          <a
                            href={DOCUMENT_LINKS.referenceManager}
                            target="_blank"
                            rel="noreferrer"
                          >
                            View reference source <ArrowSquareOut />
                          </a>
                          {" · "}
                          <a href={DOCUMENT_LINKS.poolOperator} target="_blank" rel="noreferrer">
                            Pool operator guide <ArrowSquareOut />
                          </a>
                        </p>
                      </div>
                      <div className="deploy-instructions">
                        <h3>Manual deployment</h3>
                        <p>
                          The <span className="mono">.clar</span> file is the contract source. The
                          manifest records the values you must review; it is not an import file.
                        </p>
                        <div className="deployment-target">
                          <span>
                            From{" "}
                            <CopyableIdentifier
                              value={onboarding.artifact.manifest.adminPrincipal}
                              label="manager admin principal"
                              className="mono"
                            />
                          </span>
                          <span>
                            Contract{" "}
                            <strong className="mono">
                              {onboarding.artifact.manifest.transaction.contractName}
                            </strong>
                          </span>
                          <span>
                            Network <strong>{onboarding.artifact.manifest.network}</strong>
                          </span>
                          <span>
                            Clarity{" "}
                            <strong>
                              {onboarding.artifact.manifest.transaction.clarityVersion}
                            </strong>
                          </span>
                        </div>
                        <div className="deployment-options">
                          <div>
                            <strong>Wallet / Explorer</strong>
                            <p>
                              Connect the funded admin wallet to the same network, open Deploy
                              Contract, paste the <span className="mono">.clar</span> source, and
                              copy the contract name from the manifest.
                            </p>
                            <a href={DOCUMENT_LINKS.sandboxDeploy} target="_blank" rel="noreferrer">
                              Open Explorer Sandbox <ArrowSquareOut />
                            </a>
                          </div>
                          <div>
                            <strong>Clarinet CLI</strong>
                            <p>
                              Add the <span className="mono">.clar</span> file to a Clarinet
                              project, configure the same network and deployer, then generate,
                              review, and apply a deployment plan using the manifest values.
                            </p>
                            <a
                              href={DOCUMENT_LINKS.clarinetDeployment}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Clarinet deployment guide <ArrowSquareOut />
                            </a>
                          </div>
                        </div>
                        <p className="deploy-warning">
                          After the transaction confirms, return here to verify the deployment.
                        </p>
                        <button
                          type="button"
                          className="btn btn-accent"
                          disabled={busy}
                          onClick={() => void run(refreshFresh)}
                        >
                          <ArrowClockwise /> Verify deployment
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="help mono src src-chain">
                      Prepare the manager artifact before deploying.
                    </p>
                  )}
                </div>
              ) : null}

              {path === "fresh" && active?.id === "signer-grant-ceremony" ? (
                <div className="form-grid grant-ceremony">
                  <div className="callout callout-info" role="note">
                    <Key className="ic" />
                    <div className="body">
                      <strong>Authorize this manager with your signer</strong>
                      <div>
                        Run the generated authorization command on the signer host. Sidekick
                        verifies its output before preparing registration.
                      </div>
                    </div>
                  </div>
                  {!onboarding.signerGrant.preparation ? (
                    <>
                      <p>Generate the command to run on the signer host.</p>
                      <button
                        type="button"
                        className="btn btn-accent"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            apiJson(
                              token,
                              "/api/v1/onboarding/fresh/grant/prepare",
                              onboardingActionResponseSchema,
                              { method: "POST" },
                            ),
                          )
                        }
                      >
                        Generate signer command
                      </button>
                    </>
                  ) : (
                    <>
                      <ol className="ceremony-steps">
                        <li>Run the command below on the signer host.</li>
                        <li>
                          Paste its complete JSON output below and click{" "}
                          <strong>Verify signer output</strong>.
                        </li>
                      </ol>
                      <div className="ceremony-command">
                        <div className="ceremony-command-head">
                          <strong>Run on the signer host</strong>
                          <CopyIdentifierButton
                            value={onboarding.signerGrant.preparation.command}
                            label="signer command"
                          />
                        </div>
                        <pre className="code command-code">
                          {onboarding.signerGrant.preparation.command}
                        </pre>
                      </div>
                      <div className="statline">
                        <span className="k">Auth ID</span>
                        <span className="v mono">{onboarding.signerGrant.preparation.authId}</span>
                      </div>
                      <div className="statline">
                        <span className="k">SIP-018 grant hash</span>
                        <span className="v">
                          <CopyableIdentifier
                            value={onboarding.signerGrant.preparation.expectedMessageHashHex}
                            label="SIP-018 grant hash"
                            className="identifier mono src src-chain"
                          />
                          <span className="sub">derived from live PoX-5</span>
                        </span>
                      </div>
                    </>
                  )}
                  {onboarding.signerGrant.preparation && !onboarding.signerGrant.verified ? (
                    <>
                      <Field
                        label="JSON output from the signer command"
                        help="Paste the complete JSON object. Never paste the signer configuration or private key."
                      >
                        <textarea
                          className="input code-input"
                          rows={10}
                          placeholder="Paste the complete JSON object printed by stacks-signer"
                          value={signerOutput}
                          onChange={(event) => setSignerOutput(event.target.value)}
                        />
                      </Field>
                      <button
                        type="button"
                        className="btn btn-accent"
                        disabled={busy || !signerOutput.trim()}
                        onClick={verifySignerOutput}
                      >
                        Verify signer output
                      </button>
                    </>
                  ) : null}
                  {onboarding.signerGrant.verified ? (
                    <div className="callout callout-info">
                      <Check className="ic" />
                      <div className="body">
                        Signer output is verified. Continue to manager registration.
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {path === "fresh" &&
              active?.id === "register-manager" &&
              onboarding.signerGrant.verified ? (
                <div className="registration-handoff">
                  <div className="callout callout-info">
                    <ShieldCheck className="ic" />
                    <div className="body">
                      <strong>Register the manager with PoX-5.</strong> This transaction also
                      registers the signer key. Sign below or use the manual transaction details.
                    </div>
                  </div>

                  <BrowserWalletActionPanel
                    chainId={data.preflight.node.networkId}
                    createRequest={{ action: "register-self" }}
                    managerPrincipal={data.managerPrincipal}
                    network={data.network}
                    onVerified={onOperatorStateChanged}
                    token={token}
                  />

                  <h3>Manual registration</h3>
                  <ol className="ceremony-steps registration-instructions">
                    <li>
                      Open your preferred Stacks wallet, Explorer contract-call interface, or CLI on
                      the same network as Sidekick.
                    </li>
                    <li>
                      Call <span className="mono">register-self</span> on the manager contract using
                      the values below, signed by the manager admin principal.
                    </li>
                    <li>Broadcast the transaction and wait for it to confirm.</li>
                    <li>
                      Return here and click <strong>Check registration</strong>.
                    </li>
                  </ol>

                  <div className="registration-values">
                    {[
                      [
                        "Manager contract",
                        onboarding.signerGrant.verified.registerSelfCall.contract,
                        "manager contract",
                      ],
                      [
                        "Function",
                        onboarding.signerGrant.verified.registerSelfCall.functionName,
                        "function name",
                      ],
                      [
                        "Signing principal",
                        onboarding.signerGrant.verified.registerSelfCall.signingPrincipal,
                        "signing principal",
                      ],
                      [
                        "Signer manager",
                        onboarding.signerGrant.verified.managerPrincipal,
                        "signer manager",
                      ],
                      [
                        "Signer key",
                        `0x${onboarding.signerGrant.verified.signerKeyHex}`,
                        "signer key",
                      ],
                      ["Auth ID", `u${onboarding.signerGrant.verified.authId}`, "auth ID"],
                      [
                        "Signer signature",
                        `0x${onboarding.signerGrant.verified.signerSignatureHex}`,
                        "signer signature",
                      ],
                    ].map(([label, value, copyLabel]) => (
                      <div className="registration-value" key={label}>
                        <span>{label}</span>
                        <CopyableIdentifier value={value} label={copyLabel} className="mono" />
                      </div>
                    ))}
                  </div>

                  <details className="setup-advanced">
                    <summary>Encoded transaction arguments (advanced)</summary>
                    <div className="ceremony-command">
                      <div className="ceremony-command-head">
                        <span>Raw call payload</span>
                        <CopyIdentifierButton
                          value={JSON.stringify(
                            onboarding.signerGrant.verified.registerSelfCall,
                            null,
                            2,
                          )}
                          label="raw call payload"
                        />
                      </div>
                      <pre className="code command-code">
                        {JSON.stringify(onboarding.signerGrant.verified.registerSelfCall, null, 2)}
                      </pre>
                    </div>
                  </details>
                  <button
                    type="button"
                    className="btn btn-accent"
                    disabled={busy}
                    onClick={() => void run(refreshFresh)}
                  >
                    <ArrowClockwise /> Check registration
                  </button>
                </div>
              ) : null}

              {path === "fresh" && active?.id === "final-verification" ? (
                <div className="signer-activation" data-activation-state={activation.kind}>
                  <div
                    className={`setup-completion ${initialSetupComplete ? "is-complete" : "needs-attention"}`}
                  >
                    {initialSetupComplete ? <Check /> : <Warning />}
                    <div>
                      <strong>
                        {initialSetupComplete
                          ? "Initial setup complete"
                          : "Initial setup verification pending"}
                      </strong>
                      <p>
                        {initialSetupComplete
                          ? "Manager deployed · Signer registered · Grant valid"
                          : "Resolve the failed setup checks before activating the signer."}
                      </p>
                    </div>
                  </div>

                  <div className="activation-card">
                    <div className="activation-heading">
                      <div>
                        <span className="eyebrow">Signer activation</span>
                        <h3>{activation.title}</h3>
                      </div>
                    </div>
                    <p className="activation-message">{activation.message}</p>

                    {activation.kind === "stake-required" && targetEligibility ? (
                      <p className="activation-progress-copy">
                        <strong>{formatUstx(targetEligibility.delegatedUstx)} STX</strong> of{" "}
                        <strong>{formatUstx(targetEligibility.thresholdUstx)} STX</strong> required
                      </p>
                    ) : null}

                    <div className="activation-stats">
                      <div>
                        <span>Stake assigned</span>
                        <strong>{formatUstx(targetEligibility?.delegatedUstx)} STX</strong>
                      </div>
                      <div>
                        <span>Required</span>
                        <strong>{formatUstx(targetEligibility?.thresholdUstx)} STX</strong>
                      </div>
                      <div>
                        <span>Target cycle</span>
                        <strong>{targetEligibility?.cycleId ?? "Unavailable"}</strong>
                      </div>
                      <div>
                        <span>Enrollment closes</span>
                        <strong>
                          {activationSetup?.enrollmentWindow.status === "prepare-phase"
                            ? "Closed"
                            : enrollmentCloseHeight
                              ? `Bitcoin block ${enrollmentCloseHeight}`
                              : "Unavailable"}
                        </strong>
                        {activationSetup?.enrollmentWindow.status === "open" &&
                        blocksUntilEnrollmentClose !== null ? (
                          <small>{blocksUntilEnrollmentClose} Bitcoin blocks remaining</small>
                        ) : null}
                      </div>
                    </div>

                    <div className="activation-manager">
                      <span>Manager</span>
                      <strong className="mono">{data.managerPrincipal}</strong>
                    </div>

                    {activation.kind === "stake-required" ? (
                      <p className="activation-next-step">
                        Have participants delegate enough STX before enrollment closes.
                      </p>
                    ) : null}
                    {activation.kind === "scheduled" && signingStartHeight ? (
                      <p className="activation-next-step">
                        Signing begins at Bitcoin block {signingStartHeight}. No further setup
                        action is required.
                      </p>
                    ) : null}

                    <div className="activation-actions">
                      <CopyIdentifierButton
                        value={data.managerPrincipal}
                        label="manager principal"
                        showLabel
                      />
                      {activation.kind === "stake-required" ? (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => {
                            location.hash = "enrollment";
                          }}
                        >
                          Open Public Pool Page
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="btn btn-accent"
                        disabled={busy}
                        onClick={() => void run(refreshFresh)}
                      >
                        <ArrowClockwise /> {activation.refreshLabel}
                      </button>
                    </div>

                    {active.command ? (
                      <details className="activation-advanced">
                        <summary>Advanced</summary>
                        <pre className="code command-code activation-command-code">
                          {active.command}
                        </pre>
                      </details>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
