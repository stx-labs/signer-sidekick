import { describe, expect, it, vi } from "vitest";
import { readManagerActivity } from "./manager-activity.js";

const manager = "SP000000000000000000002Q6VF78.signer-manager";
const staker = "SP000000000000000000002Q6VF78.staker";

describe("manager activity projection", () => {
  it("uses the normalized unbounded projection for claims and withdrawals", () => {
    const listManagerClaims = vi.fn().mockReturnValue({
      items: [
        {
          txId: `0x${"11".repeat(32)}`,
          eventIndex: 0,
          blockHeight: 101,
          stakerPrincipal: staker,
          rewardCycle: "141",
          bondIndex: null,
          amountSats: "10000",
          destination: "bitcoin-l1",
          withdrawalRequestId: "72",
        },
      ],
      total: 2_105,
      offset: 2_050,
      limit: 50,
    });
    const listManagerWithdrawals = vi
      .fn()
      .mockReturnValueOnce({
        items: [
          {
            requestId: "72",
            stakerPrincipal: staker,
            amountSats: "9000",
            maxFeeSats: "1000",
            initiatedTxId: `0x${"11".repeat(32)}`,
            initiatedBlockHeight: 101,
            state: "settled",
            resolvedTxId: `0x${"22".repeat(32)}`,
            resolvedBlockHeight: 102,
          },
        ],
        total: 700,
        offset: 0,
        limit: 50,
      })
      .mockReturnValueOnce({ items: [], total: 12, offset: 0, limit: 1 });
    const activity = readManagerActivity(
      {
        listManagerClaims,
        listManagerWithdrawals,
        getManagerActivityMetadata: () => ({ eventCount: 2_805, latestBlockHeight: 102 }),
      },
      1,
      manager,
      { claimOffset: 2_050 },
    );

    expect(activity).toMatchObject({
      claimTotal: 2_105,
      withdrawalTotal: 700,
      pendingWithdrawalTotal: 12,
      eventCount: 2_805,
      latestBlockHeight: 102,
    });
    expect(activity.withdrawals).toEqual([
      expect.objectContaining({ requestId: "72", state: "settled", resolvedBlockHeight: 102 }),
    ]);
    expect(listManagerClaims).toHaveBeenCalledWith(1, manager, {
      limit: 50,
      offset: 2_050,
      rewardCycle: null,
    });
  });

  it("forwards independent claim and withdrawal sort orders", () => {
    const listManagerClaims = vi
      .fn()
      .mockReturnValue({ items: [], total: 0, offset: 0, limit: 50 });
    const listManagerWithdrawals = vi
      .fn()
      .mockReturnValueOnce({ items: [], total: 0, offset: 0, limit: 50 })
      .mockReturnValueOnce({ items: [], total: 0, offset: 0, limit: 1 });

    readManagerActivity(
      {
        listManagerClaims,
        listManagerWithdrawals,
        getManagerActivityMetadata: () => ({ eventCount: 0, latestBlockHeight: null }),
      },
      1,
      manager,
      {
        claimSort: "amount",
        claimDirection: "asc",
        withdrawalSort: "max-fee",
        withdrawalDirection: "desc",
      },
    );

    expect(listManagerClaims).toHaveBeenCalledWith(1, manager, {
      limit: 50,
      offset: 0,
      rewardCycle: null,
      sort: "amount",
      direction: "asc",
    });
    expect(listManagerWithdrawals).toHaveBeenNthCalledWith(1, 1, manager, {
      limit: 50,
      offset: 0,
      state: null,
      sort: "max-fee",
      direction: "desc",
    });
  });

  it("reconstructs the current admin set only after a complete event-history sync", () => {
    const common = {
      listManagerClaims: () => ({ items: [], total: 0, offset: 0, limit: 50 }),
      listManagerWithdrawals: () => ({ items: [], total: 0, offset: 0, limit: 50 }),
      getManagerActivityMetadata: () => ({ eventCount: 2, latestBlockHeight: 102 }),
      listManagerAdminUpdates: () => [
        {
          adminPrincipal: "SP000000000000000000002Q6VF78.second-admin",
          enabled: true,
          transactionIndex: 2,
          blockHeight: 101,
          eventIndex: 0,
        },
        {
          adminPrincipal: "SP000000000000000000002Q6VF78",
          enabled: false,
          transactionIndex: 3,
          blockHeight: 101,
          eventIndex: 0,
        },
      ],
    };
    const complete = readManagerActivity(
      { ...common, getCursor: () => ({ cursor: null }) },
      1,
      manager,
      { sourceId: "api:mainnet:test", eventVocabulary: "reference-manager-v1" },
    );
    const incomplete = readManagerActivity(
      { ...common, getCursor: () => ({ cursor: "older-page" }) },
      1,
      manager,
      { sourceId: "api:mainnet:test", eventVocabulary: "reference-manager-v1" },
    );
    const generic = readManagerActivity(
      { ...common, getCursor: () => ({ cursor: null }) },
      1,
      manager,
      { sourceId: "api:mainnet:test", eventVocabulary: "generic-v1" },
    );
    const inferredReference = readManagerActivity(
      {
        ...common,
        getCursor: (_sourceId, stream) =>
          stream.includes("reference-manager-v1")
            ? { cursor: null, updatedAt: "2026-08-13T12:01:00.000Z" }
            : { cursor: null, updatedAt: "2026-08-13T12:00:00.000Z" },
      },
      1,
      manager,
      { sourceId: "api:mainnet:test" },
    );

    expect(complete.admins).toEqual({
      status: "current",
      principals: ["SP000000000000000000002Q6VF78.second-admin"],
      updatesObserved: 2,
    });
    expect(incomplete.admins).toEqual({
      status: "sync-required",
      principals: [],
      updatesObserved: 2,
    });
    expect(generic.admins).toEqual({
      status: "sync-required",
      principals: [],
      updatesObserved: 2,
    });
    expect(inferredReference.admins.status).toBe("current");
  });
});
