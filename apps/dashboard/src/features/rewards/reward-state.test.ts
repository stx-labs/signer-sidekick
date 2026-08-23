import type {
  DashboardSnapshot,
  GasWalletStatus,
  RewardLedger,
  RewardLedgerDistribution,
  RewardLedgerPayment,
} from "@stx-labs/signer-sidekick-api-contracts";
import { describe, expect, it } from "vitest";
import { rewardRunFixture } from "./reward-run.fixture.js";
import {
  comparePayments,
  deriveCycleGeometry,
  deriveDistributionCards,
  deriveEarning,
  distributionTooltip,
  paymentStatusLabel,
  paymentTab,
  pendingDistributions,
  rollForwardExplanation,
} from "./reward-state.js";

const alice = "SP1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA7QZD";
const bob = "SP2KBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBM3XW";

function distribution(
  overrides: Partial<RewardLedgerDistribution> & { distribution: 1 | 2; cycle: number },
): RewardLedgerDistribution {
  return {
    schemaVersion: 1,
    current: false,
    calculation: {
      state: "done",
      txId: `0x${"7c".repeat(32)}`,
      blockHeight: 5_000,
      calculationBurnHeight: 908_000,
      observedAt: "2026-08-19T17:27:00.000Z",
      poolSats: "1400000",
      poolSatsUnavailableReason: null,
      by: "another-caller",
    },
    collects: [],
    collectedSats: "0",
    availableToCollectSats: "1400000",
    feeBips: "500",
    feeEvidence: "locked",
    payments: {
      made: 0,
      outstanding: 40,
      notPayable: 0,
      belowFee: 0,
      rolledForward: 0,
      arriving: 0,
      rejected: 0,
      returned: 0,
      distributedSats: "0",
      outstandingSats: "1330000",
      operatorFeeSats: "0",
    },
    status: "ready",
    statusDetail: "Ready to collect and distribute",
    coverage: "exact",
    ...overrides,
  };
}

function complete(cycle: number, index: 1 | 2): RewardLedgerDistribution {
  return distribution({
    cycle,
    distribution: index,
    collectedSats: "1400000",
    availableToCollectSats: "0",
    collects: [
      {
        sats: "1400000",
        stxSats: "1400000",
        txId: `0x${"9a".repeat(32)}`,
        blockHeight: 4_100,
        by: "you",
      },
    ],
    payments: {
      made: 40,
      outstanding: 0,
      notPayable: 0,
      belowFee: 0,
      rolledForward: 0,
      arriving: 0,
      rejected: 0,
      returned: 0,
      distributedSats: "1330000",
      outstandingSats: "0",
      operatorFeeSats: "70000",
    },
    status: "complete",
    statusDetail: "Complete",
  });
}

function accruing(cycle: number, index: 1 | 2, overdue = false): RewardLedgerDistribution {
  return distribution({
    cycle,
    distribution: index,
    calculation: {
      state: overdue ? "overdue" : "waiting",
      txId: null,
      blockHeight: null,
      calculationBurnHeight: null,
      observedAt: null,
      poolSats: null,
      poolSatsUnavailableReason: null,
      by: null,
    },
    availableToCollectSats: null,
    payments: {
      made: 0,
      outstanding: 0,
      notPayable: 0,
      belowFee: 0,
      rolledForward: 0,
      arriving: 0,
      rejected: 0,
      returned: 0,
      distributedSats: "0",
      outstandingSats: "0",
      operatorFeeSats: "0",
    },
    status: overdue ? "calculation-overdue" : "accruing",
    statusDetail: overdue ? "The network calculation is overdue" : "Accruing",
  });
}

