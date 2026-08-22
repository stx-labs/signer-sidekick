import { describe, expect, it } from "vitest";
import {
  buildRewardLedger,
  csvSafeCell,
  type RewardLedgerSnapshotInput,
  type RewardLedgerStore,
  rewardLedgerDistributionsCsv,
  rewardLedgerFeesCsv,
  rewardLedgerPaymentsCsv,
} from "./reward-ledger.js";
import type {
  StoredCycleMembership,
  StoredManagerClaim,
  StoredManagerWithdrawal,
  StoredPox5RewardPrint,
  StoredRewardCalculationRealization,
} from "./storage/store.js";

const manager = "SP000000000000000000002Q6VF78.signer-manager";
const pox5 = "SP000000000000000000002Q6VF78.pox-5";
const alice = "SP1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1";
const bob = "SP2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2";
const carol = "SP3CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC3";
const dave = "SP4DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD4";
const now = new Date("2026-08-22T12:00:00.000Z");

function tx(seed: number): string {
  return `0x${seed.toString(16).padStart(64, "0")}`;
}

function realization(
  cycle: number,
  checkpoint: "first-half" | "second-half",
  blockHeight: number,
  poolSats: string | null,
  txId: string,
): StoredRewardCalculationRealization {
  return {
    chainId: 1,
    txId,
    eventIndex: 0,
    sourceId: "mainnet:https://api",
    managerPrincipal: manager,
    pox5ContractId: pox5,
    canonical: true,
    evidenceLevel: "node-index-verified",
    blockHeight,
    indexBlockHash: `0x${"ab".repeat(32)}`,
    burnBlockHeight: 900_000 + blockHeight,
    targetRewardCycle: cycle,
    targetCheckpoint: checkpoint,
    calculationBurnHeight: 900_000 + blockHeight,
    event: {
      kind: "calculate-rewards",
      topic: "calculate-rewards",
      bondPeriods: [],
      calculationBurnHeight: String(900_000 + blockHeight),
      grossAccruedRewardsSats: "100000000",
      totalBondRewardsSats: "0",
      reserveDepositSats: "0",
      reserveBalanceSats: "0",
      rewardCycle: String(cycle),
      totalStxStakerRewardsSats: "100000000",
      cycleStakedUstx: "1",
      accruedRewardsPerUstx: "1",
      cumulativeRewardsPerUstx: "1",
    },
    poolEstimate:
      poolSats === null
        ? null
        : {
            kind: "if-calculated-now",
            targetRewardCycle: cycle,
            targetCheckpoint: checkpoint,
            calculationBurnHeight: 900_000 + blockHeight,
            grossSats: poolSats,
            stxSats: poolSats,
            bondSats: "0",
            inputs: { globalStxSharesUstx: "1", managerStxSharesUstx: "1", activeBonds: [] },
          },
    poolEstimateUnavailableReason: poolSats === null ? "anchored-inputs-unavailable" : null,
    modelRevision: 1,
    evaluation: null,
    observedAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  } as unknown as StoredRewardCalculationRealization;
}

function claim(
  seed: number,
  staker: string,
  cycle: number,
  blockHeight: number,
  amountSats: string,
  requestId: string | null = null,
): StoredManagerClaim {
  return {
    txId: tx(seed),
    eventIndex: 0,
    blockHeight,
    stakerPrincipal: staker,
    rewardCycle: String(cycle),
    bondIndex: null,
    amountSats,
    destination: requestId === null ? "direct-sbtc" : "bitcoin-l1",
    withdrawalRequestId: requestId,
    occurredAt: null,
  };
}

