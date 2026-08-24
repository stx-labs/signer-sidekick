import { Info, Warning, X } from "@phosphor-icons/react";
import type { GasWalletStatus } from "@stx-labs/signer-sidekick-api-contracts";
import { short, stxAmount } from "../../shared/format.js";

export function GasWalletBanners({
  gasWallet,
  engineMode,
  neededTransactions,
  onCreate,
  onDismiss,
  onFundInstructions,
}: {
  gasWallet: GasWalletStatus | null | undefined;
  engineMode: "observe" | "operator-run" | null;
  neededTransactions: number;
  onCreate: () => void;
  onDismiss: (kind: "setup" | "low-balance") => void;
  onFundInstructions: () => void;
}) {
  if (!gasWallet || engineMode !== "operator-run") return null;
  if (!gasWallet.configured) {
    if (gasWallet.banners.setupDismissedAt) return null;
    return (
      <div className="callout callout-info rw-banner" role="status">
        <Info className="ic" aria-hidden="true" />
        <div className="body">
          <strong>No gas wallet yet.</strong> Create one and Sidekick can run calculations,
          collects, and distributions from here with a click — or keep signing each call with your
          own wallet.
          <div className="actions">
            <button className="btn btn-primary" type="button" onClick={onCreate}>
              Create gas wallet
            </button>
            <button className="btn btn-tertiary" type="button" onClick={() => onDismiss("setup")}>
              Not now
            </button>
          </div>
        </div>
        <button
          className="btn-icon rw-dismiss"
          type="button"
          aria-label="Dismiss"
          onClick={() => onDismiss("setup")}
        >
          <X aria-hidden="true" />
        </button>
      </div>
    );
  }
  const low =
    gasWallet.enabled &&
    gasWallet.estimatedTransactions !== null &&
    neededTransactions > 0 &&
    gasWallet.estimatedTransactions < neededTransactions;
  const dismissedUntil = gasWallet.banners.lowBalanceDismissedUntil;
  if (!low || (dismissedUntil && Date.parse(dismissedUntil) > Date.now())) return null;
  const needed = Math.max(0, neededTransactions - (gasWallet.estimatedTransactions ?? 0));
  const fund = stxAmount((BigInt(gasWallet.feeBasisUstx) * BigInt(needed)).toString());
  return (
    <div className="callout callout-caution rw-banner" role="status">
      <Warning className="ic" aria-hidden="true" />
      <div className="body">
        <strong>Gas wallet is low.</strong> {stxAmount(gasWallet.balanceUstx)} left — about{" "}
        {(gasWallet.estimatedTransactions ?? 0).toLocaleString("en-US")} transactions. The next run
        needs {neededTransactions.toLocaleString("en-US")}. Fund about {fund} to{" "}
        <span className="identifier" title={gasWallet.principal ?? undefined}>
          {short(gasWallet.principal, 6, 5)}
        </span>
        .
        <div className="actions">
          <button className="btn btn-secondary" type="button" onClick={onFundInstructions}>
            Fund instructions
          </button>
          <button
            className="btn btn-tertiary"
            type="button"
            onClick={() => onDismiss("low-balance")}
          >
            Dismiss until the next run
          </button>
        </div>
      </div>
      <button
        className="btn-icon rw-dismiss"
        type="button"
        aria-label="Dismiss"
        onClick={() => onDismiss("low-balance")}
      >
        <X aria-hidden="true" />
      </button>
    </div>
  );
}
