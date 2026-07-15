import {
  ArrowClockwise,
  BracketsCurly,
  Check,
  CheckCircle,
  Coins,
  DownloadSimple,
  Eye,
  FileCsv,
  Gauge,
  GearSix,
  Key,
  ListChecks,
  Moon,
  Plugs,
  SealCheck,
  ShareNetwork,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  UsersThree,
  Warning,
  WarningCircle,
} from "@phosphor-icons/react";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../../design/tokens/tokens.css";
import "../../../design/screens/_app.css";
import "./styles.css";

type Page =
  | "overview"
  | "registration"
  | "pool"
  | "rewards"
  | "operations"
  | "setup"
  | "enrollment"
  | "settings";

interface Snapshot {
  generatedAt: string;
  network: string;
  managerPrincipal: string;
  config?: {
    nodeRpcUrl: string;
    apiUrl: string;
    apiKeyConfigured: boolean;
    forecastHorizonCycles: number;
  };
  preflight: {
    status: "pass" | "warn" | "fail";
    node: { networkId: number; burnBlockHeight: number; stacksTipHeight: number };
    api: {
      serverVersion: string;
      burnBlockHeight: number;
      stacksTipHeight: number;
      burnBlockLag: number;
    };
    pox: { rewardCycleId: number; pox5Available: boolean; pox5ContractId: string | null };
    cycle: {
      currentId: number;
      nextId: number | null;
      blocksUntilPreparePhase: number | null;
      preparePhaseStartBurnHeight: number | null;
      isPreparePhase: boolean | null;
    };
    checks: Array<{ id: string; status: "pass" | "warn" | "fail"; message: string }>;
  };
  manager: {
    attachAllowed: boolean;
    automationEligible: boolean;
    publishHeight: number;
    source: { recognized: boolean; profileId: string | null; sha256: string; match: string };
    reasons: string[];
  };
  registration: null | {
    registered: boolean;
    signerKeyHex: string | null;
    signerKeyGrantValid: boolean | null;
    reason: string;
  };
  setup: null | {
    status: "ready" | "attention" | "blocked";
    enrollmentWindow: {
      status: string;
      targetCycleId: number | null;
      blocksUntilPreparePhase: number | null;
    };
    eligibility: {
      current: CycleEligibility | null;
      next: CycleEligibility | null;
    };
    checks: Array<{ id: string; status: "pass" | "warn" | "fail"; message: string }>;
  };
  forecast: null | {
    status: "ready" | "attention";
    ingestion: null | { activeDiscoveredStakers: number; completedAt: string };
    cycles: ForecastCycle[];
  };
  rewards: null | {
    status: "ready" | "attention";
    rewardCycle: number;
    global: {
      lastRewardComputeBurnHeight: string;
      lastComputedRewardCycle: string | null;
      signerEarnedBeforeManagerClaimSats: string;
    };
    manager: {
      configuredFeeBips: string;
      feeSnapshotBips: string | null;
      earnedFeesSats: string;
      withdrawalLiabilitySats: string;
      unclaimedStakerRewardsSats: string;
    };
    totals: {
      stakers: number;
      grossSats: string;
      earnedSats: string;
      feeSats: string;
      actionableClaims: number;
      l1ClaimsWaitingForFeeThreshold: number;
    };
    stakers: Array<{
      stakerPrincipal: string;
      payout: { kind: string; maxFeeSats: string | null };
      rewards: { earnedSats: string; feeSats: string; grossSats: string };
      claimableByPolicy: boolean;
    }>;
  };
  activity: {
    eventCount: number;
    latestBlockHeight: number | null;
    claimTotal: number;
    withdrawalTotal: number;
    pendingWithdrawalTotal: number;
    claims: Array<{
      txId: string;
      eventIndex: number;
      blockHeight: number;
      stakerPrincipal: string;
      rewardCycle: string;
      amountSats: string;
      destination: string;
      withdrawalRequestId: string | null;
    }>;
    withdrawals: Array<{
      requestId: string;
      stakerPrincipal: string;
      amountSats: string;
      maxFeeSats: string;
      initiatedBlockHeight: number;
      state: "pending" | "settled" | "reclaimed";
    }>;
  };
  roster: RosterEntry[];
  rosterTotal?: number;
  rosterStats?: { deferredUnlocks: number };
  alerts: Array<{
    id: string;
    severity: "critical" | "warning" | "info";
    title: string;
    detail: string;
  }>;
}

interface CycleEligibility {
  cycleId: number;
  delegatedUstx: string;
  marginUstx: string;
  meetsThreshold: boolean;
  inSignerSet: boolean;
}

interface ForecastCycle {
  cycleId: number;
  status: "ready" | "attention";
  provenance: {
    classification: "authoritative" | "projected";
    contractSource: "pox5-read-only";
    localRosterSource: "api-indexed-node-verified" | "unavailable";
  };
  local: { stakerCount: number | null; enumeratedStxUstx: string | null; rosterAvailable: boolean };
  contract: { pendingStxUstx: string; inSignerSet: boolean };
  threshold: { marginUstx: string; meetsThreshold: boolean };
  changesFromPrevious: null | {
    joiningStakers: number;
    leavingStakers: number;
    changedAmountStakers: number;
  };
}

interface RosterEntry {
  stakerPrincipal: string;
  active: boolean;
  hasStx: boolean;
  stxNodeVerified: boolean | null;
  position: null | {
    amountUstx: string;
    firstRewardCycle: string;
    numCycles: string;
    unlockCycle: string;
    unlockBurnHeight: string | null;
    active: boolean;
  };
}

interface RewardCycleSummary {
  rewardCycle: number;
  status: "ready" | "attention";
  observedBurnBlockHeight: number;
  stakerCount: number;
  grossSats: string;
  earnedSats: string;
  feeSats: string;
  configuredFeeBips: string | null;
  feeSnapshotBips: string | null;
  actionableClaims: number;
}

const nav: Array<{ group?: string; id?: Page; label?: string; icon?: typeof Gauge }> = [
  { group: "Operate" },
  { id: "overview", label: "Overview", icon: Gauge },
  { id: "registration", label: "Registration", icon: SealCheck },
  { id: "pool", label: "Pool", icon: UsersThree },
  { id: "rewards", label: "Rewards", icon: Coins },
  { id: "operations", label: "Operations", icon: ListChecks },
  { group: "Configure" },
  { id: "setup", label: "Initial Setup", icon: SlidersHorizontal },
  { id: "enrollment", label: "Public Pool Page", icon: ShareNetwork },
  { id: "settings", label: "Settings", icon: GearSix },
];

