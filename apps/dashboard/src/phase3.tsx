import {
  ArrowClockwise,
  ArrowSquareOut,
  Check,
  DownloadSimple,
  Key,
  Plugs,
  ShieldCheck,
  Warning,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CopyableIdentifier, CopyIdentifierButton } from "./copyable-identifier.js";

type StepStatus = "complete" | "ready" | "pending" | "attention" | "blocked";

interface ActivationStep {
  id: string;
  status: StepStatus;
  title: string;
  detail: string;
  command: string | null;
}

interface OnboardingState {
  path: "attach" | "fresh";
  status: "in-progress" | "blocked" | "complete";
  currentStep: string;
  managerPrincipal: string;
  updatedAt: string;
  activationPlan: null | { status: string; steps: ActivationStep[] };
  freshInput: null | {
    adminPrincipal: string;
    contractName: string;
    authId: string;
    signerConfigPath: string;
  };
  artifact: {
    available: boolean;
    sourceFile: string | null;
    manifestFile: string | null;
    manifest: null | {
      deploymentAllowed: boolean;
      warnings: string[];
      artifact: { sourceSha256: string; canonicalSourceSha256: string };
    };
  };
  signerGrant: {
    preparation: null | { command: string; expectedMessageHashHex: string; authId: string };
    verified: null | {
      signerKeyHex: string;
      registerSelfCall: {
        contract: string;
        functionName: string;
        arguments: string[];
        signingPrincipal: string;
      };
    };
  };
  audit: Array<{
    action: string;
    path: "attach" | "fresh";
    currentStep: string;
    status: string;
    changedAt: string;
  }>;
}

interface OnboardingWizardState {
  dismissed: boolean;
  dismissedAt: string | null;
  updatedAt: string | null;
  audit: Array<{ action: "dismissed" | "resumed"; changedAt: string }>;
}

export interface RuntimeSettings {
  schemaVersion: 1;
  revision: number;
  updatedAt: string | null;
  pool: {
    displayName: string;
    websiteUrl: string;
    supportContact: string;
    leatherUrl: string;
  };
  display: {
    timezone: string;
    timeFormat: "relative" | "absolute" | "both";
    numberFormat: "1,234.5678" | "1 234,5678";
    defaultTheme: "light" | "dark" | "system";
  };
  dataSources: {
    nodeRpcUrl: string;
    apiUrl: string;
    apiKeyHeader: string;
    apiKeyConfigured: boolean;
    apiKeySource: "environment" | "database" | "none";
  };
  forecast: { horizonCycles: number };
  embed: { type: "live" | "static"; publicApiUrl: string };
  payoutPolicy: {
    minimumDirectSbtcSats: string;
    maxTransactionFeeUstx: string;
    rollingGasBudgetUstx: string;
  };
  automation: { mode: "observe"; gasPayerPrincipal: string };
  alerts: { webhookUrl: string; criticalOnly: boolean };
  audit: Array<{ revision: number; changedFields: string[]; changedAt: string }>;
}

interface EnrollmentDocument {
  pool: { displayName: string; websiteUrl?: string; support?: { email?: string; url?: string } };
  chain: { network: string; burnBlockHeight: number; rewardCycleId: number };
  manager: { principal: string; sourceSha256: string };
  signer: { publicKeyHex: string | null; grantValid: boolean | null };
  fee: { currentConfiguredBips: number };
  eligibility: {
    current: null | { delegatedUstx: string; meetsThreshold: boolean; inSignerSet: boolean };
  };
  links: { managerExplorer: string; officialPlatforms: Array<{ label: string; url: string }> };
}

interface PoolCardArtifact {
  mode: "live" | "static";
  filename: string;
  contentType: string;
  body: string;
  json: { filename: string; contentType: string; body: string };
  enrollment: EnrollmentDocument;
  liveFields: string[];
}

export interface Phase3Snapshot {
  managerPrincipal: string;
  network: string;
  setup: null | {
    status: "ready" | "attention" | "blocked";
    checks: Array<{ id: string; status: "pass" | "warn" | "fail"; message: string }>;
  };
  preflight: {
    status: "pass" | "warn" | "fail";
    checks: Array<{ id: string; status: "pass" | "warn" | "fail"; message: string }>;
  };
  runtimeSettings?: RuntimeSettings;
  manager?: {
    automationEligible: boolean;
    automationEligibilityReason: string;
    source: {
      profileId: string | null;
      tier: "reference-built-in" | "reference-render" | "custom-observe" | "unrecognized";
      origin: "built-in" | "operator-installed" | null;
    };
    installedProfiles: {
      directory: string | null;
      loaded: number;
      issues: Array<{ fileName: string | null; code: string; message: string }>;
    };
  };
}

async function api<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (response.status === 401) {
    sessionStorage.removeItem("sidekick-token");
    window.dispatchEvent(new Event("sidekick-auth-rejected"));
    throw new Error("The operator credential was rejected.");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const detail =
      typeof body?.error === "string" ? body.error.replaceAll("_", " ") : `HTTP ${response.status}`;
    throw new Error(`Request failed: ${detail}`);
  }
  return (await response.json()) as T;
}