function ledger(
  current: RewardLedgerDistribution,
  extra: RewardLedgerDistribution[] = [],
  payments: RewardLedgerPayment[] = [],
): RewardLedger {
  const byCycle = new Map<number, RewardLedgerDistribution[]>();
  for (const d of [current, ...extra]) byCycle.set(d.cycle, [...(byCycle.get(d.cycle) ?? []), d]);
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-22T12:00:00.000Z",
    managerPrincipal: "SP000000000000000000002Q6VF78.signer-manager",
    network: "mainnet",
    pox5ContractId: "SP000000000000000000002Q6VF78.pox-5",
    anchor: null,
    capabilityLevel: "reviewed-event-vocabulary",
    monitoringStartedAt: null,
    recovery: { managerHistory: "complete", currentMemberHistory: "complete" },
    evidenceWindow: { truncated: false, oldestRetainedBlockHeight: null, limit: 10_000 },
    current: { cycle: current.cycle, distribution: current.distribution },
    cycles: [...byCycle.entries()]
      .sort(([a], [b]) => b - a)
      .map(([cycle, distributions]) => ({
        cycle,
        feeBips: "500",
        feeEvidence: "locked" as const,
        collectedSats: distributions
          .reduce((sum, d) => sum + BigInt(d.collectedSats), 0n)
          .toString(),
        distributedSats: distributions
          .reduce((sum, d) => sum + BigInt(d.payments.distributedSats), 0n)
          .toString(),
        operatorFeeSats: distributions
          .reduce((sum, d) => sum + BigInt(d.payments.operatorFeeSats), 0n)
          .toString(),
        outstandingSats: distributions
          .reduce((sum, d) => sum + BigInt(d.payments.outstandingSats), 0n)
          .toString(),
        coverage: "exact" as const,
        distributions: distributions.sort((a, b) => a.distribution - b.distribution),
      })),
    payments,
    paymentsTruncated: false,
    fees: {
      feeBips: "500",
      earnedIndexedSats: "0",
      balanceInManagerSats: null,
      withdrawnDerivedSats: null,
      refunds: [],
    },
    query: {
      cycle: current.cycle,
      distribution: current.distribution,
      staker: null,
      scope: "selection",
    },
  };
}

function gasWallet(overrides: Partial<GasWalletStatus> = {}): GasWalletStatus {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-22T12:00:00.000Z",
    network: "mainnet",
    engineMode: "operator-run",
    configured: true,
    enabled: true,
    source: "generated",
    principal: "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7",
    publicKey: `02${"ab".repeat(32)}`,
    secretFilePath: "/var/lib/sidekick/gas-wallet.key",
    createdAt: "2026-08-20T12:00:00.000Z",
    enabledAt: "2026-08-20T12:05:00.000Z",
    signer: "ready",
    signerError: null,
    balanceUstx: "12480000",
    balanceObservedAt: "2026-08-22T12:00:00.000Z",
    balanceError: null,
    feeBasisUstx: "100000",
    feeBasis: "fee-cap",
    estimatedTransactions: 124,
    refusal: {
      checkedAt: "2026-08-22T12:00:00.000Z",
      isManagerAdmin: false,
      isSignerKey: false,
      isContract: false,
      refusalReason: null,
    },
    banners: { setupDismissedAt: null, lowBalanceDismissedUntil: null },
    activeSweepId: null,
    sweeps: [],
    ...overrides,
  };
}

function payment(overrides: Partial<RewardLedgerPayment>): RewardLedgerPayment {
  return {
    schemaVersion: 1,
    cycle: 141,
    distribution: 2,
    bucket: "stx",
    stakerPrincipal: alice,
    route: "sbtc",
    grossRewardSats: "245900",
    operatorFeeSats: "12295",
    stakerEntitlementSats: "233605",
    payoutSats: "233605",
    payoutAsset: "sBTC",
    l1MaxFeeSats: null,
    l1ActualFeeSats: null,
    feeRefundSats: null,
    returnedSats: null,
    status: "outstanding",
    coverage: "exact",
    includesPriorDistribution: false,
    paymentTxId: null,
    paymentBlockHeight: null,
    paidAt: null,
    by: null,
    l1RequestId: null,
    l1Status: null,
    settleOrReclaimTxId: null,
    btcSweepTxId: null,
    unavailableReason: null,
    l1Address: null,
    rollForward: null,
    ...overrides,
  };
}

