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
      operatorReviewRequired: true;
      warnings: string[];
      network: string;
      adminPrincipal: string;
      artifact: { sourceSha256: string; canonicalSourceSha256: string };
      transaction: { contractName: string; clarityVersion: 6 };
    };
  };
  signerGrant: {
    preparation: null | { command: string; expectedMessageHashHex: string; authId: string };
    verified: null | {
      managerPrincipal: string;
      authId: string;
      signerKeyHex: string;
      signerSignatureHex: string;
      expectedMessageHashHex: string;
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

interface FreshRefreshResponse {
  onboarding: OnboardingState;
  preflight: Phase3Snapshot["preflight"];
  setup: NonNullable<Phase3Snapshot["setup"]>;
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
    nodeMetricsUrl: string;
    signerMonitoringUrl: string;
    hiroReferenceApiUrl: string;
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
    enrollmentWindow: {
      status: "open" | "prepare-phase" | "unknown";
      targetCycleId: number | null;
      preparePhaseStartBurnHeight: number | null;
      blocksUntilPreparePhase: number | null;
    };
    eligibility: {
      current: null | {
        cycleId: number;
        delegatedUstx: string;
        thresholdUstx: string;
        meetsThreshold: boolean;
        inSignerSet: boolean;
      };
      next: null | {
        cycleId: number;
        delegatedUstx: string;
        thresholdUstx: string;
        meetsThreshold: boolean;
        inSignerSet: boolean;
      };
    };
    checks: Array<{ id: string; status: "pass" | "warn" | "fail"; message: string }>;
  };
  preflight: {
    status: "pass" | "warn" | "fail";
    node: {
      serverVersion: string | null;
      version: string | null;
      commit: string | null;
      burnBlockHeight: number;
    };
    pox: {
      activationState: "active" | "scheduled" | "unavailable";
      blocksUntilActivation: number | null;
    };
    cycle: {
      currentId: number | null;
      nextId: number | null;
      preparePhaseStartBurnHeight: number | null;
      blocksUntilPreparePhase: number | null;
      rewardPhaseStartBurnHeight: number | null;
      blocksUntilRewardPhase: number | null;
      isPreparePhase: boolean | null;
    };
    compatibility: {
      status: "matched" | "unrecognized" | "inconsistent";
      profileId: string | null;
      profileRevision: number | null;
      profileLabel: string | null;
      origin: "built-in" | "operator-provided" | null;
      nodeBuildPreviouslyTested: boolean;
      reason: string;
    };
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
  const state = [
    "complete",
    "ready",
    "pass",
    "connected",
    "grant valid",
    "eligible",
    "activation scheduled",
    "signer active",
    "setup complete",
  ].includes(normalized)
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
  "Activate your signer",
];

function randomAuthId(): string {
  const values = new Uint32Array(2);
  globalThis.crypto.getRandomValues(values);
  return ((BigInt(values[0] ?? 0) << 32n) | BigInt(values[1] ?? 0)).toString();
}

type SignerActivationKind =
  | "stake-required"
  | "membership-pending"
  | "scheduled"
  | "active"
  | "window-closed"
  | "blocked"
  | "unknown";

interface SignerActivationView {
  kind: SignerActivationKind;
  badge: string;
  title: string;
  message: string;
  refreshLabel: string;
}

function signerActivationView(
  setup: Phase3Snapshot["setup"],
  preflight: Phase3Snapshot["preflight"],
): SignerActivationView {
  if (!setup) {
    return {
      kind: "unknown",
      badge: "Verification required",
      title: "Check signer activation",
      message: "Refresh chain status to read the manager's stake and signer-set membership.",
      refreshLabel: "Refresh chain status",
    };
  }
  if (setup.status === "blocked") {
    return {
      kind: "blocked",
      badge: "Activation blocked",
      title: "Signer activation is blocked",
      message:
        setup.checks.find(({ status }) => status === "fail")?.message ??
        "Resolve the failed setup check before continuing.",
      refreshLabel: "Refresh chain status",
    };
  }

  const current = setup.eligibility.current;
  const next = setup.eligibility.next;
  if (current?.meetsThreshold && current.inSignerSet) {
    return {
      kind: "active",
      badge: "Signer active",
      title: `Signer active for cycle ${current.cycleId}`,
      message: `The manager is eligible and in the signer set for cycle ${current.cycleId}.`,
      refreshLabel: "Refresh chain status",
    };
  }
  if (next?.meetsThreshold && next.inSignerSet) {
    const start = preflight.cycle.rewardPhaseStartBurnHeight;
    return {
      kind: "scheduled",
      badge: "Activation scheduled",
      title: `Activation scheduled for cycle ${next.cycleId}`,
      message: start
        ? `No action is required. Signing begins when cycle ${next.cycleId} starts at burn height ${start}.`
        : `No action is required. Signing begins when cycle ${next.cycleId} starts.`,
      refreshLabel: "Refresh chain status",
    };
  }
  if (next?.meetsThreshold && !next.inSignerSet) {
    return {
      kind: "membership-pending",
      badge: "Chain update pending",
      title: `Signer-set confirmation pending for cycle ${next.cycleId}`,
      message:
        "The stake threshold is met, but signer-set membership has not updated at this chain tip. Wait for the chain to advance, then refresh.",
      refreshLabel: "Refresh chain status",
    };
  }
  if (setup.enrollmentWindow.status === "prepare-phase") {
    const targetCycle = setup.enrollmentWindow.targetCycleId;
    return {
      kind: "window-closed",
      badge: "Enrollment closed",
      title: targetCycle ? `Cycle ${targetCycle} enrollment is closed` : "Enrollment is closed",
      message: targetCycle
        ? `Stake changes are closed for cycle ${targetCycle}. Target cycle ${targetCycle + 1} when enrollment reopens.`
        : "Stake changes are closed during the prepare phase. Target the next cycle when enrollment reopens.",
      refreshLabel: "Refresh chain status",
    };
  }
  if (setup.enrollmentWindow.status === "open" && next) {
    return {
      kind: "stake-required",
      badge: "Stake required",
      title: `Stake required for cycle ${next.cycleId}`,
      message: `Stake at least ${formatUstx(next.thresholdUstx)} STX total to this manager before the prepare phase begins.`,
      refreshLabel: "Refresh after staking",
    };
  }
  return {
    kind: "unknown",
    badge: "Window unknown",
    title: "Signer activation needs attention",
    message:
      "The node did not report a usable enrollment window. Refresh after the chain advances.",
    refreshLabel: "Refresh chain status",
  };
}

function combinedStepStatus(steps: Array<ActivationStep | undefined>): StepStatus {
  const values = steps.filter((step): step is ActivationStep => Boolean(step));
  if (values.length === 0) return "pending";
  if (values.some(({ status }) => status === "blocked")) return "blocked";
  if (values.some(({ status }) => status === "attention")) return "attention";
  if (values.every(({ status }) => status === "complete")) return "complete";
  if (values.some(({ status }) => status === "ready")) return "ready";
  return "pending";
}

function attachWorkflowSteps(raw: ActivationStep[]): ActivationStep[] {
  const status = combinedStepStatus(raw);
  return [
    {
      id: "attach-verification",
      title: "Verify existing manager",
      detail:
        status === "complete" || status === "ready"
          ? "Manager attached and operational checks passed"
          : status === "attention"
            ? "Manager attached; review the checks that need attention"
            : "Review the manager verification results",
      status,
      command: null,
    },
  ];
}

function freshWorkflowSteps(raw: ActivationStep[]): ActivationStep[] {
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
      id: "final-verification",
      title: "Activate your signer",
      detail:
        verificationSteps.find((step) => step?.status !== "complete")?.detail ??
        "Setup and pool information are ready",
      status: combinedStepStatus(verificationSteps),
      command: verificationSteps.find((step) => step?.status !== "complete")?.command ?? null,
    },
  ];
}

