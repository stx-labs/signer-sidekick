import { MagnifyingGlass } from "@phosphor-icons/react";
import type { RewardLedgerPayment } from "@stx-labs/signer-sidekick-api-contracts";
import { useMemo, useState } from "react";
import { SortableHeader, type TableSort } from "../../shared/dashboard-ui.js";
import { amount, exactSats } from "../../shared/format.js";
import {
  comparePayments,
  type PaymentSortKey,
  type PaymentTab,
  paymentStatusLabel,
  paymentTab,
  rollForwardExplanation,
  shortDate,
} from "./reward-state.js";
import { Pager, StakerCell, StatusChip } from "./reward-ui.js";

const PAGE_SIZE = 10;
const SEARCH_THRESHOLD = 10;

export type PaymentsVariant = "pending" | "history";

function tabCounts(payments: readonly RewardLedgerPayment[]) {
  const counts = { outstanding: 0, paid: 0, arriving: 0, rejected: 0, rolled: 0 };
  for (const row of payments) counts[paymentTab(row)] += 1;
  return counts;
}

function shortTx(txId: string | null): string {
  if (!txId) return "";
  return `${txId.slice(0, 6)}…${txId.slice(-4)}`;
}

/**
 * Dense payment rows shared by the Distribute cards (`pending`: gross, fee, to staker, status) and
 * the past-cycle panels (`history`: to staker, status, paid). Ten per page; Bitcoin-route stakers
 * carry the ₿ marker with their L1 address; rolled-forward rows explain themselves on hover.
 */
export function PaymentsTable({
  payments,
  variant = "pending",
  defaultTab,
  emptyText,
  toolbarRight,
  pageSize = PAGE_SIZE,
}: {
  payments: readonly RewardLedgerPayment[];
  variant?: PaymentsVariant;
  defaultTab?: PaymentTab;
  emptyText?: string;
  /** Replaces the count on the toolbar's right (past-cycle exports live here). */
  toolbarRight?: React.ReactNode;
  pageSize?: number;
}) {
  const counts = useMemo(() => tabCounts(payments), [payments]);
  const initialTab: PaymentTab =
    defaultTab ??
    (variant === "history"
      ? "all"
      : counts.rejected > 0
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
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<TableSort<PaymentSortKey>>(
    variant === "pending"
      ? { key: "toStaker", direction: "desc" }
      : { key: "staker", direction: "asc" },
  );
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return [...payments]
      .filter((row) => tab === "all" || paymentTab(row) === tab)
      .filter((row) => needle === "" || row.stakerPrincipal.toLowerCase().includes(needle))
      .sort((left, right) => comparePayments(left, right, sort.key, sort.direction));
  }, [payments, tab, search, sort]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const tabs: Array<[PaymentTab, string, number]> =
    variant === "history"
      ? [
          ["all", "All", payments.length],
          ["paid", "Paid", counts.paid],
        ]
      : [
          ["outstanding", "Outstanding", counts.outstanding],
          ["paid", "Paid", counts.paid],
          ["arriving", "Arriving", counts.arriving],
        ];
  if (variant === "history" && counts.arriving > 0)
    tabs.push(["arriving", "Arriving", counts.arriving]);
  if (variant === "history" && counts.outstanding > 0) {
    tabs.push(["outstanding", "Outstanding", counts.outstanding]);
  }
  if (counts.rolled > 0) tabs.push(["rolled", "Rolled forward", counts.rolled]);
  if (counts.rejected > 0) tabs.push(["rejected", "Rejected", counts.rejected]);
  const hasAny = payments.length > 0;
  const selectTab = (key: PaymentTab) => {
    setTab(key);
    setPage(0);
  };
  return (
    <div className={`tbl-wrap rw-dense rw-payments rw-payments-${variant}`}>
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
                  onClick={() => selectTab(key)}
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
                    setPage(0);
                  }}
                />
              </label>
            ) : null}
          </div>
          {toolbarRight ?? (
            <div className="total">
              {filtered.length === payments.length
                ? `${payments.length} payments`
                : `${filtered.length} of ${payments.length} payments`}
            </div>
          )}
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
              {variant === "pending" ? (
                <>
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
                </>
              ) : null}
              <SortableHeader
                label="To staker"
                column="toStaker"
                sort={sort}
                setSort={setSort}
                align="right"
                title="What the staker receives: sBTC directly, or BTC over Bitcoin after the Bitcoin fee budget. Hover an amount for the exact sats."
              />
              <th scope="col">Status</th>
              {variant === "history" ? (
                <th scope="col" className="rw-hide-sm">
                  Paid
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const status = paymentStatusLabel(row);
              const rolled = row.status === "rolled-forward";
              const toStaker = row.payoutSats ?? row.stakerEntitlementSats;
              const toStakerAsset = row.payoutAsset ?? "sBTC";
              const amountTitle = rolled
                ? row.grossRewardSats
                  ? `gross ${exactSats(row.grossRewardSats)} at preparation · the first-half amount was paid with the Second Distribution`
                  : "the first-half amount was paid with the Second Distribution"
                : `${exactSats(toStaker)}${row.route === "bitcoin" && row.l1MaxFeeSats ? ` · entitlement ${exactSats(row.stakerEntitlementSats)} minus the ${exactSats(row.l1MaxFeeSats)} Bitcoin fee budget` : ""}${row.grossRewardSats ? ` · gross ${exactSats(row.grossRewardSats)}` : ""}${row.operatorFeeSats ? ` · fee ${exactSats(row.operatorFeeSats)}` : ""}`;
              const amountText = rolled
                ? row.grossRewardSats
                  ? amount(row.grossRewardSats)
                  : "—"
                : amount(toStaker, row.status === "returned" ? "sBTC" : toStakerAsset);
              const paidText = row.paymentTxId
                ? `${row.paidAt ? shortDate(row.paidAt) : row.paymentBlockHeight ? `block ${row.paymentBlockHeight.toLocaleString("en-US")}` : "paid"} · ${shortTx(row.paymentTxId)}`
                : "—";
              return (
                <tr
                  key={`${row.cycle}|${row.distribution}|${row.stakerPrincipal}|${row.bucket}|${row.paymentTxId ?? "outstanding"}`}
                >
                  <td>
                    <StakerCell
                      principal={row.stakerPrincipal}
                      bitcoin={row.route === "bitcoin"}
                      l1Address={row.l1Address}
                    />
                    {row.bucket !== "stx" ? (
                      <span className="rw-pay-sub">{row.bucket.replace("bond-", "bond ")}</span>
                    ) : null}
                    {row.includesPriorDistribution ? (
                      <span
                        className="rw-pay-sub"
                        title="Carries the First Distribution amount too"
                      >
                        + First
                      </span>
                    ) : null}
                  </td>
                  {variant === "pending" ? (
                    <>
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
                    </>
                  ) : null}
                  <td className="mono right" title={amountTitle}>
                    {amountText}
                  </td>
                  <td>
                    <StatusChip
                      tone={status.tone}
                      label={status.label}
                      tooltip={status.sub}
                      popover={rolled ? rollForwardExplanation(row) : null}
                    />
                    {row.coverage === "historical-coverage-incomplete" ? (
                      <span className="rw-pay-sub rw-coverage">history incomplete</span>
                    ) : null}
                  </td>
                  {variant === "history" ? (
                    <td className="rw-hide-sm">
                      <span className="rw-txid" title={row.paymentTxId ?? undefined}>
                        {paidText}
                      </span>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {hasAny ? (
        <Pager page={currentPage} pageSize={pageSize} total={filtered.length} onPage={setPage} />
      ) : null}
    </div>
  );
}
