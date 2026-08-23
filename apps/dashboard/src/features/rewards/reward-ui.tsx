import { CaretLeft, CaretRight, CurrencyBtc, Info, Wallet } from "@phosphor-icons/react";
import type { RewardLedgerPayment } from "@stx-labs/signer-sidekick-api-contracts";
import { useEffect, useId, useRef, useState } from "react";
import { CopyIdentifierButton } from "../../copyable-identifier.js";
import { short } from "../../shared/format.js";
import type { RewardExecutionAvailability, Tone } from "./reward-state.js";

/** ⓘ — who / when / txid live here, never on the surface. */
export function InfoTip({ text, label = "Details" }: { text: string | null; label?: string }) {
  if (!text) return null;
  return (
    <button
      className="tooltip-trigger rw-info"
      type="button"
      aria-label={label}
      data-tooltip={text}
    >
      <Info aria-hidden="true" weight="regular" />
    </button>
  );
}

export function GasChip({ execution }: { execution: RewardExecutionAvailability }) {
  if (!execution.chip) return null;
  return (
    <span
      className={`rw-gas${execution.chipTone === "low" ? " low" : ""}`}
      data-tooltip={execution.chipTooltip ?? undefined}
    >
      <Wallet aria-hidden="true" />
      {execution.chip}
    </span>
  );
}

function useDismissablePopover(open: boolean, close: () => void) {
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && wrapperRef.current?.contains(target)) return;
      close();
      triggerRef.current?.blur();
    };
    const dismissWithKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      triggerRef.current?.blur();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissWithKeyboard);
    };
  }, [open, close]);
  return { wrapperRef, triggerRef };
}

/**
 * The ₿ marker beside a staker who is paid out over Bitcoin. Hover or focus shows the currently
 * registered L1 address with a copy button; click toggles it for touch.
 */
