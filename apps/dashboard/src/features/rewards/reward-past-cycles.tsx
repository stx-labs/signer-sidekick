import { DownloadSimple } from "@phosphor-icons/react";
import type {
  RewardLedgerCycle,
  RewardLedgerDistribution,
  RewardLedgerPayment,
} from "@stx-labs/signer-sidekick-api-contracts";
import { useState } from "react";
import { amount } from "../../shared/format.js";
import {
  DistributionHistoryDetails,
  type DistributionPaymentsState,
} from "./reward-distribution-history.js";
import { type CycleGeometry, distributionName, paymentTotal, shortDate } from "./reward-state.js";
import { ChevronButton } from "./reward-ui.js";

const PAGE = 6;

export interface PastCyclesExportQuery {
  cycle: number;
  distribution?: 1 | 2;
}

function cycleBadge(cycle: RewardLedgerCycle): { tone: string; label: string } {
  const statuses = cycle.distributions.map((d) => d.status);
  if (statuses.includes("needs-attention")) return { tone: "error", label: "Needs attention" };
  if (statuses.every((s) => s === "complete")) return { tone: "success", label: "Complete" };
  if (statuses.some((s) => s === "all-distributed"))
    return { tone: "success", label: "All distributed" };
  if (statuses.some((s) => s === "distributing" || s === "ready"))
    return { tone: "info", label: "In progress" };
  return { tone: "neutral", label: "Open" };
}

/** Approximate calendar span of a cycle from the current geometry and the average block time. */
function cycleDates(
  cycle: number,
  geometry: CycleGeometry | null,
  seconds: number,
  now: Date,
): string | null {
  if (!geometry) return null;
  const start = geometry.cycleStart - (geometry.cycle - cycle) * geometry.length;
  const end = start + geometry.length - 1;
  const at = (height: number) =>
    new Date(now.getTime() - (geometry.burnHeight - height) * seconds * 1000).toISOString();
  return `${shortDate(at(start))} – ${shortDate(at(end))}`;
}

