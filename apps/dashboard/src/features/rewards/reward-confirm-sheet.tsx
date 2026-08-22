import { ArrowRight } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { amount, stxAmount } from "../../shared/format.js";
import type { RewardExecutionAvailability, RewardPrimaryAction } from "./reward-state.js";
import type { RewardRun, RewardRunKind } from "./run-api.js";

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
  | { status: "ready"; run: RewardRun }
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
  onUseWallet,
}: {
  action: RewardPrimaryAction;
  eyebrow: string;
  execution: RewardExecutionAvailability;
  state: ConfirmState;
  onCancel: () => void;
  onGo: (run: RewardRun) => void;
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
  const steps = run?.steps ?? [];
  const transactions = run?.transactions ?? action.transactions;
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
            Preparing the run from the current chain facts…
          </p>
        ) : null}
        {steps.length > 0 ? (
          <div className="checklist rw-run-steps rw-sheet-steps">
            {steps.map((step, index) => (
              <div className="check-item" key={`${step.kind}-${step.label}`}>
                <span className={`box ${step.state === "done" ? "ok" : "wait"}`}>{index + 1}</span>
                <div className="body">
                  {step.label}
                  {step.detail ? <div className="m">{step.detail}</div> : null}
                </div>
                {step.amountSats ? (
                  <span className="v">{amount(step.amountSats, step.asset ?? "sBTC")}</span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {state.status === "unavailable" ? (
          <div className="callout callout-neutral" role="status" style={{ marginTop: 12 }}>
            <div className="body">
              <strong>Runs are not available in this Sidekick build yet.</strong> {state.reason}
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
            {run?.estimatedGasUstx ? (
              <>
                {" "}
                · about <span className="mono">{stxAmount(run.estimatedGasUstx)}</span> gas from the
                gas wallet
              </>
            ) : null}
            {execution.chip ? <> ({execution.chip.replace("Gas wallet ", "")} available)</> : null}
          </span>
          <span>
            Another caller may finish some of this first — Sidekick skips what is already done.
          </span>
          <span>You can close this page. Progress shows on Rewards and Overview.</span>
          {run?.approvalExpiresAt ? (
            <span>
              This approval is good until{" "}
              <span className="mono">
                {new Date(run.approvalExpiresAt).toUTCString().replace(" GMT", " UTC")}
              </span>
            </span>
          ) : null}
        </div>
        <div className="rw-sheet-actions">
          <button className="btn btn-tertiary" type="button" onClick={onCancel} ref={cancelRef}>
            Cancel
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
