import { MagnifyingGlass } from "@phosphor-icons/react";
import type {
  RewardLedgerDistribution,
  RewardLedgerPayment,
} from "@stx-labs/signer-sidekick-api-contracts";
import { useMemo, useState } from "react";
import { SortableHeader, type TableSort } from "../../shared/dashboard-ui.js";
import { amount, exactSats } from "../../shared/format.js";
import {
  comparePayments,
  type PaymentSortKey,
  type PaymentTab,
  paymentStatusLabel,
  paymentTab,
} from "./reward-state.js";
import { RouteCell, StakerCell } from "./reward-ui.js";

const PAGE = 25;
const SEARCH_THRESHOLD = 10;

function tabCounts(payments: readonly RewardLedgerPayment[]) {
  const counts = { outstanding: 0, paid: 0, arriving: 0, rejected: 0 };
  for (const row of payments) counts[paymentTab(row)] += 1;
  return counts;
}

export function PaymentsTable({
  payments,
  compact = false,
  defaultTab,
  emptyText,
}: {
  payments: readonly RewardLedgerPayment[];
  compact?: boolean;
  defaultTab?: PaymentTab;
  emptyText?: string;
}) {
  const counts = useMemo(() => tabCounts(payments), [payments]);
  const initialTab: PaymentTab =
    defaultTab ??
    (counts.rejected > 0
      ? "rejected"
      : counts.outstanding > 0
        ? "outstanding"
        : counts.arriving > 0
          ? "arriving"
          : counts.paid > 0
            ? "paid"
            : "all");
  const [tab, setTab] = useState<PaymentTab>(initialTab);
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [sort, setSort] = useState<TableSort<PaymentSortKey>>({ key: "staker", direction: "asc" });
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return [...payments]
      .filter((row) => tab === "all" || paymentTab(row) === tab)
      .filter((row) => needle === "" || row.stakerPrincipal.toLowerCase().includes(needle))
      .sort((left, right) => comparePayments(left, right, sort.key, sort.direction));
  }, [payments, tab, search, sort]);
  const visible = showAll ? filtered : filtered.slice(0, PAGE);
  const tabs: Array<[PaymentTab, string, number]> = [
    ["outstanding", "Outstanding", counts.outstanding],
    ["paid", "Paid", counts.paid],
    ["arriving", "Arriving", counts.arriving],
  ];
  if (counts.rejected > 0) tabs.push(["rejected", "Rejected", counts.rejected]);
  const hasAny = payments.length > 0;
  return (
    <div className={`tbl-wrap${compact ? " rw-cycle-payments" : ""}`}>
      {hasAny ? (
        <div className="tbl-toolbar">
          <div className="filters">
            <div className="seg" role="tablist" aria-label="Payment status">
              {tabs.map(([key, label, count]) => (
                <button
                  key={key}
                  className={tab === key ? "on" : undefined}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  onClick={() => {
                    setTab(key);
                    setShowAll(false);
                  }}
                >
                  {label} · {count}
                </button>
              ))}
            </div>
            {payments.length > SEARCH_THRESHOLD ? (
              <label className="search-inline">
                <MagnifyingGlass className="rw-ico" aria-hidden="true" />
                <input
                  type="search"
                  placeholder="Find a staker"
                  aria-label="Find a staker"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setShowAll(false);
                  }}
                />
              </label>
            ) : null}
          </div>
          <div className="total">
            {filtered.length === payments.length
              ? `${payments.length} payments`
              : `${filtered.length} of ${payments.length} payments`}
          </div>
        </div>
      ) : null}
      {!hasAny ? (
        <div className="empty-table">{emptyText ?? "No payments for this distribution yet."}</div>
      ) : filtered.length === 0 ? (
        <div className="empty-table">No payments match.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <SortableHeader label="Staker" column="staker" sort={sort} setSort={setSort} />
              <th scope="col" className="rw-hide-sm">
                Route
              </th>
              <SortableHeader
                label="Gross"
                column="gross"
                sort={sort}
                setSort={setSort}
                align="right"
                className="rw-hide-sm"
              />
              <th scope="col" className="right rw-hide-sm">
                Fee
              </th>
              <SortableHeader
                label="To staker"
                column="toStaker"
                sort={sort}
                setSort={setSort}
                align="right"
                title="What the staker receives: sBTC directly, or BTC over Bitcoin after the Bitcoin fee budget"
              />
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const status = paymentStatusLabel(row);
              const toStaker = row.payoutSats ?? row.stakerEntitlementSats;
              const toStakerAsset = row.payoutAsset ?? "sBTC";
              const bitcoinNote =
                row.route === "bitcoin" && row.l1MaxFeeSats && row.status !== "returned"
                  ? `after ${exactSats(row.l1MaxFeeSats)} Bitcoin fee budget`
                  : row.status === "returned"
                    ? "returned as sBTC"
                    : null;
              return (
                <tr
                  key={`${row.stakerPrincipal}|${row.bucket}|${row.paymentTxId ?? "outstanding"}`}
                >
                  <td>
                    <StakerCell principal={row.stakerPrincipal} bitcoin={row.route === "bitcoin"} />
                    {row.bucket !== "stx" ? (
                      <span className="rw-pay-sub">
                        {row.bucket.replace("bond-", "Bitcoin bond ")}
                      </span>
                    ) : null}
                    {row.includesPriorDistribution ? (
                      <span className="rw-pay-sub">includes the First Distribution</span>
                    ) : null}
                  </td>
                  <td className="rw-hide-sm">
                    <RouteCell payment={row} />
                  </td>
                  <td
                    className="mono right rw-hide-sm"
                    title={
                      row.grossRewardSats
                        ? exactSats(row.grossRewardSats)
                        : "gross unavailable without the PoX-5 print"
                    }
                  >
                    {amount(row.grossRewardSats)}
                  </td>
                  <td
                    className="mono right rw-hide-sm"
                    title={row.operatorFeeSats ? exactSats(row.operatorFeeSats) : undefined}
                  >
                    {amount(row.operatorFeeSats)}
                  </td>
                  <td
                    className="mono right"
                    title={`${exactSats(toStaker)}${row.route === "bitcoin" && row.l1MaxFeeSats ? ` · entitlement ${exactSats(row.stakerEntitlementSats)} minus the ${exactSats(row.l1MaxFeeSats)} Bitcoin fee budget` : ""}`}
                  >
                    {amount(toStaker, row.status === "returned" ? "sBTC" : toStakerAsset)}
                    {bitcoinNote ? <span className="rw-pay-sub">{bitcoinNote}</span> : null}
                  </td>
                  <td>
                    <span className={`badge b-${status.tone}`}>{status.label}</span>
                    {status.sub ? <span className="rw-pay-sub">{status.sub}</span> : null}
                    {row.coverage === "historical-coverage-incomplete" ? (
                      <span className="rw-pay-sub rw-coverage">history incomplete</span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {filtered.length > PAGE ? (
        <div className="rw-table-foot">
          <span>
            Showing {visible.length} of {filtered.length}
          </span>
          <button
            className="btn btn-tertiary sm"
            type="button"
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll ? "Show fewer" : `Show all ${filtered.length}`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function paymentsHint(distribution: RewardLedgerDistribution | null): string {
  if (!distribution) return "this distribution";
  const buckets = distribution.payments;
  return buckets.made + buckets.outstanding > 0
    ? "this distribution · one per staker per bucket"
    : "this distribution";
}