/** Cycle 141 at burn block 963,900: second half, 67% through, prepare phase 250 blocks away. */
function snapshot(
  overrides: Partial<{
    burnBlockHeight: number;
    next: NonNullable<NonNullable<DashboardSnapshot["rewards"]>["calculation"]["next"]> | null;
    outlook: Partial<NonNullable<DashboardSnapshot["rewardOutlook"]>> | null;
  }> = {},
): Pick<DashboardSnapshot, "rewardOutlook" | "rewards" | "preflight"> {
  const burnBlockHeight = overrides.burnBlockHeight ?? 963_900;
  const next =
    overrides.next === undefined
      ? {
          state: "scheduled" as const,
          targetRewardCycle: 141,
          targetCheckpoint: "second-half" as const,
          calculationBurnHeight: 964_249,
          eligibleBurnHeight: 964_249,
          blocksRemaining: 964_249 - burnBlockHeight,
          grace: null,
        }
      : overrides.next;
  const outlook =
    overrides.outlook === null
      ? null
      : {
          accrued: { globalSats: "242000000", source: "pox5-get-new-rewards" },
          poolEstimate: { grossSats: "629000" },
          forecast: {
            targetRewardCycle: 141,
            targetCheckpoint: "second-half",
            globalSats: { low: "370000000", point: "381000000", high: "392000000" },
            poolSats: { low: "1290000", point: "1400000", high: "1510000" },
            sample: { observations: 6, sampleBlocks: 31 },
            confidence: "developing",
          },
          operatorFeeForecast: { sats: { low: "65000", point: "70000", high: "75000" } },
          calculation: { next },
          ...(overrides.outlook ?? {}),
        };
  return {
    preflight: {
      node: { burnBlockHeight },
      cycle: {
        currentId: 141,
        preparePhaseStartBurnHeight: 964_150,
        blocksUntilPreparePhase: Math.max(0, 964_150 - burnBlockHeight),
        rewardPhaseStartBurnHeight: 964_250,
        blocksUntilRewardPhase: Math.max(0, 964_250 - burnBlockHeight),
        isPreparePhase: burnBlockHeight >= 964_150,
        rewardCycleLength: 2_100,
        prepareCycleLength: 100,
        currentCycleStartBurnHeight: 962_150,
      },
    },
    rewards: {
      global: { globalAccruedRewardsSats: "242000000" },
      calculation: { next },
    },
    rewardOutlook: outlook,
  } as unknown as Pick<DashboardSnapshot, "rewardOutlook" | "rewards" | "preflight">;
}

describe("deriveCycleGeometry", () => {
  it("places the burn tip inside the accruing cycle", () => {
    expect(deriveCycleGeometry(snapshot())).toEqual({
      cycle: 141,
      burnHeight: 963_900,
      cycleStart: 962_150,
      halfBoundary: 963_200,
      cycleEnd: 964_250,
      length: 2_100,
      prepareStart: 964_150,
      blocksUntilPrepare: 250,
      inPreparePhase: false,
      liveHalf: 2,
    });
    expect(deriveCycleGeometry(null)).toBeNull();
  });
});