function distributionMeta(d: RewardLedgerDistribution): string {
  const p = d.payments;
  return [
    d.calculation.state === "done" ? amount(d.calculation.poolSats) : "not calculated",
    `${p.made} of ${paymentTotal(d)} paid`,
    p.rolledForward > 0 ? `${p.rolledForward} rolled forward` : null,
    p.rejected > 0 ? `${p.rejected} rejected` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Past cycles as a ledger: one line per cycle; a cycle opens into its two distributions (tabs),
 * a one-line summary, and that distribution's payments with exports where the data is.
 */
export function PastCyclesLedger({
  cycles,
  loadPayments,
  onExport,
  exportBusy = false,
  geometry = null,
  burnBlockSeconds = null,
  now = new Date(),
  totalWithActivity,
}: {
  cycles: readonly RewardLedgerCycle[];
  loadPayments: (cycle: number, distribution: 1 | 2) => Promise<RewardLedgerPayment[]>;
  onExport: (query: PastCyclesExportQuery) => void;
  exportBusy?: boolean;
  geometry?: CycleGeometry | null;
  burnBlockSeconds?: number | null;
  now?: Date;
  totalWithActivity?: number;
}) {
  const [shown, setShown] = useState(PAGE);
  const [openCycle, setOpenCycle] = useState<number | null>(null);
  const [tabs, setTabs] = useState<Record<number, 1 | 2>>({});
  const [payments, setPayments] = useState<Record<string, DistributionPaymentsState>>({});
  if (cycles.length === 0) return null;
  const visible = cycles.slice(0, shown);
  const seconds = burnBlockSeconds ?? 600;

  const ensurePayments = (cycle: number, distribution: 1 | 2) => {
    const key = `${cycle}:${distribution}`;
    if (payments[key]) return;
    setPayments((current) => ({ ...current, [key]: { rows: null, error: null } }));
    loadPayments(cycle, distribution)
      .then((rows) => setPayments((current) => ({ ...current, [key]: { rows, error: null } })))
      .catch((cause: unknown) =>
        setPayments((current) => ({
          ...current,
          [key]: { rows: null, error: cause instanceof Error ? cause.message : String(cause) },
        })),
      );
  };
  const toggle = (cycle: RewardLedgerCycle) => {
    if (openCycle === cycle.cycle) {
      setOpenCycle(null);
      return;
    }
    const tab = tabs[cycle.cycle] ?? cycle.distributions[0]?.distribution ?? 1;
    setOpenCycle(cycle.cycle);
    ensurePayments(cycle.cycle, tab);
  };
  const selectTab = (cycle: number, distribution: 1 | 2) => {
    setTabs((current) => ({ ...current, [cycle]: distribution }));
    ensurePayments(cycle, distribution);
  };

  return (
    <>
      <div className="section-title rw-past-title domain-section-anchor" id="rewards-history">
        Past cycles
      </div>
      <section className="card rw-ledger" aria-label="Past cycles">
        <table className="rw-ledger-table">
          <thead>
            <tr>
              <th scope="col">Cycle</th>
              <th scope="col" className="rw-hide-sm">
                Dates
              </th>
              <th scope="col" className="right">
                To stakers
              </th>
              <th scope="col" className="right rw-hide-sm">
                Your fee
              </th>
              <th scope="col" className="right">
                Payments
              </th>
              <th scope="col" className="rw-ledger-toggle">
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((cycle) => {
              const badge = cycleBadge(cycle);
              const open = openCycle === cycle.cycle;
              const made = cycle.distributions.reduce((sum, d) => sum + d.payments.made, 0);
              const total = cycle.distributions.reduce((sum, d) => sum + paymentTotal(d), 0);
              const tab = tabs[cycle.cycle] ?? cycle.distributions[0]?.distribution ?? 1;
              const active =
                cycle.distributions.find((d) => d.distribution === tab) ??
                cycle.distributions[0] ??
                null;
              const state = active ? payments[`${cycle.cycle}:${active.distribution}`] : undefined;
              const dates = cycleDates(cycle.cycle, geometry, seconds, now);
              return [
                <tr
                  className={`rw-ledger-row${open ? " is-open" : ""}`}
                  key={cycle.cycle}
                  id={`rewards-cycle-${cycle.cycle}`}
                  aria-label={`Cycle ${cycle.cycle}`}
                >
                  <td>
                    <span className="rw-ledger-cycle">Cycle {cycle.cycle}</span>{" "}
                    <span className={`badge b-${badge.tone}`}>{badge.label}</span>
                    {cycle.coverage === "historical-coverage-incomplete" ? (
                      <span
                        className="rw-coverage"
                        title="Sidekick has not yet seen every payment for this cycle"
                      >
                        {" "}
                        history incomplete
                      </span>
                    ) : null}
                  </td>
                  <td
                    className="mono rw-hide-sm"
                    title="Estimated from the average Bitcoin block time"
                  >
                    {dates ?? "—"}
                  </td>
                  <td className="mono right">{amount(cycle.distributedSats)}</td>
                  <td className="mono right rw-hide-sm">{amount(cycle.operatorFeeSats)}</td>
                  <td className="mono right">
                    {made} of {total}
                  </td>
                  <td className="right rw-ledger-toggle">
                    <ChevronButton
                      expanded={open}
                      onClick={() => toggle(cycle)}
                      label={open ? "Hide distributions" : "Show distributions"}
                    />
                  </td>
                </tr>,
                open && active ? (
                  <tr className="rw-ledger-panel-row" key={`${cycle.cycle}-panel`}>
                    <td colSpan={6}>
                      <div className="rw-ledger-panel">
                        <div
                          className="rw-dist-tabs"
                          role="tablist"
                          aria-label={`Cycle ${cycle.cycle} distributions`}
                        >
                          {cycle.distributions.map((d) => (
                            <button
                              key={d.distribution}
                              type="button"
                              role="tab"
                              aria-selected={d.distribution === active.distribution}
                              className={d.distribution === active.distribution ? "on" : undefined}
                              onClick={() => selectTab(cycle.cycle, d.distribution)}
                            >
                              <span className="t">{distributionName(d.distribution)}</span>
                              <span className="m">{distributionMeta(d)}</span>
                            </button>
                          ))}
                        </div>
                        <DistributionHistoryDetails
                          distribution={active}
                          state={state}
                          toolbarRight={
                            <div className="rw-export-inline">
                              <span className="muted">Export</span>
                              <button
                                className="btn btn-tertiary sm"
                                type="button"
                                disabled={exportBusy}
                                onClick={() =>
                                  onExport({
                                    cycle: cycle.cycle,
                                    distribution: active.distribution,
                                  })
                                }
                              >
                                <DownloadSimple className="rw-ico" aria-hidden="true" />
                                This distribution
                              </button>
                              <button
                                className="btn btn-tertiary sm"
                                type="button"
                                disabled={exportBusy}
                                onClick={() => onExport({ cycle: cycle.cycle })}
                              >
                                <DownloadSimple className="rw-ico" aria-hidden="true" />
                                Cycle {cycle.cycle}
                              </button>
                            </div>
                          }
                        />
                      </div>
                    </td>
                  </tr>
                ) : null,
              ];
            })}
          </tbody>
        </table>
        {cycles.length > PAGE || totalWithActivity !== undefined ? (
          <div className="rw-table-foot">
            <span>
              {visible.length} of {totalWithActivity ?? cycles.length} cycles
            </span>
            {cycles.length > shown ? (
              <button
                className="btn btn-tertiary sm"
                type="button"
                onClick={() => setShown((value) => value + PAGE)}
              >
                Show older
              </button>
            ) : null}
          </div>
        ) : null}
      </section>
    </>
  );
}
