import type { ActivationStep, OperatorSnapshot } from "@stx-labs/signer-sidekick-api-contracts";
import { formatUstx } from "../../shared/format.js";

type StepStatus = ActivationStep["status"];

export const attachLabels = [
  "Verify sources",
  "Verify manager",
  "Verify registration",
  "Verify signer grant",
  "Check eligibility",
  "Publish pool information",
];

export const freshLabels = [
  "Prerequisites",
  "Manager artifact",
  "Deploy manager",
  "Signer grant ceremony",
  "Register manager",
  "Activate your signer",
];

export function randomAuthId(): string {
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

export function signerActivationView(
  setup: OperatorSnapshot["setup"],
  preflight: OperatorSnapshot["preflight"],
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
        ? `No action is required. Signing begins when cycle ${next.cycleId} starts at Bitcoin block ${start}.`
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
        "The stake threshold is met, but signer-set membership has not updated at this Stacks chain tip. Wait for the chain to advance, then refresh.",
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

export function attachWorkflowSteps(raw: ActivationStep[]): ActivationStep[] {
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

export function freshWorkflowSteps(raw: ActivationStep[]): ActivationStep[] {
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

export function workflowStepId(path: "attach" | "fresh", rawStep: string): string {
  if (path === "attach") return "attach-verification";
  if (["prepare-signer-grant", "verify-signer-grant"].includes(rawStep))
    return "signer-grant-ceremony";
  if (["verify-setup", "publish-enrollment-info"].includes(rawStep)) return "final-verification";
  return rawStep;
}
