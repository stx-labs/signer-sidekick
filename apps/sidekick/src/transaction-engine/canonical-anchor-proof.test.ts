import { describe, expect, it, vi } from "vitest";
import type { ChainAnchor } from "../chain-anchor.js";
import type { ApiStatus, StacksBlockSummary } from "../chain-clients.js";
import { proveCanonicalAnchorRelationship } from "./canonical-anchor-proof.js";

const planned: ChainAnchor = {
  stacksBlockHeight: 100,
  indexBlockHash: `0x${"11".repeat(32)}`,
  burnBlockHeight: 50,
  rewardCycle: 2,
  rewardCycleLength: 10,
  prepareCycleLength: 2,
  cyclePosition: 5,
  phase: "reward",
  checkpoint: "second-half",
};
const live: ChainAnchor = {
  ...planned,
  stacksBlockHeight: 105,
  indexBlockHash: `0x${"22".repeat(32)}`,
  burnBlockHeight: 55,
  rewardCycle: 3,
  cyclePosition: 0,
  checkpoint: "first-half",
};

function status(height = 110, hash = `0x${"aa".repeat(32)}`): ApiStatus {
  return {
    server_version: "stacks-blockchain-api v9",
    status: "ready",
    chain_tip: {
      block_height: height,
      block_hash: `0x${"bb".repeat(32)}`,
      index_block_hash: hash,
      burn_block_height: 60,
    },
  };
}

function block(anchor: ChainAnchor, canonical = true): StacksBlockSummary {
  return {
    canonical,
    height: anchor.stacksBlockHeight,
    hash: `0x${"cc".repeat(32)}`,
    index_block_hash: anchor.indexBlockHash,
    parent_block_hash: `0x${"dd".repeat(32)}`,
    parent_index_block_hash: `0x${"ee".repeat(32)}`,
    burn_block_height: anchor.burnBlockHeight,
  };
}

describe("canonical anchor proof", () => {
  it("proves same-chain descendants by canonical height under one stable API fence", async () => {
    const api = {
      getStatus: vi.fn().mockResolvedValue(status()),
      getBlock: vi.fn(async (height: number) => block(height === 100 ? planned : live)),
    };
    await expect(proveCanonicalAnchorRelationship(api, planned, live)).resolves.toMatchObject({
      status: "proven",
      apiTipHeight: 110,
    });
    expect(api.getBlock).toHaveBeenNthCalledWith(1, 100);
    expect(api.getBlock).toHaveBeenNthCalledWith(2, 105);
  });

  it("proves the same anchor with one canonical-height lookup", async () => {
    const api = {
      getStatus: vi.fn().mockResolvedValue(status()),
      getBlock: vi.fn().mockResolvedValue(block(planned)),
    };
    await expect(proveCanonicalAnchorRelationship(api, planned, planned)).resolves.toMatchObject({
      status: "proven",
    });
    expect(api.getBlock).toHaveBeenCalledOnce();
  });

  it("rejects older live anchors and a stable canonical-height mismatch", async () => {
    const api = {
      getStatus: vi.fn().mockResolvedValue(status()),
      getBlock: vi.fn(async (height: number) =>
        height === planned.stacksBlockHeight
          ? block({ ...planned, indexBlockHash: `0x${"99".repeat(32)}` })
          : block(live),
      ),
    };
    await expect(proveCanonicalAnchorRelationship(api, live, planned)).resolves.toEqual({
      status: "invalid",
      reason: "planned-anchor-after-live-anchor",
    });
    await expect(proveCanonicalAnchorRelationship(api, planned, live)).resolves.toEqual({
      status: "invalid",
      reason: "planned-anchor-mismatch",
    });
  });

  it("rejects an explicitly noncanonical planned block, including at the same height", async () => {
    const api = {
      getStatus: vi.fn().mockResolvedValue(status()),
      getBlock: vi.fn().mockResolvedValue(block(planned, false)),
    };
    await expect(proveCanonicalAnchorRelationship(api, planned, planned)).resolves.toEqual({
      status: "invalid",
      reason: "planned-anchor-noncanonical",
    });
  });

  it("retries tip movement and fails closed when the API never stabilizes", async () => {
    const api = {
      getStatus: vi
        .fn()
        .mockResolvedValueOnce(status(110, `0x${"aa".repeat(32)}`))
        .mockResolvedValueOnce(status(111, `0x${"ab".repeat(32)}`))
        .mockResolvedValueOnce(status(111, `0x${"ab".repeat(32)}`))
        .mockResolvedValueOnce(status(112, `0x${"ac".repeat(32)}`)),
      getBlock: vi.fn(async (height: number) => block(height === 100 ? planned : live)),
    };
    await expect(proveCanonicalAnchorRelationship(api, planned, live)).resolves.toEqual({
      status: "unavailable",
      reason: "api-tip-unstable",
    });
    expect(api.getBlock).toHaveBeenCalledTimes(4);
  });

  it("retains rather than disproves on an unavailable API or a stale live snapshot", async () => {
    await expect(
      proveCanonicalAnchorRelationship(
        { getStatus: vi.fn().mockRejectedValue(new Error("offline")), getBlock: vi.fn() },
        planned,
        live,
      ),
    ).resolves.toEqual({ status: "unavailable", reason: "api-unavailable" });
    const staleApi = {
      getStatus: vi.fn().mockResolvedValue(status()),
      getBlock: vi.fn(async (height: number) =>
        height === planned.stacksBlockHeight
          ? block(planned)
          : block({ ...live, indexBlockHash: `0x${"ff".repeat(32)}` }),
      ),
    };
    await expect(proveCanonicalAnchorRelationship(staleApi, planned, live)).resolves.toEqual({
      status: "unavailable",
      reason: "live-anchor-stale",
    });
  });
});