function grossPrint(
  seed: number,
  staker: string,
  blockHeight: number,
  gross: string,
): StoredPox5RewardPrint {
  return {
    txId: tx(seed),
    eventIndex: 1,
    blockHeight,
    indexBlockHash: `0x${"cd".repeat(32)}`,
    kind: "claim-staker-rewards-for-signer",
    rewardCycle: null,
    stakerPrincipal: staker,
    bondIndex: null,
    rewardsClaimedSats: gross,
    totalRewardsSats: null,
    stxRewardsSats: null,
    firstSeenAt: "2026-08-01T00:00:00.000Z",
  };
}

function collectPrint(
  seed: number,
  cycle: number,
  blockHeight: number,
  total: string,
): StoredPox5RewardPrint {
  return {
    txId: tx(seed),
    eventIndex: 0,
    blockHeight,
    indexBlockHash: `0x${"ef".repeat(32)}`,
    kind: "claim-rewards",
    rewardCycle: String(cycle),
    stakerPrincipal: null,
    bondIndex: null,
    rewardsClaimedSats: null,
    totalRewardsSats: total,
    stxRewardsSats: total,
    firstSeenAt: "2026-08-01T00:00:00.000Z",
  };
}

function membership(staker: string, cycle: number): StoredCycleMembership {
  return {
    stakerPrincipal: staker,
    rewardCycle: BigInt(cycle),
    signerPrincipal: manager,
    amountUstx: 1_000_000_000n,
    active: true,
  };
}

function fakeStore(data: {
  realizations?: StoredRewardCalculationRealization[];
  prints?: StoredPox5RewardPrint[];
  claims?: StoredManagerClaim[];
  withdrawals?: StoredManagerWithdrawal[];
  memberships?: Record<number, StoredCycleMembership[]>;
}): RewardLedgerStore {
  return {
    listRewardCalculationRealizations: () => data.realizations ?? [],
    // Mirrors the store contract: newest `limit` rows, returned oldest first.
    listPox5RewardPrints: (_chainId, _pox5, _manager, options) => {
      const rows = [...(data.prints ?? [])].sort((a, b) => a.blockHeight - b.blockHeight);
      const limit = options?.limit ?? rows.length;
      return rows.slice(Math.max(0, rows.length - limit));
    },
    listManagerClaimRecords: (_chainId, _manager, limit) => {
      const rows = [...(data.claims ?? [])].sort((a, b) => a.blockHeight - b.blockHeight);
      const bounded = limit ?? rows.length;
      return rows.slice(Math.max(0, rows.length - bounded));
    },
    listManagerWithdrawalRecords: () => data.withdrawals ?? [],
    listManagerTopicEvents: () => [],
    listCycleMembershipsForCycle: (_manager, cycle) => data.memberships?.[cycle] ?? [],
  };
}

function snapshot(overrides: Partial<RewardLedgerSnapshotInput> = {}): RewardLedgerSnapshotInput {
  return {
    generatedAt: now.toISOString(),
    network: "mainnet",
    managerPrincipal: manager,
    chainAnchor: {
      stacksBlockHeight: 5_000,
      burnBlockHeight: 905_000,
      indexBlockHash: `0x${"11".repeat(32)}`,
    },
    roster: [alice, bob, carol].map((stakerPrincipal) => ({ stakerPrincipal, active: true })),
    historyRecovery: {
      monitoringStartedAt: "2026-07-01T00:00:00.000Z",
      managerHistory: { status: "complete" },
      currentMemberHistory: { status: "complete" },
    },
    manager: {
      capabilities: {
        eventVocabulary: { normalizationAvailable: true },
        actions: [{ id: "reference-reward-claims", executionAvailable: true }],
      },
    },
    rewards: null,
    rewardOutlook: null,
    ...overrides,
  };
}

