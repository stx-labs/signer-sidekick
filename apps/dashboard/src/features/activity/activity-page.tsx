import { ArrowClockwise, ArrowLeft, MagnifyingGlass, WarningCircle } from "@phosphor-icons/react";
import {
  type ActivityCoverage,
  type ActivityDetail,
  type ActivityGroupSummary,
  type ActivityResponse,
  activityDetailSchema,
  activityResponseSchema,
  browserWalletIntentResponseSchema,
  type DashboardSnapshot,
  operatorOperationCodeSchema,
  recurringWalletIntentActionSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiJson } from "../../api-client.js";
import { CopyableIdentifier } from "../../copyable-identifier.js";
import {
  actionHash,
  activityHash,
  type DomainSection,
  dashboardHash,
} from "../../dashboard-route.js";
import { Badge, PageHead, StatLine } from "../../shared/dashboard-ui.js";
import { useDomainSection } from "../../shared/domain-section.js";
import { short } from "../../shared/format.js";
import { operatorErrorDetail } from "../../shared/operator-error.js";
import { BrowserWalletActionPanel } from "../operations/browser-wallet-action.js";
import {
  type ActivityFilters,
  activityDeadlineLabel,
  activityDomainFilters,
  activityDomainLabel,
  activityFilterSearch,
  activityKindLabel,
  activityStageLabel,
  activityStatusBadge,
  activityStatusFilters,
  activityStatusLabel,
  activityTimeFilters,
  activityTimelineState,
  activityTimestamp,
  activityTypeFilters,
  groupActivityHistory,
  parseActivityFilters,
} from "./activity-presentation.js";

const activityRefreshMs = 15_000;
const activityPageSize = 50;

