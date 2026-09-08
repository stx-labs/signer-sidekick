import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeRewardHandoff, storeRewardHandoff } from "./reward-handoff.js";
import type { RewardPrimaryAction } from "./reward-state.js";

const action = (cycle: number, distribution: 1 | 2): RewardPrimaryAction => ({
  kind: "collect",
  label: "Collect",
  operations: ["claim-rewards"],
  transactions: 1,
  cycle,
  distribution,
});

describe("Overview reward handoff", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      setItem: (key: string, value: string) => values.set(key, value),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("targets the exact cycle, distribution and kind, and consumes only once", () => {
    const target = action(141, 2);
    storeRewardHandoff(target, "mainnet:manager");
    const actions = [action(140, 1), action(141, 1), target];
    expect(consumeRewardHandoff(actions, "mainnet:manager")).toBe(target);
    expect(consumeRewardHandoff(actions, "mainnet:manager")).toBeNull();
  });

  it("does not redirect a stale target or another manager into a same-kind action", () => {
    storeRewardHandoff(action(141, 2), "mainnet:manager");
    expect(consumeRewardHandoff([action(142, 1)], "mainnet:manager")).toBeNull();
    storeRewardHandoff(action(141, 2), "mainnet:manager");
    expect(consumeRewardHandoff([action(141, 2)], "testnet:manager")).toBeNull();
    sessionStorage.setItem("sidekick-rewards-pending-run", "collect");
    expect(consumeRewardHandoff([action(141, 2)], "mainnet:manager")).toBeNull();
  });
});
