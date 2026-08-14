import {
  bufferCV,
  cvToHex,
  noneCV,
  principalCV,
  someCV,
  tupleCV,
  uintCV,
} from "@stacks/transactions";
import { describe, expect, it, vi } from "vitest";
import type { ChainAnchor } from "./chain-anchor.js";
import {
  discoverStakerClaims,
  type RewardStatusStore,
  readRewardOutlook,
  readStxRewardStatus,
} from "./reward-status.js";
import type { SignerStakerRun, StoredCycleMembership } from "./storage/store.js";

const manager = "SP000000000000000000002Q6VF78.signer-manager";
const pox5 = "SP000000000000000000002Q6VF78.pox-5";
const sourceId = "api:mainnet:test";
const stakerOne = "SP000000000000000000002Q6VF78";
const stakerTwo = "SP2JXKMSH007NPYAQHKJPQMAQYAD90NQGTVJVQ02B";
const chainAnchor: ChainAnchor = {
  stacksBlockHeight: 8_600_000,
  indexBlockHash: `0x${"ab".repeat(32)}`,
  burnBlockHeight: 960_240,
  rewardCycle: 141,
  rewardCycleLength: 2_100,
  prepareCycleLength: 100,
  cyclePosition: 240,
  phase: "reward",
  checkpoint: "first-half",
};
const completedRun: SignerStakerRun = {
  runId: "1f53f216-71c3-4b72-865d-53e81a426bc8",
  sourceId,
  managerPrincipal: manager,
  status: "completed",
  authoritative: true,
  reconciliationComplete: true,
  chainAnchor,
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
    putRewardOutlookObservation: vi.fn(),
  };
}

function options(
  projectionStore: RewardStatusStore,
  callReadOnly: ReturnType<typeof vi.fn>,
  anchor?: ChainAnchor,
) {
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
    ...(anchor ? { chainAnchor: anchor } : {}),
  };
}

/**
 * Dispatches on the read being made instead of on call order. The reward status now issues a
 * variable number of reads -- one set per candidate bond bucket -- so an ordered mock would have to
 * be re-counted every time the bucket window moves.
 */
