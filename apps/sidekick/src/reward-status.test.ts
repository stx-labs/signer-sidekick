import { bufferCV, noneCV, someCV, tupleCV, uintCV } from "@stacks/transactions";
import { describe, expect, it, vi } from "vitest";
import { type RewardStatusStore, readStxRewardStatus } from "./reward-status.js";
import type { SignerStakerRun, StoredCycleMembership } from "./storage/store.js";

const manager = "SP000000000000000000002Q6VF78.signer-manager";
const pox5 = "SP000000000000000000002Q6VF78.pox-5";
const sourceId = "api:mainnet:test";
const stakerOne = "SP000000000000000000002Q6VF78";
const stakerTwo = "SP2JXKMSH007NPYAQHKJPQMAQYAD90NQGTVJVQ02B";
const completedRun: SignerStakerRun = {
  runId: "1f53f216-71c3-4b72-865d-53e81a426bc8",
  sourceId,
  managerPrincipal: manager,
  status: "completed",
  cursor: null,
  pagesProcessed: 1,
  itemsProcessed: 2,
  startedAt: "2026-07-14T12:00:00.000Z",
  updatedAt: "2026-07-14T12:01:00.000Z",
  completedAt: "2026-07-14T12:01:00.000Z",
};

function membership(stakerPrincipal: string, active = true): StoredCycleMembership {
  return {
    stakerPrincipal,
    rewardCycle: 141n,
    signerPrincipal: manager,
    amountUstx: 50_000_000_000n,
    active,
  };
}

function store(run: SignerStakerRun | null = completedRun): RewardStatusStore {
  return {
    getLatestCompletedSignerStakerRun: vi.fn().mockReturnValue(run),
    listCycleMembershipsForCycle: vi
      .fn()
      .mockReturnValue([membership(stakerOne), membership(stakerTwo)]),
    putRewardCycleSnapshot: vi.fn(),
  };
}

function options(projectionStore: RewardStatusStore, callReadOnly: ReturnType<typeof vi.fn>) {
  return {
    store: projectionStore,
    node: {
      callReadOnly,
      getDataVar: vi.fn().mockResolvedValue(uintCV(500n)),
      getMapEntry: vi.fn().mockResolvedValue(someCV(uintCV(500n))),
    },
    sourceId,
    managerPrincipal: manager,
    pox5ContractId: pox5,
    rewardCycle: 141,
    observedAt: "2026-07-14T12:02:00.000Z",
    burnBlockHeight: 960_240,
    stacksTipHeight: 8_600_000,
  };
}

function rewards(earned: bigint, fees: bigint) {
  return tupleCV({ earned: uintCV(earned), fees: uintCV(fees) });
}

function l1Preference(maxFee: bigint) {
  return someCV(
    tupleCV({
      "max-fee": uintCV(maxFee),
      "pox-addr": tupleCV({
        version: bufferCV(Uint8Array.of(0)),
        hashbytes: bufferCV(new Uint8Array(20).fill(7)),
      }),
    }),
  );
}

