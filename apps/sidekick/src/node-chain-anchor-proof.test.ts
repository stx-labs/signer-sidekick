import { describe, expect, it, vi } from "vitest";
import type { ChainAnchor } from "./chain-anchor.js";
import { nodeProvesChainAnchorCanonical } from "./node-chain-anchor-proof.js";

function anchor(
  stacksBlockHeight: number,
  byte: string,
  overrides: Partial<ChainAnchor> = {},
): ChainAnchor {
  return {
    stacksBlockHeight,
    indexBlockHash: `0x${byte.repeat(64)}`,
    burnBlockHeight: 960_000,
    rewardCycle: 142,
    rewardCycleLength: 2_100,
    prepareCycleLength: 100,
    cyclePosition: 200,
    phase: "reward",
    checkpoint: "first-half",
    ...overrides,
  };
}

describe("local node chain-anchor proof", () => {
  it("accepts an unchanged anchor without extra node reads", async () => {
    const value = anchor(100, "a");
    const node = {
      getNakamotoBlockById: vi.fn(),
      getNakamotoBlockAtHeight: vi.fn(),
    };

    await expect(nodeProvesChainAnchorCanonical(node, value, value)).resolves.toBe(true);
    expect(node.getNakamotoBlockById).not.toHaveBeenCalled();
    expect(node.getNakamotoBlockAtHeight).not.toHaveBeenCalled();
  });

  it("accepts normal forward movement when both local-node reads identify the same ancestor", async () => {
    const captured = anchor(100, "a");
    const live = anchor(103, "b", { burnBlockHeight: 960_001, cyclePosition: 201 });
    const block = Uint8Array.of(1, 2, 3);
    const node = {
      getNakamotoBlockById: vi.fn(async () => block),
      getNakamotoBlockAtHeight: vi.fn(async () => Uint8Array.of(1, 2, 3)),
    };

    await expect(nodeProvesChainAnchorCanonical(node, captured, live)).resolves.toBe(true);
    expect(node.getNakamotoBlockById).toHaveBeenCalledWith(captured.indexBlockHash);
    expect(node.getNakamotoBlockAtHeight).toHaveBeenCalledWith(captured.stacksBlockHeight, {
      tip: live.indexBlockHash,
    });
  });

  it("rejects a reorged or unverifiable captured block", async () => {
    const captured = anchor(100, "a");
    const live = anchor(103, "b");
    const node = {
      getNakamotoBlockById: vi.fn(async () => Uint8Array.of(1, 2, 3)),
      getNakamotoBlockAtHeight: vi.fn(async () => Uint8Array.of(4, 5, 6)),
    };

    await expect(nodeProvesChainAnchorCanonical(node, captured, live)).resolves.toBe(false);
    node.getNakamotoBlockAtHeight.mockRejectedValueOnce(new Error("node unavailable"));
    await expect(nodeProvesChainAnchorCanonical(node, captured, live)).resolves.toBe(false);
  });

  it("rejects a captured height ahead of the live anchor", async () => {
    const captured = anchor(103, "a");
    const live = anchor(100, "b");
    const node = {
      getNakamotoBlockById: vi.fn(),
      getNakamotoBlockAtHeight: vi.fn(),
    };

    await expect(nodeProvesChainAnchorCanonical(node, captured, live)).resolves.toBe(false);
    expect(node.getNakamotoBlockById).not.toHaveBeenCalled();
  });
});