describe("buildRewardLedger", () => {
  it("projects a current distribution that is ready to collect and distribute", async () => {
    const ledger = await buildRewardLedger({
      store: fakeStore({
        realizations: [realization(141, "second-half", 4_900, "1287000", tx(9))],
      }),
      chainId: 1,
      managerPrincipal: manager,
      pox5ContractId: pox5,
      sourceId: null,
      ownedTxids: new Set(),
      now,
      snapshot: snapshot({
        rewards: {
          rewardCycle: 141,
          calculation: { next: null },
          buckets: [
            {
              bondIndex: null,
              signerEarnedBeforeManagerClaimSats: "1287000",
              feeSnapshotBips: "500",
            },
          ],
          manager: { configuredFeeBips: "500", feeSnapshotBips: "500", earnedFeesSats: "0" },
          stakers: [
            {
              stakerPrincipal: alice,
              payout: { kind: "direct-sbtc", maxFeeSats: null },
              rewards: { earnedSats: "233605", feeSats: "12295", grossSats: "245900" },
              claimableByPolicy: true,
            },
            {
              stakerPrincipal: bob,
              payout: { kind: "bitcoin-l1", maxFeeSats: "10000" },
              rewards: { earnedSats: "172235", feeSats: "9065", grossSats: "181300" },
              claimableByPolicy: true,
            },
            {
              stakerPrincipal: carol,
              payout: { kind: "bitcoin-l1", maxFeeSats: "10000" },
              rewards: { earnedSats: "7742", feeSats: "408", grossSats: "8150" },
              claimableByPolicy: false,
            },
          ],
        },
      }),
    });
    expect(ledger.current).toEqual({ cycle: 141, distribution: 2 });
    const [cycle] = ledger.cycles;
    const second = cycle?.distributions.find((d) => d.distribution === 2);
    expect(second).toMatchObject({
      status: "ready",
      current: true,
      availableToCollectSats: "1287000",
      feeBips: "500",
      feeEvidence: "locked",
      calculation: { state: "done", poolSats: "1287000", by: "another-caller" },
      payments: { outstanding: 2, belowFee: 1, made: 0, outstandingSats: "413582" },
      coverage: "exact",
    });
    const bobRow = ledger.payments.find((p) => p.stakerPrincipal === bob);
    expect(bobRow).toMatchObject({
      route: "bitcoin",
      stakerEntitlementSats: "172235",
      payoutSats: "162235",
      payoutAsset: "BTC",
      l1MaxFeeSats: "10000",
      status: "outstanding",
    });
    expect(ledger.payments.find((p) => p.stakerPrincipal === carol)).toMatchObject({
      status: "below-fee",
      unavailableReason: "entitlement-below-bitcoin-fee-budget",
    });
    // identities: gross = fee + entitlement on every row
    for (const row of ledger.payments) {
      expect(BigInt(row.grossRewardSats ?? "0")).toBe(
        BigInt(row.operatorFeeSats ?? "0") + BigInt(row.stakerEntitlementSats),
      );
    }
  });

  it("applies the seam rule, rolled-forward counts, combined coverage, and provenance", async () => {
    const store = fakeStore({
      realizations: [
        realization(140, "first-half", 1_000, "1198000", tx(1)),
        realization(140, "second-half", 2_000, "1241000", tx(2)),
      ],
      prints: [
        collectPrint(3, 140, 1_100, "1198000"),
        collectPrint(4, 140, 2_100, "1241000"),
        grossPrint(10, alice, 1_200, "245900"),
        grossPrint(11, bob, 2_200, "120000"),
        grossPrint(12, carol, 2_300, "90000"),
      ],
      claims: [
        claim(10, alice, 140, 1_200, "233605"),
        claim(11, bob, 140, 2_200, "114000"),
        claim(12, carol, 140, 2_300, "85500"),
      ],
      memberships: { 140: [membership(alice, 140), membership(bob, 140), membership(carol, 140)] },
    });
    const ledger = await buildRewardLedger({
      store,
      chainId: 1,
      managerPrincipal: manager,
      pox5ContractId: pox5,
      sourceId: null,
      ownedTxids: new Set([tx(3), tx(10)]),
      now,
      snapshot: snapshot({
        rewards: { rewardCycle: 141, calculation: { next: null }, stakers: [] },
      }),
      query: { cycle: 140 },
    });
    const cycle = ledger.cycles.find((c) => c.cycle === 140);
    const first = cycle?.distributions.find((d) => d.distribution === 1);
    const second = cycle?.distributions.find((d) => d.distribution === 2);
    expect(first).toMatchObject({
      status: "complete",
      collectedSats: "1198000",
      collects: [{ by: "you" }],
      payments: { made: 1, rolledForward: 2, distributedSats: "233605", operatorFeeSats: "12295" },
      coverage: "exact",
    });
    expect(second).toMatchObject({
      status: "complete",
      collectedSats: "1241000",
      collects: [{ by: "another-caller" }],
      payments: { made: 2, rolledForward: 0 },
      coverage: "combined",
    });
    expect(cycle?.coverage).toBe("combined");
    const rows = ledger.payments;
    expect(
      rows.map((r) => [
        r.stakerPrincipal,
        r.distribution,
        r.includesPriorDistribution,
        r.coverage,
        r.by,
      ]),
    ).toEqual([
      [carol, 2, true, "combined", "another-caller"],
      [bob, 2, true, "combined", "another-caller"],
      [alice, 1, false, "exact", "you"],
    ]);
    expect(ledger.fees).toMatchObject({ earnedIndexedSats: String(12295 + 6000 + 4500) });
  });

  it("tracks Bitcoin-route payouts through sent, arrived, rejected, returned, and retired", async () => {
    const withdrawals: StoredManagerWithdrawal[] = [
      {
        requestId: "1",
        stakerPrincipal: alice,
        amountSats: "162235",
        maxFeeSats: "10000",
        initiatedTxId: tx(21),
        initiatedBlockHeight: 2_100,
        state: "pending",
        resolvedTxId: null,
        resolvedBlockHeight: null,
      },
      {
        requestId: "2",
        stakerPrincipal: bob,
        amountSats: "50000",
        maxFeeSats: "10000",
        initiatedTxId: tx(22),
        initiatedBlockHeight: 2_100,
        state: "pending",
        resolvedTxId: null,
        resolvedBlockHeight: null,
      },
      {
        requestId: "3",
        stakerPrincipal: carol,
        amountSats: "40000",
        maxFeeSats: "10000",
        initiatedTxId: tx(23),
        initiatedBlockHeight: 2_100,
        state: "reclaimed",
        resolvedTxId: tx(33),
        resolvedBlockHeight: 2_500,
      },
      {
        requestId: "4",
        stakerPrincipal: dave,
        amountSats: "30000",
        maxFeeSats: "10000",
        initiatedTxId: tx(24),
        initiatedBlockHeight: 2_100,
        state: "settled",
        resolvedTxId: tx(34),
        resolvedBlockHeight: 2_600,
      },
    ];
    const ledger = await buildRewardLedger({
      store: fakeStore({
        realizations: [realization(140, "second-half", 2_000, "1000000", tx(2))],
        claims: [
          claim(21, alice, 140, 2_100, "172235", "1"),
          claim(22, bob, 140, 2_100, "60000", "2"),
          claim(23, carol, 140, 2_100, "50000", "3"),
          claim(24, dave, 140, 2_100, "40000", "4"),
        ],
        withdrawals,
      }),
      chainId: 1,
      managerPrincipal: manager,
      pox5ContractId: pox5,
      sourceId: null,
      ownedTxids: new Set(),
      now,
      snapshot: snapshot({
        roster: [alice, bob, carol, dave].map((stakerPrincipal) => ({
          stakerPrincipal,
          active: true,
        })),
        rewards: { rewardCycle: 141, calculation: { next: null }, stakers: [] },
      }),
      query: { cycle: 140 },
      withdrawalRequestStatus: async (id) =>
        id === "1" ? "accepted" : id === "2" ? "rejected" : "unknown",
    });
    const byStaker = Object.fromEntries(ledger.payments.map((p) => [p.stakerPrincipal, p]));
    expect(byStaker[alice]).toMatchObject({
      status: "arrived",
      l1Status: "accepted-ready-to-retire",
      payoutSats: "162235",
      payoutAsset: "BTC",
    });
    expect(byStaker[bob]).toMatchObject({
      status: "rejected",
      l1Status: "rejected-return-pending",
    });
    expect(byStaker[carol]).toMatchObject({
      status: "returned",
      l1Status: "returned",
      returnedSats: "50000",
      payoutSats: null,
      settleOrReclaimTxId: tx(33),
    });
    expect(byStaker[dave]).toMatchObject({
      status: "retired",
      l1Status: "retired",
      settleOrReclaimTxId: tx(34),
    });
    const distribution = ledger.cycles
      .find((c) => c.cycle === 140)
      ?.distributions.find((d) => d.distribution === 2);
    expect(distribution).toMatchObject({
      status: "needs-attention",
      payments: { made: 4, arriving: 1, rejected: 1, returned: 1 },
    });
  });

  it("marks historical coverage incomplete while recovery runs or members departed", async () => {
    const base = {
      store: fakeStore({
        realizations: [realization(139, "first-half", 500, "900000", tx(1))],
        claims: [claim(40, alice, 139, 600, "100000")],
        memberships: { 139: [membership(alice, 139), membership(dave, 139)] },
      }),
      chainId: 1,
      managerPrincipal: manager,
      pox5ContractId: pox5,
      sourceId: null,
      ownedTxids: new Set<string>(),
      now,
      query: { cycle: 139 },
    };
    const departed = await buildRewardLedger({
      ...base,
      snapshot: snapshot({
        rewards: { rewardCycle: 141, calculation: { next: null }, stakers: [] },
      }),
    });
    expect(departed.cycles.find((c) => c.cycle === 139)?.coverage).toBe(
      "historical-coverage-incomplete",
    );
    expect(departed.payments[0]?.coverage).toBe("historical-coverage-incomplete");
    const reconstructing = await buildRewardLedger({
      ...base,
      snapshot: snapshot({
        roster: [alice, dave].map((stakerPrincipal) => ({ stakerPrincipal, active: true })),
        historyRecovery: {
          monitoringStartedAt: null,
          managerHistory: { status: "reconstructing" },
          currentMemberHistory: { status: "complete" },
        },
        rewards: { rewardCycle: 141, calculation: { next: null }, stakers: [] },
      }),
    });
    expect(reconstructing.cycles.find((c) => c.cycle === 139)?.coverage).toBe(
      "historical-coverage-incomplete",
    );
    // A fresh install may not have seen payments made earlier in the live cycle either.
    expect(reconstructing.cycles.find((c) => c.cycle === 141)?.coverage).toBe(
      "historical-coverage-incomplete",
    );
    const complete = await buildRewardLedger({
      ...base,
      snapshot: snapshot({
        roster: [alice, dave].map((stakerPrincipal) => ({ stakerPrincipal, active: true })),
        rewards: { rewardCycle: 141, calculation: { next: null }, stakers: [] },
      }),
    });
    expect(complete.cycles.find((c) => c.cycle === 139)?.coverage).toBe("exact");
  });

  it("reports accruing, waiting, and overdue before the calculation exists", async () => {
    const base = {
      store: fakeStore({}),
      chainId: 1,
      managerPrincipal: manager,
      pox5ContractId: pox5,
      sourceId: null,
      ownedTxids: new Set<string>(),
      now,
    };
    const next = { targetRewardCycle: 141, targetCheckpoint: "first-half" as const };
    for (const [state, grace, expected] of [
      ["scheduled", null, "accruing"],
      ["due", { state: "awaiting-calculation" }, "waiting-calculation"],
      ["due", { state: "action-required" }, "calculation-overdue"],
    ] as const) {
      const ledger = await buildRewardLedger({
        ...base,
        snapshot: snapshot({
          rewards: {
            rewardCycle: 141,
            calculation: { next: { ...next, state, grace } },
            stakers: [],
          },
        }),
      });
      expect(ledger.cycles[0]?.distributions[0]).toMatchObject({
        distribution: 1,
        status: expected,
        current: true,
      });
      expect(ledger.current).toEqual({ cycle: 141, distribution: 1 });
    }
  });

  it("exports sanitized CSV with the accounting columns", async () => {
    const ledger = await buildRewardLedger({
      store: fakeStore({
        realizations: [realization(140, "first-half", 1_000, "1198000", tx(1))],
        prints: [grossPrint(10, alice, 1_200, "245900")],
        claims: [claim(10, "=SP1EVIL", 140, 1_200, "233605")],
      }),
      chainId: 1,
      managerPrincipal: manager,
      pox5ContractId: pox5,
      sourceId: null,
      ownedTxids: new Set(),
      now,
      snapshot: snapshot({
        roster: [],
        rewards: { rewardCycle: 141, calculation: { next: null }, stakers: [] },
      }),
      query: { cycle: 140 },
    });
    const payments = rewardLedgerPaymentsCsv(ledger);
    expect(payments.split("\n")[0]).toBe(
      "cycle,distribution,bucket,staker_principal,route,gross_reward_sats,operator_fee_sats,staker_entitlement_sats,payout_sats,payout_asset,l1_max_fee_sats,l1_actual_fee_sats,fee_refund_sats,returned_sats,status,coverage,includes_prior_distribution,payment_txid,payment_block_height,paid_at,by,l1_request_id,l1_status,settle_or_reclaim_txid,btc_sweep_txid,unavailable_reason",
    );
    expect(payments).toContain("'=SP1EVIL");
    expect(rewardLedgerDistributionsCsv(ledger).split("\n")).toHaveLength(3);
    expect(rewardLedgerFeesCsv(ledger)).toContain("earned-indexed-total");
    expect(csvSafeCell("+1")).toBe("'+1");
    expect(csvSafeCell('a,"b"')).toBe('"a,""b"""');
    expect(csvSafeCell(12)).toBe("12");
  });

  it("keeps the newest evidence and marks older cycles incomplete when the window truncates", async () => {
    const store = fakeStore({
      realizations: [
        realization(138, "first-half", 900, "1000000", tx(1)),
        realization(139, "first-half", 1_900, "1000000", tx(2)),
        realization(140, "first-half", 2_900, "1000000", tx(3)),
      ],
      prints: [
        grossPrint(10, alice, 1_000, "100000"),
        grossPrint(11, bob, 1_050, "100000"),
        grossPrint(12, alice, 2_000, "100000"),
        grossPrint(13, bob, 2_050, "100000"),
        grossPrint(14, alice, 3_000, "100000"),
      ],
      claims: [
        claim(10, alice, 138, 1_000, "95000"),
        claim(11, bob, 138, 1_050, "95000"),
        claim(12, alice, 139, 2_000, "95000"),
        claim(13, bob, 139, 2_050, "95000"),
        claim(14, alice, 140, 3_000, "95000"),
      ],
      memberships: {
        138: [membership(alice, 138), membership(bob, 138)],
        139: [membership(alice, 139), membership(bob, 139)],
        140: [membership(alice, 140), membership(bob, 140)],
      },
    });
    const build = (evidenceLimit?: number, query?: { cycle: number }) =>
      buildRewardLedger({
        store,
        chainId: 1,
        managerPrincipal: manager,
        pox5ContractId: pox5,
        sourceId: null,
        ownedTxids: new Set(),
        now,
        snapshot: snapshot({
          rewards: { rewardCycle: 141, calculation: { next: null }, stakers: [] },
        }),
        ...(evidenceLimit === undefined ? {} : { evidenceLimit }),
        ...(query === undefined ? {} : { query }),
      });

    const complete = await build();
    expect(complete.evidenceWindow).toEqual({
      truncated: false,
      oldestRetainedBlockHeight: null,
      limit: 10_000,
    });
    expect(complete.cycles.map((c) => [c.cycle, c.coverage])).toEqual([
      [141, "exact"],
      [140, "exact"],
      [139, "exact"],
      [138, "exact"],
    ]);

    // Only the newest three rows per stream survive: the current cycle stays exact, the boundary
    // cycle (139, whose oldest row is the oldest retained row) and everything older degrade.
    const windowed = await build(3);
    expect(windowed.evidenceWindow).toEqual({
      truncated: true,
      oldestRetainedBlockHeight: 2_000,
      limit: 3,
    });
    expect(windowed.cycles.map((c) => [c.cycle, c.coverage])).toEqual([
      [141, "exact"],
      [140, "exact"],
      [139, "historical-coverage-incomplete"],
      [138, "historical-coverage-incomplete"],
    ]);
    const latest = windowed.cycles.find((c) => c.cycle === 140);
    expect(latest?.distributions[0]?.payments).toMatchObject({ made: 1, distributedSats: "95000" });
    const windowedCycle = await build(3, { cycle: 140 });
    expect(windowedCycle.payments.filter((row) => row.cycle === 140)).toHaveLength(1);
    expect(windowedCycle.payments.find((row) => row.cycle === 140)).toMatchObject({
      grossRewardSats: "100000",
      coverage: "exact",
    });
    // Nothing newer than the window start was dropped.
    expect(
      windowedCycle.payments
        .filter((row) => row.paymentTxId !== null)
        .every((row) => (row.paymentBlockHeight ?? 0) >= 2_000),
    ).toBe(true);
  });

  it("keeps Bitcoin-bond bucket identity across the settlement seam", async () => {
    const store = fakeStore({
      realizations: [
        realization(140, "first-half", 1_000, "1000000", tx(1)),
        realization(140, "second-half", 2_000, "1000000", tx(2)),
      ],
      prints: [
        grossPrint(10, alice, 1_200, "100000"),
        { ...grossPrint(11, bob, 2_200, "80000"), bondIndex: "1" },
        grossPrint(12, bob, 2_300, "50000"),
      ],
      claims: [
        claim(10, alice, 140, 1_200, "95000"),
        { ...claim(11, bob, 140, 2_200, "76000"), bondIndex: "1" },
        claim(12, bob, 140, 2_300, "47500"),
      ],
      memberships: { 140: [membership(alice, 140), membership(bob, 140)] },
    });
    const ledger = await buildRewardLedger({
      store,
      chainId: 1,
      managerPrincipal: manager,
      pox5ContractId: pox5,
      sourceId: null,
      ownedTxids: new Set(),
      now,
      snapshot: snapshot({
        rewards: { rewardCycle: 141, calculation: { next: null }, stakers: [] },
      }),
      query: { cycle: 140 },
    });
    const cycle = ledger.cycles.find((c) => c.cycle === 140);
    const first = cycle?.distributions.find((d) => d.distribution === 1);
    const second = cycle?.distributions.find((d) => d.distribution === 2);
    // bob's STX bucket and bob's bond bucket both rolled forward out of the First Distribution;
    // alice's STX bucket did not. Their later payments carry both distributions.
    expect(first?.payments).toMatchObject({ made: 1, rolledForward: 2 });
    expect(second?.payments).toMatchObject({ made: 2, rolledForward: 0 });
    const bond = ledger.payments.find((p) => p.stakerPrincipal === bob && p.bucket === "bond-1");
    expect(bond).toMatchObject({
      distribution: 2,
      grossRewardSats: "80000",
      stakerEntitlementSats: "76000",
      includesPriorDistribution: true,
      coverage: "combined",
    });
    expect(
      ledger.payments.find((p) => p.stakerPrincipal === bob && p.bucket === "stx"),
    ).toMatchObject({
      includesPriorDistribution: true,
      coverage: "combined",
    });
    expect(ledger.payments.find((p) => p.stakerPrincipal === alice)).toMatchObject({
      distribution: 1,
      includesPriorDistribution: false,
      coverage: "exact",
    });
  });

  it("stays fast and truthful for a 150-staker pool with 50 cycles of history", async () => {
    const stakers = Array.from({ length: 150 }, (_, index) =>
      `SP${index.toString(36).toUpperCase().padStart(4, "0")}${"A".repeat(35)}`.slice(0, 41),
    );
    const realizations: StoredRewardCalculationRealization[] = [];
    const prints: StoredPox5RewardPrint[] = [];
    const claims: StoredManagerClaim[] = [];
    const memberships: Record<number, StoredCycleMembership[]> = {};
    let seed = 1_000;
    for (let cycle = 91; cycle <= 140; cycle += 1) {
      const base = (cycle - 91) * 10_000;
      realizations.push(realization(cycle, "first-half", base + 100, "10000000", tx(seed++)));
      realizations.push(realization(cycle, "second-half", base + 5_100, "10000000", tx(seed++)));
      memberships[cycle] = stakers.map((staker) => membership(staker, cycle));
      for (const [index, staker] of stakers.entries()) {
        for (const offset of [200, 5_200]) {
          const id = seed++;
          prints.push(grossPrint(id, staker, base + offset + index, "100000"));
          claims.push(claim(id, staker, cycle, base + offset + index, "95000"));
        }
      }
    }
    expect(claims).toHaveLength(15_000);
    const store = fakeStore({ realizations, prints, claims, memberships });
    const started = performance.now();
    const ledger = await buildRewardLedger({
      store,
      chainId: 1,
      managerPrincipal: manager,
      pox5ContractId: pox5,
      sourceId: null,
      ownedTxids: new Set(),
      now,
      snapshot: snapshot({
        roster: stakers.map((stakerPrincipal) => ({ stakerPrincipal, active: true })),
        rewards: { rewardCycle: 141, calculation: { next: null }, stakers: [] },
      }),
      query: { cycle: 140 },
    });
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(3_000);
    // 15,000 rows per stream exceed the 10,000-row window: the newest cycles stay exact and
    // complete, the oldest ones are flagged rather than silently thinned.
    expect(ledger.evidenceWindow.truncated).toBe(true);
    expect(ledger.cycles.find((c) => c.cycle === 140)).toMatchObject({ coverage: "exact" });
    expect(
      ledger.cycles.find((c) => c.cycle === 140)?.distributions.map((d) => d.payments.made),
    ).toEqual([150, 150]);
    expect(ledger.payments).toHaveLength(300);
    expect(ledger.cycles.find((c) => c.cycle === 91)).toMatchObject({
      coverage: "historical-coverage-incomplete",
    });
    const exact = ledger.cycles.filter((c) => c.coverage === "exact").map((c) => c.cycle);
    expect(Math.min(...exact)).toBeGreaterThan(91);
    expect(Math.max(...exact)).toBe(141);
    const all = await buildRewardLedger({
      store,
      chainId: 1,
      managerPrincipal: manager,
      pox5ContractId: pox5,
      sourceId: null,
      ownedTxids: new Set(),
      now,
      snapshot: snapshot({
        roster: stakers.map((stakerPrincipal) => ({ stakerPrincipal, active: true })),
        rewards: { rewardCycle: 141, calculation: { next: null }, stakers: [] },
      }),
      query: { scope: "all" },
    });
    expect(all.query.scope).toBe("all");
    expect(all.payments.length).toBe(10_000);
    expect(all.paymentsTruncated).toBe(false);
  });
});
