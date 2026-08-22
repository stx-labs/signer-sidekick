import type {
  RewardLedgerCycle,
  RewardLedgerDistribution,
  RewardLedgerPayment,
} from "@stx-labs/signer-sidekick-api-contracts";
import { useState } from "react";
import { amount, feePercent } from "../../shared/format.js";
import { PaymentsTable } from "./reward-payments.js";
import { distributionName, distributionTooltip, paymentTotal } from "./reward-state.js";
import { ChevronButton, InfoTip } from "./reward-ui.js";

const PAGE = 5;

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

function DistributionRow({
  distribution,
  loadPayments,
}: {
  distribution: RewardLedgerDistribution;
  loadPayments: (cycle: number, distribution: 1 | 2) => Promise<RewardLedgerPayment[]>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [payments, setPayments] = useState<RewardLedgerPayment[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const total = paymentTotal(distribution);
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && payments === null && !loading) {
      setLoading(true);
      setError(null);
      loadPayments(distribution.cycle, distribution.distribution)
        .then((rows) => setPayments(rows))
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setLoading(false));
    }
  };
  return (
    <>
      <div className="rw-dist">
        <div className="rw-dist-name">
          {distributionName(distribution.distribution)}{" "}
          <InfoTip text={distributionTooltip(distribution)} />
          {distribution.coverage === "historical-coverage-incomplete" ? (
            <span
              className="rw-coverage"
              title="Sidekick has not yet seen every payment for this distribution"
            >
              history incomplete
            </span>
          ) : null}
        </div>
        <div className="rw-dist-fact">
          <span>Calculated</span>
          <strong>
            {distribution.calculation.state === "done"
              ? amount(distribution.calculation.poolSats)
              : "—"}
          </strong>
        </div>
        <div className="rw-dist-fact">
          <span>Collected</span>
          <strong>{amount(distribution.collectedSats)}</strong>
        </div>
        <div className="rw-dist-fact">
          <span>Distributed</span>
          <strong>
            {distribution.payments.made} of {total}
            {distribution.payments.rolledForward > 0 ? (
              <span className="rw-roll">
                · {distribution.payments.rolledForward} rolled forward
              </span>
            ) : null}
          </strong>
        </div>
        <ChevronButton
          expanded={expanded}
          onClick={toggle}
          label={expanded ? "Hide payments" : "Show payments"}
        />
      </div>
      {expanded ? (
        loading ? (
          <div className="rw-cycle-payments rw-loading" role="status">
            Loading payments…
          </div>
        ) : error ? (
          <div className="rw-cycle-payments rw-loading" role="alert">
            Could not load payments: {error}
          </div>
        ) : (
          <PaymentsTable
            payments={payments ?? []}
            compact
            defaultTab="all"
            emptyText="No payments recorded for this distribution."
          />
        )
      ) : null}
    </>
  );
}

export function PastCycles({
  cycles,
  loadPayments,
  onViewCycleRef,
  totalWithActivity,
}: {
  cycles: readonly RewardLedgerCycle[];
  loadPayments: (cycle: number, distribution: 1 | 2) => Promise<RewardLedgerPayment[]>;
  onViewCycleRef?: (cycle: number, element: HTMLElement | null) => void;
  totalWithActivity?: number;
}) {
  const [shown, setShown] = useState(PAGE);
  if (cycles.length === 0) return null;
  const visible = cycles.slice(0, shown);
  return (
    <>
      <div className="section-title domain-section-anchor" id="rewards-history">
        Past cycles{" "}
        <span className="hint">two distributions per cycle · fee locks once per cycle</span>
      </div>
      {visible.map((cycle) => {
        const badge = cycleBadge(cycle);
        return (
          <section
            className="card rw-cycle"
            aria-label={`Cycle ${cycle.cycle}`}
            key={cycle.cycle}
            id={`rewards-cycle-${cycle.cycle}`}
            ref={(element) => onViewCycleRef?.(cycle.cycle, element)}
          >
            <div className="rw-cycle-head">
              <h3>
                Cycle {cycle.cycle} <span className={`badge b-${badge.tone}`}>{badge.label}</span>
              </h3>
              <div className="rw-totals">
                {cycle.feeBips ? (
                  <span>
                    fee {cycle.feeEvidence === "locked" ? "locked" : "assumed"}{" "}
                    <strong>{feePercent(cycle.feeBips)}</strong>
                  </span>
                ) : null}
                <span>
                  to stakers <strong>{amount(cycle.distributedSats)}</strong>
                </span>
                <span>
                  your fee <strong>{amount(cycle.operatorFeeSats)}</strong>
                </span>
              </div>
            </div>
            {cycle.distributions.map((distribution) => (
              <DistributionRow
                key={distribution.distribution}
                distribution={distribution}
                loadPayments={loadPayments}
              />
            ))}
          </section>
        );
      })}
      {cycles.length > shown ? (
        <div
          className="rw-table-foot"
          style={{ border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-md)" }}
        >
          <span>
            Showing cycles {visible[0]?.cycle}–{visible.at(-1)?.cycle} of{" "}
            {totalWithActivity ?? cycles.length} with reward activity
          </span>
          <button
            className="btn btn-tertiary sm"
            type="button"
            onClick={() => setShown((value) => value + PAGE)}
          >
            Show older cycles
          </button>
        </div>
      ) : null}
    </>
  );
}