function activityRequestSearch(filters: ActivityFilters, cursor: string | null): string {
  const params = new URLSearchParams(activityFilterSearch(filters));
  params.set("limit", activityPageSize.toString());
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

function Coverage({ coverage }: { coverage: readonly ActivityCoverage[] }) {
  const degraded = coverage.filter(({ status }) => status !== "current");
  if (degraded.length === 0) return null;
  return (
    <div className="callout callout-caution activity-coverage" role="status">
      <WarningCircle className="ic" />
      <div className="body">
        <strong>Some Activity evidence is incomplete</strong>
        <ul>
          {degraded.map((source) => (
            <li key={source.source}>
              <span className="mono">{source.source.replaceAll("-", " ")}</span>: {source.status}
              {source.reason ? ` — ${source.reason}` : ""}
              {source.anchor
                ? ` Last verified at Stacks ${source.anchor.stacksBlockHeight.toLocaleString("en-US")} / Bitcoin ${source.anchor.burnBlockHeight.toLocaleString("en-US")}.`
                : ""}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ActivityIdentifiers({ item }: { item: ActivityGroupSummary }) {
  const txid = item.txids[0] ?? null;
  if (!item.actorPrincipal && !txid) return null;
  return (
    <div className="activity-identifiers">
      {item.actorPrincipal ? (
        <CopyableIdentifier
          value={item.actorPrincipal}
          display={short(item.actorPrincipal)}
          label="actor principal"
        />
      ) : null}
      {txid ? (
        <CopyableIdentifier value={txid} display={short(txid, 10, 8)} label="transaction ID" />
      ) : null}
      {item.txids.length > 1 ? <span>+{item.txids.length - 1} transactions</span> : null}
    </div>
  );
}

function ActivityRow({ item, search }: { item: ActivityGroupSummary; search: string }) {
  const detail = activityHash(item.activityId, search);
  const deadline = activityDeadlineLabel(item.deadline);
  const actionLabel =
    item.primaryAction?.kind === "resume-activity" ? item.primaryAction.label : "View details";
  return (
    <article className={`activity-row activity-${item.displayStatus}`}>
      <div className="activity-row-main">
        <div className="activity-row-heading">
          <h3>
            <a href={detail}>{item.title}</a>
          </h3>
          <Badge state={activityStatusBadge(item.displayStatus)}>
            {activityStatusLabel(item.displayStatus)}
          </Badge>
        </div>
        <p>{item.summary}</p>
        <div className="activity-row-meta">
          <span>{activityDomainLabel(item.domain)}</span>
          <span>{activityKindLabel(item.kind)}</span>
          <span>{activityStageLabel(item.stage)}</span>
          {deadline ? <span>Due {deadline}</span> : null}
          <time dateTime={item.occurredAt}>{activityTimestamp(item.occurredAt)}</time>
        </div>
        <ActivityIdentifiers item={item} />
      </div>
      <a className="btn btn-tertiary sm activity-row-action" href={detail}>
        {actionLabel}
      </a>
    </article>
  );
}

function ActivityFiltersForm({
  filters,
  searchDraft,
  setSearchDraft,
  navigate,
}: {
  filters: ActivityFilters;
  searchDraft: string;
  setSearchDraft: (value: string) => void;
  navigate: (filters: ActivityFilters) => void;
}) {
  return (
    <form
      className="activity-filters"
      aria-label="Activity filters"
      onSubmit={(event) => {
        event.preventDefault();
        navigate({ ...filters, search: searchDraft });
      }}
    >
      <label>
        <span>Status</span>
        <select
          className="select"
          value={filters.status}
          onChange={(event) =>
            navigate({
              ...filters,
              status: event.target.value as ActivityFilters["status"],
            })
          }
        >
          {activityStatusFilters.map((value) => (
            <option key={value} value={value}>
              {value === "all" ? "All" : value.replaceAll("-", " ")}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Type</span>
        <select
          className="select"
          value={filters.type}
          onChange={(event) =>
            navigate({ ...filters, type: event.target.value as ActivityFilters["type"] })
          }
        >
          {activityTypeFilters.map((value) => (
            <option key={value} value={value}>
              {value === "all" ? "All" : value.replaceAll("-", " ")}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Domain</span>
        <select
          className="select"
          value={filters.domain}
          onChange={(event) =>
            navigate({ ...filters, domain: event.target.value as ActivityFilters["domain"] })
          }
        >
          {activityDomainFilters.map((value) => (
            <option key={value} value={value}>
              {value === "all" ? "All" : activityDomainLabel(value)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Time</span>
        <select
          className="select"
          value={filters.time}
          onChange={(event) =>
            navigate({ ...filters, time: event.target.value as ActivityFilters["time"] })
          }
        >
          {activityTimeFilters.map((value) => (
            <option key={value} value={value}>
              {value === "24h"
                ? "24 hours"
                : value === "7d"
                  ? "7 days"
                  : value === "30d"
                    ? "30 days"
                    : "All"}
            </option>
          ))}
        </select>
      </label>
      <label className="activity-search">
        <span>Search IDs or principals</span>
        <span className="activity-search-control">
          <MagnifyingGlass aria-hidden="true" />
          <input
            className="input"
            maxLength={500}
            placeholder="Transaction, principal, or Activity ID"
            type="search"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
          />
        </span>
      </label>
      <button className="btn btn-secondary sm" type="submit">
        Search
      </button>
    </form>
  );
}

function ActivityFeed({
  token,
  search,
  section,
}: {
  token: string;
  search: string;
  section: DomainSection | null;
}) {
  useDomainSection("activity", section);
  const filters = useMemo(() => parseActivityFilters(search), [search]);
  const filterSearch = activityFilterSearch(filters);
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const cursor = cursorStack.at(-1) ?? null;
  const [data, setData] = useState<ActivityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const paginationFilter = useRef(filterSearch);

  useEffect(() => {
    if (paginationFilter.current === filterSearch) return;
    paginationFilter.current = filterSearch;
    setSearchDraft(filters.search);
    setCursorStack([null]);
  }, [filterSearch, filters.search]);

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      if (refresh > 0) setError(null);
      setLoading(true);
      try {
        const result = await apiJson(
          token,
          `/api/v1/activity?${activityRequestSearch(filters, cursor)}`,
          activityResponseSchema,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          setData(result);
          setError(null);
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(operatorErrorDetail(cause, "Sidekick returned no Activity error detail"));
        }
      } finally {
        pending = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, activityRefreshMs);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [token, filters, cursor, refresh]);

  const historyGroups = groupActivityHistory(data?.items ?? []);
  const navigate = (next: ActivityFilters) => {
    location.hash = activityHash(null, activityFilterSearch(next));
  };
  return (
    <>
      <PageHead
        title="Activity"
        lede="Durable operator work and verified on-chain evidence for this signer manager."
        actions={
          <button
            className="btn btn-tertiary sm"
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}
            type="button"
          >
            <ArrowClockwise className={loading ? "spin" : ""} />
            {loading ? "Refreshing" : "Refresh Activity"}
          </button>
        }
      />
      <ActivityFiltersForm
        filters={filters}
        searchDraft={searchDraft}
        setSearchDraft={setSearchDraft}
        navigate={navigate}
      />
      {error ? (
        <div className="callout callout-critical content-notice" role="alert">
          <WarningCircle className="ic" />
          <div className="body">
            <strong>Could not refresh Activity</strong>
            <div>{error}</div>
            <div className="actions">
              <button
                className="btn btn-secondary sm"
                onClick={() => setRefresh((value) => value + 1)}
                type="button"
              >
                Retry Activity
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {data ? <Coverage coverage={data.coverage} /> : null}
      <div className="domain-section-anchor" id="activity-active">
        {data?.active.length ? (
          <section aria-labelledby="activity-active-heading">
            <div className="section-title" id="activity-active-heading">
              Active work <span className="hint">{data.active.length} open</span>
            </div>
            <div className="activity-list activity-active-list">
              {data.active.map((item) => (
                <ActivityRow item={item} key={item.activityId} search={filterSearch} />
              ))}
            </div>
          </section>
        ) : null}
      </div>
      <section
        aria-labelledby="activity-history-heading"
        className="domain-section-anchor"
        id="activity-history"
      >
        <div className="section-title" id="activity-history-heading">
          History
        </div>
        {data && historyGroups.length === 0 ? (
          <div className="card activity-empty">
            No operator or verified chain activity matches these filters.
          </div>
        ) : null}
        {historyGroups.map((group) => (
          <div className="activity-history-group" key={group.label}>
            <h2>{group.label}</h2>
            <div className="activity-list">
              {group.items.map((item) => (
                <ActivityRow item={item} key={item.activityId} search={filterSearch} />
              ))}
            </div>
          </div>
        ))}
      </section>
      {!data && loading ? (
        <div className="loading-state activity-loading" role="status">
          <ArrowClockwise className="spin" />
          <p>Loading Activity</p>
        </div>
      ) : null}
      {data ? (
        <nav aria-label="Activity history pages" className="activity-pagination">
          <button
            className="btn btn-tertiary sm"
            disabled={loading || cursorStack.length === 1}
            onClick={() => setCursorStack((values) => values.slice(0, -1))}
            type="button"
          >
            Previous
          </button>
          <span className="mono">Page {cursorStack.length}</span>
          <button
            className="btn btn-tertiary sm"
            disabled={loading || data.nextCursor === null}
            onClick={() => {
              if (data.nextCursor) setCursorStack((values) => [...values, data.nextCursor]);
            }}
            type="button"
          >
            Next
          </button>
        </nav>
      ) : null}
    </>
  );
}

function ActivityDetailPage({
  data: operatorData,
  token,
  activityId,
  operatorStateStale,
  onOperatorStateChanged,
  search,
}: {
  data: DashboardSnapshot | null;
  token: string;
  activityId: string;
  operatorStateStale: boolean;
  onOperatorStateChanged?: (() => void | Promise<void>) | undefined;
  search: string;
}) {
  const [data, setData] = useState<ActivityDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshingEvidence, setRefreshingEvidence] = useState(false);
  const [evidenceRefreshNotice, setEvidenceRefreshNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      if (refresh > 0) setError(null);
      setLoading(true);
      try {
        const result = await apiJson(
          token,
          `/api/v1/activity/${encodeURIComponent(activityId)}`,
          activityDetailSchema,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setData(result);
        setError(null);
        if (result.canonicalActivityId !== activityId) {
          history.replaceState(null, "", activityHash(result.canonicalActivityId, search));
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(operatorErrorDetail(cause, "Sidekick returned no Activity error detail"));
        }
      } finally {
        pending = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, activityRefreshMs);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [token, activityId, search, refresh]);

  if (!data && loading) {
    return (
      <div className="loading-state activity-loading" role="status">
        <ArrowClockwise className="spin" />
        <p>Loading Activity details</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="callout callout-critical" role="alert">
        <WarningCircle className="ic" />
        <div className="body">
          <strong>Could not load Activity details</strong>
          <div>{error}</div>
          <div className="actions">
            <button
              className="btn btn-secondary sm"
              onClick={() => setRefresh((value) => value + 1)}
              type="button"
            >
              Retry details
            </button>
            <a className="btn btn-tertiary sm" href={activityHash(null, search)}>
              Return to Activity
            </a>
          </div>
        </div>
      </div>
    );
  }

  const item = data.summary;
  const walletIntentId = item.activityId.startsWith("wallet-intent:")
    ? item.activityId.slice("wallet-intent:".length)
    : null;
  const walletAction = recurringWalletIntentActionSchema.safeParse(item.code);
  const engineJobId = item.activityId.startsWith("engine-job:")
    ? item.activityId.slice("engine-job:".length)
    : null;
  const engineOperation = operatorOperationCodeSchema.safeParse(item.code);
  const activeOperation = ["action-required", "in-progress", "needs-attention"].includes(
    item.displayStatus,
  );
  const refreshEvidence = async () => {
    setRefreshingEvidence(true);
    setEvidenceRefreshNotice(null);
    setError(null);
    try {
      if (walletIntentId !== null) {
        await apiJson(
          token,
          `/api/v1/wallet-intents/${encodeURIComponent(walletIntentId)}/refresh`,
          browserWalletIntentResponseSchema,
          { method: "POST", body: "{}" },
        );
        setEvidenceRefreshNotice(
          "Verification checked. Sidekick queried the configured transaction sources and reloaded this operation’s evidence.",
        );
      } else {
        setEvidenceRefreshNotice("Activity evidence reloaded.");
      }
      setRefresh((value) => value + 1);
      await Promise.resolve(onOperatorStateChanged?.());
    } catch (cause) {
      setError(operatorErrorDetail(cause, "Sidekick could not refresh this evidence"));
    } finally {
      setRefreshingEvidence(false);
    }
  };
  return (
    <>
      <a className="activity-back" href={activityHash(null, search)}>
        <ArrowLeft /> Return to Activity
      </a>
      <PageHead
        title={item.title}
        lede={item.summary}
        actions={
          <button
            className="btn btn-tertiary sm"
            disabled={loading || refreshingEvidence}
            onClick={() => void refreshEvidence()}
            type="button"
          >
            <ArrowClockwise className={loading || refreshingEvidence ? "spin" : ""} />{" "}
            {walletIntentId === null ? "Reload evidence" : "Refresh verification"}
          </button>
        }
      />
      {error ? (
        <div className="callout callout-caution content-notice" role="status">
          <WarningCircle className="ic" />
          <div className="body">
            Could not refresh this detail. Showing retained evidence: {error}
          </div>
        </div>
      ) : null}
      {evidenceRefreshNotice ? (
        <div className="callout callout-info content-notice" role="status">
          <div className="body">{evidenceRefreshNotice}</div>
        </div>
      ) : null}
      <div className="grid cols-2-1 activity-detail-grid">
        <section className="card" aria-labelledby="activity-detail-summary">
          <div className="card-head">
            <h2 id="activity-detail-summary">Operation summary</h2>
            <Badge state={activityStatusBadge(item.displayStatus)}>
              {activityStatusLabel(item.displayStatus)}
            </Badge>
          </div>
          <StatLine label="Stage">{activityStageLabel(item.stage)}</StatLine>
          <StatLine label="Outcome">{item.outcome}</StatLine>
          <StatLine label="Domain">{activityDomainLabel(item.domain)}</StatLine>
          <StatLine label="Type">{activityKindLabel(item.kind)}</StatLine>
          <StatLine label="Occurred">
            <time dateTime={item.occurredAt}>{activityTimestamp(item.occurredAt)}</time>
          </StatLine>
          {item.updatedAt === item.occurredAt ? null : (
            <StatLine label="Last updated">
              <time dateTime={item.updatedAt}>{activityTimestamp(item.updatedAt)}</time>
            </StatLine>
          )}
          <StatLine label="Activity ID">
            <CopyableIdentifier
              value={item.activityId}
              display={short(item.activityId, 18, 12)}
              label="Activity ID"
            />
          </StatLine>
          {item.actorPrincipal ? (
            <StatLine label="Actor">
              <CopyableIdentifier
                value={item.actorPrincipal}
                display={short(item.actorPrincipal)}
                label="actor principal"
              />
            </StatLine>
          ) : null}
          {item.txids.map((txid, index) => (
            <StatLine label={index === 0 ? "Transaction" : `Transaction ${index + 1}`} key={txid}>
              <CopyableIdentifier
                value={txid}
                display={short(txid, 12, 10)}
                label="transaction ID"
              />
            </StatLine>
          ))}
          {item.anchor ? (
            <>
              <StatLine label="Stacks block">
                {item.anchor.stacksBlockHeight.toLocaleString("en-US")}
              </StatLine>
              <StatLine label="Bitcoin block">
                {item.anchor.burnBlockHeight.toLocaleString("en-US")}
              </StatLine>
              <StatLine label="Index block">
                <CopyableIdentifier
                  value={item.anchor.indexBlockHash}
                  display={short(item.anchor.indexBlockHash, 12, 10)}
                  label="index block hash"
                />
              </StatLine>
            </>
          ) : null}
        </section>
        <aside className="card activity-detail-coverage" aria-labelledby="activity-detail-coverage">
          <div className="card-head">
            <h2 id="activity-detail-coverage">Evidence coverage</h2>
          </div>
          {item.coverage.map((source) => (
            <div className="activity-coverage-source" key={source.source}>
              <strong>{source.source.replaceAll("-", " ")}</strong>
              <span>{source.status}</span>
              {source.observedAt ? (
                <time dateTime={source.observedAt}>{activityTimestamp(source.observedAt)}</time>
              ) : null}
              {source.reason ? <small>{source.reason}</small> : null}
              {source.anchor ? (
                <small>
                  Last verified at Stacks {source.anchor.stacksBlockHeight.toLocaleString("en-US")}{" "}
                  / Bitcoin {source.anchor.burnBlockHeight.toLocaleString("en-US")}
                </small>
              ) : null}
            </div>
          ))}
          {item.supersedesActivityId ? (
            <a href={activityHash(item.supersedesActivityId, search)}>View replaced Activity</a>
          ) : null}
          {item.supersededByActivityId ? (
            <a href={activityHash(item.supersededByActivityId, search)}>
              View replacement Activity
            </a>
          ) : null}
        </aside>
      </div>
      {activeOperation && walletIntentId && walletAction.success ? (
        <section aria-labelledby="activity-operation-heading">
          <div className="section-title" id="activity-operation-heading">
            Progress and action
          </div>
          {operatorData && !operatorStateStale ? (
            <BrowserWalletActionPanel
              action={walletAction.data}
              chainId={operatorData.preflight.node.networkId}
              existingIntentId={walletIntentId}
              managerPrincipal={operatorData.managerPrincipal}
              network={operatorData.network}
              onVerified={async () => {
                try {
                  await onOperatorStateChanged?.();
                } finally {
                  setRefresh((value) => value + 1);
                }
              }}
              token={token}
            />
          ) : (
            <div className="callout callout-caution" role="status">
              <WarningCircle className="ic" />
              <div className="body">
                Current operation evidence is unavailable or stale. This Activity remains readable,
                but signing controls stay disabled until the current operator snapshot recovers.
              </div>
            </div>
          )}
        </section>
      ) : activeOperation && engineJobId && engineOperation.success ? (
        operatorStateStale ? (
          <div className="callout callout-caution" role="status">
            <WarningCircle className="ic" />
            <div className="body">
              This transaction job remains readable, but approval and wallet controls are disabled
              until the current deployment identity and operator snapshot recover.
            </div>
          </div>
        ) : (
          <section
            className="card activity-resume-operation"
            aria-labelledby="activity-operation-heading"
          >
            <div>
              <span className="eyebrow">CURRENT OPERATION</span>
              <h2 id="activity-operation-heading">Resume the exact transaction job</h2>
              <p className="muted">
                Sidekick will reload and validate this job before enabling approval or wallet
                controls.
              </p>
            </div>
            <a
              className="btn btn-accent"
              href={actionHash(engineOperation.data, { kind: "engine-job", jobId: engineJobId })}
            >
              {item.primaryAction?.label ?? "Resume operation"}
            </a>
          </section>
        )
      ) : null}
      <section aria-labelledby="activity-timeline-heading">
        <div className="section-title" id="activity-timeline-heading">
          Evidence timeline
        </div>
        <div className="card">
          {data.timeline.length ? (
            <div className="timeline activity-timeline">
              {data.timeline.map((entry) => (
                <article className={`ev ${activityTimelineState(entry)}`} key={entry.eventId}>
                  <div className="t">{entry.title}</div>
                  <div className="m">{entry.detail}</div>
                  <div className="h">
                    {activityTimestamp(entry.occurredAt)} · {entry.source.replaceAll("-", " ")}
                    {entry.stacksBlockHeight !== null
                      ? ` · Stacks ${entry.stacksBlockHeight.toLocaleString("en-US")}`
                      : ""}
                    {entry.canonical === false ? " · noncanonical" : ""}
                    {entry.finalized === true ? " · finalized" : ""}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="activity-empty">No timeline evidence is available for this Activity.</p>
          )}
        </div>
      </section>
      <div className="activity-detail-footer">
        <a className="btn btn-tertiary sm" href={dashboardHash("settings")}>
          Open support settings
        </a>
      </div>
    </>
  );
}

export function Activity({
  data,
  token,
  activityId,
  operatorStateStale,
  onOperatorStateChanged,
  search,
  section,
}: {
  data: DashboardSnapshot | null;
  token: string;
  activityId: string | null;
  operatorStateStale: boolean;
  onOperatorStateChanged?: (() => void | Promise<void>) | undefined;
  search: string;
  section: DomainSection | null;
}) {
  return activityId ? (
    <ActivityDetailPage
      activityId={activityId}
      data={data}
      operatorStateStale={operatorStateStale}
      onOperatorStateChanged={onOperatorStateChanged}
      search={search}
      token={token}
    />
  ) : (
    <ActivityFeed search={search} section={section} token={token} />
  );
}
