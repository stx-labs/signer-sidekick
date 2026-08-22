import { DownloadSimple } from "@phosphor-icons/react";
import type { RewardLedger } from "@stx-labs/signer-sidekick-api-contracts";
import { useState } from "react";
import { StatLine } from "../../shared/dashboard-ui.js";
import { amount, feePercent } from "../../shared/format.js";
import { operatorErrorSentence } from "../../shared/operator-error.js";
import {
  downloadRewardLedgerExport,
  type RewardLedgerExportFormat,
  type RewardLedgerExportName,
  type RewardLedgerQuery,
} from "./reward-ledger-api.js";
import { InfoTip } from "./reward-ui.js";

type Scope = "distribution" | "cycle" | "all";

export function RewardAccounting({
  token,
  ledger,
  selectedCycle,
  selectedDistribution,
  feeActions,
}: {
  token: string;
  ledger: RewardLedger;
  selectedCycle: number | null;
  selectedDistribution: 1 | 2 | null;
  feeActions?: React.ReactNode;
}) {
  const [scope, setScope] = useState<Scope>("distribution");
  const [format, setFormat] = useState<RewardLedgerExportFormat>("csv");
  const [busy, setBusy] = useState<RewardLedgerExportName | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query: RewardLedgerQuery =
    scope === "all"
      ? { scope: "all" }
      : scope === "cycle"
        ? { cycle: selectedCycle }
        : { cycle: selectedCycle, distribution: selectedDistribution };
  const download = (name: RewardLedgerExportName) => {
    setBusy(name);
    setError(null);
    downloadRewardLedgerExport(token, name, format, query)
      .catch((cause: unknown) => setError(operatorErrorSentence(cause)))
      .finally(() => setBusy(null));
  };
  const currentCycle = ledger.cycles.find((cycle) => cycle.cycle === ledger.current.cycle) ?? null;
  const allTimeFee = ledger.fees.earnedIndexedSats;
  return (
    <>
      <div className="section-title domain-section-anchor" id="rewards-fees">
        Accounting <span className="hint">integer sats · every row carries its transaction ID</span>
      </div>
      <div className="grid cols-2">
        <section className="card" aria-labelledby="rw-export-title">
          <div className="card-head">
            <h2 id="rw-export-title">Export</h2>
            <span className="badge b-neutral">CSV · JSON</span>
          </div>
          <p className="card-sub">
            Distributions, payments, and your fee ledger — built to tie out against a block
            explorer.
          </p>
          <div className="rw-export-row">
            <button
              className={`btn ${scope === "distribution" ? "btn-primary" : "btn-secondary"}`}
              type="button"
              onClick={() => setScope("distribution")}
              disabled={selectedDistribution === null}
            >
              This distribution
            </button>
            <button
              className={`btn ${scope === "cycle" ? "btn-primary" : "btn-secondary"}`}
              type="button"
              onClick={() => setScope("cycle")}
              disabled={selectedCycle === null}
            >
              Cycle {selectedCycle ?? "—"}
            </button>
            <button
              className={`btn ${scope === "all" ? "btn-primary" : "btn-secondary"}`}
              type="button"
              onClick={() => setScope("all")}
            >
              All cycles
            </button>
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
          </div>
          <div className="divider" />
          {(
            [
              [
                "distributions",
                "cycle · distribution · bucket · calculated · collected · fee · distributed · outstanding",
              ],
              [
                "payments",
                "cycle · distribution · staker · route · gross · fee · to staker · status · paid at · txid",
              ],
              ["fees", "fee per payment · refunds · running balance"],
            ] as const
          ).map(([name, columns]) => (
            <div className="statline" key={name}>
              <span className="k">
                <button
                  className="btn btn-tertiary sm"
                  type="button"
                  onClick={() => download(name)}
                  disabled={busy !== null}
                >
                  <DownloadSimple className="rw-ico" aria-hidden="true" />
                  {busy === name ? "Preparing…" : `${name}.${format}`}
                </button>
              </span>
              <span className="v">
                <span className="sub">{columns}</span>
              </span>
            </div>
          ))}
          {ledger.evidenceWindow.truncated ? (
            <p className="tertiary balance-note">
              History older than block{" "}
              {ledger.evidenceWindow.oldestRetainedBlockHeight?.toLocaleString("en-US")} is outside
              the evidence window and is marked history incomplete.
            </p>
          ) : null}
          {error ? (
            <p className="tertiary balance-note" role="alert">
              {error}
            </p>
          ) : null}
        </section>
        <section className="card" aria-labelledby="rw-fee-title">
          <div className="card-head">
            <h2 id="rw-fee-title">Your fee ledger</h2>
            {ledger.fees.feeBips ? (
              <span className="badge b-info">
                {feePercent(ledger.fees.feeBips)}
                {currentCycle?.feeEvidence === "locked" ? " locked" : " configured"}
              </span>
            ) : null}
          </div>
          <p className="card-sub">
            Fees are paid to you as each payment is distributed and stay in the manager until you
            withdraw them.
          </p>
          {currentCycle ? (
            <StatLine label={`Earned in cycle ${currentCycle.cycle}`}>
              {amount(currentCycle.operatorFeeSats)}
            </StatLine>
          ) : null}
          <StatLine
            label={
              <>
                Earned all time <InfoTip text="Sum of the operator fee on every indexed payment" />
              </>
            }
          >
            {amount(allTimeFee)}
          </StatLine>
          <StatLine
            label={
              <>
                Withdrawn{" "}
                <InfoTip text="Derived: earned all time minus the balance held in the manager; the manager emits no event when fees are withdrawn" />
              </>
            }
          >
            {amount(ledger.fees.withdrawnDerivedSats)}
          </StatLine>
          <StatLine label="Balance in manager">
            {amount(ledger.fees.balanceInManagerSats)}
            {feeActions ? null : <span className="sub">withdraw from Settings › Manager</span>}
          </StatLine>
          {ledger.fees.refunds.length > 0 ? (
            <StatLine label="Fee refunds swept">{ledger.fees.refunds.length}</StatLine>
          ) : null}
          {feeActions ? <div className="reward-admin-actions">{feeActions}</div> : null}
        </section>
      </div>
    </>
  );
}
