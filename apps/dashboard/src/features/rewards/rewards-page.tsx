import { Coins, Percent } from "@phosphor-icons/react";
import {
  activityResponseSchema,
  type DashboardSnapshot,
  type RewardCycleSummary,
  rewardHistoryResponseSchema,
  rewardsPageResponseSchema,
  stakerClaimsResponseSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { useEffect, useState } from "react";
import { apiJson } from "../../api-client.js";
import { CopyableIdentifier } from "../../copyable-identifier.js";
import { dashboardHash } from "../../dashboard-route.js";
import { Badge, PageHead, Pagination, StatLine } from "../../shared/dashboard-ui.js";
import { number, sbtc, short } from "../../shared/format.js";
import { managerActionAvailability } from "../../shared/manager-action-availability.js";
import { operatorErrorDetail, operatorErrorSentence } from "../../shared/operator-error.js";
import { PipelineStage } from "../../shared/pipeline-stage.js";
import { standardManagerActionPrincipal } from "../manager/manager-action-principal.js";
import { BrowserWalletActionPanel } from "../setup/browser-wallet-action.js";

type Snapshot = DashboardSnapshot;

function RequestState({
  label,
  loading,
  error,
  retry,
}: {
  label: string;
  loading: boolean;
  error: string | null;
  retry: () => void;
}) {
  if (error) {
    return (
      <div className="callout callout-critical" role="alert">
        <div className="body">
          <strong>Could not refresh {label}.</strong> {operatorErrorSentence(error)}
          <div className="actions">
            <button type="button" className="btn btn-secondary sm" onClick={retry}>
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }
  return loading ? (
    <div className="callout callout-neutral" role="status">
      Refreshing {label}…
    </div>
  ) : null;
}

export function Rewards({
  data,
  operatorStateStale,
  token,
}: {
  data: Snapshot;
  operatorStateStale: boolean;
  token: string;
}) {
  const rewards = data.rewards;
  const [rewardsFreshness, setRewardsFreshness] = useState(data.freshness ?? null);
  const actionAvailability = managerActionAvailability(data, operatorStateStale);
  const managerActionsAvailable = actionAvailability.available;
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
  const [rewardStakerTotal, setRewardStakerTotal] = useState(rewards?.totals.stakers ?? 0);
  const [stakersLoading, setStakersLoading] = useState(true);
  const [stakersError, setStakersError] = useState<string | null>(null);
  const [stakersRetry, setStakersRetry] = useState(0);
  const [activityLoading, setActivityLoading] = useState(true);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [activityRetry, setActivityRetry] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyRetry, setHistoryRetry] = useState(0);
  const stakersRefreshKey = `${data.generatedAt}:${stakersRetry}`;
  const activityRefreshKey = `${data.generatedAt}:${activityRetry}`;
  const historyRefreshKey = `${data.generatedAt}:${historyRetry}`;
  const withdrawals = activity.withdrawals;
  useEffect(() => {
    void stakersRefreshKey;
    const controller = new AbortController();
    let correctingPage = false;
    const query = new URLSearchParams({
      limit: String(pageSize),
      offset: String(stakerPage * pageSize),
    });
    setStakersLoading(true);
    setStakersError(null);
    void apiJson(token, `/api/v1/rewards?${query}`, rewardsPageResponseSchema, {
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        const total = result.rewards?.totals.stakers ?? 0;
        const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);
        setRewardsFreshness(result.freshness ?? null);
        setRewardStakerTotal(total);
        if (stakerPage > lastPage) {
          correctingPage = true;
          setStakerPage(lastPage);
          return;
        }
        setRewardStakers(result.rewards?.stakers ?? []);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setStakersError(operatorErrorDetail(cause, "Sidekick returned no error detail"));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && !correctingPage) setStakersLoading(false);
      });
    return () => controller.abort();
  }, [stakerPage, stakersRefreshKey, token]);
  useEffect(() => {
    void activityRefreshKey;
    const controller = new AbortController();
    let correctingPage = false;
    const query = new URLSearchParams({
      claimLimit: String(pageSize),
      claimOffset: String(claimPage * pageSize),
      withdrawalLimit: String(pageSize),
      withdrawalOffset: String(withdrawalPage * pageSize),
    });
    if (claimCycle) query.set("rewardCycle", claimCycle);
    setActivityLoading(true);
    setActivityError(null);
    void apiJson(token, `/api/v1/activity?${query}`, activityResponseSchema, {
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        const lastClaimPage = Math.max(0, Math.ceil(result.claimTotal / pageSize) - 1);
        const lastWithdrawalPage = Math.max(0, Math.ceil(result.withdrawalTotal / pageSize) - 1);
        if (claimPage > lastClaimPage || withdrawalPage > lastWithdrawalPage) {
          correctingPage = true;
          if (claimPage > lastClaimPage) setClaimPage(lastClaimPage);
          if (withdrawalPage > lastWithdrawalPage) setWithdrawalPage(lastWithdrawalPage);
          return;
        }
        setActivity(result);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setActivityError(operatorErrorDetail(cause, "Sidekick returned no error detail"));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && !correctingPage) setActivityLoading(false);
      });
    return () => controller.abort();
  }, [activityRefreshKey, claimCycle, claimPage, token, withdrawalPage]);
  useEffect(() => {
    void historyRefreshKey;
    const controller = new AbortController();
    let correctingPage = false;
    const query = new URLSearchParams({
      limit: String(cycleHistoryPageSize),
      offset: String(cycleHistoryPage * cycleHistoryPageSize),
    });
    setHistoryLoading(true);
    setHistoryError(null);
    void apiJson(token, `/api/v1/rewards/history?${query}`, rewardHistoryResponseSchema, {
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        const lastPage = Math.max(0, Math.ceil(result.total / cycleHistoryPageSize) - 1);
        setCycleHistoryTotal(result.total);
        if (cycleHistoryPage > lastPage) {
          correctingPage = true;
          setCycleHistoryPage(lastPage);
          return;
        }
        setCycleHistory(result.items);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setHistoryError(operatorErrorDetail(cause, "Sidekick returned no error detail"));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && !correctingPage) setHistoryLoading(false);
      });
    return () => controller.abort();
  }, [cycleHistoryPage, historyRefreshKey, token]);
  return (
    <>
      <PageHead
        title="Rewards"
        lede={`sBTC rewards and Bitcoin withdrawals for cycle ${rewards?.rewardCycle ?? data.preflight.cycle.currentId}.`}
      />
      {rewardsFreshness?.status === "stale" ? (
        <div className="callout callout-caution" role="status">
          Showing last known reward data while Sidekick refreshes chain data.
        </div>
      ) : null}
      <div className="card-standout pipeline-wrap">
        <div className="pipeline">
          <PipelineStage
            done={
              rewards?.calculation.state === "completed" || rewards?.calculation.state === "ahead"
            }
            title="Global calculated"
            value={
              rewards?.calculation.state === "pending"
                ? "Not run yet"
                : BigInt(rewards?.global.lastRewardComputeBurnHeight ?? 0) === 0n
                  ? "Waiting"
                  : `Bitcoin block #${number(rewards?.global.lastRewardComputeBurnHeight)}`
            }
            detail={
              rewards?.calculation.state === "pending"
                ? "nobody has called calculate-rewards"
                : "last reward calculation"
            }
          />
          <PipelineStage
            done={BigInt(rewards?.global.signerEarnedAcrossBucketsSats ?? 0) === 0n}
            title="Manager claimed"
            value={`${sbtc(rewards?.global.signerEarnedAcrossBucketsSats)} sBTC`}
            detail={
              (rewards?.buckets.filter(({ bondIndex }) => bondIndex !== null).length ?? 0) > 0
                ? "earned across all buckets"
                : "currently earned"
            }
          />
          <PipelineStage
            done={(rewards?.totals.actionableClaims ?? 0) === 0}
            title="Stakers paid"
            value={`${activity.claimTotal} recorded`}
            detail={`${rewards?.totals.actionableClaims ?? 0} actionable`}
          />
          <PipelineStage
            done={activity.pendingWithdrawalTotal === 0}
            title="Bitcoin withdrawals"
            value={`${activity.withdrawalTotal - activity.pendingWithdrawalTotal} / ${activity.withdrawalTotal}`}
            detail="completed requests"
          />
        </div>
      </div>
      {rewards?.calculation.state === "pending" ? (
        <p className="tertiary balance-note" role="status">
          <strong>Waiting on the global reward calculation.</strong> PoX-5 credits nothing for cycle{" "}
          {rewards.calculation.targetRewardCycle ?? "—"} until someone calls the permissionless{" "}
          <code>calculate-rewards</code> at Bitcoin block #
          {number(String(rewards.calculation.expectedLastRewardComputeBurnHeight ?? 0))}. Sidekick
          observes that call; it does not make it.
        </p>
      ) : null}
      <StakerSettlementPanel
        chainId={data.preflight.node.networkId}
        calculationPending={rewards?.calculation.state === "pending"}
        managerPrincipal={data.managerPrincipal}
        network={data.network}
        onSettled={() => setStakersRetry((value) => value + 1)}
        token={token}
      />
      {rewards?.buckets.some(({ bondIndex }) => bondIndex !== null) ? (
        <section className="card" aria-labelledby="reward-buckets">
          <h2 id="reward-buckets">Reward buckets</h2>
          <p className="tertiary">
            PoX-5 keys rewards by bond period. A manager claim names every participating bucket in
            one transaction, which is what pins the same fee across the pool.
          </p>
          <table>
            <thead>
              <tr>
                <th scope="col">Bucket</th>
                <th scope="col">Manager shares</th>
                <th scope="col">Earned</th>
                <th scope="col">Fee snapshot</th>
                <th scope="col">In next claim</th>
              </tr>
            </thead>
            <tbody>
              {rewards.buckets.map((bucket) => (
                <tr key={bucket.bondIndex ?? "stx"}>
                  <th scope="row">
                    {bucket.bondIndex === null ? "STX-only" : `Bond period ${bucket.bondIndex}`}
                  </th>
                  <td>
                    {bucket.bondIndex === null ? "—" : `${number(bucket.managerSharesSats)} sats`}
                  </td>
                  <td>{sbtc(bucket.signerEarnedBeforeManagerClaimSats)} sBTC</td>
                  <td>
                    {bucket.feeSnapshotBips === null ? (
                      <Badge state="caution">Not pinned</Badge>
                    ) : (
                      `${bucket.feeSnapshotBips} bips`
                    )}
                  </td>
                  <td>
                    {bucket.participating ? (
                      <Badge state="success">Included</Badge>
                    ) : (
                      <Badge state="neutral">Empty</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      {!managerActionsAvailable ? (
        <p className="tertiary balance-note" role="status">
          <strong>Guided manager actions are unavailable.</strong> {actionAvailability.reason}
        </p>
      ) : null}
      {actionAvailability.warning ? (
        <p className="tertiary balance-note" role="status">
          <strong>Unverified manager source.</strong> {actionAvailability.warning}
        </p>
      ) : null}
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
                ? "Not recorded"
                : `${Number(rewards.manager.feeSnapshotBips) / 100}%`}
            </span>
          </StatLine>
          <p className="tertiary balance-note">A cycle’s fee is set by its first manager claim.</p>
          <div className="reward-admin-actions">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!managerActionsAvailable}
              onClick={() => {
                location.hash = dashboardHash("manager", "update-fees");
              }}
            >
              <Percent /> Update manager fee
            </button>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Balance &amp; liability</h2>
          </div>
          <StatLine label="Unclaimed staker rewards">
            <span className="mono">{sbtc(rewards?.manager.unclaimedStakerRewardsSats)} sBTC</span>
          </StatLine>
          <StatLine label="Earned fees">
            <span className="mono">{sbtc(rewards?.manager.earnedFeesSats)} sBTC</span>
          </StatLine>
          <StatLine label="Bitcoin withdrawal liability">
            <span className="mono">{sbtc(rewards?.manager.withdrawalLiabilitySats)} sBTC</span>
          </StatLine>
          <p className="tertiary balance-note">
            Pending Bitcoin withdrawals are shown separately and excluded from expected balance.
          </p>
          <div className="reward-admin-actions">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={
                !managerActionsAvailable || BigInt(rewards?.manager.earnedFeesSats ?? 0) === 0n
              }
              onClick={() => {
                location.hash = dashboardHash("manager", "withdraw-fees");
              }}
            >
              <Coins /> Withdraw earned fees
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!managerActionsAvailable}
              onClick={() => {
                location.hash = dashboardHash("manager", "sweep-fee-refunds");
              }}
            >
              Sweep fee refunds
            </button>
          </div>
        </div>
      </div>
      <div className="section-title">Reward cycle ledger</div>
      <RequestState
        label="reward cycle history"
        loading={historyLoading}
        error={historyError}
        retry={() => setHistoryRetry((value) => value + 1)}
      />
      <div className="tbl-wrap" aria-busy={historyLoading}>
        {!historyLoading && !historyError ? (
          <>
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
                  <th>Observed Bitcoin block</th>
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
                        ? "Not recorded"
                        : `${Number(cycle.feeSnapshotBips) / 100}%`}
                    </td>
                    <td className="right mono">{number(cycle.actionableClaims)}</td>
                    <td className="mono">{number(cycle.observedBurnBlockHeight)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {cycleHistory.length === 0 ? (
              <div className="empty-table">No reward cycle history yet</div>
            ) : null}
            <Pagination
              page={cycleHistoryPage}
              pageSize={cycleHistoryPageSize}
              total={cycleHistoryTotal}
              setPage={setCycleHistoryPage}
            />
          </>
        ) : null}
      </div>
      <div className="section-title">Per-staker claims</div>
      <RequestState
        label="per-staker rewards"
        loading={stakersLoading}
        error={stakersError}
        retry={() => setStakersRetry((value) => value + 1)}
      />
      <div className="tbl-wrap" aria-busy={stakersLoading}>
        {!stakersLoading && !stakersError ? (
          <>
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
                    <td>
                      <CopyableIdentifier
                        value={entry.stakerPrincipal}
                        display={short(entry.stakerPrincipal, 8, 5)}
                        label="staker principal"
                        className="mono"
                      />
                    </td>
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
            {rewardStakerTotal === 0 ? (
              <div className="empty-table">No per-staker rewards for this cycle</div>
            ) : null}
            <Pagination
              page={stakerPage}
              pageSize={pageSize}
              total={rewardStakerTotal}
              setPage={setStakerPage}
            />
          </>
        ) : null}
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
      <RequestState
        label="claim and withdrawal history"
        loading={activityLoading}
        error={activityError}
        retry={() => setActivityRetry((value) => value + 1)}
      />
      <div className="tbl-wrap" aria-busy={activityLoading}>
        {!activityLoading && !activityError ? (
          <>
            <table>
              <thead>
                <tr>
                  <th>Cycle</th>
                  <th>Staker</th>
                  <th className="right">Amount</th>
                  <th>Destination</th>
                  <th>Stacks block</th>
                  <th>Transaction</th>
                </tr>
              </thead>
              <tbody>
                {activity.claims.map((claim) => (
                  <tr key={`${claim.txId}:${claim.eventIndex}`}>
                    <td className="mono">{claim.rewardCycle}</td>
                    <td>
                      <CopyableIdentifier
                        value={claim.stakerPrincipal}
                        display={short(claim.stakerPrincipal)}
                        label="staker principal"
                        className="mono"
                      />
                    </td>
                    <td className="right mono btc-value">{sbtc(claim.amountSats)}</td>
                    <td>
                      <Badge state="neutral">
                        {claim.destination === "bitcoin-l1" ? "Bitcoin L1" : "Direct sBTC"}
                      </Badge>
                    </td>
                    <td className="mono">{number(claim.blockHeight)}</td>
                    <td>
                      <CopyableIdentifier
                        value={claim.txId}
                        display={short(claim.txId)}
                        label="transaction ID"
                        className="mono"
                      />
                    </td>
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
          </>
        ) : null}
      </div>
      <div className="section-title">Bitcoin withdrawal queue</div>
      {activityLoading || activityError ? (
        <p className={activityError ? "field-error" : "muted"} role="status">
          {activityLoading
            ? "Refreshing the withdrawal queue…"
            : "Withdrawal history is temporarily unavailable. Retry above."}
        </p>
      ) : null}
      <div className="tbl-wrap" aria-busy={activityLoading}>
        {!activityLoading && !activityError ? (
          <>
            <table>
              <thead>
                <tr>
                  <th>Request ID</th>
                  <th>Staker</th>
                  <th className="right">Amount</th>
                  <th className="right">Max fee</th>
                  <th>Manager state</th>
                  <th>Initiated at Stacks block</th>
                </tr>
              </thead>
              <tbody>
                {withdrawals.map((entry) => (
                  <tr key={entry.requestId}>
                    <td className="mono">#{entry.requestId}</td>
                    <td>
                      <CopyableIdentifier
                        value={entry.stakerPrincipal}
                        display={short(entry.stakerPrincipal)}
                        label="staker principal"
                        className="mono"
                      />
                    </td>
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
              <div className="empty-table">No Bitcoin withdrawal requests found</div>
            ) : null}
            <Pagination
              page={withdrawalPage}
              pageSize={pageSize}
              total={activity.withdrawalTotal}
              setPage={setWithdrawalPage}
            />
          </>
        ) : null}
      </div>
    </>
  );
}

/**
 * What settling this cycle costs, before the operator signs anything.
 *
 * `claim-staker-rewards` settles one `(staker, reward-cycle, bond-index)` per call and has no batch
 * form, so the outstanding claim count is the transaction count. Discovery is its own request
 * because it reads per staker per bucket and must not ride the operator snapshot.
 */
type StakerClaimsResponse = ReturnType<typeof stakerClaimsResponseSchema.parse>;
type StakerClaimCandidate = StakerClaimsResponse["candidates"][number];

/** Every reason mirrors a guard the wallet-intent preparation applies before building a call. */
function blockedLabel(reason: string | null): string {
  if (reason === "manager-has-not-claimed") return "Manager has not claimed this bucket";
  if (reason === "l1-below-max-fee") return "Below withdrawal fee";
  if (reason === "l1-below-dust-limit") return "Below withdrawal dust limit";
  return "Nothing settled";
}

function StakerSettlementPanel({
  chainId,
  calculationPending,
  managerPrincipal,
  network,
  onSettled,
  token,
}: {
  chainId: number;
  calculationPending: boolean;
  managerPrincipal: string;
  network: string;
  onSettled: () => void;
  token: string;
}) {
  const [selected, setSelected] = useState<StakerClaimCandidate | null>(null);
  const [actorPrincipal, setActorPrincipal] = useState("");
  // The signing account. `claim-staker-rewards` is permissionless and pays the staker named in its
  // arguments, so this only identifies who submits and pays the fee.
  const actorValid = standardManagerActionPrincipal(actorPrincipal.trim(), network);
  const [pages, setPages] = useState<StakerClaimsResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = pages.at(-1) ?? null;
  // Discovery is paged on purpose, so these are running totals over the stakers actually read.
  // Presenting them as cycle totals would understate the work on any roster past one page.
  const scanned = pages.reduce((total, page) => total + page.settlement.stakersScanned, 0);
  const stakersTotal = latest?.page.stakersTotal ?? 0;
  const transactionCount = pages.reduce(
    (total, page) => total + page.settlement.transactionCount,
    0,
  );
  const blockedClaims = pages.reduce((total, page) => total + page.settlement.blockedClaims, 0);
  const totalNetSats = pages
    .reduce((total, page) => total + BigInt(page.settlement.totalNetSats), 0n)
    .toString();
  const complete = latest !== null && latest.page.nextCursor === null;
  const candidates = pages.flatMap(({ candidates: pageCandidates }) => pageCandidates);
  // A zero-reward tuple is neither actionable nor a blocked obligation. Avoid rendering an
  // O(stakers) table of those rows, while keeping every payable or genuinely blocked tuple visible.
  const candidatesWithDetails = candidates.filter(
    (candidate) => candidate.claimable || candidate.blockedReason !== "nothing-settled",
  );

  const load = (cursor: string | null): void => {
    setLoading(true);
    setError(null);
    const query = cursor === null ? "" : `?offset=${cursor}`;
    void apiJson(token, `/api/v1/rewards/staker-claims${query}`, stakerClaimsResponseSchema)
      .then((value) => setPages((previous) => (cursor === null ? [value] : [...previous, value])))
      .catch((cause: unknown) => setError(operatorErrorSentence(cause)))
      .finally(() => setLoading(false));
  };

  return (
    <section className="card reward-settlement" aria-labelledby="staker-settlement">
      <h2 id="staker-settlement">Settle staker rewards</h2>
      {calculationPending ? (
        <p className="tertiary" role="status">
          Staker rewards become available after the global calculation runs. Sidekick observes that
          permissionless call and will list payable rewards once it is confirmed.
        </p>
      ) : (
        <>
          <p className="tertiary">
            Each settleable staker and bucket is its own transaction; the reference manager offers
            no way to combine them. Sidekick lists only the calls the manager would accept.
          </p>
          {latest ? (
            <>
              <div className="stat-row">
                <StatLine label={complete ? "Transactions to sign" : "Transactions so far"}>
                  {transactionCount}
                </StatLine>
                <StatLine label={complete ? "Total payout" : "Payout so far"}>
                  {sbtc(totalNetSats)} sBTC
                </StatLine>
                <StatLine label="Owed but not sendable">{blockedClaims}</StatLine>
                <StatLine label="Stakers scanned">
                  {scanned} of {stakersTotal}
                </StatLine>
              </div>
              {!complete ? (
                <p className="tertiary" role="status">
                  These are running totals for the {scanned} staker{scanned === 1 ? "" : "s"}{" "}
                  scanned so far, not the whole cycle. Keep scanning to see what settling the pool
                  costs.
                </p>
              ) : null}
              {candidatesWithDetails.length > 0 ? (
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Staker</th>
                      <th scope="col">Bucket</th>
                      <th scope="col">Payout</th>
                      <th scope="col">Route</th>
                      <th scope="col">Status</th>
                      <th scope="col">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidatesWithDetails.map((candidate) => (
                      <tr key={`${candidate.stakerPrincipal}:${candidate.bondIndex ?? "stx"}`}>
                        <td>
                          <CopyableIdentifier
                            value={candidate.stakerPrincipal}
                            display={short(candidate.stakerPrincipal, 8, 5)}
                            label="staker principal"
                            className="mono"
                          />
                        </td>
                        <td>
                          {candidate.bondIndex === null
                            ? "STX-only"
                            : `Bond ${candidate.bondIndex}`}
                        </td>
                        <td className="mono">{sbtc(candidate.rewards.earnedSats)}</td>
                        <td>
                          {candidate.payout.kind === "bitcoin-l1" ? "Bitcoin L1" : "Direct sBTC"}
                        </td>
                        <td>
                          {candidate.claimable ? (
                            <Badge state="success">Ready</Badge>
                          ) : (
                            <Badge state="neutral">{blockedLabel(candidate.blockedReason)}</Badge>
                          )}
                        </td>
                        <td>
                          {candidate.claimable ? (
                            <button
                              type="button"
                              className="btn btn-secondary sm"
                              onClick={() => setSelected(candidate)}
                            >
                              Settle
                            </button>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="empty-table">
                  {complete
                    ? "No staker rewards are settleable for this cycle"
                    : `No payable or blocked rewards in the ${scanned} stakers scanned so far`}
                </div>
              )}
            </>
          ) : null}
          {selected ? (
            <div className="card-standout">
              <h3>
                Settle {short(selected.stakerPrincipal, 8, 5)} ·{" "}
                {selected.bondIndex === null ? "STX-only" : `bond ${selected.bondIndex}`}
              </h3>
              <p className="tertiary">
                One transaction settles this tuple. The call pays the staker named in its arguments,
                not the signer, and the postcondition pins the manager's exact sBTC outflow.
              </p>
              <label htmlFor="staker-claim-actor">Signing account</label>
              <input
                id="staker-claim-actor"
                value={actorPrincipal}
                onChange={(event) => setActorPrincipal(event.target.value)}
                placeholder="SP..."
                className="mono"
              />
              {actorPrincipal.trim() !== "" && !actorValid ? (
                <span className="tertiary">
                  Enter a valid Stacks account principal for this network.
                </span>
              ) : null}
              {actorValid ? (
                <BrowserWalletActionPanel
                  key={`${selected.stakerPrincipal}:${selected.bondIndex ?? "stx"}`}
                  chainId={chainId}
                  createRequest={{
                    action: "claim-staker-rewards",
                    actorPrincipal: actorPrincipal.trim(),
                    stakerPrincipal: selected.stakerPrincipal,
                    rewardCycle: String(latest?.rewardCycle ?? 0),
                    bondIndex: selected.bondIndex,
                  }}
                  intentApiBase="/api/v1/wallet-intents"
                  managerPrincipal={managerPrincipal}
                  network={network}
                  onVerified={() => {
                    setSelected(null);
                    setPages([]);
                    onSettled();
                  }}
                  token={token}
                />
              ) : null}
              <button
                type="button"
                className="btn btn-tertiary sm"
                onClick={() => setSelected(null)}
              >
                Cancel
              </button>
            </div>
          ) : null}
          <RequestState
            label="settlement plan"
            loading={loading}
            error={error}
            retry={() => load(latest?.page.nextCursor ?? null)}
          />
          {!loading && !error && latest && !complete ? (
            <button
              type="button"
              className="btn btn-secondary sm"
              onClick={() => load(latest.page.nextCursor)}
            >
              Scan the next {latest.page.limit} stakers
            </button>
          ) : null}
          {pages.length === 0 && !loading && !error ? (
            <button type="button" className="btn btn-secondary sm" onClick={() => load(null)}>
              Check what settling this cycle costs
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
