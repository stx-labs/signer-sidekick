import { Info } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { StatusBadge } from "../../shared/dashboard-ui.js";

export function SettingsInfo({ label = "Details", text }: { label?: string; text: string }) {
  return (
    <button
      className="tooltip-trigger rw-info"
      type="button"
      aria-label={label}
      data-tooltip={text}
    >
      <Info aria-hidden="true" />
    </button>
  );
}

export function SettingsSectionTitle({
  actions,
  children,
  hint,
  id,
}: {
  actions?: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  id: string;
}) {
  return (
    <div className={`section-title st-title ${actions ? "st-title-actions" : ""}`} id={id}>
      <h2>
        {children}{" "}
        {hint ? (
          <span className="hint" aria-hidden="true">
            {hint}
          </span>
        ) : null}
      </h2>
      {actions}
    </div>
  );
}

export function SettingsRow({
  actions,
  children,
  className = "",
  detail,
  help,
  importance,
  name,
  status,
  statusNode,
  value,
}: {
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  detail?: ReactNode;
  help?: string;
  importance?: "required" | "recommended";
  name: ReactNode;
  status?: string;
  statusNode?: ReactNode;
  value?: ReactNode;
}) {
  return (
    <>
      <div className={`st-row ${className}`.trim()}>
        <div className="n">
          {name}
          {help ? <SettingsInfo text={help} /> : null}
          {importance ? <span className="st-imp">{importance}</span> : null}
        </div>
        <div className="v">
          {value}
          {detail ? <span className="st-cred">{detail}</span> : null}
        </div>
        <div className="s">{statusNode ?? (status ? <StatusBadge status={status} /> : null)}</div>
        <div className="a">{actions}</div>
      </div>
      {children}
    </>
  );
}
