import { CaretDown, CaretUp, CaretUpDown, Warning } from "@phosphor-icons/react";

export type SortDirection = "asc" | "desc";

export interface TableSort<Key extends string> {
  key: Key;
  direction: SortDirection;
}

export function SortableHeader<Key extends string>({
  label,
  column,
  sort,
  setSort,
  align = "left",
}: {
  label: string;
  column: Key;
  sort: TableSort<Key>;
  setSort: (sort: TableSort<Key>) => void;
  align?: "left" | "right";
}) {
  const active = sort.key === column;
  const nextDirection: SortDirection = active && sort.direction === "asc" ? "desc" : "asc";
  const Icon = active ? (sort.direction === "asc" ? CaretUp : CaretDown) : CaretUpDown;
  return (
    <th
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
      className={align === "right" ? "right" : undefined}
      scope="col"
    >
      <button
        aria-label={`Sort by ${label}, ${nextDirection === "asc" ? "ascending" : "descending"}`}
        className="table-sort"
        type="button"
        onClick={() => setSort({ key: column, direction: nextDirection })}
      >
        {label} <Icon aria-hidden="true" weight={active ? "bold" : "regular"} />
      </button>
    </th>
  );
}

export function Badge({
  state,
  children,
}: {
  state: "success" | "caution" | "error" | "info" | "neutral" | "accent";
  children: React.ReactNode;
}) {
  return <span className={`badge b-${state}`}>{children}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const state = [
    "complete",
    "ready",
    "pass",
    "connected",
    "grant valid",
    "eligible",
    "activation scheduled",
    "signer active",
    "setup complete",
  ].includes(normalized)
    ? "b-success"
    : ["blocked", "fail", "unavailable", "grant not verified", "needs attention"].includes(
          normalized,
        )
      ? "b-error"
      : "b-caution";
  return <span className={`badge ${state}`}>{status.replaceAll("-", " ")}</span>;
}

export function StatLine({
  label,
  children,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="statline">
      <span className="k">{label}</span>
      <span className="v">{children}</span>
    </div>
  );
}

export function PageHead({
  title,
  lede,
  actions,
}: {
  title: string;
  lede: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        <p className="lede">{lede}</p>
      </div>
      {actions ? <div className="actions">{actions}</div> : null}
    </div>
  );
}

export function ErrorCallout({ error }: { error: string | null }) {
  return error ? (
    <div className="callout callout-critical error-banner">
      <Warning className="ic" />
      <div className="body">{error}</div>
    </div>
  ) : null;
}

export function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the concrete control is supplied as a child.
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {help ? <span className="help">{help}</span> : null}
    </label>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  setPage,
  disabled = false,
}: {
  page: number;
  pageSize: number;
  total: number;
  setPage: (page: number) => void;
  disabled?: boolean;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const boundedPage = Math.min(page, pages - 1);
  const first = total === 0 ? 0 : boundedPage * pageSize + 1;
  const last = Math.min(total, (boundedPage + 1) * pageSize);
  return (
    <nav className="pagination" aria-label="Table pagination">
      <span className="mono">
        {first}–{last} of {total}
      </span>
      <div className="actions">
        <button
          type="button"
          className="btn btn-tertiary sm"
          disabled={disabled || boundedPage === 0}
          onClick={() => setPage(boundedPage - 1)}
        >
          Previous
        </button>
        <span className="mono">
          Page {boundedPage + 1} of {pages}
        </span>
        <button
          type="button"
          className="btn btn-tertiary sm"
          disabled={disabled || boundedPage >= pages - 1}
          onClick={() => setPage(boundedPage + 1)}
        >
          Next
        </button>
      </div>
    </nav>
  );
}
