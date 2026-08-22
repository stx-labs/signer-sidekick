import { ArrowRight } from "@phosphor-icons/react";
import type { RewardRun } from "@stx-labs/signer-sidekick-api-contracts";
import { useEffect, useRef } from "react";
import { amount, shortUtc, stxAmount } from "../../shared/format.js";
import type { RewardExecutionAvailability, RewardPrimaryAction } from "./reward-state.js";
import { type RewardRunKind, summarizeRunSteps } from "./run-api.js";

export function runTitle(kind: RewardRunKind): string {
  switch (kind) {
    case "collect-and-distribute":
      return "Collect & distribute";
    case "distribute":
      return "Distribute";
    case "collect":
      return "Collect";
    case "calculate":
      return "Run calculation";
    case "finish-bitcoin-payouts":
      return "Finish Bitcoin payouts";
  }
}

export function runLede(kind: RewardRunKind): string {
  switch (kind) {
    case "collect-and-distribute":
      return "Two steps, run in order. The manager sends each staker payout; your fee stays credited in the manager; the gas wallet pays only the network fees.";
    case "distribute":
      return "One transaction per payment, one at a time. The manager sends each staker payout; your fee stays credited in the manager; the gas wallet pays only the network fees.";
    case "collect":
      return "One transaction. PoX-5 moves this distribution's rewards into the manager; the fee locks at the first collect of the cycle.";
    case "calculate":
      return "One permissionless transaction. PoX-5 calculates this distribution for every pool; nothing moves to or from your manager.";
    case "finish-bitcoin-payouts":
      return "Retire settled payouts (nothing moves) and return rejected payouts to their stakers as sBTC, with exact post-conditions.";
  }
}

export type ConfirmState =
  | { status: "drafting" }
  | { status: "ready"; run: RewardRun; reused: boolean }
  | { status: "approving"; run: RewardRun }
  | { status: "unavailable"; reason: string }
  | { status: "error"; message: string };

export function RewardConfirmSheet({
  action,
  eyebrow,
  execution,
  state,
  onCancel,
  onGo,
  onDiscard,
  onUseWallet,
}: {
  action: RewardPrimaryAction;
  eyebrow: string;
  execution: RewardExecutionAvailability;
  state: ConfirmState;
  onCancel: () => void;
  onGo: (run: RewardRun) => void;
  /** Cancels a reused draft so the wallet lease is released. */
  onDiscard?: ((run: RewardRun) => void) | undefined;
  onUseWallet?: (() => void) | null;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);
  const run = state.status === "ready" || state.status === "approving" ? state.run : null;
  const steps = run ? summarizeRunSteps(run) : [];
  const transactions = run?.recipe.children.length ?? action.transactions;
  const truncated = run ? run.recipe.children.length >= run.recipe.maxTransactions : false;
  return (
    <div className="rw-backdrop" role="presentation">
      <div className="rw-sheet" role="dialog" aria-modal="true" aria-labelledby="rw-sheet-title">
        <div className="rw-eyebrow">{eyebrow}</div>
        <h2 id="rw-sheet-title">{runTitle(action.kind)}</h2>
        <p className="muted" style={{ margin: "0 0 14px", fontSize: 13 }}>
          {runLede(action.kind)}
        </p>
        {state.status === "drafting" ? (
          <p className="tertiary" role="status">
            Sealing the run from the current chain facts…
          </p>
        ) : null}
        {steps.length > 0 ? (
          <div className="checklist rw-run-steps rw-sheet-steps">
            {steps.map((step, index) => (
              <div className="check-item" key={step.operation}>
                <span
                  className={`box ${step.done === step.count && step.count > 0 ? "ok" : "wait"}`}
                >
                  {index + 1}
                </span>
                <div className="body">
                  {step.label}
                  <div className="m">
                    {step.count === 1
                      ? "1 transaction"
                      : `${step.count.toLocaleString("en-US")} transactions, one at a time`}
                    {step.operation === "claim-staker-rewards" && run
                      ? ` · ${run.recipe.reviewedPaymentCount.toLocaleString("en-US")} payments reviewed · up to ${amount(run.recipe.reviewedTotalSats)} gross`
                      : ""}
                  </div>
                </div>
                {step.amountSats ? <span className="v">{amount(step.amountSats)}</span> : null}
              </div>
            ))}
          </div>
        ) : null}
        {state.status === "ready" && state.reused ? (
          <div className="callout callout-neutral" role="status" style={{ marginTop: 12 }}>
            <div className="body">
              <strong>A sealed run is already waiting for your approval.</strong> It was prepared{" "}
              {shortUtc(state.run.createdAt)} and holds the gas wallet until{" "}
              {shortUtc(state.run.approvalExpiresAt)}.
              {onDiscard ? (
                <div className="actions">
                  <button
                    className="btn btn-tertiary sm"
                    type="button"
                    onClick={() => onDiscard(state.run)}
                  >
                    Discard it and prepare a fresh run
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        {truncated && run ? (
          <div className="callout callout-caution" role="status" style={{ marginTop: 12 }}>
            <div className="body">
              This run covers the first {run.recipe.maxTransactions.toLocaleString("en-US")}{" "}
              transactions. Run it again afterwards for the rest; Sidekick skips what is already
              done.
            </div>
          </div>
        ) : null}
        {state.status === "unavailable" ? (
          <div className="callout callout-neutral" role="status" style={{ marginTop: 12 }}>
            <div className="body">
              <strong>Runs are not available in this Sidekick build.</strong> {state.reason}
              {onUseWallet ? (
                <div className="actions">
                  <button className="btn btn-secondary sm" type="button" onClick={onUseWallet}>
                    Use your wallet instead
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        {state.status === "error" ? (
          <div className="callout callout-critical" role="alert" style={{ marginTop: 12 }}>
            <div className="body">{state.message}</div>
          </div>
        ) : null}
        <div className="rw-facts">
          <span>
            <span className="mono">{transactions.toLocaleString("en-US")} transactions</span>
            {run ? (
              <>
                {" "}
                · up to <span className="mono">{stxAmount(run.recipe.gasBudgetUstx)}</span> gas from
                the gas wallet
              </>
            ) : null}
            {execution.chip ? <> ({execution.chip.replace("Gas wallet ", "")} available)</> : null}
          </span>
          <span>
            Another caller may finish some of this first — Sidekick skips what is already done.
          </span>
          <span>You can close this page. Progress shows on Rewards and Overview.</span>
          {run ? (
            <span>
              Approve by <span className="mono">{shortUtc(run.approvalExpiresAt)}</span>; once
              started the run stops itself after 6 hours.
            </span>
          ) : null}
        </div>
        <div className="rw-sheet-actions">
          <button className="btn btn-tertiary" type="button" onClick={onCancel} ref={cancelRef}>
            Close
          </button>
          <button
            className="btn btn-primary"
            type="button"
            disabled={state.status !== "ready" || !execution.available}
            onClick={() => {
              if (state.status === "ready") onGo(state.run);
            }}
          >
            {state.status === "approving" ? "Starting…" : "Go"}
            <ArrowRight className="rw-ico" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
