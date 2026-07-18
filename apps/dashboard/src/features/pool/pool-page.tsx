import { BracketsCurly, FileCsv } from "@phosphor-icons/react";
import {
  type DashboardSnapshot,
  poolPageResponseSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { useEffect, useState } from "react";
import { apiDownload, apiJson } from "../../api-client.js";
import { CopyableIdentifier } from "../../copyable-identifier.js";
import { Badge, PageHead, Pagination } from "../../shared/dashboard-ui.js";
import { number, short, stx } from "../../shared/format.js";

type Snapshot = DashboardSnapshot;

export function Pool({ data, token }: { data: Snapshot; token: string }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [roster, setRoster] = useState(data.roster);
  const [rosterTotal, setRosterTotal] = useState(data.rosterTotal ?? data.roster.length);
  const pageSize = 50;
  useEffect(() => {
    const controller = new AbortController();
    const parameters = new URLSearchParams({
      offset: String(page * pageSize),
      limit: String(pageSize),
      query,
    });
    void apiJson(token, `/api/v1/pool?${parameters}`, poolPageResponseSchema, {
      signal: controller.signal,
    })
      .then((result) => {
        setRoster(result.roster);
        setRosterTotal(result.total);
      })
      .catch((error) => {
        if ((error as Error).name !== "AbortError") console.error(error);
      });
    return () => controller.abort();
  }, [page, query, token]);
  const cycles = data.forecast?.cycles ?? [];
  const max = Math.max(1, ...cycles.map((cycle) => Number(cycle.contract.pendingStxUstx)));
  return (
    <>
      <PageHead
        title="Pool positions"
        lede="Every STX-only staker assigned to this manager, which cycles they count in, and when their STX unlocks. No wallet connection or stake submission here."
        actions={
          <>
            <a
              className="btn btn-tertiary sm"
              href="/api/v1/pool/roster.csv"
              onClick={(event) => {
                event.preventDefault();
                void apiDownload(token, "/api/v1/pool/roster.csv", {
                  expectedContentTypes: ["text/csv"],
                  fallbackFilename: "signer-sidekick-roster.csv",
                });
              }}
            >
              <FileCsv />
              CSV
            </a>
            <button
              type="button"
              className="btn btn-tertiary sm"
              onClick={() => {
                void apiDownload(token, "/api/v1/pool/roster.json", {
                  expectedContentTypes: ["application/json"],
                  fallbackFilename: "signer-sidekick-roster.json",
                });
              }}
            >
              <BracketsCurly />
              JSON
            </button>
          </>
        }
      />
      <div className="kpi">
        <div className="tile hero">
          <div className="l">Stakers</div>
          <div className="v">{data.rosterTotal ?? data.roster.length}</div>
          <div className="d">node-verified API roster</div>
        </div>
        <div className="tile">
          <div className="l">
            Stacked · current <span className="src src-chain" />
          </div>
          <div className="v">
            {stx(cycles[0]?.contract.pendingStxUstx)} <span className="u">STX</span>
          </div>
          <div className="d">
            {cycles[0]?.threshold.meetsThreshold ? "above threshold" : "below threshold"}
          </div>
        </div>
        <div className="tile">
          <div className="l">Future joins</div>
          <div className="v">
            {cycles
              .slice(1)
              .reduce((sum, cycle) => sum + (cycle.changesFromPrevious?.joiningStakers ?? 0), 0)}
          </div>
          <div className="d">within configured horizon</div>
        </div>
        <div className="tile">
          <div className="l">Deferred unlocks</div>
          <div className="v">
            {data.rosterStats?.deferredUnlocks ??
              data.roster.filter(({ position }) => position?.unlockBurnHeight).length}
          </div>
          <div className="d">unlock Bitcoin block tracked</div>
        </div>
      </div>
      <div className="section-title">
        Pool total by cycle{" "}
        <span className="hint">
          current cycle is authoritative; future cycles remain labeled projections pending core
          confirmation
        </span>
      </div>
      <div className="card forecast-card">
        <div className="barchart">
          {cycles.map((cycle, index) => (
            <div className="col" key={cycle.cycleId}>
              <div className="amt">{stx(cycle.contract.pendingStxUstx)}</div>
              <div
                className={`bar ${cycle.threshold.meetsThreshold ? (index === 0 ? "" : "forecast") : "under"}`}
                style={{
                  height: `${Math.max(6, (Number(cycle.contract.pendingStxUstx) / max) * 100)}%`,
                }}
              />
              <div className="cyc">{cycle.cycleId}</div>
              <div className="hint">{cycle.provenance.classification}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="section-title">Staker roster</div>
      <div className="tbl-wrap">
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
          <div className="total">{rosterTotal} stakers</div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Staker</th>
              <th className="right">Amount</th>
              <th>First cycle</th>
              <th>Last cycle</th>
              <th>Unlock Bitcoin block</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {roster.map((entry) => {
              const position = entry.position;
              const lastCycle = position ? BigInt(position.unlockCycle) - 1n : null;
              return (
                <tr key={entry.stakerPrincipal}>
                  <td>
                    <div className="staker">
                      <span className="avatar">SP</span>
                      <CopyableIdentifier
                        value={entry.stakerPrincipal}
                        display={short(entry.stakerPrincipal, 8, 5)}
                        label="staker principal"
                        className="mono"
                      />
                    </div>
                  </td>
                  <td className="right mono">{stx(position?.amountUstx)}</td>
                  <td className="mono">{position?.firstRewardCycle ?? "—"}</td>
                  <td className="mono">{lastCycle?.toString() ?? "—"}</td>
                  <td className="mono">{number(position?.unlockBurnHeight)}</td>
                  <td>
                    <Badge state={entry.stxNodeVerified ? "success" : "caution"}>
                      {entry.stxNodeVerified ? "Verified" : "API only"}
                    </Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rosterTotal === 0 ? <div className="empty-table">No matching stakers</div> : null}
        <Pagination page={page} pageSize={pageSize} total={rosterTotal} setPage={setPage} />
      </div>
      <p className="tertiary roster-note">
        An unstake shortens the position immediately, while STX stays locked until the recorded
        unlock Bitcoin block.
      </p>
    </>
  );
}
