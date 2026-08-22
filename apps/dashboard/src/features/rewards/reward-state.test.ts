import type {
  GasWalletStatus,
  RewardLedger,
  RewardLedgerDistribution,
  RewardLedgerPayment,
} from "@stx-labs/signer-sidekick-api-contracts";
import { describe, expect, it } from "vitest";
import {
  comparePayments,
  deriveRewardNow,
  distributionTooltip,
  paymentStatusLabel,
  paymentTab,
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
      observedAt: "2026-08-22T03:14:00.000Z",
      poolSats: "1287000",
      poolSatsUnavailableReason: null,
      by: "another-caller",
    },
    collects: [],
    collectedSats: "0",
    availableToCollectSats: "1287000",
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
      outstandingSats: "1222650",
      operatorFeeSats: "0",
    },
    status: "ready",
    statusDetail: "Ready to collect and distribute",
    coverage: "exact",
    ...overrides,
  };
}

function ledger(
  current: RewardLedgerDistribution,
  extra: RewardLedgerDistribution[] = [],
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
    payments: [],
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
    ...overrides,
  };
}

describe("deriveRewardNow", () => {
  it("offers Collect & distribute when the calculation is in and nothing has moved", () => {
    const current = distribution({ cycle: 141, distribution: 2, current: true });
    const first = distribution({
      cycle: 141,
      distribution: 1,
      calculation: {
        state: "done",
        txId: `0x${"41".repeat(32)}`,
        blockHeight: 4_000,
        calculationBurnHeight: 907_000,
        observedAt: "2026-08-15T03:20:00.000Z",
        poolSats: "1250000",
        poolSatsUnavailableReason: null,
        by: "another-caller",
      },
      collectedSats: "1250000",
      availableToCollectSats: "0",
      payments: {
        made: 40,
        outstanding: 0,
        notPayable: 0,
        belowFee: 0,
        rolledForward: 0,
        arriving: 0,
        rejected: 0,
        returned: 0,
        distributedSats: "1187500",
        outstandingSats: "0",
        operatorFeeSats: "62500",
      },
      status: "complete",
      statusDetail: "Complete",
    });
    const model = deriveRewardNow({
      ledger: ledger(current, [first]),
      snapshot: null,
      gasWallet: gasWallet(),
      engineMode: "operator-run",
      activeRun: null,
    });
    expect(model).not.toBeNull();
    expect(model?.eyebrow).toBe("Cycle 141 · Second Distribution");
    expect(model?.badge).toMatchObject({ tone: "success", label: "Ready" });
    expect(model?.headline).toBe("Ready to collect & distribute");
    expect(model?.primary).toMatchObject({ kind: "collect-and-distribute", transactions: 41 });
    expect(model?.execution).toMatchObject({ available: true, chipTone: "ok" });
    expect(model?.execution.chip).toBe("Gas wallet 12.48 STX · ≈ 124 tx");
    expect(model?.tiles.map((tile) => tile.label)).toEqual([
      "Calculated for this pool",
      "Collected",
      "Distributed",
      "Your fee",
    ]);
    expect(model?.tiles[0]).toMatchObject({ value: "0.0129", unit: "sBTC" });
    expect(model?.tiles[2]).toMatchObject({
      value: "0",
      unit: "of 40",
      detail: "0.0122 sBTC waiting for stakers",
    });
    expect(model?.tiles[3]).toMatchObject({ value: "64,350", unit: "sats" });
    expect(model?.cycleLine).toMatchObject({ cycle: 141, amount: "0.0254 sBTC" });
    expect(model?.cycleLine?.text).toContain("First Distribution complete");
    expect(model?.sub).toContain("40 payments");
  });

  it("disables the run but keeps the financial state when the gas wallet cannot cover it", () => {
    const current = distribution({ cycle: 141, distribution: 2, current: true });
    const low = deriveRewardNow({
      ledger: ledger(current),
      snapshot: null,
      gasWallet: gasWallet({ balanceUstx: "310000", estimatedTransactions: 3 }),
      engineMode: "operator-run",
      activeRun: null,
    });
    expect(low?.badge.label).toBe("Ready");
    expect(low?.primary?.kind).toBe("collect-and-distribute");
    expect(low?.execution).toMatchObject({ available: false, chipTone: "low" });
    expect(low?.execution.reason).toContain("needs about 3.80 STX more");

    const observe = deriveRewardNow({
      ledger: ledger(current),
      snapshot: null,
      gasWallet: null,
      engineMode: "observe",
      activeRun: null,
    });
    expect(observe?.execution).toMatchObject({
      available: false,
      walletFallback: true,
      chip: null,
    });

    const admin = deriveRewardNow({
      ledger: ledger(current),
      snapshot: null,
      gasWallet: gasWallet({
        refusal: {
          checkedAt: "2026-08-22T12:00:00.000Z",
          isManagerAdmin: true,
          isSignerKey: false,
          isContract: false,
          refusalReason: "manager-admin",
        },
      }),
      engineMode: "operator-run",
      activeRun: null,
    });
    expect(admin?.execution.reason).toContain("dedicated key");
  });

  it("describes accruing, quiet, distributing, complete, and attention states", () => {
    const accruing = distribution({
      cycle: 142,
      distribution: 1,
      current: true,
      calculation: {
        state: "waiting",
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
      status: "accruing",
      statusDetail: "Accruing",
      feeEvidence: "provisional",
    });
    const previous = distribution({
      cycle: 141,
      distribution: 2,
      collectedSats: "1287000",
      availableToCollectSats: "0",
      payments: {
        made: 40,
        outstanding: 0,
        notPayable: 0,
        belowFee: 0,
        rolledForward: 0,
        arriving: 0,
        rejected: 0,
        returned: 0,
        distributedSats: "1222650",
        outstandingSats: "0",
        operatorFeeSats: "64350",
      },
      status: "complete",
      statusDetail: "Complete",
    });
    const quiet = deriveRewardNow({
      ledger: ledger(accruing, [previous]),
      snapshot: null,
      gasWallet: gasWallet(),
      engineMode: "operator-run",
      activeRun: null,
      nextCalculationIn: "2d 4h",
    });
    expect(quiet?.headline).toBe("Nothing to do — accruing for the next distribution");
    expect(quiet?.sub).toContain("Cycle 141 is fully distributed");
    expect(quiet?.sub).toContain("about 2d 4h");
    expect(quiet?.primary).toBeNull();
    expect(quiet?.previous).toMatchObject({ kind: "cycle-complete", cycle: 141 });
    expect(quiet?.tiles[0]?.label).toBe("Projected for this distribution");
    expect(quiet?.tiles[1]?.value).toBe("—");

    const distributing = deriveRewardNow({
      ledger: ledger(
        distribution({
          cycle: 141,
          distribution: 2,
          current: true,
          collectedSats: "1287000",
          availableToCollectSats: "0",
          payments: {
            made: 12,
            outstanding: 28,
            notPayable: 0,
            belowFee: 0,
            rolledForward: 0,
            arriving: 0,
            rejected: 0,
            returned: 0,
            distributedSats: "351000",
            outstandingSats: "871650",
            operatorFeeSats: "18470",
          },
          status: "distributing",
          statusDetail: "Distributing",
        }),
      ),
      snapshot: null,
      gasWallet: gasWallet(),
      engineMode: "operator-run",
      activeRun: null,
    });
    expect(distributing?.headline).toBe("Distributing · 12 of 40 paid");
    expect(distributing?.primary).toMatchObject({
      kind: "distribute",
      label: "Distribute 28 payments",
      transactions: 28,
    });

    const running = deriveRewardNow({
      ledger: ledger(distribution({ cycle: 141, distribution: 2, current: true })),
      snapshot: null,
      gasWallet: gasWallet(),
      engineMode: "operator-run",
      activeRun: {
        runId: "run-1",
        kind: "collect-and-distribute",
        cycle: 141,
        distribution: 2,
        state: "running",
        steps: [],
        transactions: 41,
        transactionsDone: 13,
        estimatedGasUstx: null,
        gasUsedUstx: "120000",
        approvalExpiresAt: null,
        startedAt: null,
        finishedAt: null,
        haltReason: null,
        distributedSats: "351000",
      },
    });
    expect(running?.headline).toBe("Distributing… 13 of 41 payments");
    expect(running?.progress).toMatchObject({ done: 13, total: 41, right: "0.12 STX gas used" });
    expect(running?.badge).toMatchObject({ tone: "accent", live: true });

    const complete = deriveRewardNow({
      ledger: ledger(
        distribution({
          cycle: 141,
          distribution: 2,
          current: true,
          collectedSats: "1287000",
          availableToCollectSats: "0",
          payments: {
            made: 40,
            outstanding: 0,
            notPayable: 0,
            belowFee: 0,
            rolledForward: 0,
            arriving: 3,
            rejected: 0,
            returned: 0,
            distributedSats: "1222650",
            outstandingSats: "0",
            operatorFeeSats: "64350",
          },
          status: "all-distributed",
          statusDetail: "All distributed",
        }),
      ),
      payments: [
        payment({ status: "arrived", route: "bitcoin", stakerPrincipal: bob, l1RequestId: "4187" }),
      ],
      snapshot: null,
      gasWallet: gasWallet(),
      engineMode: "operator-run",
      activeRun: null,
    });
    expect(complete?.headline).toBe("All distributed · 3 payouts arriving over Bitcoin");
    expect(complete?.primary).toBeNull();
    expect(complete?.secondary).toMatchObject({
      kind: "finish-bitcoin-payouts",
      label: "Finish Bitcoin payouts",
    });

    const attention = deriveRewardNow({
      ledger: ledger(
        distribution({
          cycle: 141,
          distribution: 2,
          current: true,
          collectedSats: "1287000",
          availableToCollectSats: "0",
          payments: {
            made: 40,
            outstanding: 0,
            notPayable: 0,
            belowFee: 0,
            rolledForward: 0,
            arriving: 2,
            rejected: 1,
            returned: 0,
            distributedSats: "1222650",
            outstandingSats: "0",
            operatorFeeSats: "64350",
          },
          status: "needs-attention",
          statusDetail: "1 Bitcoin payout was rejected",
        }),
      ),
      snapshot: null,
      gasWallet: gasWallet(),
      engineMode: "operator-run",
      activeRun: null,
    });
    expect(attention?.badge).toMatchObject({ tone: "error", label: "Needs attention" });
    expect(attention?.headline).toBe("1 Bitcoin payout was rejected");
    expect(attention?.primary).toMatchObject({ kind: "finish-bitcoin-payouts", transactions: 1 });
    expect(attention?.attention?.text).toContain("does not change a staker's route");
  });

  it("surfaces a prior distribution that still has payments outstanding", () => {
    const current = distribution({
      cycle: 141,
      distribution: 2,
      current: true,
      calculation: {
        state: "waiting",
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
      status: "accruing",
      statusDetail: "Accruing",
    });
    const first = distribution({
      cycle: 141,
      distribution: 1,
      collectedSats: "1250000",
      availableToCollectSats: "0",
      payments: {
        made: 38,
        outstanding: 2,
        notPayable: 0,
        belowFee: 0,
        rolledForward: 0,
        arriving: 0,
        rejected: 0,
        returned: 0,
        distributedSats: "1162890",
        outstandingSats: "24610",
        operatorFeeSats: "61200",
      },
      status: "distributing",
      statusDetail: "2 payments outstanding",
    });
    const model = deriveRewardNow({
      ledger: ledger(current, [first]),
      snapshot: null,
      gasWallet: gasWallet(),
      engineMode: "operator-run",
      activeRun: null,
    });
    expect(model?.previous).toMatchObject({ kind: "prior-outstanding", distribution: 1, count: 2 });
    expect(model?.previous?.text).toBe(
      "First Distribution still has 2 payments outstanding · 24,610 sats",
    );
    expect(model?.secondary).toMatchObject({ kind: "distribute", label: "Distribute 2 payments" });
    expect(distributionTooltip(first)).toContain(
      "Calculated Aug 22, 03:14 UTC · by another caller · tx 0x7c7c…7c7c",
    );
  });
});

describe("payment helpers", () => {
  it("buckets statuses into tabs and labels them in operator terms", () => {
    expect(paymentTab(payment({ status: "outstanding" }))).toBe("outstanding");
    expect(paymentTab(payment({ status: "below-fee" }))).toBe("outstanding");
    expect(paymentTab(payment({ status: "paid" }))).toBe("paid");
    expect(paymentTab(payment({ status: "sent" }))).toBe("arriving");
    expect(paymentTab(payment({ status: "arrived" }))).toBe("arriving");
    expect(paymentTab(payment({ status: "rejected" }))).toBe("rejected");
    expect(paymentTab(payment({ status: "returned" }))).toBe("paid");
    expect(
      paymentStatusLabel(
        payment({ status: "returned", settleOrReclaimTxId: `0x${"6e".repeat(32)}` }),
      ),
    ).toMatchObject({ tone: "caution", label: "Returned as sBTC" });
    expect(paymentStatusLabel(payment({ status: "sent", l1RequestId: "4181" }))).toMatchObject({
      label: "Sent over Bitcoin",
      sub: "request #4181 · awaiting signers",
    });
  });

  it("sorts amounts by integer sats regardless of rendering", () => {
    const rows = [
      payment({ stakerPrincipal: "SP1", grossRewardSats: "99999", payoutSats: "99999" }),
      payment({ stakerPrincipal: "SP2", grossRewardSats: "100000", payoutSats: "100000" }),
      payment({ stakerPrincipal: "SP3", grossRewardSats: "8150", payoutSats: "8150" }),
      payment({
        stakerPrincipal: "SP4",
        grossRewardSats: null,
        payoutSats: null,
        stakerEntitlementSats: "5",
      }),
    ];
    const ascending = [...rows]
      .sort((a, b) => comparePayments(a, b, "gross", "asc"))
      .map((row) => row.stakerPrincipal);
    expect(ascending).toEqual(["SP4", "SP3", "SP1", "SP2"]);
    const descending = [...rows]
      .sort((a, b) => comparePayments(a, b, "toStaker", "desc"))
      .map((row) => row.stakerPrincipal);
    expect(descending).toEqual(["SP2", "SP1", "SP3", "SP4"]);
  });
});