describe("deriveEarning", () => {
  it("describes the accruing cycle: identity, three facts, two halves", () => {
    const model = deriveEarning({
      ledger: ledger(accruing(141, 2), [distribution({ cycle: 141, distribution: 1 })]),
      snapshot: snapshot(),
      burnBlockSeconds: 600,
      now: new Date("2026-08-22T12:00:00.000Z"),
    });
    expect(model).not.toBeNull();
    expect(model?.cycle).toBe(141);
    expect(model?.when).toBe("Second half · 2d 10h left · ends at block 964,249");
    expect(model?.prepare).toBe("Prepare phase in 1d 17h · block 964,150");
    expect(model?.facts.map((fact) => [fact.label, fact.value, fact.unit, fact.sub])).toEqual([
      ["Network earned this half", "2.42", "sBTC", "3.81 sBTC projected at calculation"],
      [
        "Pool projected this half",
        "0.014",
        "sBTC",
        "0.00629 sBTC accrued · 0.0129 sBTC – 0.0151 sBTC · developing confidence",
      ],
      [
        "Pool projected this cycle",
        "0.028",
        "sBTC",
        "0.014 sBTC calculated + 0.014 sBTC projected · your fee 0.0014 sBTC",
      ],
    ]);
    expect(model?.halves[0]).toMatchObject({
      label: "First half",
      percent: 100,
      status: { text: "Ready to collect", tone: "ready" },
      note: "ended at block 963,199 · calculated Aug 19 · 0.014 sBTC",
    });
    expect(model?.halves[1]).toMatchObject({
      label: "Second half",
      percent: 67,
      status: { text: "Accruing · 67% · 2d 10h left", tone: "live" },
    });
    expect(model?.halves[1]?.note).toMatch(/^ends at block 964,249 · calculation expected Aug 2/);
  });

  it("marks a finished first half by its distribution status and the second as not started", () => {
    const model = deriveEarning({
      ledger: ledger(accruing(141, 1, true)),
      snapshot: snapshot({ burnBlockHeight: 962_400, next: null, outlook: null }),
    });
    expect(model?.when).toBe("First half · 5d 13h left · ends at block 963,199");
    expect(model?.halves.map((half) => [half.status.text, half.percent])).toEqual([
      ["Accruing · 24% · 5d 13h left", 24],
      ["Not started", 0],
    ]);
    expect(model?.facts[1]?.sub).toBe("projection unavailable");
    const later = deriveEarning({
      ledger: ledger(accruing(141, 1, true), [complete(141, 2)]),
      snapshot: snapshot({ burnBlockHeight: 964_300, next: null, outlook: null }),
    });
    expect(later?.halves[0]?.status).toEqual({ text: "Ready to calculate", tone: "ready" });
  });

  it("keeps the projection honest when the calculation target still lags behind", () => {
    const model = deriveEarning({
      ledger: ledger(accruing(141, 2)),
      snapshot: snapshot({
        next: {
          state: "due",
          targetRewardCycle: 141,
          targetCheckpoint: "first-half",
          calculationBurnHeight: 963_199,
          eligibleBurnHeight: 963_199,
          blocksRemaining: 0,
          grace: null,
        },
      }),
    });
    expect(model?.facts[0]?.sub).toBe("includes Cycle 141 first half until it is calculated");
    expect(model?.facts[1]).toMatchObject({ value: "—", sub: "after the Cycle 141 calculation" });
  });
});

