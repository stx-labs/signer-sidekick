import { DownloadSimple } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { useDismissablePopover } from "./reward-ui.js";

export function DistributionExportControls({
  cycle,
  distribution,
  busy,
  onExport,
}: {
  cycle: number;
  distribution: 1 | 2;
  busy: boolean;
  onExport: (query: { cycle: number; distribution?: 1 | 2 }) => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const { wrapperRef, triggerRef } = useDismissablePopover(open, () => setOpen(false));
  const choose = (query: { cycle: number; distribution?: 1 | 2 }) => {
    setOpen(false);
    onExport(query);
  };
  return (
    <>
      <div className="rw-export-inline rw-export-wide">
        <span className="muted">Export</span>
        <button
          className="btn btn-tertiary sm"
          type="button"
          disabled={busy}
          onClick={() => onExport({ cycle, distribution })}
        >
          <DownloadSimple className="rw-ico" aria-hidden="true" />
          This distribution
        </button>
        <button
          className="btn btn-tertiary sm"
          type="button"
          disabled={busy}
          onClick={() => onExport({ cycle })}
        >
          <DownloadSimple className="rw-ico" aria-hidden="true" />
          Cycle {cycle}
        </button>
      </div>
      <span className={`rw-export-menu rw-show-sm${open ? " is-open" : ""}`} ref={wrapperRef}>
        <button
          className="btn btn-tertiary sm"
          type="button"
          aria-label="Export payments"
          aria-expanded={open}
          aria-haspopup="menu"
          aria-controls={id}
          disabled={busy}
          onClick={() => setOpen((value) => !value)}
          ref={triggerRef}
        >
          <DownloadSimple className="rw-ico" aria-hidden="true" />
        </button>
        <span className="rw-pop rw-export-pop" role="menu" id={id}>
          <button type="button" role="menuitem" onClick={() => choose({ cycle, distribution })}>
            This distribution
          </button>
          <button type="button" role="menuitem" onClick={() => choose({ cycle })}>
            Cycle {cycle}
          </button>
        </span>
      </span>
    </>
  );
}