function StacksGlyph() {
  return (
    <svg viewBox="0 0 17 18" fill="currentColor" aria-hidden="true">
      <path d="M5.09 5.385c-.023.052-.069.082-.131.082H.496C.212 5.507 0 5.735 0 6.025v.948c0 .3.235.558.551.558h14.998c.302 0 .551-.244.551-.558v-.948c0-.3-.235-.558-.551-.558h-4.407c-.056 0-.102-.025-.133-.084-.029-.051-.026-.11.005-.154L13.902.865c.095-.157.123-.368.024-.559C13.834.111 13.633 0 13.436 0h-1.121c-.172 0-.36.086-.464.255L8.508 5.349a.293.293 0 0 1-.238.127h-.423a.282.282 0 0 1-.236-.124L4.247.261A.58.58 0 0 0 3.785.008H2.664a.554.554 0 0 0-.487.292.56.56 0 0 0 .023.568l2.882 4.347c.037.057.037.12.012.163Z" />
      <path d="m8.663 12.001 3.197 4.838c.104.169.292.255.464.255h1.121c.203 0 .388-.115.486-.289a.56.56 0 0 0-.024-.574l-2.87-4.343c-.035-.054-.039-.11-.01-.166.035-.06.086-.087.134-.087h4.39c.302 0 .551-.244.551-.558v-.948c0-.3-.235-.558-.551-.558h-15C.249 9.571 0 9.815 0 10.129v.948c0 .3.235.558.551.558h4.398c.069 0 .107.028.128.075.035.068.029.121-.001.163l-2.888 4.364a.57.57 0 0 0-.025.563c.097.185.283.302.488.302h1.121c.187 0 .353-.09.454-.244l3.363-5.09a.282.282 0 0 1 .236-.125h.423c.095 0 .182.048.239.129l.173.229Z" />
    </svg>
  );
}

function short(value: string | null | undefined, left = 7, right = 5): string {
  if (!value) return "—";
  return value.length <= left + right + 1
    ? value
    : `${value.slice(0, left)}…${value.slice(-right)}`;
}

function number(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return BigInt(value).toLocaleString("en-US");
}