describe("deriveDistributionCards", () => {
  it("offers Collect & distribute for a calculated distribution with nothing moved", () => {
    const cards = deriveDistributionCards({
      ledger: ledger(distribution({ cycle: 141, distribution: 2, current: true }), [
        complete(141, 1),
      ]),
      gasWallet: gasWallet(),
      engineMode: "operator-run",
      activeRun: null,
    });
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card?.eyebrow).toBe("Cycle 141 · Second Distribution");
    expect(card?.badge).toMatchObject({ tone: "success", label: "Ready" });
    expect(card?.headline).toBe("Ready to collect & distribute");
    expect(card?.sub).toBe("Calculated Aug 19 by another caller");
    expect(card?.primary).toMatchObject({
      kind: "collect-and-distribute",
      transactions: 41,
      cycle: 141,
      distribution: 2,
    });
    expect(card?.execution).toMatchObject({ available: true, chipTone: "ok" });
    expect(card?.execution.chip).toBe("Gas wallet 12.48 STX · ≈ 124 tx");
    expect(card?.tiles.map((tile) => [tile.label, tile.value, tile.unit, tile.detail])).toEqual([
      ["Calculated for this pool", "0.014", "sBTC", null],
      ["Collected", "0", "sats", "0.014 sBTC ready to collect"],
      ["Distributed", "0", "of 40", "0.0133 sBTC to stakers"],
      ["Your fee", "70,000", "sats", "5% locked"],
    ]);
    expect(card?.queued).toBeNull();
  });

  it("lists every open distribution oldest first, and queues the rest behind the running one", () => {
    const first = distribution({
      cycle: 141,
      distribution: 1,
      collectedSats: "1400000",
      availableToCollectSats: "0",
      collects: [
        {
          sats: "1400000",
          stxSats: "1400000",
          txId: `0x${"9a".repeat(32)}`,
          blockHeight: 4_100,
          by: "you",
        },
      ],
      payments: {
        made: 38,
        outstanding: 2,
        notPayable: 0,
        belowFee: 0,
        rolledForward: 0,
        arriving: 0,
        rejected: 0,
        returned: 0,
        distributedSats: "1218548",
        outstandingSats: "111452",
        operatorFeeSats: "64300",
      },
      status: "distributing",
      statusDetail: "Distributing",
    });
    const run = rewardRunFixture({
      recipe: { ...rewardRunFixture().recipe, cycle: 141, distribution: 1 },
    });
    const cards = deriveDistributionCards({
      ledger: ledger(distribution({ cycle: 141, distribution: 2, current: true }), [first]),
      gasWallet: gasWallet(),
      engineMode: "operator-run",
      activeRun: run,
    });
    expect(cards.map((card) => card.key)).toEqual(["141:1", "141:2"]);
    expect(cards[0]?.progress).toMatchObject({ done: 2, total: 3, runId: run.runId });
    expect(cards[0]?.headline).toBe("Distributing… 2 of 3 payments");
    expect(cards[0]?.queued).toBeNull();
    expect(cards[1]?.queued).toBe(
      "Queued behind Cycle 141 · First Distribution — one run at a time",
    );
    expect(cards[1]?.primary?.kind).toBe("collect-and-distribute");
    const idle = deriveDistributionCards({
      ledger: ledger(distribution({ cycle: 141, distribution: 2, current: true }), [first]),
      gasWallet: gasWallet(),
      engineMode: "operator-run",
      activeRun: null,
    });
    expect(idle[0]).toMatchObject({
      headline: "2 payments still outstanding",
      sub: "Collected by you · 38 of 40 paid",
      badge: { label: "In progress" },
    });
    expect(idle[0]?.primary).toMatchObject({ kind: "distribute", transactions: 2 });
  });

  it("surfaces an overdue calculation and rejected Bitcoin payouts as their own cards", () => {
    const rejected = distribution({
      cycle: 140,
      distribution: 2,
      availableToCollectSats: "0",
      collectedSats: "1400000",
      payments: {
        made: 40,
        outstanding: 0,
        notPayable: 0,
        belowFee: 0,
        rolledForward: 0,
        arriving: 0,
        rejected: 1,
        returned: 0,
        distributedSats: "1330000",
        outstandingSats: "0",
        operatorFeeSats: "70000",
      },
      status: "needs-attention",
      statusDetail: "1 Bitcoin payout rejected · return pending",
    });
    const cards = deriveDistributionCards({
      ledger: ledger(accruing(141, 1, true), [rejected]),
      gasWallet: gasWallet(),
      engineMode: "operator-run",
      activeRun: null,
    });
    expect(cards.map((card) => [card.key, card.primary?.kind, card.headline])).toEqual([
      ["140:2", "finish-bitcoin-payouts", "1 Bitcoin payout was rejected"],
      ["141:1", "calculate", "Calculation is overdue — you can run it"],
    ]);
    expect(cards[0]?.attention?.title).toBe("1 rejected withdrawal");
    expect(cards[1]?.tiles).toEqual([]);
    expect(cards[1]?.calculated).toBe(false);
  });

  it("leaves complete and accruing distributions out of Distribute", () => {
    expect(
      pendingDistributions(ledger(accruing(141, 2), [complete(141, 1), complete(140, 2)])),
    ).toEqual([]);
  });

  it("explains why execution is unavailable without a gas wallet or in Observe mode", () => {
    const base = ledger(distribution({ cycle: 141, distribution: 2, current: true }));
    const observe = deriveDistributionCards({
      ledger: base,
      gasWallet: null,
      engineMode: "observe",
      activeRun: null,
    });
    expect(observe[0]?.execution).toMatchObject({ available: false, walletFallback: true });
    const low = deriveDistributionCards({
      ledger: base,
      gasWallet: gasWallet({ estimatedTransactions: 10 }),
      engineMode: "operator-run",
      activeRun: null,
    });
    expect(low[0]?.execution.reason).toBe(
      "Gas wallet needs about 3.10 STX more to cover 41 transactions",
    );
  });
});