function PageHead({
  title,
  lede,
  actions,
}: {
  title: string;
  lede: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        <p className="lede">{lede}</p>
      </div>
      {actions ? <div className="actions">{actions}</div> : null}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const state = ["complete", "ready", "pass", "connected", "grant valid", "eligible"].includes(
    normalized,
  )
    ? "b-success"
    : ["blocked", "fail", "unavailable", "grant not verified", "needs attention"].includes(
          normalized,
        )
      ? "b-error"
      : "b-caution";
  return <span className={`badge ${state}`}>{status.replaceAll("-", " ")}</span>;
}

function ErrorCallout({ error }: { error: string | null }) {
  return error ? (
    <div className="callout callout-critical error-banner">
      <Warning className="ic" />
      <div className="body">{error}</div>
    </div>
  ) : null;
}

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the concrete control is supplied as a child.
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {help ? <span className="help">{help}</span> : null}
    </label>
  );
}

async function authenticatedDownload(token: string, url: string): Promise<void> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 401) {
    sessionStorage.removeItem("sidekick-token");
    window.dispatchEvent(new Event("sidekick-auth-rejected"));
    throw new Error("The operator credential was rejected.");
  }
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}`);
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") ?? "";
  const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? "signer-sidekick-artifact";
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}

const attachLabels = [
  "Verify sources",
  "Verify manager",
  "Verify registration",
  "Verify signer grant",
  "Check eligibility",
  "Publish pool information",
];

const freshLabels = [
  "Prerequisites",
  "Manager artifact",
  "Deploy manager",
  "Signer grant ceremony",
  "Register manager",
  "Pool policy",
  "Automation identity",
  "Final verification",
];

function combinedStepStatus(steps: Array<ActivationStep | undefined>): StepStatus {
  const values = steps.filter((step): step is ActivationStep => Boolean(step));
  if (values.length === 0) return "pending";
  if (values.some(({ status }) => status === "blocked")) return "blocked";
  if (values.some(({ status }) => status === "attention")) return "attention";
  if (values.every(({ status }) => status === "complete")) return "complete";
  if (values.some(({ status }) => status === "ready")) return "ready";
  return "pending";
}

function freshWorkflowSteps(
  raw: ActivationStep[],
  settings: RuntimeSettings | undefined,
): ActivationStep[] {
  const byId = new Map(raw.map((step) => [step.id, step]));
  const mapped = (id: string, title: string): ActivationStep => {
    const step = byId.get(id);
    return step
      ? { ...step, title }
      : { id, title, detail: "Pending", status: "pending", command: null };
  };
  const grantSteps = [byId.get("prepare-signer-grant"), byId.get("verify-signer-grant")];
  const verificationSteps = [byId.get("verify-setup"), byId.get("publish-enrollment-info")];
  return [
    mapped("preflight", "Prerequisites"),
    mapped("render-manager", "Manager artifact"),
    mapped("deploy-manager", "Deploy manager"),
    {
      id: "signer-grant-ceremony",
      title: "Signer grant ceremony",
      detail:
        grantSteps.find((step) => step?.status !== "complete")?.detail ??
        "Signer output verified against the live PoX-5 grant hash",
      status: combinedStepStatus(grantSteps),
      command: grantSteps.find((step) => step?.status !== "complete")?.command ?? null,
    },
    mapped("register-manager", "Register manager"),
    {
      id: "pool-policy",
      title: "Pool policy",
      detail: settings?.revision
        ? `Settings revision ${settings.revision} saved`
        : "Configure fee, payout, display, and alert policy",
      status: settings?.revision ? "complete" : "ready",
      command: null,
    },
    {
      id: "automation-identity",
      title: "Automation identity",
      detail: settings?.automation.gasPayerPrincipal
        ? "Dedicated gas-payer principal recorded"
        : "Record a dedicated gas-payer principal; key custody remains external",
      status: settings?.automation.gasPayerPrincipal ? "complete" : "attention",
      command: null,
    },
    {
      id: "final-verification",
      title: "Final verification",
      detail:
        verificationSteps.find((step) => step?.status !== "complete")?.detail ??
        "Setup and pool information are ready",
      status: combinedStepStatus(verificationSteps),
      command: verificationSteps.find((step) => step?.status !== "complete")?.command ?? null,
    },
  ];
}

function workflowStepId(path: "attach" | "fresh", rawStep: string): string {
  if (path === "attach") return rawStep;
  if (["prepare-signer-grant", "verify-signer-grant"].includes(rawStep))
    return "signer-grant-ceremony";
  if (["verify-setup", "publish-enrollment-info"].includes(rawStep)) return "final-verification";
  return rawStep;
}

export function SetupPage({ data, token }: { data: Phase3Snapshot; token: string }) {
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [wizard, setWizard] = useState<OnboardingWizardState>({
    dismissed: false,
    dismissedAt: null,
    updatedAt: null,
    audit: [],
  });
  const [path, setPath] = useState<"attach" | "fresh">("attach");
  const [selectedStep, setSelectedStep] = useState<string>("preflight");
  const [busy, setBusy] = useState(false);
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
    authId: "0",
    signerConfigPath: "<SIGNER_CONFIG_PATH>",
  });
  const [signerOutput, setSignerOutput] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await api<{
        onboarding: OnboardingState | null;
        wizard: OnboardingWizardState;
      }>(token, "/api/v1/onboarding");
      setWizard(result.wizard);
      if (result.onboarding) {
        setOnboarding(result.onboarding);
        setPath(result.onboarding.path);
        setSelectedStep(workflowStepId(result.onboarding.path, result.onboarding.currentStep));
        if (result.onboarding.freshInput) setFresh(result.onboarding.freshInput);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (
      path !== "fresh" ||
      !onboarding?.activationPlan ||
      !["deploy-manager", "register-manager", "final-verification"].includes(selectedStep)
    ) {
      return;
    }
    const interval = window.setInterval(() => {
      void api<{ onboarding: OnboardingState }>(token, "/api/v1/onboarding/fresh/refresh", {
        method: "POST",
      })
        .then((result) => {
          setOnboarding(result.onboarding);
        })
        .catch(() => {
          // The manager may not be deployed yet; the visible manual refresh reports errors.
        });
    }, 20_000);
    return () => window.clearInterval(interval);
  }, [onboarding?.activationPlan, path, selectedStep, token]);

  const run = async (action: () => Promise<{ onboarding: OnboardingState }>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      setOnboarding(result.onboarding);
      setPath(result.onboarding.path);
      setSelectedStep(workflowStepId(result.onboarding.path, result.onboarding.currentStep));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const start = async (nextPath: "attach" | "fresh") => {
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
      api(token, "/api/v1/onboarding/start", {
        method: "POST",
        body: JSON.stringify({ path: nextPath, reset }),
      }),
    );
  };

  const rawSteps = onboarding?.activationPlan?.steps ?? [];
  const steps = rawSteps.length
    ? path === "fresh"
      ? freshWorkflowSteps(rawSteps, data.runtimeSettings)
      : rawSteps
    : [];
  const visibleLabels = path === "attach" ? attachLabels : freshLabels;
  const active = steps.find(({ id }) => id === selectedStep) ?? steps[0] ?? null;

  const selectStep = async (step: ActivationStep) => {
    setSelectedStep(step.id);
    if (
      onboarding &&
      ![
        "signer-grant-ceremony",
        "pool-policy",
        "automation-identity",
        "final-verification",
      ].includes(step.id)
    ) {
      try {
        const result = await api<{ onboarding: OnboardingState }>(
          token,
          "/api/v1/onboarding/progress",
          { method: "PATCH", body: JSON.stringify({ currentStep: step.id }) },
        );
        setOnboarding(result.onboarding);
      } catch {
        // Selection remains useful even if persistence is temporarily unavailable.
      }
    }
  };

  const setWizardDismissed = async (dismissed: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{
        onboarding: OnboardingState | null;
        wizard: OnboardingWizardState;
      }>(token, dismissed ? "/api/v1/onboarding/dismiss" : "/api/v1/onboarding/resume", {
        method: "POST",
      });
      setWizard(result.wizard);
      if (result.onboarding) {
        setOnboarding(result.onboarding);
        setPath(result.onboarding.path);
        setSelectedStep(workflowStepId(result.onboarding.path, result.onboarding.currentStep));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (wizard.dismissed) {
    return (
      <>
        <PageHead
          title="Initial Setup"
          lede="Guided setup is optional. Sidekick can operate from configuration supplied directly by the operator."
        />
        <ErrorCallout error={error} />
        <div className="card-standout phase3-action-card manual-setup-card">
          <div className="card-head">
            <h2>Using manual configuration</h2>
            <StatusBadge status="Wizard skipped" />
          </div>
          <p className="muted">
            Sidekick will continue using the configured manager principal, node, and API. Skipping
            does not mark activation checks complete and does not erase saved wizard progress.
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
        lede="Attach a running manager or prepare a fresh PoX-5 deployment. Sidekick verifies and generates artifacts; signing and broadcast stay outside the app."
        actions={
          <div className="setup-head-actions">
            <div className="seg">
              <button
                type="button"
                className={path === "attach" ? "on" : ""}
                onClick={() => void start("attach")}
              >
                Attach existing
              </button>
              <button
                type="button"
                className={path === "fresh" ? "on" : ""}
                onClick={() => void start("fresh")}
              >
                Fresh setup
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
      <div className="wizard phase3-wizard">
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
            <div className="card-standout phase3-action-card">
              <div className="card-head">
                <h2>{path === "attach" ? "Verify existing manager" : "Prepare fresh manager"}</h2>
                <StatusBadge status={data.preflight.status} />
              </div>
              {path === "attach" ? (
                <>
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
                          await api(token, "/api/v1/onboarding/start", {
                            method: "POST",
                            body: JSON.stringify({ path: "attach" }),
                          });
                        }
                        return api(token, "/api/v1/onboarding/attach/verify", {
                          method: "POST",
                          body: JSON.stringify({ managerPrincipal: data.managerPrincipal }),
                        });
                      })
                    }
                  >
                    <ShieldCheck /> Verify and attach
                  </button>
                </>
              ) : (
                <div className="form-grid">
                  <div className="archive-guidance" role="note">
                    <div>
                      <strong>Starting a new mainnet or testnet node?</strong>
                      <p>
                        Seed its chainstate from the Hiro Archive before launch to avoid syncing
                        from genesis. Verify the SHA-256 checksum, extract it into the node&apos;s
                        <code> working_dir</code>, then confirm the local block height is catching
                        up. Private networks should use their own network-specific bootstrap.
                      </p>
                    </div>
                    <a
                      href="https://docs.hiro.so/en/resources/archive/stacks-blockchain"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Hiro Archive guide <ArrowSquareOut aria-hidden="true" />
                    </a>
                  </div>
                  <Field
                    label="Manager admin principal"
                    help="Public principal only. No admin key is accepted."
                  >
                    <span className="copyable-input">
                      <input
                        className="input mono"
                        value={fresh.adminPrincipal}
                        onChange={(event) =>
                          setFresh({ ...fresh, adminPrincipal: event.target.value })
                        }
                      />
                      <CopyIdentifierButton
                        value={fresh.adminPrincipal}
                        label="manager admin principal"
                      />
                    </span>
                  </Field>
                  <Field label="Contract name">
                    <input
                      className="input mono"
                      value={fresh.contractName}
                      onChange={(event) => setFresh({ ...fresh, contractName: event.target.value })}
                    />
                  </Field>
                  <Field label="Signer grant auth ID">
                    <input
                      className="input mono"
                      inputMode="numeric"
                      value={fresh.authId}
                      onChange={(event) => setFresh({ ...fresh, authId: event.target.value })}
                    />
                  </Field>
                  <Field
                    label="Signer config path in generated instruction"
                    help="Sidekick does not open or read this path."
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
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        if (onboarding?.path !== "fresh") {
                          await api(token, "/api/v1/onboarding/start", {
                            method: "POST",
                            body: JSON.stringify({ path: "fresh" }),
                          });
                        }
                        return api(token, "/api/v1/onboarding/fresh/prepare", {
                          method: "POST",
                          body: JSON.stringify(fresh),
                        });
                      })
                    }
                  >
                    Prepare manager artifact
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="card-standout phase3-action-card">
              <div className="card-head">
                <h2>{active?.title ?? "Setup complete"}</h2>
                <StatusBadge status={active?.status ?? onboarding.status} />
              </div>
              <p className="muted setup-copy">{active?.detail}</p>
              {active?.command ? <pre className="code command-code">{active.command}</pre> : null}

              {path === "attach" ? (
                <div className="checklist">
                  {steps.map((step) => (
                    <div className="check-item" key={step.id}>
                      <span
                        className={`box ${step.status === "complete" ? "ok" : step.status === "blocked" ? "bad" : "wait"}`}
                      >
                        {step.status === "complete" ? <Check /> : <Warning />}
                      </span>
                      <div className="body">
                        <strong>{step.title}</strong>
                        <div className="m">{step.detail}</div>
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="btn btn-accent"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        api(token, "/api/v1/onboarding/attach/verify", {
                          method: "POST",
                          body: JSON.stringify({ managerPrincipal: data.managerPrincipal }),
                        }),
                      )
                    }
                  >
                    <ArrowClockwise /> Re-run verification
                  </button>
                </div>
              ) : null}

              {path === "fresh" && active?.id === "deploy-manager" ? (
                <div className="artifact-actions">
                  <button
                    type="button"
                    className="btn btn-accent"
                    onClick={() =>
                      void authenticatedDownload(token, "/api/v1/onboarding/artifacts/source")
                    }
                  >
                    <DownloadSimple /> Download .clar
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() =>
                      void authenticatedDownload(token, "/api/v1/onboarding/artifacts/manifest")
                    }
                  >
                    <DownloadSimple /> Download manifest
                  </button>
                  <button
                    type="button"
                    className="btn btn-tertiary"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        api(token, "/api/v1/onboarding/fresh/refresh", { method: "POST" }),
                      )
                    }
                  >
                    <ArrowClockwise /> Verify deployment
                  </button>
                  {onboarding.artifact.manifest ? (
                    <p className="help mono src src-chain">
                      source {onboarding.artifact.manifest.artifact.sourceSha256}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {path === "fresh" && active?.id === "signer-grant-ceremony" ? (
                <div className="form-grid">
                  {!onboarding.signerGrant.preparation ? (
                    <button
                      type="button"
                      className="btn btn-accent"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          api(token, "/api/v1/onboarding/fresh/grant/prepare", { method: "POST" }),
                        )
                      }
                    >
                      Prepare signer-host instruction
                    </button>
                  ) : (
                    <>
                      <pre className="code command-code">
                        {onboarding.signerGrant.preparation.command}
                      </pre>
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
                        label="Signer command JSON output"
                        help="Contains a public signer key and signature, never the signer private key."
                      >
                        <textarea
                          className="input code-input"
                          rows={10}
                          value={signerOutput}
                          onChange={(event) => setSignerOutput(event.target.value)}
                        />
                      </Field>
                      <button
                        type="button"
                        className="btn btn-accent"
                        disabled={busy || !signerOutput.trim()}
                        onClick={() =>
                          void run(() =>
                            api(token, "/api/v1/onboarding/fresh/grant/verify", {
                              method: "POST",
                              body: JSON.stringify({ signerOutput: JSON.parse(signerOutput) }),
                            }),
                          )
                        }
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
                <div className="form-grid">
                  <p className="muted">
                    Sign and broadcast this <span className="mono">register-self</span> call with
                    the external manager admin wallet.
                  </p>
                  <pre className="code command-code">
                    {JSON.stringify(onboarding.signerGrant.verified.registerSelfCall, null, 2)}
                  </pre>
                  <button
                    type="button"
                    className="btn btn-accent"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        api(token, "/api/v1/onboarding/fresh/refresh", { method: "POST" }),
                      )
                    }
                  >
                    <ArrowClockwise /> Verify registration
                  </button>
                </div>
              ) : null}

              {path === "fresh" && active?.id === "pool-policy" ? (
                <button
                  type="button"
                  className="btn btn-accent"
                  onClick={() => {
                    location.hash = "settings";
                  }}
                >
                  Open Settings
                </button>
              ) : null}

              {path === "fresh" && active?.id === "automation-identity" ? (
                <button
                  type="button"
                  className="btn btn-accent"
                  onClick={() => {
                    location.hash = "settings";
                  }}
                >
                  Configure automation identity
                </button>
              ) : null}

              {path === "fresh" && active?.id === "final-verification" ? (
                <button
                  type="button"
                  className="btn btn-accent"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      api(token, "/api/v1/onboarding/fresh/refresh", { method: "POST" }),
                    )
                  }
                >
                  <ArrowClockwise /> Refresh chain verification
                </button>
              ) : null}
            </div>
          )}
          <div className="callout callout-neutral setup-note">
            <ShieldCheck className="ic" />
            <div className="body">
              <strong>External authority stays external.</strong> Sidekick never accepts the manager
              admin key or signer private key, never signs these setup transactions, and never
              broadcasts them.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export function SettingsPage({
  data,
  token,
  setTheme,
}: {
  data: Phase3Snapshot;
  token: string;
  setTheme: (theme: "light" | "dark") => void;
}) {
  const [settings, setSettings] = useState<RuntimeSettings | null>(data.runtimeSettings ?? null);
  const [apiKeyAction, setApiKeyAction] = useState<"keep" | "clear" | "replace">("keep");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState("identity");

  useEffect(() => {
    void api<RuntimeSettings>(token, "/api/v1/settings")
      .then(setSettings)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [token]);

  const save = async () => {
    if (!settings) return;
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      const {
        audit: _audit,
        revision: _revision,
        schemaVersion: _schemaVersion,
        updatedAt: _updatedAt,
        ...editable
      } = settings;
      const result = await api<RuntimeSettings>(token, "/api/v1/settings", {
        method: "PUT",
        body: JSON.stringify({
          ...editable,
          dataSources: {
            nodeRpcUrl: editable.dataSources.nodeRpcUrl,
            apiUrl: editable.dataSources.apiUrl,
            apiKeyHeader: editable.dataSources.apiKeyHeader,
            apiKeyAction:
              apiKeyAction === "replace"
                ? { action: "replace", value: apiKey }
                : { action: apiKeyAction },
          },
        }),
      });
      setSettings(result);
      setApiKey("");
      setApiKeyAction("keep");
      setSaved(true);
      if (result.display.defaultTheme !== "system") setTheme(result.display.defaultTheme);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!settings) return <div className="loading-state">Loading settings</div>;
  const update = <K extends keyof RuntimeSettings>(section: K, value: RuntimeSettings[K]) =>
    setSettings({ ...settings, [section]: value });

  return (
    <>
      <PageHead
        title="Settings"
        lede="Configure the running deployment. Changes are validated, persisted, and audited; secrets are never returned to the browser."
        actions={
          <button
            type="button"
            className="btn btn-accent"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? "Saving" : "Save changes"}
          </button>
        }
      />
      <ErrorCallout error={error} />
      {saved ? (
        <div className="callout callout-info settings-saved">
          <Check className="ic" />
          <div className="body">Settings revision {settings.revision} is active.</div>
        </div>
      ) : null}
      <div className="grid cols-1-2 settings-grid">
        <nav className="set-nav">
          {(
            [
              ["identity", "Pool identity"],
              ["display", "Display"],
              ["sources", "Data sources"],
              ["policy", "Payout policy"],
              ["automation", "Automation & alerts"],
              ["security", "Access & security"],
              ["maintenance", "About & maintenance"],
            ] as const
          ).map(([id, label]) => (
            <button
              type="button"
              className={activeSection === id ? "active" : ""}
              key={id}
              onClick={() => {
                setActiveSection(id);
                document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        <div>
          <section className="card-standout set-section form-grid" id="identity">
            <div className="card-head">
              <h2>Pool identity</h2>
              <span className="muted">shown in the dashboard and generated pool card</span>
            </div>
            <Field label="Manager principal">
              <span className="copyable-input">
                <input className="input mono" readOnly value={data.managerPrincipal} />
                <CopyIdentifierButton value={data.managerPrincipal} label="manager principal" />
              </span>
            </Field>
            <Field label="Display name">
              <input
                className="input"
                value={settings.pool.displayName}
                onChange={(event) =>
                  update("pool", { ...settings.pool, displayName: event.target.value })
                }
              />
            </Field>
            <Field label="Website URL">
              <input
                className="input"
                type="url"
                value={settings.pool.websiteUrl}
                onChange={(event) =>
                  update("pool", { ...settings.pool, websiteUrl: event.target.value })
                }
              />
            </Field>
            <Field label="Support email or URL">
              <input
                className="input"
                value={settings.pool.supportContact}
                onChange={(event) =>
                  update("pool", { ...settings.pool, supportContact: event.target.value })
                }
              />
            </Field>
            <Field label="Leather enrollment URL">
              <input
                className="input"
                type="url"
                value={settings.pool.leatherUrl}
                onChange={(event) =>
                  update("pool", { ...settings.pool, leatherUrl: event.target.value })
                }
              />
            </Field>
          </section>

          <section className="card-standout set-section form-grid" id="display">
            <div className="card-head">
              <h2>Display preferences</h2>
            </div>
            <Field label="Default theme">
              <select
                className="input"
                value={settings.display.defaultTheme}
                onChange={(event) =>
                  update("display", {
                    ...settings.display,
                    defaultTheme: event.target.value as RuntimeSettings["display"]["defaultTheme"],
                  })
                }
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </Field>
            <Field label="Time zone" help="Formatting only. Scheduling remains burn-height-driven.">
              <input
                className="input"
                value={settings.display.timezone}
                onChange={(event) =>
                  update("display", { ...settings.display, timezone: event.target.value })
                }
              />
            </Field>
            <Field label="Time format">
              <select
                className="input"
                value={settings.display.timeFormat}
                onChange={(event) =>
                  update("display", {
                    ...settings.display,
                    timeFormat: event.target.value as RuntimeSettings["display"]["timeFormat"],
                  })
                }
              >
                <option value="relative">Relative</option>
                <option value="absolute">Absolute</option>
                <option value="both">Both</option>
              </select>
            </Field>
            <Field label="Number format">
              <select
                className="input"
                value={settings.display.numberFormat}
                onChange={(event) =>
                  update("display", {
                    ...settings.display,
                    numberFormat: event.target.value as RuntimeSettings["display"]["numberFormat"],
                  })
                }
              >
                <option value="1,234.5678">1,234.5678</option>
                <option value="1 234,5678">1 234,5678</option>
              </select>
            </Field>
          </section>

          <section className="card-standout set-section form-grid" id="sources">
            <div className="card-head">
              <h2>
                <Plugs /> Data sources
              </h2>
              <StatusBadge
                status={
                  data.preflight.status === "pass"
                    ? "Connected"
                    : data.preflight.status === "warn"
                      ? "Attention"
                      : "Unavailable"
                }
              />
            </div>
            <Field
              label="Stacks node RPC URL"
              help="Changing provider creates a separate node evidence identity."
            >
              <input
                className="input mono"
                type="url"
                value={settings.dataSources.nodeRpcUrl}
                onChange={(event) =>
                  update("dataSources", { ...settings.dataSources, nodeRpcUrl: event.target.value })
                }
              />
            </Field>
            <Field
              label="Stacks API URL"
              help="Changing provider preserves the old cursor and starts a provider-specific cursor."
            >
              <input
                className="input mono"
                type="url"
                value={settings.dataSources.apiUrl}
                onChange={(event) =>
                  update("dataSources", { ...settings.dataSources, apiUrl: event.target.value })
                }
              />
            </Field>
            <Field label="API key header">
              <input
                className="input mono"
                value={settings.dataSources.apiKeyHeader}
                onChange={(event) =>
                  update("dataSources", {
                    ...settings.dataSources,
                    apiKeyHeader: event.target.value,
                  })
                }
              />
            </Field>
            <Field
              label="API key"
              help={`Currently ${settings.dataSources.apiKeyConfigured ? `configured from ${settings.dataSources.apiKeySource}` : "not configured"}. The value is never returned.`}
            >
              <select
                className="input"
                value={apiKeyAction}
                onChange={(event) => setApiKeyAction(event.target.value as typeof apiKeyAction)}
              >
                <option value="keep">Keep current</option>
                <option value="replace">Replace</option>
                <option value="clear">Clear</option>
              </select>
            </Field>
            {apiKeyAction === "replace" ? (
              <Field label="New API key">
                <input
                  className="input mono"
                  type="password"
                  autoComplete="new-password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </Field>
            ) : null}
            <Field label="Forecast horizon">
              <div className="input-group">
                <input
                  inputMode="numeric"
                  value={settings.forecast.horizonCycles}
                  onChange={(event) => {
                    const value = event.target.valueAsNumber;
                    if (Number.isInteger(value)) update("forecast", { horizonCycles: value });
                  }}
                  type="number"
                  min={1}
                  max={96}
                />
                <span className="suffix">cycles</span>
              </div>
            </Field>
          </section>

          <section className="card-standout set-section form-grid" id="policy">
            <div className="card-head">
              <h2>Payout policy</h2>
              <span className="badge b-neutral">broadcast gates only</span>
            </div>
            <Field
              label="Minimum direct-sBTC payout"
              help="Delays a permissionless claim; never changes amount or recipient."
            >
              <div className="input-group">
                <input
                  className="mono"
                  inputMode="numeric"
                  value={settings.payoutPolicy.minimumDirectSbtcSats}
                  onChange={(event) =>
                    update("payoutPolicy", {
                      ...settings.payoutPolicy,
                      minimumDirectSbtcSats: event.target.value,
                    })
                  }
                />
                <span className="suffix">sats</span>
              </div>
            </Field>
            <Field label="Maximum transaction fee">
              <div className="input-group">
                <input
                  className="mono"
                  inputMode="numeric"
                  value={settings.payoutPolicy.maxTransactionFeeUstx}
                  onChange={(event) =>
                    update("payoutPolicy", {
                      ...settings.payoutPolicy,
                      maxTransactionFeeUstx: event.target.value,
                    })
                  }
                />
                <span className="suffix">uSTX</span>
              </div>
            </Field>
            <Field label="Rolling gas budget">
              <div className="input-group">
                <input
                  className="mono"
                  inputMode="numeric"
                  value={settings.payoutPolicy.rollingGasBudgetUstx}
                  onChange={(event) =>
                    update("payoutPolicy", {
                      ...settings.payoutPolicy,
                      rollingGasBudgetUstx: event.target.value,
                    })
                  }
                />
                <span className="suffix">uSTX</span>
              </div>
            </Field>
          </section>

          <section className="card-standout set-section form-grid" id="automation">
            <div className="card-head">
              <h2>Automation &amp; alerts</h2>
              <span className="badge b-info">Observe</span>
            </div>
            <Field
              label="Dedicated gas-payer principal"
              help="Public principal only. Key custody is configured later through a read-only secret mount."
            >
              <span className="copyable-input">
                <input
                  className="input mono"
                  value={settings.automation.gasPayerPrincipal}
                  onChange={(event) =>
                    update("automation", {
                      ...settings.automation,
                      gasPayerPrincipal: event.target.value,
                    })
                  }
                />
                <CopyIdentifierButton
                  value={settings.automation.gasPayerPrincipal}
                  label="gas-payer principal"
                />
              </span>
            </Field>
            <Field
              label="Webhook URL"
              help="Saved now for automation policy; webhook delivery is enabled in Phase 4."
            >
              <input
                className="input"
                type="url"
                value={settings.alerts.webhookUrl}
                onChange={(event) =>
                  update("alerts", { ...settings.alerts, webhookUrl: event.target.value })
                }
              />
            </Field>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={settings.alerts.criticalOnly}
                onChange={(event) =>
                  update("alerts", { ...settings.alerts, criticalOnly: event.target.checked })
                }
              />
              <span>Send critical alerts only</span>
            </label>
          </section>

          <section className="card set-section" id="security">
            <div className="card-head">
              <h2>Access &amp; security</h2>
            </div>
            <div className="statline">
              <span className="k">HTTP surface</span>
              <span className="v mono">loopback · authenticated</span>
            </div>
            <div className="statline">
              <span className="k">Settings revision</span>
              <span className="v mono">{settings.revision}</span>
            </div>
            {data.manager ? (
              <>
                <div className="statline">
                  <span className="k">Manager trust</span>
                  <span className="v">
                    {data.manager.source.tier === "reference-built-in"
                      ? "Reference — built in"
                      : data.manager.source.tier === "reference-render"
                        ? "Reference render — operator-installed"
                        : data.manager.source.tier === "custom-observe"
                          ? "Custom — read-only"
                          : "Not recognized — read-only"}
                  </span>
                </div>
                <div className="statline">
                  <span className="k">Installed profile store</span>
                  <span className="v">
                    {data.manager.installedProfiles.directory
                      ? `${data.manager.installedProfiles.loaded} loaded · ${data.manager.installedProfiles.issues.length} issue(s)`
                      : "Not configured"}
                  </span>
                </div>
                <div className="callout callout-info security-note">
                  <ShieldCheck className="ic" />
                  <div className="body">
                    <strong>
                      {data.manager.automationEligible
                        ? "Reference automation eligible."
                        : "Read-only operation."}
                    </strong>{" "}
                    {data.manager.automationEligibilityReason}
                  </div>
                </div>
                {data.manager.installedProfiles.issues.map((issue) => (
                  <div
                    className="callout callout-caution security-note"
                    key={`${issue.fileName ?? "directory"}-${issue.code}`}
                  >
                    <Warning className="ic" />
                    <div className="body">
                      <strong>{issue.fileName ?? "Profile directory"}:</strong> {issue.message}
                    </div>
                  </div>
                ))}
              </>
            ) : null}
            <div className="callout callout-critical security-note">
              <Key className="ic" />
              <div className="body">
                <strong>Never configurable here.</strong> Manager admin and signer private keys are
                rejected. The generated pool card does not expose Sidekick.
              </div>
            </div>
            {settings.audit.length ? (
              <div className="settings-audit">
                <h3>Recent changes</h3>
                {settings.audit.slice(0, 5).map((entry) => (
                  <div className="audit-row" key={`${entry.revision}-${entry.changedAt}`}>
                    <span className="mono">r{entry.revision}</span>
                    <span>{entry.changedFields.join(", ")}</span>
                    <time className="mono">{new Date(entry.changedAt).toLocaleString()}</time>
                  </div>
                ))}
              </div>
            ) : null}
          </section>

          <section className="card set-section" id="maintenance">
            <div className="card-head">
              <h2>About &amp; maintenance</h2>
              <span className="badge b-neutral">schema-managed</span>
            </div>
            <div className="statline">
              <span className="k">Backup</span>
              <span className="v">Online SQLite backup with integrity verification</span>
            </div>
            <pre className="code command-code">
              sidekick database backup /backups/sidekick.sqlite
            </pre>
            <div className="statline">
              <span className="k">Restore</span>
              <span className="v">
                Stop Sidekick, preserve the current database, replace it with the verified backup,
                then restart
              </span>
            </div>
            <div className="statline">
              <span className="k">Existing deployment</span>
              <span className="v">
                Keep the same manager principal and database path; re-run Attach Existing after
                changing providers or restoring
              </span>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

function formatUstx(value: string | undefined): string {
  if (!value) return "Unavailable";
  const amount = BigInt(value);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").slice(0, 4);
  return `${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

export function EnrollmentPage({ data: _data, token }: { data: Phase3Snapshot; token: string }) {
  const [mode, setMode] = useState<"live" | "static">("live");
  const [artifact, setArtifact] = useState<PoolCardArtifact | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setArtifact(
        await api(token, "/api/v1/pool-card/generate", {
          method: "POST",
          body: JSON.stringify({ mode }),
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [mode, token]);

  useEffect(() => {
    void generate();
  }, [generate]);

  const download = (format: "html" | "json") => {
    if (!artifact) return;
    const selected = format === "html" ? artifact : artifact.json;
    const url = URL.createObjectURL(new Blob([selected.body], { type: selected.contentType }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = selected.filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const enrollment = artifact?.enrollment;
  const current = enrollment?.eligibility.current;
  return (
    <>
      <PageHead
        title="Public Pool Page"
        lede="Generate an embeddable pool card for a website you already run. Sidekick hosts nothing and opens no public route."
        actions={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!artifact}
              onClick={() => download("html")}
            >
              <DownloadSimple /> Download .html
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!artifact}
              onClick={() => download("json")}
            >
              <DownloadSimple /> Download .json
            </button>
            <button
              type="button"
              className="btn btn-accent"
              disabled={busy}
              onClick={() => void generate()}
            >
              <ArrowClockwise /> Regenerate
            </button>
          </>
        }
      />
      <ErrorCallout error={error} />
      <div className="callout callout-info intro-callout">
        <ShieldCheck className="ic" />
        <div className="body">
          <strong>No public surface on this app.</strong> The artifact contains reviewed public pool
          facts only—never the API key, gas payer, jobs, alerts, or Sidekick database state.
        </div>
      </div>
      <div className="card-standout embed-mode">
        <div>
          <span className="muted">Embed type</span>
          <div className="seg">
            <button
              type="button"
              className={mode === "live" ? "on" : ""}
              onClick={() => setMode("live")}
            >
              Live card
            </button>
            <button
              type="button"
              className={mode === "static" ? "on" : ""}
              onClick={() => setMode("static")}
            >
              Static snapshot
            </button>
          </div>
        </div>
        <p className="tertiary">
          {mode === "live"
            ? "Refreshes reward cycle and burn height from the configured unauthenticated public API. Verified pool identity and manager facts remain baked in."
            : "Baked HTML plus versioned JSON with current verified values and no runtime network request."}
        </p>
      </div>
      <div className="grid cols-3-2 embed-grid">
        <div className="card">
          <div className="card-head">
            <h2>{mode === "live" ? "Self-contained live HTML" : "Self-contained static HTML"}</h2>
            <button
              type="button"
              className="btn btn-tertiary sm"
              disabled={!artifact}
              onClick={() => artifact && void navigator.clipboard.writeText(artifact.body)}
            >
              Copy
            </button>
          </div>
          <pre className="code">{artifact?.body ?? "Generating artifact"}</pre>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Artifact boundary</h2>
          </div>
          <div className="actions-list">
            <div className="action-item">
              <div className="ic">
                <Check />
              </div>
              <div className="body">
                <div className="t">Operator-maintained</div>
                <div className="m">Name, website, support, official enrollment link.</div>
              </div>
            </div>
            <div className="action-item">
              <div className="ic">
                <Check />
              </div>
              <div className="body">
                <div className="t">Verified public state</div>
                <div className="m">
                  Manager, signer public key, grant, fee, cycle, eligibility, source hash.
                </div>
              </div>
            </div>
            <div className="action-item">
              <div className="ic">
                <ShieldCheck />
              </div>
              <div className="body">
                <div className="t">Excluded</div>
                <div className="m">
                  Secrets, gas payer, automation jobs, transactions, alerts, and local history.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="section-title">Preview</div>
      <div className="preview-frame">
        <div className="pv-bar">
          <span className="mono">your-site.example / stacking</span>
          <span className="badge b-neutral">embedded card</span>
        </div>
        <div className="pv-body">
          {enrollment ? (
            <>
              <div className="preview-title">
                <div>
                  <h2>{enrollment.pool.displayName}</h2>
                  <p>
                    <CopyableIdentifier
                      value={enrollment.manager.principal}
                      label="manager principal"
                      className="mono"
                    />
                  </p>
                  <p>
                    source{" "}
                    <CopyableIdentifier
                      value={enrollment.manager.sourceSha256}
                      label="manager source hash"
                      className="mono src src-chain"
                    />
                  </p>
                </div>
                <StatusBadge
                  status={enrollment.signer.grantValid ? "Grant valid" : "Grant not verified"}
                />
              </div>
              <div className="grid cols-2">
                <div className="card-standout">
                  <div className="statline">
                    <span className="k">Reward cycle</span>
                    <span className="v mono src src-chain">{enrollment.chain.rewardCycleId}</span>
                  </div>
                  <div className="statline">
                    <span className="k">Pool size</span>
                    <span className="v mono src src-chain">
                      {formatUstx(current?.delegatedUstx)} STX
                    </span>
                  </div>
                </div>
                <div className="card-standout">
                  <div className="statline">
                    <span className="k">Eligibility</span>
                    <span className="v src src-chain">
                      <StatusBadge
                        status={
                          current?.meetsThreshold && current.inSignerSet
                            ? "Eligible"
                            : "Needs attention"
                        }
                      />
                    </span>
                  </div>
                  <div className="statline">
                    <span className="k">Configured fee</span>
                    <span className="v mono">
                      {(enrollment.fee.currentConfiguredBips / 100).toFixed(2)}%
                    </span>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="loading-state">Preview unavailable</div>
          )}
        </div>
      </div>
    </>
  );
}