describe("STX-only reward status", () => {
  it("shows per-staker earnings, payout policy, and manager liabilities", async () => {
    const projectionStore = store();
    const callReadOnly = vi
      .fn()
      .mockResolvedValueOnce(uintCV(960_000n))
      .mockResolvedValueOnce(uintCV(1_000n))
      .mockResolvedValueOnce(uintCV(2_000n))
      .mockResolvedValueOnce(uintCV(30_000n))
      .mockResolvedValueOnce(uintCV(999n))
      .mockResolvedValueOnce(uintCV(40_000n))
      .mockResolvedValueOnce(uintCV(141n))
      .mockResolvedValueOnce(rewards(9_500n, 500n))
      .mockResolvedValueOnce(noneCV())
      .mockResolvedValueOnce(rewards(4_000n, 200n))
      .mockResolvedValueOnce(l1Preference(5_000n));

    const result = await readStxRewardStatus(options(projectionStore, callReadOnly));

    expect(result).toMatchObject({
      status: "ready",
      global: {
        lastRewardComputeBurnHeight: "960000",
        lastComputedRewardCycle: "141",
        rewardsPerToken: "999",
        signerEarnedBeforeManagerClaimSats: "40000",
      },
      manager: {
        configuredFeeBips: "500",
        feeSnapshotBips: "500",
        earnedFeesSats: "1000",
        withdrawalLiabilitySats: "2000",
        unclaimedStakerRewardsSats: "30000",
      },
      totals: {
        stakers: 2,
        grossSats: "14200",
        earnedSats: "13500",
        feeSats: "700",
        actionableClaims: 1,
        l1ClaimsWaitingForFeeThreshold: 1,
      },
    });
    expect(result.stakers).toMatchObject([
      {
        stakerPrincipal: stakerOne,
        payout: { kind: "direct-sbtc", poxAddress: null, maxFeeSats: null },
        claimableByPolicy: true,
      },
      {
        stakerPrincipal: stakerTwo,
        payout: {
          kind: "bitcoin-l1",
          poxAddress: { versionHex: "00", hashbytesHex: "07".repeat(20) },
          maxFeeSats: "5000",
        },
        claimableByPolicy: false,
      },
    ]);
    expect(projectionStore.putRewardCycleSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        managerPrincipal: manager,
        rewardCycle: 141,
        totals: expect.objectContaining({ stakers: 2, grossSats: "14200" }),
        stakers: expect.arrayContaining([
          expect.objectContaining({ stakerPrincipal: stakerOne }),
          expect.objectContaining({ stakerPrincipal: stakerTwo }),
        ]),
      }),
    );
    expect(callReadOnly).toHaveBeenCalledTimes(11);
  });

  it("keeps global and manager state visible when no local roster is available", async () => {
    const projectionStore = store(null);
    const callReadOnly = vi
      .fn()
      .mockResolvedValueOnce(uintCV(0n))
      .mockResolvedValueOnce(uintCV(0n))
      .mockResolvedValueOnce(uintCV(0n))
      .mockResolvedValueOnce(uintCV(0n))
      .mockResolvedValueOnce(uintCV(0n))
      .mockResolvedValueOnce(uintCV(0n));

    const result = await readStxRewardStatus(options(projectionStore, callReadOnly));

    expect(result.status).toBe("attention");
    expect(result.ingestion).toBeNull();
    expect(result.stakers).toEqual([]);
    expect(result.totals.stakers).toBe(0);
    expect(projectionStore.listCycleMembershipsForCycle).not.toHaveBeenCalled();
  });

  it("keeps an inactive departed staker in the requested historical cycle", async () => {
    const projectionStore = store();
    vi.mocked(projectionStore.listCycleMembershipsForCycle).mockReturnValue([
      membership(stakerOne, false),
    ]);
    const callReadOnly = vi
      .fn()
      .mockResolvedValueOnce(uintCV(0n))
      .mockResolvedValueOnce(uintCV(0n))
      .mockResolvedValueOnce(uintCV(0n))
      .mockResolvedValueOnce(uintCV(0n))
      .mockResolvedValueOnce(uintCV(0n))
      .mockResolvedValueOnce(uintCV(0n))
      .mockResolvedValueOnce(rewards(10_000n, 0n))
      .mockResolvedValueOnce(noneCV());

    const result = await readStxRewardStatus(options(projectionStore, callReadOnly));

    expect(result.stakers).toMatchObject([{ stakerPrincipal: stakerOne }]);
    expect(result.totals).toMatchObject({ stakers: 1, earnedSats: "10000" });
    expect(projectionStore.listCycleMembershipsForCycle).toHaveBeenCalledWith(
      manager,
      141,
      sourceId,
    );
  });

  it("distinguishes a missing fee snapshot from an explicit zero-bips snapshot", async () => {
    const projectionStore = store(null);
    const callReadOnly = vi.fn().mockResolvedValue(uintCV(0n));
    const missingOptions = options(projectionStore, callReadOnly);
    vi.mocked(missingOptions.node.getDataVar).mockResolvedValue(uintCV(250n));
    vi.mocked(missingOptions.node.getMapEntry).mockResolvedValue(noneCV());

    await expect(readStxRewardStatus(missingOptions)).resolves.toMatchObject({
      manager: { configuredFeeBips: "250", feeSnapshotBips: null },
    });

    const zeroOptions = options(projectionStore, vi.fn().mockResolvedValue(uintCV(0n)));
    vi.mocked(zeroOptions.node.getMapEntry).mockResolvedValue(someCV(uintCV(0n)));
    await expect(readStxRewardStatus(zeroOptions)).resolves.toMatchObject({
      manager: { configuredFeeBips: "500", feeSnapshotBips: "0" },
    });
  });
});
