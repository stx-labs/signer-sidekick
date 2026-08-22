import { CaretRight, CurrencyBtc, Info, Wallet } from "@phosphor-icons/react";
import type { RewardLedgerPayment } from "@stx-labs/signer-sidekick-api-contracts";
import { short } from "../../shared/format.js";
import type { RewardExecutionAvailability } from "./reward-state.js";

/** ⓘ — who / when / txid live here, never on the surface. */
export function InfoTip({ text, label = "Details" }: { text: string | null; label?: string }) {
  if (!text) return null;
  return (
    <button className="tooltip-trigger rw-info" type="button" aria-label={label} title={text}>
      <Info aria-hidden="true" weight="regular" />
    </button>
  );
}

export function GasChip({ execution }: { execution: RewardExecutionAvailability }) {
  if (!execution.chip) return null;
  return (
    <span
      className={`rw-gas${execution.chipTone === "low" ? " low" : ""}`}
      title={execution.chipTooltip ?? undefined}
    >
      <Wallet aria-hidden="true" />
      {execution.chip}
    </span>
  );
}

export function StakerCell({
  principal,
  bitcoin = false,
}: {
  principal: string;
  bitcoin?: boolean;
}) {
  const initials = principal.slice(2, 4).toUpperCase();
  return (
    <span className="staker">
      <span className="avatar" aria-hidden="true">
        {initials}
      </span>
      <span className="identifier" title={principal}>
        {short(principal, 4, 4)}
      </span>
      {bitcoin ? (
        <span className="rw-route btc rw-show-sm" title="Paid out over Bitcoin">
          <CurrencyBtc aria-hidden="true" />
        </span>
      ) : null}
    </span>
  );
}

export function RouteCell({ payment }: { payment: RewardLedgerPayment }) {
  if (payment.route === "bitcoin") {
    return (
      <span className="rw-route btc" title="Paid out over Bitcoin after the Bitcoin fee budget">
        <CurrencyBtc aria-hidden="true" />
        Bitcoin
      </span>
    );
  }
  return <span className="rw-route">sBTC</span>;
}

export function ChevronButton({
  expanded,
  onClick,
  label,
}: {
  expanded: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      className="btn-icon"
      type="button"
      aria-label={label}
      aria-expanded={expanded}
      onClick={onClick}
    >
      <CaretRight
        aria-hidden="true"
        style={{ transform: expanded ? "rotate(90deg)" : undefined }}
      />
    </button>
  );
}
