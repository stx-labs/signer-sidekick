import { BracketsCurly, FileCsv } from "@phosphor-icons/react";
import {
  type DashboardSnapshot,
  poolPageResponseSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { useEffect, useState } from "react";
import { apiDownload, apiJson } from "../../api-client.js";
import { CopyableIdentifier } from "../../copyable-identifier.js";
import type { DomainSection } from "../../dashboard-route.js";
import {
  Badge,
  MobileSortSelect,
  PageHead,
  Pagination,
  SortableHeader,
  type TableSort,
} from "../../shared/dashboard-ui.js";
import { useDomainSection } from "../../shared/domain-section.js";
import { number, short, stx } from "../../shared/format.js";
import {
  operatorActionError,
  operatorErrorDetail,
  operatorErrorSentence,
} from "../../shared/operator-error.js";
import { PoolForecastChart } from "./pool-forecast-chart.js";
import { buildPoolForecastView } from "./pool-forecast-view.js";

type Snapshot = DashboardSnapshot;
type RosterSort =
  | "staker"
  | "amount"
  | "first-cycle"
  | "last-cycle"
  | "unlock-height"
  | "bond"
  | "status";

const rosterSortLabels: Record<RosterSort, string> = {
  staker: "Staker",
  amount: "Amount",
  "first-cycle": "First cycle",
  "last-cycle": "Last cycle",
  "unlock-height": "Unlock block",
  bond: "Bond",
  status: "Status",
};

function rosterStatus(entry: Snapshot["roster"][number]): {
  state: "caution" | "success";
  label: string;
} {
  return entry.stxNodeVerified === false
    ? { state: "caution", label: "Not node-verified" }
    : entry.stxNodeVerified === null && entry.bond
      ? { state: "success", label: "Bond verified" }
      : { state: "success", label: "Verified" };
}

export function Pool({
  data,
  token,
  section,
}: {
  data: Snapshot;
  token: string;
  section: DomainSection | null;
}) {
  useDomainSection("pool", section);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<TableSort<RosterSort>>({ key: "staker", direction: "asc" });
  const [roster, setRoster] = useState(data.roster);
  const [rosterTotal, setRosterTotal] = useState(data.rosterTotal ?? data.roster.length);
  const [rosterFreshness, setRosterFreshness] = useState(data.freshness ?? null);
  const [rosterLoading, setRosterLoading] = useState(true);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [rosterRetry, setRosterRetry] = useState(0);
  const [downloadBusy, setDownloadBusy] = useState<"csv" | "json" | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const rosterRefreshKey = `${data.generatedAt}:${rosterRetry}`;
  const pageSize = 50;
  useEffect(() => {
    void rosterRefreshKey;
    const controller = new AbortController();
    let correctingPage = false;
    const parameters = new URLSearchParams({
      offset: String(page * pageSize),
      limit: String(pageSize),
      query,
      sort: sort.key,
      direction: sort.direction,
    });
    setRosterLoading(true);
    setRosterError(null);
    void apiJson(token, `/api/v1/pool?${parameters}`, poolPageResponseSchema, {
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        const lastPage = Math.max(0, Math.ceil(result.total / pageSize) - 1);
        setRosterFreshness(result.freshness ?? null);
        setRosterTotal(result.total);
        if (page > lastPage) {
          correctingPage = true;
          setPage(lastPage);
          return;
        }
        setRoster(result.roster);
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setRosterError(operatorErrorDetail(cause, "Sidekick returned no error detail"));
      })
      .finally(() => {
        if (!controller.signal.aborted && !correctingPage) setRosterLoading(false);
      });
    return () => controller.abort();
  }, [page, query, rosterRefreshKey, sort, token]);
  const download = async (format: "csv" | "json") => {
    setDownloadBusy(format);
    setDownloadError(null);
    try {
      await apiDownload(token, `/api/v1/pool/roster.${format}`, {
        expectedContentTypes: format === "csv" ? ["text/csv"] : ["application/json"],
        fallbackFilename: `signer-sidekick-roster.${format}`,
      });
    } catch (cause) {
      setDownloadError(
        operatorActionError(
          cause,
          `Could not download the ${format.toUpperCase()} roster`,
          "Retrying is safe",
        ),
      );
    } finally {
      setDownloadBusy(null);
    }
  };
  const cycles = data.forecast?.cycles ?? [];
  const forecastView = buildPoolForecastView(cycles);
  return (
    <>
      <PageHead
        title="Pool positions"
        lede="Stakers assigned to this manager, including observed bond participants, their eligible cycles, and unlock timing."
        actions={
          <>
            <button
              type="button"
              className="btn btn-tertiary sm"
              disabled={downloadBusy !== null}
              onClick={() => void download("csv")}
            >
              <FileCsv />
              {downloadBusy === "csv" ? "Downloading" : "CSV"}
            </button>
            <button
              type="button"
              className="btn btn-tertiary sm"
              disabled={downloadBusy !== null}
              onClick={() => void download("json")}
            >
              <BracketsCurly />
              {downloadBusy === "json" ? "Downloading" : "JSON"}
            </button>
          </>
        }
      />
      {rosterFreshness?.status === "stale" ? (
        <div className="callout callout-caution content-notice" role="status">
          Showing last known roster data while Sidekick refreshes chain data.
        </div>
      ) : null}
      {downloadError ? (
        <div className="callout callout-critical content-notice" role="alert">
          {downloadError}
        </div>
      ) : null}
      <div className="kpi pool-kpi domain-section-anchor" id="pool-positions">
        <div className="tile hero">
          <div className="l">Stakers</div>
          <div className="v">{data.rosterTotal ?? data.roster.length}</div>
          <div className="d">assigned to this manager</div>
        </div>
        <div className="tile">
          <div className="l">
            Stacked · current <span className="src src-chain" />
          </div>
          <div className="v">
            {stx(cycles[0]?.contract.pendingStxUstx)} <span className="u">STX</span>
          </div>
          <div className="d">
            {cycles[0]?.threshold.meetsThreshold ? "eligible" : "not eligible"}
          </div>
        </div>
        <div className="tile">
          <div className="l">Future joins</div>
          <div className="v">
            {cycles
              .slice(1)
              .reduce((sum, cycle) => sum + (cycle.changesFromPrevious?.joiningStakers ?? 0), 0)}
          </div>
          <div className="d">across displayed cycles</div>
        </div>
        <div className="tile">
          <div className="l">Deferred unlocks</div>
          <div className="v">
            {data.rosterStats?.deferredUnlocks ??
              data.roster.filter(({ position }) => position?.unlockBurnHeight).length}
          </div>
          <div className="d">recorded unlock heights</div>
        </div>
      </div>
      {cycles[0] && !cycles[0].threshold.meetsThreshold ? (
        <div className="callout callout-critical content-notice" role="alert">
          <div className="body">
            <strong>Pool is not eligible for signing.</strong> It is below the 50,000 STX minimum.
          </div>
        </div>
      ) : null}
      <div className="section-title domain-section-anchor" id="pool-forecast">
        Pool forecast{" "}
        <span className="hint">Current cycle confirmed; future cycles may change.</span>
      </div>
      <div className="card forecast-card">
        <PoolForecastChart view={forecastView} />
      </div>
      <div className="section-title domain-section-anchor" id="pool-roster">
        Staker roster
      </div>
      {rosterError ? (
        <div className="callout callout-critical content-notice" role="alert">
          <div className="body">
            <strong>Could not refresh the staker roster.</strong>{" "}
            {operatorErrorSentence(rosterError)}
            <div className="actions">
              <button
                type="button"
                className="btn btn-secondary sm"
                onClick={() => setRosterRetry((value) => value + 1)}
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {rosterLoading ? (
        <div className="callout callout-neutral content-notice" role="status">
          Refreshing roster…
        </div>
      ) : null}
      <div className="tbl-wrap responsive-table-wrap pool-roster-wrap" aria-busy={rosterLoading}>
        <div className="tbl-toolbar">
          <div className="search-inline">
            <input
              aria-label="Search principal"
              placeholder="Search principal…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(0);
              }}
            />
          </div>
          <MobileSortSelect
            label="Sort roster"
            options={Object.entries(rosterSortLabels) as Array<[RosterSort, string]>}
            sort={sort}
            setSort={(next) => {
              setSort(next);
              setPage(0);
            }}
          />
          <div className="total">
            {rosterLoading ? "Loading…" : rosterError ? "Unavailable" : `${rosterTotal} stakers`}
          </div>
        </div>
        {!rosterLoading && !rosterError ? (
          <>
            <table className="responsive-data-table pool-roster-table">
              <thead>
                <tr>
                  <SortableHeader
                    column="staker"
                    label="Staker"
                    setSort={(next) => {
                      setSort(next);
                      setPage(0);
                    }}
                    sort={sort}
                  />
                  <SortableHeader
                    align="right"
                    column="amount"
                    label="Amount"
                    setSort={(next) => {
                      setSort(next);
                      setPage(0);
                    }}
                    sort={sort}
                  />
                  <SortableHeader
                    column="first-cycle"
                    label="First cycle"
                    setSort={(next) => {
                      setSort(next);
                      setPage(0);
                    }}
                    sort={sort}
                  />
                  <SortableHeader
                    column="last-cycle"
                    label="Last cycle"
                    setSort={(next) => {
                      setSort(next);
                      setPage(0);
                    }}
                    sort={sort}
                  />
                  <SortableHeader
                    column="unlock-height"
                    label="Unlock Bitcoin block"
                    setSort={(next) => {
                      setSort(next);
                      setPage(0);
                    }}
                    sort={sort}
                  />
                  <SortableHeader
                    column="bond"
                    label="Bond"
                    setSort={(next) => {
                      setSort(next);
                      setPage(0);
                    }}
                    sort={sort}
                  />
                  <SortableHeader
                    column="status"
                    label="Status"
                    setSort={(next) => {
                      setSort(next);
                      setPage(0);
                    }}
                    sort={sort}
                  />
                </tr>
              </thead>
              <tbody>
                {roster.map((entry) => {
                  const position = entry.position;
                  const lastCycle = position ? BigInt(position.unlockCycle) - 1n : null;
                  const status = rosterStatus(entry);
                  return (
                    <tr key={entry.stakerPrincipal}>
                      <td className="pool-roster-staker" data-label="Staker">
                        <div className="staker">
                          <span className="avatar">SP</span>
                          <CopyableIdentifier
                            value={entry.stakerPrincipal}
                            display={short(entry.stakerPrincipal, 6, 6)}
                            label="staker principal"
                            className="mono"
                          />
                        </div>
                      </td>
                      <td className="right mono pool-roster-amount" data-label="Amount">
                        {stx(position?.amountUstx)} STX
                      </td>
                      <td className="mono pool-roster-cycles" data-label="Cycles">
                        <span className="responsive-table-desktop-value">
                          {position?.firstRewardCycle ?? "—"}
                        </span>
                        <span className="responsive-table-mobile-value">
                          Cycles {position?.firstRewardCycle ?? "—"}–{lastCycle?.toString() ?? "—"}
                        </span>
                      </td>
                      <td className="mono pool-roster-last-cycle" data-label="Last cycle">
                        {lastCycle?.toString() ?? "—"}
                      </td>
                      <td className="mono pool-roster-unlock" data-label="Unlock">
                        <span className="responsive-table-mobile-value">Unlock </span>
                        {number(position?.unlockBurnHeight)}
                      </td>
                      <td className="pool-roster-bond" data-label="Bond">
                        {entry.bond ? (
                          // Read from PoX-5 `get-bond-membership`, not the indexer's type label.
                          <Badge state={entry.bond.isL1Lock ? "accent" : "info"}>
                            {entry.bond.isL1Lock ? "Bitcoin L1" : "sBTC"} · #{entry.bond.bondIndex}
                          </Badge>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="pool-roster-status" data-label="Status">
                        <Badge state={status.state}>{status.label}</Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rosterTotal === 0 ? <div className="empty-table">No matching stakers</div> : null}
            <Pagination page={page} pageSize={pageSize} total={rosterTotal} setPage={setPage} />
          </>
        ) : null}
      </div>
      <p className="tertiary roster-note">
        An unstake shortens the position immediately, while STX stays locked until the recorded
        unlock Bitcoin block.
      </p>
    </>
  );
}