function nodeReads(
  overrides: {
    perStaker?: Record<string, ReturnType<typeof rewards> | ReturnType<typeof l1Preference>>;
    firstBondPeriodCycle?: bigint;
    bondBuckets?: Record<string, { shares?: bigint; earned?: bigint; rewardsPerToken?: bigint }>;
    stxEarned?: bigint;
    stxShares?: bigint;
    lastRewardComputeHeight?: bigint;
    globalAccruedRewards?: bigint;
    managerUnclaimedSats?: bigint;
  } = {},
) {
  return vi.fn(
    async (_principal: string, functionName: string, _sender: string, args: string[] = []) => {
      const bondIndexArg = args.at(-1);
      const isStxBucket = bondIndexArg === cvToHex(noneCV());
      const bondKey =
        Object.keys(overrides.bondBuckets ?? {}).find(
          (index) => cvToHex(someCV(uintCV(BigInt(index)))) === bondIndexArg,
        ) ?? "";
      switch (functionName) {
        case "get-last-reward-compute-height":
          return uintCV(overrides.lastRewardComputeHeight ?? 960_000n);
        case "get-new-rewards":
          return uintCV(overrides.globalAccruedRewards ?? 25_000n);
        case "burn-height-to-reward-cycle":
          return uintCV(141n);
        case "bond-period-to-reward-cycle":
          return uintCV(overrides.firstBondPeriodCycle ?? 141n);
        case "get-earned-fees":
          return uintCV(1_000n);
        case "get-withdrawal-liability":
          return uintCV(2_000n);
        case "get-unclaimed-staker-rewards":
          return uintCV(overrides.managerUnclaimedSats ?? 30_000n);
        case "get-rewards-per-token-for-cycle":
          return uintCV(
            isStxBucket ? 999n : (overrides.bondBuckets?.[bondKey]?.rewardsPerToken ?? 0n),
          );
        case "get-earned":
          return uintCV(
            isStxBucket
              ? (overrides.stxEarned ?? 40_000n)
              : (overrides.bondBuckets?.[bondKey]?.earned ?? 0n),
          );
        case "get-signer-shares-staked-for-cycle":
          return uintCV(
            isStxBucket
              ? (overrides.stxShares ?? 0n)
              : (overrides.bondBuckets?.[bondKey]?.shares ?? 0n),
          );
        case "get-earned-staker-rewards": {
          const staker = stakerFor(args[0]);
          const scoped = overrides.perStaker?.[`${staker}@${isStxBucket ? "stx" : bondKey}`];
          return scoped ?? overrides.perStaker?.[staker] ?? rewards(0n, 0n);
        }
        case "get-pox-addr":
          return overrides.perStaker?.[`pox:${stakerFor(args[0])}`] ?? noneCV();
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
    },
  );
}

/** Reads carry principals as hex-encoded Clarity values; map one back to the fixture's name. */
function stakerFor(encoded: string | undefined): string {
  for (const candidate of [stakerOne, stakerTwo]) {
    if (cvToHex(principalCV(candidate)) === encoded) return candidate;
  }
  return "";
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
  it("reads and persists exact PoX-5 outlook without a signer-manager adapter", async () => {
    const projectionStore = store();
    const outlook = await readRewardOutlook({
      store: projectionStore,
      node: { callReadOnly: nodeReads({ globalAccruedRewards: 123_456n }) },
      managerPrincipal: manager,
      pox5ContractId: pox5,
      observedAt: "2026-07-14T12:02:00.000Z",
      chainAnchor,
    });

    expect(outlook).toMatchObject({
      pox5ContractId: pox5,
      accrued: { globalSats: "123456", source: "pox5-get-new-rewards" },
      calculation: {
        state: "ahead",
        observedLastRewardComputeBurnHeight: "960000",
      },
    });
    expect(projectionStore.putRewardOutlookObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        managerPrincipal: manager,
        globalAccruedRewardsSats: "123456",
        chainAnchor,
      }),
    );
  });

  it("schedules the second-half calculation after the first-half calculation completes", async () => {
    const secondHalfAnchor: ChainAnchor = {
      ...chainAnchor,
      burnBlockHeight: 961_200,
      cyclePosition: 1_200,
      checkpoint: "second-half",
    };
    const outlook = await readRewardOutlook({
      store: store(),
      node: {
        callReadOnly: nodeReads({ lastRewardComputeHeight: 961_049n }),
      },
      managerPrincipal: manager,
      pox5ContractId: pox5,
      observedAt: "2026-07-14T12:02:00.000Z",
      chainAnchor: secondHalfAnchor,
    });

    expect(outlook.calculation).toMatchObject({
      state: "completed",
      targetRewardCycle: 141,
      targetCheckpoint: "first-half",
      next: {
        state: "scheduled",
        targetRewardCycle: 141,
        targetCheckpoint: "second-half",
        calculationBurnHeight: 962_099,
        eligibleBurnHeight: 962_100,
        blocksRemaining: 900,
      },
    });
  });

  it("shows per-staker earnings, payout policy, and manager liabilities", async () => {
    const projectionStore = store();
    const callReadOnly = nodeReads({
      perStaker: {
        [stakerOne]: rewards(9_500n, 500n),
        [stakerTwo]: rewards(4_000n, 200n),
        [`pox:${stakerTwo}`]: l1Preference(5_000n),
      },
    });

    const result = await readStxRewardStatus(options(projectionStore, callReadOnly));

    expect(result).toMatchObject({
      status: "ready",
      global: {
        lastRewardComputeBurnHeight: "960000",
        lastComputedRewardCycle: "141",
        globalAccruedRewardsSats: "25000",
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
    expect(projectionStore.putRewardOutlookObservation).not.toHaveBeenCalled();
  });

  it("keeps global and manager state visible when no local roster is available", async () => {
    const projectionStore = store(null);
    const callReadOnly = nodeReads({ stxEarned: 0n });

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
    const callReadOnly = nodeReads({
      stxEarned: 0n,
      perStaker: { [stakerOne]: rewards(10_000n, 0n) },
    });

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

  it("pins every manager read and excludes membership from another anchor", async () => {
    const projectionStore = store({
      ...completedRun,
      chainAnchor: { ...chainAnchor, indexBlockHash: `0x${"cd".repeat(32)}` },
    });
    const callReadOnly = vi.fn().mockResolvedValue(uintCV(0n));
    const anchoredOptions = options(projectionStore, callReadOnly, chainAnchor);

    const result = await readStxRewardStatus(anchoredOptions);

    expect(result.ingestion).toBeNull();
    expect(projectionStore.listCycleMembershipsForCycle).not.toHaveBeenCalled();
    for (const call of callReadOnly.mock.calls) {
      expect(call[4]).toEqual({ tip: chainAnchor.indexBlockHash });
    }
    expect(anchoredOptions.node.getDataVar).toHaveBeenCalledWith(manager, "fees-bips", {
      tip: chainAnchor.indexBlockHash,
    });
    expect(anchoredOptions.node.getMapEntry).toHaveBeenCalledWith(
      manager,
      "fee-bips-for-cycle",
      expect.any(String),
      { tip: chainAnchor.indexBlockHash },
    );
  });

  it("reads bond buckets and reports each settleable tuple as its own transaction", async () => {
    const projectionStore = store();
    vi.mocked(projectionStore.listCycleMembershipsForCycle).mockReturnValue([
      membership(stakerOne),
    ]);
    const callReadOnly = nodeReads({
      // Cycle 141 with bond period 0 opening at 141 puts exactly one bond bucket in range.
      firstBondPeriodCycle: 141n,
      bondBuckets: { "0": { shares: 100_000n, earned: 2_000n, rewardsPerToken: 42n } },
      perStaker: {
        [`${stakerOne}@stx`]: rewards(9_000n, 1_000n),
        [`${stakerOne}@0`]: rewards(1_800n, 200n),
      },
    });

    const result = await readStxRewardStatus(options(projectionStore, callReadOnly));

    expect(result.buckets).toMatchObject([
      { bondIndex: null, participating: true },
      { bondIndex: "0", managerSharesSats: "100000", participating: true },
    ]);
    expect(result.global.signerEarnedAcrossBucketsSats).toBe("42000");
    // The snapshot itself reads only the STX bucket per staker; the per-bucket expansion is the
    // paged discovery path, so a large roster cannot multiply the refresh cost by the bucket count.
    expect(result.stakers[0]?.claims).toHaveLength(1);
    expect(result.stakers[0]?.claims[0]?.bondIndex).toBeNull();

    const discovery = await discoverStakerClaims({
      node: options(projectionStore, callReadOnly).node,
      managerPrincipal: manager,
      rewardCycle: 141,
      stakerPrincipals: [stakerOne],
      bondIndices: [0n],
    });
    expect(discovery.stakers[0]?.claims).toMatchObject([
      { bondIndex: null, claimable: true, rewards: { earnedSats: "9000" } },
      { bondIndex: "0", claimable: true, rewards: { earnedSats: "1800" } },
    ]);
    expect(discovery.settlement).toEqual({
      scope: "page",
      stakersScanned: 1,
      outstandingClaims: 2,
      transactionCount: 2,
      totalNetSats: "10800",
      blockedClaims: 0,
    });
  });

  it("refuses to count a claim the manager would reject", async () => {
    const projectionStore = store();
    vi.mocked(projectionStore.listCycleMembershipsForCycle).mockReturnValue([
      membership(stakerOne),
      membership(stakerTwo),
    ]);
    const callReadOnly = nodeReads({
      firstBondPeriodCycle: 141n,
      bondBuckets: { "0": { shares: 100_000n, earned: 2_000n } },
      perStaker: {
        // Nothing settled in either bucket: calling would hit ERR_NO_CLAIMABLE_REWARDS.
        [`${stakerOne}@stx`]: rewards(0n, 0n),
        [`${stakerOne}@0`]: rewards(0n, 0n),
        // An L1 payout under the staker's own max-fee, which the manager rejects outright.
        [`${stakerTwo}@stx`]: rewards(1_000n, 0n),
        [`${stakerTwo}@0`]: rewards(0n, 0n),
        [`pox:${stakerTwo}`]: l1Preference(5_000n),
      },
    });

    const result = await readStxRewardStatus(options(projectionStore, callReadOnly));

    const discovery = await discoverStakerClaims({
      node: options(projectionStore, callReadOnly).node,
      managerPrincipal: manager,
      rewardCycle: 141,
      stakerPrincipals: [stakerOne, stakerTwo],
      bondIndices: [0n],
    });

    expect(discovery.stakers[0]?.claims.every(({ claimable }) => !claimable)).toBe(true);
    expect(discovery.stakers[0]?.claims[0]?.blockedReason).toBe("nothing-settled");
    expect(discovery.stakers[1]?.claims[0]).toMatchObject({
      claimable: false,
      blockedReason: "l1-below-max-fee",
    });
    expect(discovery.settlement).toEqual({
      scope: "page",
      stakersScanned: 2,
      outstandingClaims: 0,
      transactionCount: 0,
      totalNetSats: "0",
      blockedClaims: 1,
    });
    // The status snapshot must not have paid for that expansion.
    expect(result.stakers.every(({ claims }) => claims.length === 1)).toBe(true);
  });

  it("refuses a staker claim page large enough to become the crawl it replaced", async () => {
    await expect(
      discoverStakerClaims({
        node: options(store(), nodeReads()).node,
        managerPrincipal: manager,
        rewardCycle: 141,
        stakerPrincipals: Array.from({ length: 101 }, () => stakerOne),
        bondIndices: [],
      }),
    ).rejects.toThrow(/at most 100 stakers per page/);
  });

  it("keeps bond buckets out of range when the schedule has not reached the cycle", async () => {
    const projectionStore = store();
    vi.mocked(projectionStore.listCycleMembershipsForCycle).mockReturnValue([
      membership(stakerOne),
    ]);
    const callReadOnly = nodeReads({
      // The first bond period opens after the observed cycle, so no bucket can hold shares yet.
      firstBondPeriodCycle: 200n,
      perStaker: { [`${stakerOne}@stx`]: rewards(500n, 0n) },
    });

    const result = await readStxRewardStatus(options(projectionStore, callReadOnly));

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]?.bondIndex).toBeNull();
    expect(result.stakers[0]?.claims).toHaveLength(1);
  });

  it("reports a pending global calculation instead of implying stale local data", async () => {
    const projectionStore = store();
    const pending = await readStxRewardStatus(
      options(
        projectionStore,
        nodeReads({ stxEarned: 0n, lastRewardComputeHeight: 959_000n }),
        chainAnchor,
      ),
    );

    // The anchor's first-half checkpoint expects the previous cycle's calculation at 959_999.
    // The chain is behind that, so nobody has run the permissionless `calculate-rewards` yet --
    // which is a pending global call, not stale local data.
    expect(pending.calculation).toMatchObject({
      state: "pending",
      targetRewardCycle: 140,
      targetCheckpoint: "second-half",
      expectedLastRewardComputeBurnHeight: 959_999,
      observedLastRewardComputeBurnHeight: "959000",
      next: {
        state: "due",
        targetRewardCycle: 140,
        targetCheckpoint: "second-half",
        calculationBurnHeight: 959_999,
        eligibleBurnHeight: 960_000,
        blocksRemaining: 0,
      },
    });
    expect(projectionStore.putRewardOutlookObservation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        globalAccruedRewardsSats: "25000",
        calculationState: "pending",
        chainAnchor,
      }),
    );

    const completed = await readStxRewardStatus(
      options(
        projectionStore,
        nodeReads({ stxEarned: 0n, lastRewardComputeHeight: 959_999n }),
        chainAnchor,
      ),
    );
    expect(completed.calculation.state).toBe("completed");
    expect(completed.calculation.next).toEqual({
      state: "scheduled",
      targetRewardCycle: 141,
      targetCheckpoint: "first-half",
      calculationBurnHeight: 961_049,
      eligibleBurnHeight: 961_050,
      blocksRemaining: 810,
    });
  });

  it("never labels a claim ready that wallet-intent preparation would refuse", async () => {
    const projectionStore = store();
    vi.mocked(projectionStore.listCycleMembershipsForCycle).mockReturnValue([
      membership(stakerOne),
      membership(stakerTwo),
    ]);
    // Discovery and preparation must apply the same ladder. Each staker below trips a different
    // rung, and a "Ready" label on any of them would send the operator to a call that reverts.
    const callReadOnly = nodeReads({
      // The manager holds nothing: it has not claimed these rewards in yet.
      managerUnclaimedSats: 0n,
      perStaker: { [stakerOne]: rewards(9_000n, 1_000n) },
    });

    const notPulledIn = await discoverStakerClaims({
      node: options(projectionStore, callReadOnly).node,
      managerPrincipal: manager,
      rewardCycle: 141,
      stakerPrincipals: [stakerOne],
      bondIndices: [],
    });
    expect(notPulledIn.stakers[0]?.claims[0]).toMatchObject({
      claimable: false,
      blockedReason: "manager-has-not-claimed",
    });
    expect(notPulledIn.settlement).toMatchObject({ transactionCount: 0, blockedClaims: 1 });

    // Clears the staker's fee budget but leaves a withdrawal at the dust limit, which
    // sbtc-withdrawal rejects with `(> amount DUST_LIMIT)`.
    const atDust = await discoverStakerClaims({
      node: options(
        projectionStore,
        nodeReads({
          managerUnclaimedSats: 1_000_000n,
          perStaker: {
            [stakerOne]: rewards(1_046n, 0n),
            [`pox:${stakerOne}`]: l1Preference(500n),
          },
        }),
      ).node,
      managerPrincipal: manager,
      rewardCycle: 141,
      stakerPrincipals: [stakerOne],
      bondIndices: [],
    });
    expect(atDust.stakers[0]?.claims[0]).toMatchObject({
      claimable: false,
      blockedReason: "l1-below-dust-limit",
    });

    // One sat clear of the dust limit is genuinely ready.
    const clear = await discoverStakerClaims({
      node: options(
        projectionStore,
        nodeReads({
          managerUnclaimedSats: 1_000_000n,
          perStaker: {
            [stakerOne]: rewards(1_047n, 0n),
            [`pox:${stakerOne}`]: l1Preference(500n),
          },
        }),
      ).node,
      managerPrincipal: manager,
      rewardCycle: 141,
      stakerPrincipals: [stakerOne],
      bondIndices: [],
    });
    expect(clear.stakers[0]?.claims[0]).toMatchObject({ claimable: true, blockedReason: null });
    expect(clear.settlement).toMatchObject({ scope: "page", transactionCount: 1 });
  });

  it("does not label a bucket ready without the manager's fee snapshot", async () => {
    const projectionStore = store();
    const reads = nodeReads({
      // An unrelated claimed bucket can leave the manager with enough global funds. The bucket
      // under inspection is still not settled until its own fee snapshot exists.
      managerUnclaimedSats: 10_000n,
      perStaker: { [stakerOne]: rewards(9_000n, 1_000n) },
    });
    const input = options(projectionStore, reads);
    const result = await discoverStakerClaims({
      ...input,
      node: { ...input.node, getMapEntry: vi.fn().mockResolvedValue(noneCV()) },
      stakerPrincipals: [stakerOne],
      bondIndices: [],
    });

    expect(result.stakers[0]?.claims[0]).toMatchObject({
      claimable: false,
      blockedReason: "manager-has-not-claimed",
    });
    expect(result.settlement).toMatchObject({ transactionCount: 0, blockedClaims: 1 });
  });
});