describe("payment rows", () => {
  it("groups statuses into tabs and words, including rolled-forward rows", () => {
    expect(paymentTab(payment({ status: "below-fee" }))).toBe("outstanding");
    expect(paymentTab(payment({ status: "arrived" }))).toBe("arriving");
    expect(paymentTab(payment({ status: "rolled-forward" }))).toBe("rolled");
    expect(paymentStatusLabel(payment({ status: "rolled-forward" }))).toEqual({
      tone: "caution",
      label: "Rolled forward → Second",
      sub: null,
    });
    expect(paymentStatusLabel(payment({ status: "retired" })).label).toBe("Arrived");
  });

  it("explains a rolled-forward payment from the recorded run history", () => {
    const row = payment({
      distribution: 1,
      status: "rolled-forward",
      stakerEntitlementSats: "0",
      paymentTxId: `0x${"6e".repeat(32)}`,
      paidAt: "2026-08-08T10:21:00.000Z",
      rollForward: {
        reason: "skipped-below-fee-budget",
        detail: "Bitcoin payout is below its configured fee budget",
        runId: "1f3a9c00-0000-4000-8000-000000000001",
        childIndex: 3,
        recordedAt: "2026-08-01T09:52:00.000Z",
        paidWith: { distribution: 2, txId: `0x${"6e".repeat(32)}` },
      },
    });
    expect(rollForwardExplanation(row)).toEqual({
      title: "Skipped in the Aug 1 run · L1 payout below its fee budget",
      detail: "Bitcoin payout is below its configured fee budget",
      footer: "Paid with the Second Distribution · Aug 8 · tx 0x6e6e…6e6e · run 1f3a9c00",
    });
    expect(
      rollForwardExplanation(
        payment({
          status: "rolled-forward",
          rollForward: {
            reason: "not-attempted-run-halted",
            detail: "Current network fee exceeds the approved fee cap",
            runId: null,
            childIndex: null,
            recordedAt: null,
            paidWith: null,
          },
        }),
      ),
    ).toEqual({
      title: "Not attempted — the run halted earlier",
      detail: "Current network fee exceeds the approved fee cap",
      footer: "Still waiting on the Second Distribution payment",
    });
    expect(rollForwardExplanation(payment({}))).toBeNull();
  });

  it("sorts by integer sats, never rendered strings", () => {
    const small = payment({ stakerPrincipal: alice, payoutSats: "5", stakerEntitlementSats: "5" });
    const large = payment({
      stakerPrincipal: bob,
      payoutSats: "1000000",
      stakerEntitlementSats: "1000000",
    });
    expect([small, large].sort((a, b) => comparePayments(a, b, "toStaker", "desc"))[0]).toBe(large);
    expect([large, small].sort((a, b) => comparePayments(a, b, "toStaker", "asc"))[0]).toBe(small);
  });

  it("keeps who / when / txid in the tooltip", () => {
    const tooltip = distributionTooltip(
      distribution({
        cycle: 141,
        distribution: 1,
        collects: [
          {
            sats: "1400000",
            stxSats: "1400000",
            txId: `0x${"9a".repeat(32)}`,
            blockHeight: 4_100,
            by: "you",
          },
        ],
        payments: { ...distribution({ cycle: 141, distribution: 1 }).payments, rolledForward: 2 },
      }),
    );
    expect(tooltip).toBe(
      [
        "Calculated Aug 19, 17:27 UTC · by another caller · tx 0x7c7c…7c7c",
        "Collected block 4,100 · by you · tx 0x9a9a…9a9a",
        "2 payments rolled forward to the Second Distribution",
      ].join("\n"),
    );
  });
});
