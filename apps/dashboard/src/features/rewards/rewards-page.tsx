import {
  activityResponseSchema,
  type DashboardSnapshot,
  type RewardCycleSummary,
  rewardHistoryResponseSchema,
  rewardsPageResponseSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { useEffect, useState } from "react";
import { apiJson } from "../../api-client.js";
import { CopyableIdentifier } from "../../copyable-identifier.js";
import { Badge, PageHead, Pagination, StatLine } from "../../shared/dashboard-ui.js";
import { number, sbtc, short } from "../../shared/format.js";
import { PipelineStage } from "../../shared/pipeline-stage.js";

type Snapshot = DashboardSnapshot;

export function Rewards({ data, token }: { data: Snapshot; token: string }) {
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
    void apiJson(token, `/api/v1/rewards?${query}`, rewardsPageResponseSchema, {
      signal: controller.signal,
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
    void apiJson(token, `/api/v1/activity?${query}`, activityResponseSchema, {
      signal: controller.signal,
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
    void apiJson(token, `/api/v1/rewards/history?${query}`, rewardHistoryResponseSchema, {
      signal: controller.signal,
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
            value={`Bitcoin block #${number(rewards?.global.lastRewardComputeBurnHeight)}`}
            detail="last reward calculation"
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