function workflowStepId(path: "attach" | "fresh", rawStep: string): string {
  if (path === "attach") return "attach-verification";
  if (["prepare-signer-grant", "verify-signer-grant"].includes(rawStep))
    return "signer-grant-ceremony";
  if (["verify-setup", "publish-enrollment-info"].includes(rawStep)) return "final-verification";
  return rawStep;
}

export function SetupPage({
  data,
  token,
  onOnboardingStarted,
}: {
  data: Phase3Snapshot;
  token: string;
  onOnboardingStarted: () => void;
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
    authId: randomAuthId(),
    signerConfigPath: "<SIGNER_CONFIG_PATH>",
  });
  const [signerOutput, setSignerOutput] = useState("");
  const [activationSnapshot, setActivationSnapshot] = useState({
    preflight: data.preflight,
    setup: data.setup,
  });

  useEffect(() => {
    setActivationSnapshot({ preflight: data.preflight, setup: data.setup });
  }, [data.preflight, data.setup]);

  const refreshFresh = useCallback(async () => {
    const result = await api<FreshRefreshResponse>(token, "/api/v1/onboarding/fresh/refresh", {
      method: "POST",
    });
    setActivationSnapshot({ preflight: result.preflight, setup: result.setup });
    return result;
  }, [token]);

  const load = useCallback(async () => {
    try {
      const result = await api<{
        onboarding: OnboardingState | null;
        wizard: OnboardingWizardState;
      }>(token, "/api/v1/onboarding");
      setWizard(result.wizard);
      if (result.onboarding) {
        onOnboardingStarted();
        setOnboarding(result.onboarding);
        setPath(result.onboarding.path);
        setSelectedStep(workflowStepId(result.onboarding.path, result.onboarding.currentStep));
        if (result.onboarding.freshInput) setFresh(result.onboarding.freshInput);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [onOnboardingStarted, token]);

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
      void refreshFresh()
        .then((result) => {
          setOnboarding(result.onboarding);
        })
        .catch(() => {
          // The manager may not be deployed yet; the visible manual refresh reports errors.
        });
    }, 20_000);
    return () => window.clearInterval(interval);
  }, [onboarding?.activationPlan, path, refreshFresh, selectedStep]);

  const run = async (action: () => Promise<{ onboarding: OnboardingState }>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      onOnboardingStarted();
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
    setSelectedStep(step.id);
    if (
      onboarding &&
      !["attach-verification", "signer-grant-ceremony", "final-verification"].includes(step.id)
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
                Attach Existing Contracts
              </button>
              <button
                type="button"
                className={path === "fresh" ? "on" : ""}
                onClick={() => void start("fresh")}
              >
                Deploy New Contracts
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
                  <div className="callout callout-info" role="note">
                    <ShieldCheck className="ic" />
                    <div className="body">
                      Sidekick will read the configured manager and verify its source, PoX-5
                      registration, signer grant, and next-cycle eligibility. This is read-only and
                      does not change the manager or broadcast a transaction.
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
                        Sidekick generates the deployment files, verifies the resulting contract,
                        and guides signer authorization. You sign and broadcast the deployment and
                        registration transactions outside Sidekick.
                      </div>
                    </div>
                  </div>
                  <div className="archive-guidance" role="note">
                    <div>
                      <strong>Node and signer setup stay outside Sidekick.</strong>
                      <p>
                        Before continuing, confirm that the node and API are synced, the signer is
                        running, you know its configuration path, and the manager admin wallet is
                        funded. A new public-network node can use the verified Hiro chainstate
                        archive instead of syncing from genesis.
                      </p>
                    </div>
                    <div className="stacked-doc-links">
                      <a
                        href="https://docs.stacks.co/operate/readme/run-a-node-with-docker"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Node setup <ArrowSquareOut aria-hidden="true" />
                      </a>
                      <a
                        href="https://docs.stacks.co/operate/run-a-signer/signer-quickstart"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Signer quickstart <ArrowSquareOut aria-hidden="true" />
                      </a>
                      <a
                        href="https://docs.hiro.so/en/resources/archive/stacks-blockchain"
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
                    help="Absolute path to the signer TOML on the signer host. Sidekick inserts it into the command but never reads it."
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
                    Generate deployment files
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="card-standout phase3-action-card">
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
                <p className="muted setup-copy">{active?.detail}</p>
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
                      Sidekick is observing this manager without changing chain state. Attention
                      items do not prevent monitoring; blocked items prevent an operational pool.
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
                        <strong>Signer authorization must be repaired externally.</strong> The
                        existing manager needs a new signer grant and{" "}
                        <span className="mono">register-self</span> call. Guided repair for an
                        existing manager is not yet available; Sidekick will continue read-only
                        monitoring and can re-check the result afterward.
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
                          api(token, "/api/v1/onboarding/attach/verify", {
                            method: "POST",
                            body: JSON.stringify({ managerPrincipal: data.managerPrincipal }),
                          }),
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
                      Sidekick checked the configured node, API, network identity, and active PoX-5
                      contract. It cannot verify the external signer installation or admin-wallet
                      funding.
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
                      Sidekick generated the manager source from the approved network profile and
                      recorded its immutable deployment values. Review and download the files before
                      deploying the contract.
                    </div>
                  </div>
                  <div className="artifact-actions">
                    <button
                      type="button"
                      className="btn btn-secondary"
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
                    {onboarding.artifact.manifest ? (
                      <p className="help mono src src-chain">
                        source {onboarding.artifact.manifest.artifact.sourceSha256}
                      </p>
                    ) : null}
                  </div>

                  {onboarding.artifact.manifest ? (
                    <div className="deploy-instructions">
                      <h3>Deploy outside Sidekick</h3>
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
                          <strong>{onboarding.artifact.manifest.transaction.clarityVersion}</strong>
                        </span>
                      </div>
                      <div className="deployment-options">
                        <div>
                          <strong>Wallet / Explorer</strong>
                          <p>
                            Connect the funded admin wallet to the same network, open Deploy
                            Contract, paste the <span className="mono">.clar</span> source, and copy
                            the contract name from the manifest.
                          </p>
                          <a
                            href="https://explorer.hiro.so/sandbox/deploy"
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open Explorer Sandbox <ArrowSquareOut />
                          </a>
                        </div>
                        <div>
                          <strong>Clarinet CLI</strong>
                          <p>
                            Add the <span className="mono">.clar</span> file to a Clarinet project,
                            configure the same network and deployer, then generate, review, and
                            apply a deployment plan using the manifest values.
                          </p>
                          <a
                            href="https://docs.stacks.co/clarinet/contract-deployment"
                            target="_blank"
                            rel="noreferrer"
                          >
                            Clarinet deployment guide <ArrowSquareOut />
                          </a>
                        </div>
                      </div>
                      <p className="deploy-warning">
                        Keep the admin key in your wallet or CLI. After the transaction confirms,
                        return here and verify the deployed source before continuing.
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
                        Your signer signs the live PoX-5 authorization for this manager. Sidekick
                        verifies the public result and uses it to prepare the registration call in
                        the next step; it never accesses the signer key or broadcasts a transaction.
                      </div>
                    </div>
                  </div>
                  {!onboarding.signerGrant.preparation ? (
                    <>
                      <ol className="ceremony-steps">
                        <li>
                          Click <strong>Generate signer command</strong>. Sidekick reads the live
                          grant hash using the auth ID and signer config path entered earlier.
                        </li>
                        <li>
                          Sidekick will then show the exact command to run on the signer host.
                        </li>
                      </ol>
                      <button
                        type="button"
                        className="btn btn-accent"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            api(token, "/api/v1/onboarding/fresh/grant/prepare", {
                              method: "POST",
                            }),
                          )
                        }
                      >
                        Generate signer command
                      </button>
                    </>
                  ) : (
                    <>
                      <ol className="ceremony-steps">
                        <li>
                          Copy and run the command below on the machine running your signer. It must
                          have <span className="mono">stacks-signer</span> and access to the listed
                          signer configuration file.
                        </li>
                        <li>
                          Copy the complete JSON object printed by the command. It contains only the
                          public signer key, signature, manager, and auth ID.
                        </li>
                        <li>
                          Paste that JSON below and click <strong>Verify signer output</strong>.
                          Sidekick will reject output for a different manager, auth ID, or live
                          grant hash.
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
                <div className="registration-handoff">
                  <div className="callout callout-info">
                    <ShieldCheck className="ic" />
                    <div className="body">
                      <strong>Register the manager with PoX-5.</strong> This call grants the
                      verified signer key to the manager and registers the manager in one
                      transaction. Sign and broadcast it with the manager admin wallet; Sidekick
                      never receives the key or broadcasts the transaction.
                    </div>
                  </div>

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
                              ? `Burn height ${enrollmentCloseHeight}`
                              : "Unavailable"}
                        </strong>
                        {activationSetup?.enrollmentWindow.status === "open" &&
                        blocksUntilEnrollmentClose !== null ? (
                          <small>{blocksUntilEnrollmentClose} blocks remaining</small>
                        ) : null}
                      </div>
                    </div>

                    <div className="activation-manager">
                      <span>Manager</span>
                      <strong className="mono">{data.managerPrincipal}</strong>
                    </div>

                    {activation.kind === "stake-required" ? (
                      <p className="activation-next-step">
                        Have participants complete stake transactions through supported wallet or
                        enrollment tools. Sidekick only verifies the resulting chain state.
                      </p>
                    ) : null}
                    {activation.kind === "scheduled" && signingStartHeight ? (
                      <p className="activation-next-step">
                        Signing begins at burn height {signingStartHeight}. No further setup action
                        is required.
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
  const [sourceTest, setSourceTest] = useState<{
    kind: "node-metrics" | "signer-monitoring" | "hiro-reference";
    state: "testing" | "connected" | "failed";
    detail: string;
  } | null>(null);
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
            nodeMetricsUrl: editable.dataSources.nodeMetricsUrl,
            signerMonitoringUrl: editable.dataSources.signerMonitoringUrl,
            hiroReferenceApiUrl: editable.dataSources.hiroReferenceApiUrl,
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
  const testHealthSource = async (
    kind: "node-metrics" | "signer-monitoring" | "hiro-reference",
    url: string,
  ) => {
    setSourceTest({ kind, state: "testing", detail: "Connecting…" });
    try {
      const result = await api<{ status: "connected"; signals: number }>(
        token,
        "/api/v1/health/test-source",
        { method: "POST", body: JSON.stringify({ kind, url }) },
      );
      setSourceTest({
        kind,
        state: "connected",
        detail: `Connected · ${result.signals} recognized signals`,
      });
    } catch (cause) {
      setSourceTest({
        kind,
        state: "failed",
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  return (
    <div className="settings-page">
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
        <div className="settings-scroll">
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
            <div className="archive-guidance" role="note">
              <div>
                <strong>
                  Network compatibility: {data.preflight.compatibility.status.replace("-", " ")}
                </strong>
                <p>
                  {data.preflight.compatibility.reason}.
                  {data.preflight.compatibility.profileId ? (
                    <>
                      {" "}
                      Profile{" "}
                      <span className="mono">
                        {data.preflight.compatibility.profileLabel ??
                          data.preflight.compatibility.profileId}
                      </span>{" "}
                      revision {data.preflight.compatibility.profileRevision ?? "unknown"} is{" "}
                      {data.preflight.compatibility.origin === "operator-provided"
                        ? "operator-provided setup data and cannot authorize automation"
                        : "built into Sidekick"}
                      .
                    </>
                  ) : null}{" "}
                  Node build{" "}
                  <span className="mono">
                    {data.preflight.node.version ?? data.preflight.node.serverVersion ?? "unknown"}
                    {data.preflight.node.commit ? ` (${data.preflight.node.commit})` : ""}
                  </span>{" "}
                  is diagnostic; compatible upgrades do not require a Sidekick release.
                </p>
              </div>
              <div className="stacked-doc-links">
                <a
                  href="https://docs.stacks.co/operate/readme/run-a-node-with-docker"
                  target="_blank"
                  rel="noreferrer"
                >
                  Node setup <ArrowSquareOut aria-hidden="true" />
                </a>
                <a
                  href="https://docs.stacks.co/operate/run-a-signer/signer-quickstart"
                  target="_blank"
                  rel="noreferrer"
                >
                  Signer quickstart <ArrowSquareOut aria-hidden="true" />
                </a>
                <a
                  href="https://docs.stacks.co/reference/node-operations/signer-configuration"
                  target="_blank"
                  rel="noreferrer"
                >
                  Signer configuration <ArrowSquareOut aria-hidden="true" />
                </a>
              </div>
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
            <Field label="Node metrics URL" help="Optional Prometheus endpoint from stacks-core.">
              <div className="field-inline-action">
                <input
                  className="input mono"
                  type="url"
                  placeholder="http://stacks-node:9153"
                  value={settings.dataSources.nodeMetricsUrl}
                  onChange={(event) =>
                    update("dataSources", {
                      ...settings.dataSources,
                      nodeMetricsUrl: event.target.value,
                    })
                  }
                />
                <button
                  type="button"
                  className="btn btn-tertiary"
                  disabled={!settings.dataSources.nodeMetricsUrl || sourceTest?.state === "testing"}
                  onClick={() =>
                    void testHealthSource("node-metrics", settings.dataSources.nodeMetricsUrl)
                  }
                >
                  Test
                </button>
              </div>
              {sourceTest?.kind === "node-metrics" ? (
                <span className={sourceTest.state === "failed" ? "field-error" : "muted"}>
                  {sourceTest.detail}
                </span>
              ) : null}
            </Field>
            <Field
              label="Signer monitoring URL"
              help="Optional signer base URL exposing /info, /heartbeat, and /metrics."
            >
              <div className="field-inline-action">
                <input
                  className="input mono"
                  type="url"
                  placeholder="http://stacks-signer:9153"
                  value={settings.dataSources.signerMonitoringUrl}
                  onChange={(event) =>
                    update("dataSources", {
                      ...settings.dataSources,
                      signerMonitoringUrl: event.target.value,
                    })
                  }
                />
                <button
                  type="button"
                  className="btn btn-tertiary"
                  disabled={
                    !settings.dataSources.signerMonitoringUrl || sourceTest?.state === "testing"
                  }
                  onClick={() =>
                    void testHealthSource(
                      "signer-monitoring",
                      settings.dataSources.signerMonitoringUrl,
                    )
                  }
                >
                  Test
                </button>
              </div>
              {sourceTest?.kind === "signer-monitoring" ? (
                <span className={sourceTest.state === "failed" ? "field-error" : "muted"}>
                  {sourceTest.detail}
                </span>
              ) : null}
            </Field>
            <Field
              label="Hiro reference API URL"
              help="Public comparison source. The network default normally needs no change."
            >
              <div className="field-inline-action">
                <input
                  className="input mono"
                  type="url"
                  value={settings.dataSources.hiroReferenceApiUrl}
                  onChange={(event) =>
                    update("dataSources", {
                      ...settings.dataSources,
                      hiroReferenceApiUrl: event.target.value,
                    })
                  }
                />
                <button
                  type="button"
                  className="btn btn-tertiary"
                  disabled={
                    !settings.dataSources.hiroReferenceApiUrl || sourceTest?.state === "testing"
                  }
                  onClick={() =>
                    void testHealthSource(
                      "hiro-reference",
                      settings.dataSources.hiroReferenceApiUrl,
                    )
                  }
                >
                  Test
                </button>
              </div>
              {sourceTest?.kind === "hiro-reference" ? (
                <span className={sourceTest.state === "failed" ? "field-error" : "muted"}>
                  {sourceTest.detail}
                </span>
              ) : null}
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
    </div>
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
