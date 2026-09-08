import type { RewardPrimaryAction } from "./reward-state.js";

const PENDING_RUN_STORAGE_KEY = "sidekick-rewards-pending-run";

/** Navigation carries identity, never an approval or a stale recipe. */
export function storeRewardHandoff(action: RewardPrimaryAction, scope: string): void {
  sessionStorage.setItem(
    PENDING_RUN_STORAGE_KEY,
    JSON.stringify({
      scope,
      cycle: action.cycle,
      distribution: action.distribution,
      kind: action.kind,
    }),
  );
}

export function consumeRewardHandoff(
  actions: readonly RewardPrimaryAction[],
  scope: string,
): RewardPrimaryAction | null {
  const saved = sessionStorage.getItem(PENDING_RUN_STORAGE_KEY);
  if (!saved) return null;
  sessionStorage.removeItem(PENDING_RUN_STORAGE_KEY);
  try {
    const target: unknown = JSON.parse(saved);
    if (!target || typeof target !== "object" || !("scope" in target) || target.scope !== scope)
      return null;
    return (
      actions.find(
        (action) =>
          "cycle" in target &&
          target.cycle === action.cycle &&
          "distribution" in target &&
          target.distribution === action.distribution &&
          "kind" in target &&
          target.kind === action.kind,
      ) ?? null
    );
  } catch {
    // Old kind-only handoffs are ambiguous; leave the operator to choose the exact card.
    return null;
  }
}
