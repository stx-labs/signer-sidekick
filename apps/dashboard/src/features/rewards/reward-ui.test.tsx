import type { RewardLedgerPayment } from "@stx-labs/signer-sidekick-api-contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StakerCell, TxIdMarker } from "./reward-ui.js";

const stacksTxId = `0x${"11".repeat(32)}`;
const bitcoinTxId = `0x${"22".repeat(32)}`;
const retirementTxId = `0x${"33".repeat(32)}`;

function payment(overrides: Partial<RewardLedgerPayment> = {}): RewardLedgerPayment {
  return {
    schemaVersion: 1,
    cycle: 141,
    distribution: 1,
    bucket: "stx",
    stakerPrincipal: "SP000000000000000000002Q6VF78",
    route: "sbtc",
    grossRewardSats: "1000",
    operatorFeeSats: "50",
    stakerEntitlementSats: "950",
    payoutSats: "950",
    payoutAsset: "sBTC",
    l1MaxFeeSats: null,
    l1ActualFeeSats: null,
    feeRefundSats: null,
    returnedSats: null,
    status: "paid",
    coverage: "exact",
    includesPriorDistribution: false,
    paymentTxId: stacksTxId,
    paymentBlockHeight: 8_800_000,
    paidAt: "2026-08-23T12:00:00.000Z",
    by: "you",
    l1RequestId: null,
    l1Status: null,
    settleOrReclaimTxId: null,
    btcSweepTxId: null,
    btcSweepBlockHeight: null,
    unavailableReason: null,
    l1Address: null,
    rollForward: null,
    ...overrides,
  };
}

describe("reward transaction marker", () => {
  it("shows the direct sBTC payout transaction", () => {
    const html = renderToStaticMarkup(<TxIdMarker payment={payment()} />);
    expect(html).toContain(">txid<");
    expect(html).toContain("sBTC payout");
    expect(html).toContain(stacksTxId);
  });

  it("prioritizes the Bitcoin payout while retaining its Stacks evidence", () => {
    const html = renderToStaticMarkup(
      <TxIdMarker
        payment={payment({
          route: "bitcoin",
          payoutAsset: "BTC",
          status: "retired",
          l1RequestId: "2684",
          l1Status: "retired",
          btcSweepTxId: bitcoinTxId,
          btcSweepBlockHeight: 963_758,
          settleOrReclaimTxId: retirementTxId,
        })}
      />,
    );
    expect(html.indexOf("Bitcoin payout")).toBeLessThan(html.indexOf("Stacks withdrawal request"));
    expect(html).toContain(bitcoinTxId);
    expect(html).toContain(stacksTxId);
    expect(html).toContain(retirementTxId);
  });
});

describe("reward staker principal", () => {
  it("shows six characters on each side and retains the full principal for hover or focus", () => {
    const principal = "SP3CQC73G4YN9XAPMQEGV0X7YZGEZHERM8M30KVR1";
    const html = renderToStaticMarkup(<StakerCell principal={principal} />);
    expect(html).toContain("SP3CQC…30KVR1");
    expect(html).toContain(`title="${principal}"`);
    expect(html).toContain(`data-copy-value="${principal}"`);
  });
});