function stx(ustx: string | null | undefined): string {
  if (!ustx) return "—";
  return (Number(ustx) / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function sbtc(sats: string | null | undefined): string {
  if (!sats) return "0";
  return (Number(sats) / 100_000_000).toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {
    type: "application/json;charset=utf-8",
  });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(href);
}

function Badge({
  state,
  children,
}: {
  state: "success" | "caution" | "error" | "info" | "neutral" | "accent";
  children: React.ReactNode;
}) {
  return <span className={`badge b-${state}`}>{children}</span>;
}

function StatLine({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="statline">
      <span className="k">{label}</span>
      <span className="v">{children}</span>
    </div>
  );
}

function PageHead({
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

function Pagination({
  page,
  pageSize,
  total,
  setPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  setPage: (page: number) => void;
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
          disabled={boundedPage === 0}
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
          disabled={boundedPage >= pages - 1}
          onClick={() => setPage(boundedPage + 1)}
        >
          Next
        </button>
      </div>
    </nav>
  );
}

function Overview({ data, sync, syncing }: { data: Snapshot; sync: () => void; syncing: boolean }) {
  const current = data.forecast?.cycles[0];
  const next = data.forecast?.cycles[1];
  const rewards = data.rewards;
  return (
    <>
      <PageHead
        title="Overview"
        lede="One signer-manager. This screen answers a single question — does the pool need you right now?"
        actions={
          <>
            <button type="button" className="btn btn-tertiary sm" onClick={sync} disabled={syncing}>
              <ArrowClockwise />
              {syncing ? "Reconciling" : "Reconcile now"}
            </button>
            <button
              type="button"
              className="btn btn-secondary sm"
              onClick={() => downloadJson("signer-sidekick-status.json", data)}
            >
              <DownloadSimple />
              Support snapshot
            </button>
          </>
        }
      />
      <div className="cycle-clock card">
        <div>
          <span>Burn height</span>
          <strong>{number(data.preflight.node.burnBlockHeight)}</strong>
          <small className="src src-chain">Stacks node tip</small>
        </div>
        <div>
          <span>Reward cycle</span>
          <strong>#{data.preflight.cycle.currentId}</strong>
          <small className="src src-chain">PoX-5 contract</small>
        </div>
        <div>
          <span>API lag</span>
          <strong>
            {data.preflight.api.burnBlockLag} <em>blocks</em>
          </strong>
          <small className="src src-api">indexed tip</small>
        </div>
        <div>
          <span>Next prepare phase</span>
          <strong>
            {number(data.preflight.cycle.blocksUntilPreparePhase)} <em>blocks</em>
          </strong>
          <small>at {number(data.preflight.cycle.preparePhaseStartBurnHeight)}</small>
        </div>
      </div>
      <div className="section-title">
        <WarningCircle color="var(--status-caution)" />
        Required actions{" "}
        <span className="hint">{data.alerts.length || "No"} item(s) need attention</span>
      </div>
      {data.alerts.length ? (
        <div className="grid cols-3 action-grid">
          {data.alerts.slice(0, 3).map((alert) => (
            <div
              className={`callout callout-${alert.severity === "critical" ? "critical" : alert.severity === "warning" ? "caution" : "info"}`}
              key={alert.id}
            >
              <Warning className="ic" />
              <div className="body">
                <strong>{alert.title}</strong>
                <br />
                {alert.detail}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="callout callout-neutral">
          <CheckCircle className="ic" />
          <div className="body">
            <strong>No active operator actions</strong>
            <br />
            All current read-only checks agree at this tip.
          </div>
        </div>
      )}
      <div className="section-title">Pool at a glance</div>
      <div className="kpi">
        <div className="tile hero">
          <div className="l">
            Stacked this cycle <span className="src src-chain" />
          </div>
          <div className="v">
            {stx(current?.contract.pendingStxUstx)} <span className="u">STX</span>
          </div>
          <div className={current?.threshold.meetsThreshold ? "d up" : "d down"}>
            {current
              ? `${stx(current.threshold.marginUstx)} STX threshold margin`
              : "Roster not synchronized"}
          </div>
        </div>
        <div className="tile">
          <div className="l">
            Next cycle <span className="src src-local" />
          </div>
          <div className="v">
            {stx(next?.contract.pendingStxUstx)} <span className="u">STX</span>
          </div>
          <div className="d">cycle {next?.cycleId ?? "—"} projection</div>
        </div>
        <div className="tile">
          <div className="l">
            Unclaimed rewards <span className="src src-chain" />
          </div>
          <div className="v btc-value">
            {sbtc(rewards?.manager.unclaimedStakerRewardsSats)} <span className="u">sBTC</span>
          </div>
          <div className="d">{rewards?.totals.actionableClaims ?? 0} actionable claims</div>
        </div>
        <div className="tile">
          <div className="l">
            Registration <span className="src src-chain" />
          </div>
          <div className="v status-value">
            {data.registration?.signerKeyGrantValid ? "Valid" : "Attention"}
          </div>
          <div className="d">
            {data.registration?.registered ? "manager registered" : "registration missing"}
          </div>
        </div>
      </div>
      <div className="section-title">
        Reward pipeline <span className="hint">cycle {data.preflight.cycle.currentId}</span>
      </div>
      <div className="card-standout pipeline-wrap">
        <div className="pipeline">
          <PipelineStage
            done={BigInt(rewards?.global.lastRewardComputeBurnHeight ?? 0) > 0n}
            title="Global calculated"
            value={
              rewards?.global.lastRewardComputeBurnHeight === "0"
                ? "Waiting"
                : `#${number(rewards?.global.lastRewardComputeBurnHeight)}`
            }
            detail="contract read-only"
          />
          <PipelineStage
            done={BigInt(rewards?.global.signerEarnedBeforeManagerClaimSats ?? 0) === 0n}
            title="Manager claim"
            value={`${sbtc(rewards?.global.signerEarnedBeforeManagerClaimSats)} sBTC`}
            detail="unclaimed by manager"
          />
          <PipelineStage
            done={(rewards?.totals.actionableClaims ?? 0) === 0}
            title="Stakers paid"
            value={`${data.activity.claimTotal} recorded`}
            detail={`${rewards?.totals.actionableClaims ?? 0} currently actionable`}
          />
          <PipelineStage
            done={data.activity.withdrawals.every(({ state }) => state !== "pending")}
            title="L1 settled"
            value={`${data.activity.withdrawalTotal - data.activity.pendingWithdrawalTotal} / ${data.activity.withdrawalTotal}`}
            detail="manager event history"
          />
        </div>
      </div>
      <div className="grid cols-2-1 overview-bottom">
        <div className="card">
          <div className="card-head">
            <h2>Registration &amp; eligibility</h2>
            <Badge state={data.setup?.status === "ready" ? "success" : "caution"}>
              {data.setup?.status ?? "Unavailable"}
            </Badge>
          </div>
          <StatLine label="Manager">
            <span className="identifier">{short(data.managerPrincipal)}</span>
          </StatLine>
          <StatLine label="Grant">
            <Badge state={data.registration?.signerKeyGrantValid ? "success" : "error"}>
              {data.registration?.signerKeyGrantValid ? "Valid" : "Invalid"}
            </Badge>
          </StatLine>
          <StatLine label={`Signer set · ${current?.cycleId ?? "—"}`}>
            <Badge state={current?.contract.inSignerSet ? "success" : "error"}>
              {current?.contract.inSignerSet ? "Eligible" : "Not eligible"}
            </Badge>
          </StatLine>
          <StatLine label="Source hash">
            <span className="identifier src src-chain">{short(data.manager.source.sha256)}</span>
          </StatLine>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Recent activity</h2>
          </div>
          <div className="timeline">
            {data.activity.claims.slice(0, 4).map((claim) => (
              <div className="ev ok" key={`${claim.txId}:${claim.eventIndex}`}>
                <div className="t">Staker reward claimed</div>
                <div className="m">
                  {sbtc(claim.amountSats)} sBTC · {short(claim.stakerPrincipal)}
                </div>
                <div className="h">
                  {number(claim.blockHeight)} · {short(claim.txId)}
                </div>
              </div>
            ))}
            {data.activity.claims.length === 0 ? (
              <div className="ev">
                <div className="t">No manager claims indexed yet</div>
                <div className="m">Run reconciliation to update event history.</div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}

function PipelineStage({
  done,
  title,
  value,
  detail,
}: {
  done: boolean;
  title: string;
  value: string;
  detail: string;
}) {
  return (
    <div className={`stage ${done ? "st-done" : "st-active"}`}>
      <div className="st">
        <span className="ic">{done ? <Check /> : <ArrowClockwise />}</span>
        {title}
      </div>
      <div className="sv">{value}</div>
      <div className="sm">{detail}</div>
    </div>
  );
}

function Registration({ data }: { data: Snapshot }) {
  const cycles = data.forecast?.cycles ?? [];
  return (
    <>
      <PageHead
        title="Registration"
        lede="Can the manager and signer accept and retain eligible stakes? Protocol registration health — not signer-machine health."
      />
      <div className="callout callout-info intro-callout">
        <ShieldCheck className="ic" />
        <div className="body">
          Sidekick holds no signer or admin key. Registration and grant actions are prepared offline
          and verified from the connected node.
        </div>
      </div>
      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">
            <h2>Manager &amp; signer</h2>
            <Badge state={data.manager.source.recognized ? "success" : "caution"}>
              {data.manager.source.recognized ? "Recognized profile" : "Unreviewed source"}
            </Badge>
          </div>
          <StatLine label="Manager principal">
            <span className="identifier">{short(data.managerPrincipal, 12, 9)}</span>
          </StatLine>
          <StatLine label="Source profile">
            {data.manager.source.profileId ?? "ABI-compatible only"}
          </StatLine>
          <StatLine label="Source hash">
            <span className="identifier src src-chain">
              {short(data.manager.source.sha256, 12, 8)}
            </span>
          </StatLine>
          <StatLine label="Published">
            <span className="mono">block {number(data.manager.publishHeight)}</span>
          </StatLine>
          <StatLine label="Signer public key">
            <span className="identifier">{short(data.registration?.signerKeyHex, 12, 8)}</span>
          </StatLine>
          <StatLine label="Registration">
            <Badge state={data.registration?.registered ? "success" : "error"}>
              {data.registration?.registered ? "Confirmed" : "Missing"}
            </Badge>
          </StatLine>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Signer key grant</h2>
            <Badge state={data.registration?.signerKeyGrantValid ? "success" : "error"}>
              {data.registration?.signerKeyGrantValid ? "Valid" : "Invalid"}
            </Badge>
          </div>
          <StatLine label="verify-signer-key-grant">
            <span className="src src-chain mono">
              {String(data.registration?.signerKeyGrantValid ?? false)}
            </span>
          </StatLine>
          <StatLine label="PoX-5 contract">
            <span className="identifier">{short(data.preflight.pox.pox5ContractId, 12, 8)}</span>
          </StatLine>
          <StatLine label="Observed at">
            <span className="mono">{number(data.preflight.node.burnBlockHeight)}</span>
          </StatLine>
          <div className="callout callout-neutral grant-note">
            <WarningCircle className="ic" />
            <div className="body">
              <strong>If the grant is revoked:</strong> new stakes and stake updates into this
              manager are blocked. Existing obligations wind down.
            </div>
          </div>
        </div>
      </div>
      <div className="section-title">Signer-set membership &amp; weight</div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Reward cycle</th>
              <th className="right">Delegated STX</th>
              <th className="right">Threshold margin</th>
              <th>Eligibility</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {cycles.map((cycle, index) => (
              <tr key={cycle.cycleId}>
                <td className="mono">
                  {cycle.cycleId} {index === 0 ? <Badge state="accent">current</Badge> : null}
                </td>
                <td className="right mono">{stx(cycle.contract.pendingStxUstx)}</td>
                <td className="right mono">{stx(cycle.threshold.marginUstx)}</td>
                <td>
                  <Badge state={cycle.contract.inSignerSet ? "success" : "error"}>
                    {cycle.contract.inSignerSet ? "Eligible" : "Below 50k"}
                  </Badge>
                </td>
                <td>
                  <span
                    className={
                      cycle.provenance.classification === "authoritative"
                        ? "src src-chain"
                        : "src src-local"
                    }
                  >
                    {cycle.provenance.classification === "authoritative"
                      ? "authoritative contract state"
                      : "contract-backed projection"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Pool({ data, token }: { data: Snapshot; token: string }) {
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
    fetch(`/api/v1/pool?${parameters}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error(`Pool API returned HTTP ${response.status}`);
        return response.json() as Promise<{ roster: RosterEntry[]; total: number }>;
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
                fetch("/api/v1/pool/roster.csv", { headers: { authorization: `Bearer ${token}` } })
                  .then((response) => response.blob())
                  .then((blob) => {
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(blob);
                    a.download = "signer-sidekick-roster.csv";
                    a.click();
                    URL.revokeObjectURL(a.href);
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
                fetch("/api/v1/pool/roster.json", {
                  headers: { authorization: `Bearer ${token}` },
                })
                  .then((response) => response.blob())
                  .then((blob) => {
                    const anchor = document.createElement("a");
                    anchor.href = URL.createObjectURL(blob);
                    anchor.download = "signer-sidekick-roster.json";
                    anchor.click();
                    URL.revokeObjectURL(anchor.href);
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
          <div className="d">unlock burn height tracked</div>
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
              <th>Unlock burn height</th>
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
                      <span className="mono">{short(entry.stakerPrincipal, 8, 5)}</span>
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
        unlock burn height.
      </p>
    </>
  );
}

function Rewards({ data, token }: { data: Snapshot; token: string }) {
  const rewards = data.rewards;
  const [activity, setActivity] = useState(data.activity);
  const [stakerPage, setStakerPage] = useState(0);
  const [claimPage, setClaimPage] = useState(0);
  const [claimCycle, setClaimCycle] = useState("");
  const [withdrawalPage, setWithdrawalPage] = useState(0);
  const [cycleHistoryPage, setCycleHistoryPage] = useState(0);
  const [cycleHistory, setCycleHistory] = useState<RewardCycleSummary[]>([]);
  const [cycleHistoryTotal, setCycleHistoryTotal] = useState(0);
  const pageSize = 50;
  const cycleHistoryPageSize = 10;
  const [rewardStakers, setRewardStakers] = useState(rewards?.stakers ?? []);
  const withdrawals = activity.withdrawals;
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({
      limit: String(pageSize),
      offset: String(stakerPage * pageSize),
    });
    fetch(`/api/v1/rewards?${query}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error(`Rewards API returned HTTP ${response.status}`);
        return response.json() as Promise<{ rewards: Snapshot["rewards"] }>;
      })
      .then((result) => setRewardStakers(result.rewards?.stakers ?? []))
      .catch((error) => {
        if ((error as Error).name !== "AbortError") console.error(error);
      });
    return () => controller.abort();
  }, [stakerPage, token]);
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({
      claimLimit: String(pageSize),
      claimOffset: String(claimPage * pageSize),
      withdrawalLimit: String(pageSize),
      withdrawalOffset: String(withdrawalPage * pageSize),
    });
    if (claimCycle) query.set("rewardCycle", claimCycle);
    fetch(`/api/v1/activity?${query}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error(`Activity API returned HTTP ${response.status}`);
        return response.json() as Promise<Snapshot["activity"]>;
      })
      .then(setActivity)
      .catch((error) => {
        if ((error as Error).name !== "AbortError") console.error(error);
      });
    return () => controller.abort();
  }, [claimCycle, claimPage, token, withdrawalPage]);
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({
      limit: String(cycleHistoryPageSize),
      offset: String(cycleHistoryPage * cycleHistoryPageSize),
    });
    fetch(`/api/v1/rewards/history?${query}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error(`Reward history API returned HTTP ${response.status}`);
        return response.json() as Promise<{ items: RewardCycleSummary[]; total: number }>;
      })
      .then((result) => {
        setCycleHistory(result.items);
        setCycleHistoryTotal(result.total);
      })
      .catch((error) => {
        if ((error as Error).name !== "AbortError") console.error(error);
      });
    return () => controller.abort();
  }, [cycleHistoryPage, token]);
  return (
    <>
      <PageHead
        title="Rewards"
        lede={`The sBTC pipeline for cycle ${rewards?.rewardCycle ?? data.preflight.cycle.currentId} — calculate, claim into the manager, pay stakers, settle L1 withdrawals.`}
      />
      <div className="card-standout pipeline-wrap">
        <div className="pipeline">
          <PipelineStage
            done={BigInt(rewards?.global.lastRewardComputeBurnHeight ?? 0) > 0n}
            title="Global calculated"
            value={`#${number(rewards?.global.lastRewardComputeBurnHeight)}`}
            detail="last compute height"
          />
          <PipelineStage
            done={BigInt(rewards?.global.signerEarnedBeforeManagerClaimSats ?? 0) === 0n}
            title="Manager claimed"
            value={`${sbtc(rewards?.global.signerEarnedBeforeManagerClaimSats)} sBTC`}
            detail="currently earned"
          />
          <PipelineStage
            done={(rewards?.totals.actionableClaims ?? 0) === 0}
            title="Stakers paid"
            value={`${activity.claimTotal} recorded`}
            detail={`${rewards?.totals.actionableClaims ?? 0} actionable`}
          />
          <PipelineStage
            done={activity.pendingWithdrawalTotal === 0}
            title="L1 settled"
            value={`${activity.withdrawalTotal - activity.pendingWithdrawalTotal} / ${activity.withdrawalTotal}`}
            detail="event-derived"
          />
        </div>
      </div>
      <div className="grid cols-2 reward-ledger">
        <div className="card">
          <div className="card-head">
            <h2>Reward ledger</h2>
          </div>
          <StatLine label="Gross currently claimable">
            <span className="btc-value src src-chain">{sbtc(rewards?.totals.grossSats)} sBTC</span>
          </StatLine>
          <StatLine label="Staker net">
            <span className="mono">{sbtc(rewards?.totals.earnedSats)} sBTC</span>
          </StatLine>
          <StatLine label="Fee">
            <span className="mono">{sbtc(rewards?.totals.feeSats)} sBTC</span>
          </StatLine>
          <StatLine label="Configured fee · current">
            <span className="mono src src-chain">
              {Number(rewards?.manager.configuredFeeBips ?? 0) / 100}%
            </span>
          </StatLine>
          <StatLine label={`Effective fee · cycle ${rewards?.rewardCycle ?? "—"}`}>
            <span className="mono src src-chain">
              {rewards?.manager.feeSnapshotBips === null || !rewards
                ? "Not snapshotted"
                : `${Number(rewards.manager.feeSnapshotBips) / 100}%`}
            </span>
          </StatLine>
          <p className="tertiary balance-note">
            The effective cycle fee is fixed on the manager's first claim. A real 0% snapshot is
            shown as 0%; a missing snapshot is shown separately.
          </p>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Balance &amp; liability</h2>
            <Badge state="neutral">contract state</Badge>
          </div>
          <StatLine label="Unclaimed staker rewards">
            <span className="mono">{sbtc(rewards?.manager.unclaimedStakerRewardsSats)} sBTC</span>
          </StatLine>
          <StatLine label="Earned fees">
            <span className="mono">{sbtc(rewards?.manager.earnedFeesSats)} sBTC</span>
          </StatLine>
          <StatLine label="Withdrawal liability">
            <span className="mono">{sbtc(rewards?.manager.withdrawalLiabilitySats)} sBTC</span>
          </StatLine>
          <p className="tertiary balance-note">
            Pending L1 withdrawals have already left the manager. Liability is tracked separately
            and is not added to expected cash.
          </p>
        </div>
      </div>
      <div className="section-title">Reward cycle ledger</div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Cycle</th>
              <th>Status</th>
              <th className="right">Stakers</th>
              <th className="right">Gross</th>
              <th className="right">Net</th>
              <th className="right">Fee</th>
              <th className="right">Configured fee</th>
              <th className="right">Effective fee</th>
              <th className="right">Actionable</th>
              <th>Observed burn block</th>
            </tr>
          </thead>
          <tbody>
            {cycleHistory.map((cycle) => (
              <tr key={cycle.rewardCycle}>
                <td className="mono">{cycle.rewardCycle}</td>
                <td>
                  <Badge state={cycle.status === "ready" ? "success" : "caution"}>
                    {cycle.status}
                  </Badge>
                </td>
                <td className="right mono">{number(cycle.stakerCount)}</td>
                <td className="right mono">{sbtc(cycle.grossSats)}</td>
                <td className="right mono">{sbtc(cycle.earnedSats)}</td>
                <td className="right mono">{sbtc(cycle.feeSats)}</td>
                <td className="right mono">
                  {cycle.configuredFeeBips === null
                    ? "—"
                    : `${Number(cycle.configuredFeeBips) / 100}%`}
                </td>
                <td className="right mono">
                  {cycle.feeSnapshotBips === null
                    ? "Not snapshotted"
                    : `${Number(cycle.feeSnapshotBips) / 100}%`}
                </td>
                <td className="right mono">{number(cycle.actionableClaims)}</td>
                <td className="mono">{number(cycle.observedBurnBlockHeight)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {cycleHistory.length === 0 ? (
          <div className="empty-table">No retained reward cycle snapshots yet</div>
        ) : null}
        <Pagination
          page={cycleHistoryPage}
          pageSize={cycleHistoryPageSize}
          total={cycleHistoryTotal}
          setPage={setCycleHistoryPage}
        />
      </div>
      <div className="section-title">Per-staker claims</div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Staker</th>
              <th className="right">Gross</th>
              <th className="right">Fee</th>
              <th className="right">Net</th>
              <th>Destination</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rewardStakers.map((entry) => (
              <tr key={entry.stakerPrincipal}>
                <td className="mono">{short(entry.stakerPrincipal, 8, 5)}</td>
                <td className="right mono">{sbtc(entry.rewards.grossSats)}</td>
                <td className="right mono">{sbtc(entry.rewards.feeSats)}</td>
                <td className="right mono">{sbtc(entry.rewards.earnedSats)}</td>
                <td>
                  <Badge state="neutral">
                    {entry.payout.kind === "bitcoin-l1" ? "Bitcoin L1" : "Direct sBTC"}
                  </Badge>
                </td>
                <td>
                  <Badge state={entry.claimableByPolicy ? "info" : "neutral"}>
                    {entry.claimableByPolicy ? "Claimable" : "No action"}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pagination
          page={stakerPage}
          pageSize={pageSize}
          total={rewards?.totals.stakers ?? 0}
          setPage={setStakerPage}
        />
      </div>
      <div className="section-title split-title">
        <span>Claim history</span>
        <label className="cycle-filter">
          <span>Reward cycle</span>
          <select
            value={claimCycle}
            onChange={(event) => {
              setClaimCycle(event.target.value);
              setClaimPage(0);
            }}
          >
            <option value="">All cycles</option>
            {Array.from(
              { length: Math.min(96, data.preflight.cycle.currentId + 1) },
              (_, index) => data.preflight.cycle.currentId - index,
            ).map((cycle) => (
              <option key={cycle} value={cycle}>
                {cycle}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Cycle</th>
              <th>Staker</th>
              <th className="right">Amount</th>
              <th>Destination</th>
              <th>Block</th>
              <th>Transaction</th>
            </tr>
          </thead>
          <tbody>
            {activity.claims.map((claim) => (
              <tr key={`${claim.txId}:${claim.eventIndex}`}>
                <td className="mono">{claim.rewardCycle}</td>
                <td className="mono">{short(claim.stakerPrincipal)}</td>
                <td className="right mono btc-value">{sbtc(claim.amountSats)}</td>
                <td>
                  <Badge state="neutral">
                    {claim.destination === "bitcoin-l1" ? "Bitcoin L1" : "Direct sBTC"}
                  </Badge>
                </td>
                <td className="mono">{number(claim.blockHeight)}</td>
                <td className="mono">{short(claim.txId)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {activity.claims.length === 0 ? (
          <div className="empty-table">No claims recorded for this cycle</div>
        ) : null}
        <Pagination
          page={claimPage}
          pageSize={pageSize}
          total={activity.claimTotal}
          setPage={setClaimPage}
        />
      </div>
      <div className="section-title">L1 withdrawal queue</div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Request ID</th>
              <th>Staker</th>
              <th className="right">Amount</th>
              <th className="right">Max fee</th>
              <th>Manager state</th>
              <th>Initiated</th>
            </tr>
          </thead>
          <tbody>
            {withdrawals.map((entry) => (
              <tr key={entry.requestId}>
                <td className="mono">#{entry.requestId}</td>
                <td className="mono">{short(entry.stakerPrincipal)}</td>
                <td className="right mono btc-value">{sbtc(entry.amountSats)}</td>
                <td className="right mono">{sbtc(entry.maxFeeSats)}</td>
                <td>
                  <Badge state={entry.state === "pending" ? "caution" : "success"}>
                    {entry.state}
                  </Badge>
                </td>
                <td className="mono">{number(entry.initiatedBlockHeight)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {withdrawals.length === 0 ? (
          <div className="empty-table">No L1 withdrawal requests indexed</div>
        ) : null}
        <Pagination
          page={withdrawalPage}
          pageSize={pageSize}
          total={activity.withdrawalTotal}
          setPage={setWithdrawalPage}
        />
      </div>
    </>
  );
}

function Operations({ data }: { data: Snapshot }) {
  return (
    <>
      <PageHead
        title="Operations"
        lede="Current ingestion, alerts, and environment state. Transaction automation remains disabled until a gas-payer policy is configured and reviewed."
      />
      <div className="card-standout operation-mode">
        <div>
          <span className="muted">Automation mode</span>
          <h2>
            <Eye /> Observe
          </h2>
        </div>
        <div>
          <span className="muted">Circuit breaker</span>
          <p>
            <Badge state={data.preflight.status === "fail" ? "error" : "success"}>
              {data.preflight.status === "fail" ? "Open" : "Closed"}
            </Badge>
          </p>
        </div>
        <div>
          <span className="muted">Ingestion</span>
          <p>
            <Badge state={data.forecast?.ingestion ? "success" : "caution"}>
              {data.forecast?.ingestion ? "Synchronized" : "Not run"}
            </Badge>
          </p>
        </div>
        <p className="tertiary">
          Observe ingests, reconciles, displays, and alerts. It never signs or broadcasts.
          Admin-only calls always remain offline.
        </p>
      </div>
      <div className="grid cols-2 operation-grid">
        <div className="card">
          <div className="card-head">
            <h2>Alerts</h2>
            <span className="muted">{data.alerts.length} active</span>
          </div>
          {data.alerts.map((alert) => (
            <div className="alert-row" key={alert.id}>
              <span className={`sev sev-${alert.severity}`} />
              <div className="body">
                <div className="t">{alert.title}</div>
                <div className="m">{alert.detail}</div>
              </div>
              <div className="meta">{alert.severity}</div>
            </div>
          ))}
          {data.alerts.length === 0 ? <p className="muted">No active alerts.</p> : null}
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Ingestion evidence</h2>
          </div>
          <StatLine label="Roster">
            <span className="src src-api">{data.rosterTotal ?? data.roster.length} stakers</span>
          </StatLine>
          <StatLine label="Manager events">
            <span className="src src-api">{data.activity.eventCount}</span>
          </StatLine>
          <StatLine label="Latest event block">
            <span className="mono">{number(data.activity.latestBlockHeight)}</span>
          </StatLine>
          <StatLine label="Last roster sync">
            <span className="mono">
              {data.forecast?.ingestion
                ? new Date(data.forecast.ingestion.completedAt).toLocaleString()
                : "never"}
            </span>
          </StatLine>
        </div>
      </div>
      <div className="section-title">
        Environment <span className="hint">polled live and verified</span>
      </div>
      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">
            <h2>Stacks node</h2>
            <Badge state={data.preflight.status === "fail" ? "error" : "success"}>Live</Badge>
          </div>
          <StatLine label="Profile">
            <span className="src src-chain">stacks-core 4.0.0</span>
          </StatLine>
          <StatLine label="Network">
            <span className="mono">
              {data.network} · {data.preflight.node.networkId}
            </span>
          </StatLine>
          <StatLine label="Burn tip">
            <span className="mono src src-chain">
              {number(data.preflight.node.burnBlockHeight)}
            </span>
          </StatLine>
          <StatLine label="RPC endpoint">
            <span className="identifier">
              {data.config?.nodeRpcUrl ?? "configured server-side"}
            </span>
          </StatLine>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>stacks-signer</h2>
            <Badge state="neutral">Endpoint not configured</Badge>
          </div>
          <StatLine label="Scope">
            <span>version + liveness only</span>
          </StatLine>
          <StatLine label="Signing health">
            <span className="muted">deferred to v2</span>
          </StatLine>
          <p className="tertiary signer-note">
            The exact signer endpoint and version field remain a GA confirmation item. Sidekick does
            not guess or probe signer internals.
          </p>
        </div>
      </div>
      <p className="tertiary environment-note">
        Connected API: <span className="mono">{data.preflight.api.serverVersion}</span> ·{" "}
        {data.preflight.api.burnBlockLag} block lag.
      </p>
    </>
  );
}

function Setup({ data }: { data: Snapshot }) {
  const checks = data.setup?.checks ?? data.preflight.checks;
  return (
    <>
      <PageHead
        title="Initial Setup"
        lede="Guided path to a verified manager registration. Sidekick prepares manifests and verifies results — it never holds your admin or signer key."
        actions={
          <div className="seg">
            <button type="button" className="on">
              Attach existing
            </button>
            <button type="button">Fresh setup</button>
          </div>
        }
      />
      <div className="wizard">
        <div className="steps">
          {[
            "Prerequisites",
            "Manager artifact",
            "Deploy manager",
            "Signer grant ceremony",
            "Register manager",
            "Pool policy",
            "Automation identity",
            "Final verification",
          ].map((label, index) => {
            const done = index < 2 && data.manager.attachAllowed;
            const active = index === (data.setup?.status === "ready" ? 7 : 0);
            return (
              <div className={`step ${done ? "done" : ""} ${active ? "active" : ""}`} key={label}>
                <span className="num">{done ? <Check /> : index + 1}</span>
                <span className="lbl">
                  {label}
                  <small>{done ? "verified" : active ? "review current checks" : "pending"}</small>
                </span>
              </div>
            );
          })}
        </div>
        <div>
          <div className="card-standout">
            <div className="card-head">
              <h2>Attach verification</h2>
              <Badge
                state={
                  data.setup?.status === "ready"
                    ? "success"
                    : data.setup?.status === "blocked"
                      ? "error"
                      : "caution"
                }
              >
                {data.setup?.status ?? "Preflight"}
              </Badge>
            </div>
            <p className="muted setup-copy">
              The existing manager is never redeployed or replaced. Sidekick compares its source and
              interface, then verifies registration, grant, and eligibility.
            </p>
            <div className="checklist">
              {checks.map((check) => (
                <div className="check-item" key={check.id}>
                  <span
                    className={`box ${check.status === "pass" ? "ok" : check.status === "fail" ? "bad" : "wait"}`}
                  >
                    {check.status === "pass" ? <Check /> : <Warning />}
                  </span>
                  <div className="body">
                    <strong>{check.id.replaceAll("-", " ")}</strong>
                    <div className="m">{check.message}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="callout callout-neutral setup-note">
            <ShieldCheck className="ic" />
            <div className="body">
              Fresh setup commands remain CLI-first: render the pinned artifact, generate the signer
              grant on the signer host, then verify the externally broadcast registration.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Settings({
  data,
  theme,
  setTheme,
}: {
  data: Snapshot;
  theme: "light" | "dark";
  setTheme: (theme: "light" | "dark") => void;
}) {
  return (
    <>
      <PageHead
        title="Settings"
        lede="Ongoing configuration for this deployment. Secret values are never returned to the browser."
      />
      <div className="grid cols-1-2 settings-grid">
        <nav className="set-nav">
          <a className="active" href="#identity">
            Pool identity
          </a>
          <a href="#sources">Data sources</a>
          <a href="#display">Display</a>
          <a href="#security">Access &amp; security</a>
        </nav>
        <div>
          <div className="card-standout set-section" id="identity">
            <div className="card-head">
              <h2>Pool identity</h2>
              <Badge state="neutral">read-only</Badge>
            </div>
            <div className="field">
              <label htmlFor="manager-principal">Manager principal</label>
              <input
                id="manager-principal"
                className="input mono"
                readOnly
                value={data.managerPrincipal}
              />
            </div>
            <div className="field">
              <label htmlFor="pool-display-name">Display name</label>
              <input id="pool-display-name" className="input" readOnly value="Stacks Pool" />
              <div className="help">
                Configure the local display label server-side in the current build.
              </div>
            </div>
          </div>
          <div className="card-standout set-section" id="sources">
            <div className="card-head">
              <h2>
                <Plugs /> Data sources
              </h2>
              <Badge state={data.preflight.status === "fail" ? "error" : "success"}>
                Connected
              </Badge>
            </div>
            <ReadOnlyField
              label="Stacks node RPC URL"
              value={data.config?.nodeRpcUrl ?? "configured server-side"}
              help="Authoritative for actionable state."
            />
            <ReadOnlyField
              label="Stacks API base URL"
              value={data.config?.apiUrl ?? "configured server-side"}
              help={`${data.preflight.api.serverVersion} · ${data.preflight.api.burnBlockLag} block lag`}
            />
            <ReadOnlyField
              label="API key"
              value={data.config?.apiKeyConfigured ? "Configured" : "Not configured"}
              help="Stored server-side and never returned to the browser."
            />
          </div>
          <div className="card-standout set-section" id="display">
            <div className="card-head">
              <h2>Display preferences</h2>
            </div>
            <div className="field">
              <span className="field-label">Default theme</span>
              <div className="seg">
                <button
                  type="button"
                  className={theme === "light" ? "on" : ""}
                  onClick={() => setTheme("light")}
                >
                  Light
                </button>
                <button
                  type="button"
                  className={theme === "dark" ? "on" : ""}
                  onClick={() => setTheme("dark")}
                >
                  Dark
                </button>
              </div>
            </div>
            <div className="field">
              <label htmlFor="forecast-horizon">Forecast horizon</label>
              <div className="input-group">
                <input
                  id="forecast-horizon"
                  readOnly
                  value={data.config?.forecastHorizonCycles ?? 6}
                />
                <span className="suffix">cycles</span>
              </div>
            </div>
          </div>
          <div className="card set-section" id="security">
            <div className="card-head">
              <h2>Access &amp; security</h2>
            </div>
            <StatLine label="HTTP bind">
              <span className="mono">127.0.0.1 · loopback</span>
            </StatLine>
            <StatLine label="Operator session">
              <span>Bearer credential · browser session only</span>
            </StatLine>
            <div className="callout callout-critical security-note">
              <Key className="ic" />
              <div className="body">
                <strong>Never configurable here.</strong> Manager admin and signer private keys are
                not accepted. Sidekick has no public pool HTTP surface.
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function ReadOnlyField({ label, value, help }: { label: string; value: string; help: string }) {
  return (
    <div className="field">
      <label>
        {label}
        <input className="input mono" readOnly value={value} />
      </label>
      <div className="help">{help}</div>
    </div>
  );
}

function Enrollment({ data }: { data: Snapshot }) {
  const [mode, setMode] = useState<"live" | "static">("live");
  const current = data.forecast?.cycles[0];
  const publicApiUrl =
    data.network === "mainnet" ? "https://api.mainnet.hiro.so" : "https://api.testnet.hiro.so";
  const payload = {
    schema: "stacks-pool-card/v1",
    generatedAtBurnHeight: data.preflight.node.burnBlockHeight,
    manager: data.managerPrincipal,
    network: data.network,
    signerKey: data.registration?.signerKeyHex,
    grantValid: data.registration?.signerKeyGrantValid,
    sourceHash: data.manager.source.sha256,
    cycle: data.preflight.cycle.currentId,
    poolUstx: current?.contract.pendingStxUstx,
    aboveThreshold: current?.threshold.meetsThreshold,
  };
  const staticCode = JSON.stringify(payload, null, 2);
  const liveCode = `<!-- Signer Sidekick PoX-5 pool card. Host this file on your own site. -->\n<div class="stx-pool-card" data-manager="${data.managerPrincipal}">\n  <strong>Stacks Pool</strong>\n  <code>${data.managerPrincipal}</code>\n  <span>Cycle ${data.preflight.cycle.currentId} · ${stx(current?.contract.pendingStxUstx)} STX</span>\n</div>\n<script>\nfetch("${publicApiUrl}/v2/pox")\n  .then(r => r.json())\n  .then(pox => document.querySelector(".stx-pool-card span").dataset.cycle = pox.reward_cycle_id);\n</script>`;
  const code = mode === "live" ? liveCode : staticCode;
  return (
    <>
      <PageHead
        title="Public Pool Page"
        lede="Generate an embeddable pool card for a website you already run. Sidekick hosts nothing and opens no public route."
      />
      <div className="callout callout-info intro-callout">
        <ShieldCheck className="ic" />
        <div className="body">
          <strong>No public surface on this app.</strong> The generated artifact contains public
          manager and pool facts only. It never includes the API key, gas payer, jobs, alerts, or
          local database state.
        </div>
      </div>
      <div className="card-standout embed-mode">
        <div>
          <span className="muted">Embed type</span>
          <div className="seg">
            <button
              type="button"
              className={mode === "live" ? "on" : ""}
              onClick={() => setMode("live")}
            >
              Live card
            </button>
            <button
              type="button"
              className={mode === "static" ? "on" : ""}
              onClick={() => setMode("static")}
            >
              Static snapshot
            </button>
          </div>
        </div>
        <p className="tertiary">
          {mode === "live"
            ? "Fetches the public PoX cycle at view time; pool identity and verified snapshot values remain baked in."
            : "Versioned JSON with the current verified values, for a fully static integration."}
        </p>
      </div>
      <div className="grid cols-3-2 embed-grid">
        <div className="card">
          <div className="card-head">
            <h2>{mode === "live" ? "Embed snippet" : "Static pool JSON"}</h2>
            <button
              type="button"
              className="btn btn-accent sm"
              onClick={() => navigator.clipboard.writeText(code)}
            >
              Copy
            </button>
          </div>
          <pre className="code">{code}</pre>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>What's in the card</h2>
          </div>
          <div className="actions-list">
            <InfoCell
              title="You maintain"
              detail="Pool name, website, support, official links, manager principal, signer public key."
            />
            <InfoCell
              title="Public chain data"
              detail="Cycle, pool size, threshold status, grant validity, fee, and source hash."
            />
            <InfoCell
              title="Never included"
              detail="Gas payer, secret keys, jobs, transactions, alerts, or the Sidekick database."
            />
          </div>
        </div>
      </div>
      <div className="section-title">Preview</div>
      <div className="preview-frame">
        <div className="pv-bar">
          <span className="mono">your-site.example / stacking</span>
          <Badge state="neutral">embedded card</Badge>
        </div>
        <div className="pv-body">
          <div className="preview-title">
            <div>
              <h2>Stacks Pool</h2>
              <p>{short(data.managerPrincipal, 14, 8)}</p>
            </div>
            <Badge state={data.registration?.signerKeyGrantValid ? "success" : "error"}>
              {data.registration?.signerKeyGrantValid ? "Grant valid" : "Grant invalid"}
            </Badge>
          </div>
          <div className="grid cols-2">
            <div className="card-standout">
              <StatLine label="Reward cycle">
                <span className="mono">{data.preflight.cycle.currentId}</span>
              </StatLine>
              <StatLine label="Pool size">
                <span className="mono">{stx(current?.contract.pendingStxUstx)} STX</span>
              </StatLine>
            </div>
            <div className="card-standout">
              <StatLine label="Threshold">
                <Badge state={current?.threshold.meetsThreshold ? "success" : "error"}>
                  {current?.threshold.meetsThreshold ? "Eligible" : "Below 50k"}
                </Badge>
              </StatLine>
              <StatLine label="Source">
                <span className="identifier">{short(data.manager.source.sha256)}</span>
              </StatLine>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function InfoCell({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="action-item">
      <div className="ic">
        <Check />
      </div>
      <div className="body">
        <div className="t">{title}</div>
        <div className="m">{detail}</div>
      </div>
    </div>
  );
}

function Login({ onLogin }: { onLogin: (token: string) => void }) {
  const [token, setToken] = useState("");
  return (
    <main className="login-shell">
      <div className="card-standout login-card">
        <div className="brand-mark">
          <ShieldCheck />
        </div>
        <p className="eyebrow">SIGNER SIDEKICK</p>
        <h1>Operator access</h1>
        <p>
          Enter the local bootstrap credential configured as{" "}
          <span className="mono">SIDEKICK_AUTH_TOKEN</span>.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (token.length >= 24) onLogin(token);
          }}
        >
          <label htmlFor="token">Operator credential</label>
          <input
            id="token"
            className="input mono"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <button className="btn btn-accent" type="submit" disabled={token.length < 24}>
            Open console
          </button>
        </form>
        <small>Stored in this browser tab only. Sidekick remains loopback-bound.</small>
      </div>
    </main>
  );
}

function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem("sidekick-token") ?? "");
  const [page, setPage] = useState<Page>(() => {
    const hash = location.hash.slice(1) as Page;
    return nav.some((item) => item.id === hash) ? hash : "overview";
  });
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const load = useCallback(
    async (force = false) => {
      if (!token) return;
      try {
        const response = await fetch(force ? "/api/v1/sync" : "/api/v1/status", {
          method: force ? "POST" : "GET",
          headers: { authorization: `Bearer ${token}` },
        });
        if (response.status === 401) {
          sessionStorage.removeItem("sidekick-token");
          setToken("");
          throw new Error("The operator credential was rejected.");
        }
        if (!response.ok) throw new Error(`Sidekick API returned HTTP ${response.status}`);
        const json = (await response.json()) as Snapshot | { snapshot: Snapshot };
        setData("snapshot" in json ? json.snapshot : json);
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [token],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    const handler = () => {
      const hash = location.hash.slice(1) as Page;
      if (nav.some((item) => item.id === hash)) setPage(hash);
    };
    addEventListener("hashchange", handler);
    return () => removeEventListener("hashchange", handler);
  }, []);
  const login = (value: string) => {
    sessionStorage.setItem("sidekick-token", value);
    setToken(value);
  };
  const sync = async () => {
    setSyncing(true);
    await load(true);
    setSyncing(false);
  };
  const content = data
    ? {
        overview: <Overview data={data} sync={sync} syncing={syncing} />,
        registration: <Registration data={data} />,
        pool: <Pool data={data} token={token} />,
        rewards: <Rewards data={data} token={token} />,
        operations: <Operations data={data} />,
        setup: <Setup data={data} />,
        enrollment: <Enrollment data={data} />,
        settings: <Settings data={data} theme={theme} setTheme={setTheme} />,
      }[page]
    : null;
  if (!token) return <Login onLogin={login} />;
  return (
    <div className="app" data-network={data?.network ?? "mainnet"}>
      <aside className="sidebar">
        <div className="brand">
          <div className="glyph">
            <StacksGlyph />
          </div>
          <div className="name">
            Signer Sidekick<small>PoX-5 · v1</small>
          </div>
        </div>
        <nav>
          {nav.map((item) =>
            item.group ? (
              <div className="nav-label" key={item.group}>
                {item.group}
              </div>
            ) : (
              <a
                className={`item ${page === item.id ? "active" : ""}`}
                href={`#${item.id}`}
                key={item.id}
              >
                {item.icon ? <item.icon /> : null}
                {item.label}
                {item.id === "operations" && data?.alerts.length ? (
                  <span className="count alert">{data.alerts.length}</span>
                ) : null}
              </a>
            ),
          )}
        </nav>
        <div className="spacer" />
        <div className="mode-card">
          <div className="l">
            <ShieldCheck /> Automation mode
          </div>
          <div className="m mode-observe">
            <span className="ind" />
            Observe
          </div>
        </div>
      </aside>
      <div className="content">
        <div className="topbar">
          <select
            aria-label="Dashboard page"
            className="mobile-page-picker"
            value={page}
            onChange={(event) => {
              location.hash = event.target.value;
            }}
          >
            {nav
              .filter((item): item is (typeof nav)[number] & { id: Page; label: string } =>
                Boolean(item.id && item.label),
              )
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
          </select>
          <div className="crumbs">
            Signer Sidekick / <strong>{nav.find((item) => item.id === page)?.label}</strong>
          </div>
          <div className="right">
            <span className={`net ${data?.network === "mainnet" ? "net-mainnet" : "net-testnet"}`}>
              <span className="dot" />
              {data?.network ?? "Connecting"}
            </span>
            <button
              type="button"
              className="chip-btn"
              aria-label="Toggle theme"
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            >
              {theme === "light" ? <Moon /> : <Sun />}
            </button>
          </div>
        </div>
        <div className={`freshness ${data?.preflight.status === "fail" ? "stale" : ""}`}>
          <span className="dot" />
          <span>{data?.preflight.status === "fail" ? "Chain sources need attention" : "Live"}</span>
          <span className="sep">·</span>
          <span className="mono">
            {data
              ? `chain tip ${number(data.preflight.node.burnBlockHeight)} · api lag ${data.preflight.api.burnBlockLag} · ${new Date(data.generatedAt).toLocaleTimeString()}`
              : "loading operator state"}
          </span>
          <span className="right">
            <span className="hint-dot-legend">
              <span className="src src-chain">contract read-only</span>
              <span className="src src-api">indexed / estimated</span>
              <span className="src src-local">locally derived</span>
            </span>
          </span>
        </div>
        <main className="main">
          {error ? (
            <div className="callout callout-critical error-banner">
              <WarningCircle className="ic" />
              <div className="body">
                <strong>Unable to load operator state</strong>
                <br />
                {error}
                <div className="actions">
                  <button
                    type="button"
                    className="btn btn-secondary sm"
                    onClick={() => void load()}
                  >
                    Retry
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          {content ??
            (!error ? (
              <div className="loading-state">
                <ArrowClockwise />
                <p>Loading operator state</p>
              </div>
            ) : null)}
        </main>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
