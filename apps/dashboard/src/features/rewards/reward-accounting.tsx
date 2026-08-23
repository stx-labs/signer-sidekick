import { DownloadSimple } from "@phosphor-icons/react";
import type { RewardLedger } from "@stx-labs/signer-sidekick-api-contracts";
import { useState } from "react";
import { amount, feePercent } from "../../shared/format.js";
import { operatorErrorSentence } from "../../shared/operator-error.js";
import {
  downloadRewardLedgerExport,
  type RewardLedgerExportFormat,
  type RewardLedgerExportName,
} from "./reward-ledger-api.js";
import { shortDate } from "./reward-state.js";
import { InfoTip } from "./reward-ui.js";

/**
 * Accounting: the operator's fee ledger in one card, with the export of the whole history along
 * its foot. Per-distribution and per-cycle exports live in the past-cycles panel, next to the data.
 */
export function RewardFeeLedger({
  token,
  ledger,
  feeActions,
}: {
  token: string;
  ledger: RewardLedger;
  feeActions?: React.ReactNode;
}) {
  const [format, setFormat] = useState<RewardLedgerExportFormat>("csv");
  const [busy, setBusy] = useState<RewardLedgerExportName | null>(null);
  const [error, setError] = useState<string | null>(null);
  const download = (name: RewardLedgerExportName) => {
    setBusy(name);
    setError(null);
    downloadRewardLedgerExport(token, name, format, { scope: "all" })
      .catch((cause: unknown) => setError(operatorErrorSentence(cause)))
      .finally(() => setBusy(null));
  };
  const currentCycle = ledger.cycles.find((cycle) => cycle.cycle === ledger.current.cycle) ?? null;
  const facts: Array<{
    label: React.ReactNode;
    key: string;
    value: string;
    sub?: React.ReactNode;
  }> = [
    {
      key: "cycle",
      label: currentCycle ? `Earned in cycle ${currentCycle.cycle}` : "Earned this cycle",
      value: amount(currentCycle?.operatorFeeSats ?? "0"),
    },
    {
      key: "all-time",
      label: (
        <>
          Earned all time <InfoTip text="Sum of the operator fee on every indexed payment" />
        </>
      ),
      value: amount(ledger.fees.earnedIndexedSats),
    },
    {
      key: "withdrawn",
      label: (
        <>
          Withdrawn{" "}
          <InfoTip text="Derived: earned all time minus the balance held in the manager; the manager emits no event when fees are withdrawn" />
        </>
      ),
      value: amount(ledger.fees.withdrawnDerivedSats),
    },
    {
      key: "balance",
      label: "Balance in manager",
      value: amount(ledger.fees.balanceInManagerSats),
      sub: feeActions ? null : <span className="muted">withdraw from Settings › Manager</span>,
    },
  ];
  return (
    <>
      <div className="section-title domain-section-anchor" id="rewards-fees">
        Accounting
      </div>
      <section className="card rw-fee-card" aria-labelledby="rw-fee-title">
        <div className="card-head">
          <h2 id="rw-fee-title">Your fee ledger</h2>
          {ledger.fees.feeBips ? (
            <span className="badge b-info">
              {feePercent(ledger.fees.feeBips)}
              {currentCycle?.feeEvidence === "locked" ? " locked" : " configured"}
            </span>
          ) : null}
        </div>
        <dl className="rw-fee-grid">
          {facts.map((fact) => (
            <div key={fact.key}>
              <dt>{fact.label}</dt>
              <dd>
                {fact.value}
                {fact.sub ? <small>{fact.sub}</small> : null}
              </dd>
            </div>
          ))}
        </dl>
        {feeActions ? <div className="reward-admin-actions">{feeActions}</div> : null}
        <div className="rw-export-all">
          <span className="rw-export-all-label">Export all history</span>
          {(["payments", "distributions", "fees"] as const).map((name) => (
            <button
              key={name}
              className="btn btn-secondary sm"
              type="button"
              disabled={busy !== null}
              onClick={() => download(name)}
              title={`${name}.${format} for every cycle Sidekick has seen`}
            >
              <DownloadSimple className="rw-ico" aria-hidden="true" />
              {busy === name ? "Preparing…" : name[0]?.toUpperCase() + name.slice(1)}
            </button>
          ))}
          <div className="seg">
            <button
              className={format === "csv" ? "on" : undefined}
              type="button"
              onClick={() => setFormat("csv")}
            >
              CSV
            </button>
            <button
              className={format === "json" ? "on" : undefined}
              type="button"
              onClick={() => setFormat("json")}
            >
              JSON
            </button>
          </div>
          <span className="muted">
            {ledger.cycles.length} cycles · through {shortDate(ledger.generatedAt)}
            {ledger.evidenceWindow.truncated
              ? ` · history before block ${ledger.evidenceWindow.oldestRetainedBlockHeight?.toLocaleString("en-US")} is marked incomplete`
              : ""}
          </span>
        </div>
        {error ? (
          <p className="tertiary balance-note" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </>
  );
}
