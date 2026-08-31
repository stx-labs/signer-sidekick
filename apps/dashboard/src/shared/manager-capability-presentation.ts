import type {
  ManagerActionCapability,
  ManagerActionCapabilityId,
} from "@stx-labs/signer-sidekick-api-contracts";

export type ManagerCapabilityState = "Available" | "Observe only" | "Not provided";

export const MANAGER_CAPABILITY_LABELS: Readonly<Record<ManagerActionCapabilityId, string>> = {
  "register-self": "Signer registration",
  "update-admin": "Admin management",
  "update-fees": "Fee settings",
  "withdraw-fees": "Fee withdrawal",
  "sweep-fee-refunds": "Fee-refund sweep",
  "reference-reward-claims": "Reward distribution",
};

export function managerCapabilityState(
  capability: ManagerActionCapability,
): ManagerCapabilityState {
  if (capability.executionAvailable) return "Available";
  if (capability.interfaceAvailable) return "Observe only";
  return "Not provided";
}

export function managerCapabilityExplanation(capability: ManagerActionCapability): string {
  const state = managerCapabilityState(capability);
  if (state === "Available") {
    const adapter = capability.adapter;
    return adapter
      ? `Sidekick matched this deployment to reviewed adapter ${adapter.id} revision ${adapter.revision}.`
      : "Sidekick matched this operation to a reviewed capability adapter.";
  }
  if (state === "Observe only") {
    return "This manager exposes the required interface, but its deployed behavior does not match a reviewed adapter for this operation.";
  }
  const missing = capability.missingFunctions;
  return missing.length > 0
    ? `This manager does not expose the functions Sidekick requires for this operation: ${missing.join(", ")}.`
    : "This manager does not expose the functions Sidekick requires for this operation.";
}

export function summarizeManagerCapabilities(actions: readonly ManagerActionCapability[]): {
  state: ManagerCapabilityState | "Partial";
  detail: string;
  hasUnavailable: boolean;
} {
  const counts: Record<ManagerCapabilityState, number> = {
    Available: 0,
    "Observe only": 0,
    "Not provided": 0,
  };
  for (const action of actions) counts[managerCapabilityState(action)] += 1;

  const parts = (Object.entries(counts) as Array<[ManagerCapabilityState, number]>)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${count} ${state.toLowerCase()}`);
  const state =
    counts.Available === actions.length && actions.length > 0
      ? "Available"
      : counts.Available > 0
        ? "Partial"
        : counts["Observe only"] > 0
          ? "Observe only"
          : "Not provided";
  return {
    state,
    detail: parts.join(" · ") || "No operation capabilities reported",
    hasUnavailable: counts["Observe only"] > 0 || counts["Not provided"] > 0,
  };
}