export function L1Marker({ address, principal }: { address: string | null; principal: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const { wrapperRef, triggerRef } = useDismissablePopover(open, () => setOpen(false));

  return (
    <span className={`rw-l1-wrap${open ? " is-open" : ""}`} ref={wrapperRef}>
      <button
        type="button"
        className="rw-l1"
        aria-label={
          address
            ? `L1 payout for ${short(principal, 4, 4)}: ${address}`
            : `L1 payout for ${short(principal, 4, 4)} over Bitcoin`
        }
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
      >
        <CurrencyBtc aria-hidden="true" weight="bold" />
      </button>
      <span className="rw-pop rw-l1-pop" role="dialog" aria-label="L1 Payout" id={id}>
        <span className="k">L1 Payout</span>
        {address ? (
          <>
            <span className="a">{address}</span>
            <CopyIdentifierButton value={address} label="address" showLabel />
          </>
        ) : (
          <span className="a muted">registered address not available</span>
        )}
      </span>
    </span>
  );
}

/** Transaction evidence beside a payment status. The Bitcoin sweep replaces the Stacks request
 * as the primary payout transaction once an L1 withdrawal completes. */
export function TxIdMarker({ payment }: { payment: RewardLedgerPayment }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const { wrapperRef, triggerRef } = useDismissablePopover(open, () => setOpen(false));
  const entries =
    payment.route === "bitcoin"
      ? [
          payment.btcSweepTxId ? { label: "Bitcoin payout", txid: payment.btcSweepTxId } : null,
          payment.paymentTxId
            ? { label: "Stacks withdrawal request", txid: payment.paymentTxId }
            : null,
          payment.settleOrReclaimTxId
            ? {
                label: payment.status === "returned" ? "Stacks return" : "Stacks retirement",
                txid: payment.settleOrReclaimTxId,
              }
            : null,
        ].filter((entry): entry is { label: string; txid: string } => entry !== null)
      : payment.paymentTxId
        ? [{ label: "sBTC payout", txid: payment.paymentTxId }]
        : [];
  if (entries.length === 0) return null;
  const primary = entries[0];
  if (!primary) return null;
  return (
    <span className={`rw-tx-wrap${open ? " is-open" : ""}`} ref={wrapperRef}>
      <button
        type="button"
        className="rw-tx-badge"
        aria-label={`${primary.label} transaction ID`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
      >
        txid
      </button>
      <span className="rw-pop rw-tx-pop" role="dialog" aria-label="Transaction IDs" id={id}>
        {entries.map((entry) => (
          <span className="rw-tx-entry" key={`${entry.label}:${entry.txid}`}>
            <span className="k">{entry.label}</span>
            <span className="a">{entry.txid}</span>
            <CopyIdentifierButton value={entry.txid} label="transaction ID" showLabel />
          </span>
        ))}
      </span>
    </span>
  );
}

export function StakerCell({
  principal,
  bitcoin = false,
  l1Address = null,
}: {
  principal: string;
  bitcoin?: boolean;
  l1Address?: string | null;
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
      {bitcoin ? <L1Marker address={l1Address} principal={principal} /> : null}
    </span>
  );
}

/** A status chip whose hover/focus reveals a short explanation (why a payment rolled forward). */
export function StatusChip({
  tone,
  label,
  tooltip,
  popover,
}: {
  tone: Tone;
  label: string;
  tooltip?: string | null;
  popover?: { title: string; detail: string | null; footer: string | null } | null;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!popover) {
    return (
      <span className={`badge b-${tone}`} title={tooltip ?? undefined}>
        {label}
      </span>
    );
  }
  return (
    <span className={`rw-rf${open ? " is-open" : ""}`}>
      <button
        type="button"
        className={`badge b-${tone} rw-chip-button`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      <span className="rw-pop rw-rf-pop" role="tooltip" id={id}>
        <strong>{popover.title}</strong>
        {popover.detail ? <span>{popover.detail}</span> : null}
        {popover.footer ? <span className="muted">{popover.footer}</span> : null}
      </span>
    </span>
  );
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

function pageNumbers(pages: number, current: number): Array<number | null> {
  if (pages <= 7) return Array.from({ length: pages }, (_, index) => index);
  const set = new Set<number>([0, pages - 1, current - 1, current, current + 1]);
  const sorted = [...set].filter((page) => page >= 0 && page < pages).sort((a, b) => a - b);
  const withGaps: Array<number | null> = [];
  for (const [index, page] of sorted.entries()) {
    const previous = sorted[index - 1];
    if (previous !== undefined && page - previous > 1) withGaps.push(null);
    withGaps.push(page);
  }
  return withGaps;
}

/** "1–10 of 40 payments · ‹ 1 2 3 4 ›" — the table footer; renders nothing under one page. */
export function Pager({
  page,
  pageSize,
  total,
  onPage,
  noun = "payments",
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  noun?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(0, page), pages - 1);
  if (total <= pageSize) return null;
  const first = current * pageSize + 1;
  const last = Math.min(total, (current + 1) * pageSize);
  return (
    <div className="rw-pager">
      <span className="rw-pager-range">
        {first}–{last} of {total} {noun}
      </span>
      <nav className="rw-pager-nav" aria-label="Pages">
        <button
          className="btn-icon"
          type="button"
          aria-label="Previous page"
          disabled={current === 0}
          onClick={() => onPage(current - 1)}
        >
          <CaretLeft aria-hidden="true" />
        </button>
        {pageNumbers(pages, current).map((entry, index) =>
          entry === null ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: gaps have no identity of their own
            <span className="pg-gap" key={`gap-${index}`}>
              …
            </span>
          ) : (
            <button
              className={`pg${entry === current ? " on" : ""}`}
              type="button"
              key={entry}
              aria-current={entry === current ? "page" : undefined}
              onClick={() => onPage(entry)}
            >
              {entry + 1}
            </button>
          ),
        )}
        <button
          className="btn-icon"
          type="button"
          aria-label="Next page"
          disabled={current >= pages - 1}
          onClick={() => onPage(current + 1)}
        >
          <CaretRight aria-hidden="true" />
        </button>
      </nav>
    </div>
  );
}
