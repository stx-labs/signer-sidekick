import { Coins, Percent } from "@phosphor-icons/react";
import {
  type DashboardSnapshot,
  type RewardCalculationRealization,
  type RewardCycleSummary,
  rewardHistoryResponseSchema,
  rewardsActivityResponseSchema,
  rewardsPageResponseSchema,
  stakerClaimsResponseSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { useEffect, useMemo, useState } from "react";
import { apiJson } from "../../api-client.js";
import { CopyableIdentifier } from "../../copyable-identifier.js";
import { actionHash, type DomainSection } from "../../dashboard-route.js";
import {
  Badge,
  PageHead,
  Pagination,
  SortableHeader,
  StatLine,
  type TableSort,
} from "../../shared/dashboard-ui.js";
import { useDomainSection } from "../../shared/domain-section.js";
import { number, sbtc, short } from "../../shared/format.js";
import { managerActionAvailability } from "../../shared/manager-action-availability.js";
import { operatorErrorDetail, operatorErrorSentence } from "../../shared/operator-error.js";
import { PipelineStage } from "../../shared/pipeline-stage.js";
import { rewardManagerCapabilityId } from "./reward-action-capabilities.js";

type Snapshot = DashboardSnapshot;
type BucketSort = "bucket" | "shares" | "earned" | "fee" | "included";
type RewardHistorySort =
  | "cycle"
  | "status"
  | "stakers"
  | "gross"
  | "net"
  | "fee"
  | "configured-fee"
  | "effective-fee"
  | "actionable"
  | "bitcoin-block";
type RewardStakerSort = "staker" | "gross" | "fee" | "net" | "destination" | "status";
type ClaimSort = "cycle" | "staker" | "amount" | "destination" | "block" | "transaction";
type WithdrawalSort = "request" | "staker" | "amount" | "max-fee" | "state" | "block";

const rewardTerms = {
  network:
    "Total sBTC accumulated by PoX-5 for the next network calculation, shared across eligible signers and pools.",
  pool: "Estimated amount allocated to this signer-manager before operator fees.",
  fee: "Estimated portion earned by this pool operator, using per-staker and per-bucket integer rounding.",
  net: "Estimated amount remaining for this pool's stakers after operator fees.",
  payout:
    "Stakers whose settled reward bucket can be paid after the manager claim, fee, and dust checks.",
} as const;

function RewardTerm({ label, help }: { label: string; help: string }) {
  return (
    <button
      aria-label={`${label}: ${help}`}
      className="tooltip-trigger reward-term"
      data-tooltip={help}
      type="button"
    >
      {label}
    </button>
  );
}

function subtractSats(gross: string | null, fee: string | null): string | null {
  if (gross === null || fee === null) return null;
  return (BigInt(gross) - BigInt(fee)).toString();
}

function poolEstimateUnavailableDetail(
  reason: NonNullable<DashboardSnapshot["rewardOutlook"]>["poolEstimateUnavailableReason"],
): string {
  switch (reason) {
    case "chain-anchor-unavailable":
      return "A stable local-node anchor is required.";
    case "calculation-target-unavailable":
      return "PoX-5 does not expose a valid next calculation target at this anchor.";
    case "incomplete-active-bond-state":
      return "The complete active bond set could not be proven at this anchor.";
    case "anchored-inputs-unavailable":
      return "One or more anchored share inputs could not be read from the local node.";
    case "contract-simulation-failed":
      return "The observed inputs could not produce a valid PoX-5 integer calculation.";
    case null:
      return "The current pool estimate is unavailable.";
  }
}

function rewardForecastUnavailableDetail(
  reason: NonNullable<DashboardSnapshot["rewardOutlook"]>["forecastUnavailableReason"],
): string {
  switch (reason) {
    case "chain-anchor-unavailable":
      return "A stable local-node anchor is required.";
    case "calculation-target-unavailable":
      return "PoX-5 does not expose a valid next calculation target at this anchor.";
    case "current-pool-estimate-unavailable":
      return "The current anchored pool inputs are incomplete.";
    case "insufficient-samples":
      return "Sidekick is collecting enough observed accrual history to project the next allocation. The first PoX-5 calculation requires at least 24 Bitcoin blocks of observations.";
    case "non-monotonic-accrual":
      return "The cumulative reward balance changed unexpectedly inside this interval.";
    case "forecast-inputs-unavailable":
      return "The durable observation window could not be read safely.";
    case "contract-simulation-failed":
      return "A projected bound could not produce a valid PoX-5 integer calculation.";
    case null:
      return "The checkpoint forecast is unavailable.";
  }
}

function compareSortValues(
  left: bigint | number | string | boolean | null,
  right: bigint | number | string | boolean | null,
  direction: "asc" | "desc",
): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  const compared = left < right ? -1 : left > right ? 1 : 0;
  return direction === "asc" ? compared : -compared;
}

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
      <div className="callout callout-critical content-notice" role="alert">
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
    <div className="callout callout-neutral content-notice" role="status">
      Refreshing {label}…
    </div>
  ) : null;
}

export function Rewards({
  data,
  operatorStateStale,
  section,
  token,
}: {
  data: Snapshot;
  operatorStateStale: boolean;
  section: DomainSection | null;
  token: string;
}) {
  useDomainSection("rewards", section);
  const rewards = data.rewards;
  const rewardOutlook = data.rewardOutlook ?? null;
  const calculation = rewardOutlook?.calculation ?? rewards?.calculation ?? null;
  const calculationGrace = calculation?.next?.grace ?? null;
  const calculationActionAvailable =
    calculationGrace?.state === "action-required" && !operatorStateStale;
  const calculationNeedsAttention =
    calculationGrace?.state === "action-required" && operatorStateStale;
  const globalAccruedSats =
    rewardOutlook?.accrued.globalSats ?? rewards?.global.globalAccruedRewardsSats ?? null;
  const poolEstimate = rewardOutlook?.poolEstimate ?? null;
  const rewardForecast = rewardOutlook?.forecast ?? null;
  const operatorFeeForecast = rewardOutlook?.operatorFeeForecast ?? null;
  const operatorFeeEstimate = rewardOutlook?.operatorFeeEstimate ?? null;
  const rewardCalibration = rewardOutlook?.calibration ?? null;
  const lastRewardComputeBurnHeight =
    rewardOutlook?.calculation.observedLastRewardComputeBurnHeight ??
    rewards?.global.lastRewardComputeBurnHeight ??
    null;
  const [rewardsFreshness, setRewardsFreshness] = useState(data.freshness ?? null);
  const rewardClaimsAvailability = managerActionAvailability(
    data,
    rewardManagerCapabilityId("claim-rewards"),
    operatorStateStale,
  );
  const updateFeesAvailability = managerActionAvailability(
    data,
    rewardManagerCapabilityId("update-fees"),
    operatorStateStale,
  );
  const withdrawFeesAvailability = managerActionAvailability(
    data,
    rewardManagerCapabilityId("withdraw-fees"),
    operatorStateStale,
  );
  const sweepFeeRefundsAvailability = managerActionAvailability(
    data,
    rewardManagerCapabilityId("sweep-fee-refunds"),
    operatorStateStale,
  );
  const managerActionsAvailable = rewardClaimsAvailability.available;
  const [activity, setActivity] = useState(data.activity);
  const [stakerPage, setStakerPage] = useState(0);
  const [bucketSort, setBucketSort] = useState<TableSort<BucketSort>>({
    key: "bucket",
    direction: "asc",
  });
  const [historySort, setHistorySort] = useState<TableSort<RewardHistorySort>>({
    key: "cycle",
    direction: "desc",
  });
  const [stakerSort, setStakerSort] = useState<TableSort<RewardStakerSort>>({
    key: "staker",
    direction: "asc",
  });
  const [claimPage, setClaimPage] = useState(0);
  const [claimSort, setClaimSort] = useState<TableSort<ClaimSort>>({
    key: "block",
    direction: "desc",
  });
  const [claimCycle, setClaimCycle] = useState("");
  const [withdrawalPage, setWithdrawalPage] = useState(0);
  const [withdrawalSort, setWithdrawalSort] = useState<TableSort<WithdrawalSort>>({
    key: "block",
    direction: "desc",
  });
  const [cycleHistoryPage, setCycleHistoryPage] = useState(0);
  const [cycleHistory, setCycleHistory] = useState<RewardCycleSummary[]>([]);
  const [cycleHistoryTotal, setCycleHistoryTotal] = useState(0);
  const pageSize = 50;
  const cycleHistoryPageSize = 10;
  const [rewardStakers, setRewardStakers] = useState(rewards?.stakers ?? []);
  const [rewardStakerTotal, setRewardStakerTotal] = useState(rewards?.totals.stakers ?? 0);
  const [rewardRealizations, setRewardRealizations] = useState<RewardCalculationRealization[]>([]);
  const [stakersLoading, setStakersLoading] = useState(true);
  const [stakersError, setStakersError] = useState<string | null>(null);
  const [stakersRetry, setStakersRetry] = useState(0);
  const [activityLoading, setActivityLoading] = useState(true);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [activityRetry, setActivityRetry] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyRetry, setHistoryRetry] = useState(0);
  const stakersRefreshKey = `${data.generatedAt}:${stakersRetry}:${stakerSort.key}:${stakerSort.direction}`;
  const activityRefreshKey = `${data.generatedAt}:${activityRetry}:${claimSort.key}:${claimSort.direction}:${withdrawalSort.key}:${withdrawalSort.direction}`;
  const historyRefreshKey = `${data.generatedAt}:${historyRetry}:${historySort.key}:${historySort.direction}`;
  const withdrawals = activity.withdrawals;
  const buckets = useMemo(() => {
    const values = [...(rewards?.buckets ?? [])];
    return values.sort((left, right) => {
      const value = (bucket: (typeof values)[number]) => {
        switch (bucketSort.key) {
          case "bucket":
            return bucket.bondIndex === null ? -1 : Number(bucket.bondIndex);
          case "shares":
            return BigInt(bucket.managerSharesSats);
          case "earned":
            return BigInt(bucket.signerEarnedBeforeManagerClaimSats);
          case "fee":
            return bucket.feeSnapshotBips === null ? null : BigInt(bucket.feeSnapshotBips);
          case "included":
            return bucket.participating ? 1 : 0;
        }
      };
      return compareSortValues(value(left), value(right), bucketSort.direction);
    });
  }, [bucketSort, rewards?.buckets]);
  useEffect(() => {
    void stakersRefreshKey;
    const controller = new AbortController();
    let correctingPage = false;
    const query = new URLSearchParams({
      limit: String(pageSize),
      offset: String(stakerPage * pageSize),
      sort: stakerSort.key,
      direction: stakerSort.direction,
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
        setRewardRealizations(result.rewardRealizations ?? []);
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
  }, [stakerPage, stakersRefreshKey, stakerSort, token]);
  useEffect(() => {
    void activityRefreshKey;
    const controller = new AbortController();
    let correctingPage = false;
    const query = new URLSearchParams({
      claimLimit: String(pageSize),
      claimOffset: String(claimPage * pageSize),
      claimSort: claimSort.key,
      claimDirection: claimSort.direction,
      withdrawalLimit: String(pageSize),
      withdrawalOffset: String(withdrawalPage * pageSize),
      withdrawalSort: withdrawalSort.key,
      withdrawalDirection: withdrawalSort.direction,
    });
    if (claimCycle) query.set("rewardCycle", claimCycle);
    setActivityLoading(true);
    setActivityError(null);
    void apiJson(token, `/api/v1/rewards/activity?${query}`, rewardsActivityResponseSchema, {
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
  }, [activityRefreshKey, claimCycle, claimPage, claimSort, token, withdrawalPage, withdrawalSort]);
  useEffect(() => {
    void historyRefreshKey;
    const controller = new AbortController();
    let correctingPage = false;
    const query = new URLSearchParams({
      limit: String(cycleHistoryPageSize),
      offset: String(cycleHistoryPage * cycleHistoryPageSize),
      sort: historySort.key,
      direction: historySort.direction,
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
  }, [cycleHistoryPage, historyRefreshKey, historySort, token]);
  return (
    <>
      <PageHead
        title="Rewards"
        lede={`sBTC rewards and Bitcoin withdrawals for cycle ${rewards?.rewardCycle ?? data.preflight.cycle.currentId}.`}
      />
      {rewardsFreshness?.status === "stale" ? (
        <div className="callout callout-caution content-notice" role="status">
          Showing last known reward data while Sidekick refreshes chain data.
        </div>
      ) : null}
      <div className="grid cols-2 reward-outlook domain-section-anchor" id="rewards-outlook">
        <section className="card">
          <div className="card-head">
            <h2>Accrued so far</h2>
            <Badge state={poolEstimate ? "info" : "neutral"}>
              {poolEstimate ? "Current estimate" : "Unavailable"}
            </Badge>
          </div>
          <p className="card-sub">Estimated allocation if the network calculation ran now.</p>
          <StatLine label={<RewardTerm label="Network-wide rewards" help={rewardTerms.network} />}>
            <span className="btc-value src src-chain">
              {globalAccruedSats === null ? "Unavailable" : `${sbtc(globalAccruedSats)} sBTC`}
            </span>
          </StatLine>
          <StatLine label={<RewardTerm label="Your pool — gross" help={rewardTerms.pool} />}>
            {poolEstimate ? `${sbtc(poolEstimate.grossSats)} sBTC` : "Unavailable"}
          </StatLine>
          <StatLine label={<RewardTerm label="Operator fee estimate" help={rewardTerms.fee} />}>
            {operatorFeeEstimate ? `${sbtc(operatorFeeEstimate.sats)} sBTC` : "Unavailable"}
          </StatLine>
          <StatLine label={<RewardTerm label="Net for your stakers" help={rewardTerms.net} />}>
            {poolEstimate && operatorFeeEstimate
              ? `${sbtc(subtractSats(poolEstimate.grossSats, operatorFeeEstimate.sats) ?? "0")} sBTC`
              : "Unavailable"}
          </StatLine>
          {poolEstimate ? (
            <StatLine label="Pool allocation — STX / Bitcoin bonds">
              <span className="mono">
                {sbtc(poolEstimate.stxSats)} / {sbtc(poolEstimate.bondSats)} sBTC
              </span>
            </StatLine>
          ) : null}
          <p className="tertiary balance-note">
            {poolEstimate
              ? "Contract-exact for the current accrued rewards, pool shares, and active Bitcoin bonds."
              : poolEstimateUnavailableDetail(
                  rewardOutlook?.poolEstimateUnavailableReason ?? "anchored-inputs-unavailable",
                )}
          </p>
        </section>
        <section className="card">
          <div className="card-head">
            <h2>Projected next allocation</h2>
            <Badge state={rewardForecast ? "info" : "neutral"}>
              {rewardForecast ? `${rewardForecast.confidence} confidence` : "Collecting data"}
            </Badge>
          </div>
          <p className="card-sub">
            {calculation?.next
              ? calculation.next.state === "due"
                ? `For cycle ${calculation.next.targetRewardCycle} ${calculation.next.targetCheckpoint}; calculation is eligible now.`
                : `For cycle ${calculation.next.targetRewardCycle} ${calculation.next.targetCheckpoint}, in ${number(String(calculation.next.blocksRemaining))} Bitcoin blocks.`
              : "A valid anchored PoX-5 checkpoint is required."}
          </p>
          <StatLine label={<RewardTerm label="Network-wide rewards" help={rewardTerms.network} />}>
            {rewardForecast ? `${sbtc(rewardForecast.globalSats.point)} sBTC` : "Unavailable"}
          </StatLine>
          <StatLine label={<RewardTerm label="Your pool — gross" help={rewardTerms.pool} />}>
            {rewardForecast ? `${sbtc(rewardForecast.poolSats.point)} sBTC` : "Unavailable"}
          </StatLine>
          <StatLine label={<RewardTerm label="Operator fee estimate" help={rewardTerms.fee} />}>
            {operatorFeeForecast ? `${sbtc(operatorFeeForecast.sats.point)} sBTC` : "Unavailable"}
          </StatLine>
          <StatLine label={<RewardTerm label="Net for your stakers" help={rewardTerms.net} />}>
            {rewardForecast && operatorFeeForecast
              ? `${sbtc(subtractSats(rewardForecast.poolSats.point, operatorFeeForecast.sats.point) ?? "0")} sBTC`
              : "Unavailable"}
          </StatLine>
          {rewardForecast ? (
            <>
              <StatLine label="Pool projection range">
                <span className="mono">
                  {sbtc(rewardForecast.poolSats.low)}–{sbtc(rewardForecast.poolSats.high)} sBTC
                </span>
              </StatLine>
              <p className="tertiary balance-note">
                {rewardForecast.confidence === "calibrated"
                  ? "Calibrated"
                  : rewardForecast.confidence === "developing"
                    ? "Developing"
                    : "Low"}{" "}
                confidence from {rewardForecast.sample.observations} observations across{" "}
                {rewardForecast.sample.sampleBlocks} Bitcoin blocks. The range replays observed
                global accrual rates through exact PoX-5 arithmetic using current shares.
              </p>
              {operatorFeeForecast ? (
                <p className="tertiary balance-note">
                  Operator fees apply the reviewed manager’s per-staker, per-bucket integer rounding
                  across {operatorFeeForecast.inputs.stakers} stakers.
                  {operatorFeeForecast.assumptions.includes("configured-fee-until-claim")
                    ? " At least one cycle fee snapshot does not exist yet, so that bucket explicitly assumes the currently configured fee until the first manager claim pins it."
                    : " Every bucket uses its authoritative cycle fee snapshot."}
                </p>
              ) : (
                <p className="tertiary balance-note">
                  Operator fee forecast omitted:{" "}
                  {rewardOutlook?.operatorFeeForecastUnavailableReason ??
                    "reviewed fee semantics are unavailable"}
                  .
                </p>
              )}
              <p className="tertiary balance-note">
                Model revision {rewardCalibration?.modelRevision ?? 1} is{" "}
                {rewardCalibration?.status ?? "collecting"} with{" "}
                {rewardCalibration?.eligibleRealizations ?? 0} of{" "}
                {rewardCalibration?.requirements.realizations ?? 6} eligible realized calculations.
              </p>
            </>
          ) : (
            <p className="tertiary balance-note">
              {rewardForecastUnavailableDetail(
                rewardOutlook?.forecastUnavailableReason ?? "forecast-inputs-unavailable",
              )}
            </p>
          )}
        </section>
      </div>
      <div className="card-standout pipeline-wrap">
        <div className="pipeline">
          <PipelineStage
            done={calculation?.state === "completed" || calculation?.state === "ahead"}
            title="Global calculated"
            value={
              calculation?.state === "pending"
                ? "Not run yet"
                : BigInt(lastRewardComputeBurnHeight ?? 0) === 0n
                  ? "Waiting"
                  : `Bitcoin block #${number(lastRewardComputeBurnHeight)}`
            }
            detail={
              calculation?.state === "pending"
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
            detail={`${rewards?.totals.actionableClaims ?? 0} ready for payout`}
          />
          <PipelineStage
            done={activity.pendingWithdrawalTotal === 0}
            title="Bitcoin withdrawals"
            value={`${activity.withdrawalTotal - activity.pendingWithdrawalTotal} / ${activity.withdrawalTotal}`}
            detail="completed requests"
          />
        </div>
      </div>
      {calculation?.state === "pending" ? (
        <div
          className={`callout ${calculationGrace?.state === "action-required" ? "callout-caution" : "callout-neutral"} balance-note`}
          role="status"
        >
          <div className="body">
            <strong>
              {calculationActionAvailable
                ? "Global reward calculation needs an operator."
                : calculationNeedsAttention
                  ? "Reward calculation needs current chain evidence."
                  : "Awaiting permissionless reward calculation."}
            </strong>{" "}
            PoX-5 credits nothing for cycle {calculation.targetRewardCycle ?? "—"} until someone
            calls <code>calculate-rewards</code> after Bitcoin block #
            {number(String(calculation.expectedLastRewardComputeBurnHeight ?? 0))}.
            {calculationGrace ? (
              <span className="tertiary">
                {" "}
                Observed for {calculationGrace.elapsedMinutes} minutes and{" "}
                {calculationGrace.canonicalStacksBlocks} canonical Stacks blocks.
              </span>
            ) : null}
            {calculationNeedsAttention ? (
              <span className="tertiary">
                {" "}
                Sidekick will not offer a transaction until the local snapshot and action witnesses
                are current.
              </span>
            ) : null}
            {calculationActionAvailable ? (
              <div className="actions">
                <a className="btn btn-primary sm" href={actionHash("calculate-rewards")}>
                  Review calculation
                </a>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      <StakerSettlementPanel calculationPending={calculation?.state === "pending"} token={token} />
      {buckets.some(({ bondIndex }) => bondIndex !== null) ? (
        <section className="card reward-buckets" aria-labelledby="reward-buckets">
          <h2 id="reward-buckets">Reward buckets</h2>
          <p className="tertiary">
            PoX-5 keys rewards by bond period. A manager claim names every participating bucket in
            one transaction, which is what pins the same fee across the pool.
          </p>
          <table>
            <thead>
              <tr>
                <SortableHeader
                  column="bucket"
                  label="Bucket"
                  setSort={setBucketSort}
                  sort={bucketSort}
                />
                <SortableHeader
                  column="shares"
                  label="Manager shares"
                  setSort={setBucketSort}
                  sort={bucketSort}
                />
                <SortableHeader
                  column="earned"
                  label="Earned"
                  setSort={setBucketSort}
                  sort={bucketSort}
                />
                <SortableHeader
                  column="fee"
                  label="Fee snapshot"
                  setSort={setBucketSort}
                  sort={bucketSort}
                />
                <SortableHeader
                  column="included"
                  label="In next claim"
                  setSort={setBucketSort}
                  sort={bucketSort}
                />
              </tr>
            </thead>
            <tbody>
              {buckets.map((bucket) => (
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
          <strong>Guided reward claims are unavailable.</strong> {rewardClaimsAvailability.reason}
        </p>
      ) : null}
      {rewardClaimsAvailability.warning ? (
        <p className="tertiary balance-note" role="status">
          <strong>Unverified manager source.</strong> {rewardClaimsAvailability.warning}
        </p>
      ) : null}
      <div className="grid cols-2 reward-ledger">
        <div className="card domain-section-anchor" id="rewards-fees">
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
              disabled={!updateFeesAvailability.available}
              title={updateFeesAvailability.available ? undefined : updateFeesAvailability.reason}
              onClick={() => {
                location.hash = actionHash("update-fees");
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
                !withdrawFeesAvailability.available ||
                BigInt(rewards?.manager.earnedFeesSats ?? 0) === 0n
              }
              title={
                withdrawFeesAvailability.available ? undefined : withdrawFeesAvailability.reason
              }
              onClick={() => {
                location.hash = actionHash("withdraw-fees");
              }}
            >
              <Coins /> Withdraw earned fees
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!sweepFeeRefundsAvailability.available}
              title={
                sweepFeeRefundsAvailability.available
                  ? undefined
                  : sweepFeeRefundsAvailability.reason
              }
              onClick={() => {
                location.hash = actionHash("sweep-fee-refunds");
              }}
            >
              Sweep fee refunds
            </button>
          </div>
        </div>
      </div>
      <div className="section-title">Realized calculations &amp; model accuracy</div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Cycle</th>
              <th>Checkpoint</th>
              <th className="right">Pool allocation</th>
              <th className="right">Point error</th>
              <th>Range result</th>
              <th>Transaction</th>
            </tr>
          </thead>
          <tbody>
            {rewardRealizations.length === 0 ? (
              <tr>
                <td colSpan={6} className="tertiary">
                  No node-verified reward calculations have closed a recorded forecast yet.
                </td>
              </tr>
            ) : (
              rewardRealizations.map((realization) => (
                <tr key={`${realization.txId}:${realization.eventIndex}`}>
                  <td className="mono">{realization.targetRewardCycle}</td>
                  <td>
                    {realization.targetCheckpoint === "first-half" ? "First half" : "Second half"}
                  </td>
                  <td className="right mono">
                    {realization.poolSats === null
                      ? "Unavailable"
                      : `${sbtc(realization.poolSats)} sBTC`}
                  </td>
                  <td className="right mono">
                    {realization.evaluation?.pointErrorBips === null || !realization.evaluation
                      ? "—"
                      : `${(Number(realization.evaluation.pointErrorBips) / 100).toFixed(1)}%`}
                  </td>
                  <td>
                    {realization.evaluation ? (
                      <Badge
                        state={realization.evaluation.rangeContainsActual ? "success" : "caution"}
                      >
                        {realization.evaluation.rangeContainsActual
                          ? "Inside range"
                          : "Outside range"}
                      </Badge>
                    ) : (
                      <Badge state="neutral">Not evaluated</Badge>
                    )}
                  </td>
                  <td>
                    <CopyableIdentifier
                      value={realization.txId}
                      display={short(realization.txId, 8, 5)}
                      label="reward calculation transaction"
                      className="mono"
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="section-title domain-section-anchor" id="rewards-history">
        Reward cycle ledger
      </div>
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
                  <SortableHeader
                    column="cycle"
                    label="Cycle"
                    setSort={(sort) => {
                      setHistorySort(sort);
                      setCycleHistoryPage(0);
                    }}
                    sort={historySort}
                  />
                  <SortableHeader
                    column="status"
                    label="Status"
                    setSort={(sort) => {
                      setHistorySort(sort);
                      setCycleHistoryPage(0);
                    }}
                    sort={historySort}
                  />
                  <SortableHeader
                    align="right"
                    column="stakers"
                    label="Stakers"
                    setSort={(sort) => {
                      setHistorySort(sort);
                      setCycleHistoryPage(0);
                    }}
                    sort={historySort}
                  />
                  <SortableHeader
                    align="right"
                    column="gross"
                    label="Gross"
                    setSort={(sort) => {
                      setHistorySort(sort);
                      setCycleHistoryPage(0);
                    }}
                    sort={historySort}
                  />
                  <SortableHeader
                    align="right"
                    column="net"
                    label="Net"
                    setSort={(sort) => {
                      setHistorySort(sort);
                      setCycleHistoryPage(0);
                    }}
                    sort={historySort}
                  />
                  <SortableHeader
                    align="right"
                    column="fee"
                    label="Fee"
                    setSort={(sort) => {
                      setHistorySort(sort);
                      setCycleHistoryPage(0);
                    }}
                    sort={historySort}
                  />
                  <SortableHeader
                    align="right"
                    column="configured-fee"
                    label="Configured fee"
                    setSort={(sort) => {
                      setHistorySort(sort);
                      setCycleHistoryPage(0);
                    }}
                    sort={historySort}
                  />
                  <SortableHeader
                    align="right"
                    column="effective-fee"
                    label="Effective fee"
                    setSort={(sort) => {
                      setHistorySort(sort);
                      setCycleHistoryPage(0);
                    }}
                    sort={historySort}
                  />
                  <SortableHeader
                    align="right"
                    column="actionable"
                    label="Ready for payout"
                    setSort={(sort) => {
                      setHistorySort(sort);
                      setCycleHistoryPage(0);
                    }}
                    sort={historySort}
                  />
                  <SortableHeader
                    column="bitcoin-block"
                    label="Observed Bitcoin block"
                    setSort={(sort) => {
                      setHistorySort(sort);
                      setCycleHistoryPage(0);
                    }}
                    sort={historySort}
                  />
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
      <div className="section-title domain-section-anchor" id="rewards-claims">
        Per-staker claims
      </div>
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
                  <SortableHeader
                    column="staker"
                    label="Staker"
                    setSort={(sort) => {
                      setStakerSort(sort);
                      setStakerPage(0);
                    }}
                    sort={stakerSort}
                  />
                  <SortableHeader
                    align="right"
                    column="gross"
                    label="Gross"
                    setSort={(sort) => {
                      setStakerSort(sort);
                      setStakerPage(0);
                    }}
                    sort={stakerSort}
                  />
                  <SortableHeader
                    align="right"
                    column="fee"
                    label="Fee"
                    setSort={(sort) => {
                      setStakerSort(sort);
                      setStakerPage(0);
                    }}
                    sort={stakerSort}
                  />
                  <SortableHeader
                    align="right"
                    column="net"
                    label="Net"
                    setSort={(sort) => {
                      setStakerSort(sort);
                      setStakerPage(0);
                    }}
                    sort={stakerSort}
                  />
                  <SortableHeader
                    column="destination"
                    label="Destination"
                    setSort={(sort) => {
                      setStakerSort(sort);
                      setStakerPage(0);
                    }}
                    sort={stakerSort}
                  />
                  <SortableHeader
                    column="status"
                    label="Status"
                    setSort={(sort) => {
                      setStakerSort(sort);
                      setStakerPage(0);
                    }}
                    sort={stakerSort}
                  />
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
                  <SortableHeader
                    column="cycle"
                    label="Cycle"
                    setSort={(sort) => {
                      setClaimSort(sort);
                      setClaimPage(0);
                    }}
                    sort={claimSort}
                  />
                  <SortableHeader
                    column="staker"
                    label="Staker"
                    setSort={(sort) => {
                      setClaimSort(sort);
                      setClaimPage(0);
                    }}
                    sort={claimSort}
                  />
                  <SortableHeader
                    align="right"
                    column="amount"
                    label="Amount"
                    setSort={(sort) => {
                      setClaimSort(sort);
                      setClaimPage(0);
                    }}
                    sort={claimSort}
                  />
                  <SortableHeader
                    column="destination"
                    label="Destination"
                    setSort={(sort) => {
                      setClaimSort(sort);
                      setClaimPage(0);
                    }}
                    sort={claimSort}
                  />
                  <SortableHeader
                    column="block"
                    label="Stacks block"
                    setSort={(sort) => {
                      setClaimSort(sort);
                      setClaimPage(0);
                    }}
                    sort={claimSort}
                  />
                  <SortableHeader
                    column="transaction"
                    label="Transaction"
                    setSort={(sort) => {
                      setClaimSort(sort);
                      setClaimPage(0);
                    }}
                    sort={claimSort}
                  />
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
      <div className="section-title domain-section-anchor" id="rewards-withdrawals">
        Bitcoin withdrawal queue
      </div>
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
                  <SortableHeader
                    column="request"
                    label="Request ID"
                    setSort={(sort) => {
                      setWithdrawalSort(sort);
                      setWithdrawalPage(0);
                    }}
                    sort={withdrawalSort}
                  />
                  <SortableHeader
                    column="staker"
                    label="Staker"
                    setSort={(sort) => {
                      setWithdrawalSort(sort);
                      setWithdrawalPage(0);
                    }}
                    sort={withdrawalSort}
                  />
                  <SortableHeader
                    align="right"
                    column="amount"
                    label="Amount"
                    setSort={(sort) => {
                      setWithdrawalSort(sort);
                      setWithdrawalPage(0);
                    }}
                    sort={withdrawalSort}
                  />
                  <SortableHeader
                    align="right"
                    column="max-fee"
                    label="Max fee"
                    setSort={(sort) => {
                      setWithdrawalSort(sort);
                      setWithdrawalPage(0);
                    }}
                    sort={withdrawalSort}
                  />
                  <SortableHeader
                    column="state"
                    label="Manager state"
                    setSort={(sort) => {
                      setWithdrawalSort(sort);
                      setWithdrawalPage(0);
                    }}
                    sort={withdrawalSort}
                  />
                  <SortableHeader
                    column="block"
                    label="Initiated at Stacks block"
                    setSort={(sort) => {
                      setWithdrawalSort(sort);
                      setWithdrawalPage(0);
                    }}
                    sort={withdrawalSort}
                  />
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

/** Every reason mirrors a guard the wallet-intent preparation applies before building a call. */
function blockedLabel(reason: string | null): string {
  if (reason === "manager-has-not-claimed") return "Manager has not claimed this bucket";
  if (reason === "l1-below-max-fee") return "Below withdrawal fee";
  if (reason === "l1-below-dust-limit") return "Below withdrawal dust limit";
  return "Nothing settled";
}

function StakerSettlementPanel({
  calculationPending,
  token,
}: {
  calculationPending: boolean;
  token: string;
}) {
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
                              onClick={() => {
                                location.hash = actionHash("claim-staker-rewards", {
                                  kind: "staker-reward",
                                  stakerPrincipal: candidate.stakerPrincipal,
                                  rewardCycle: String(latest?.rewardCycle ?? 0),
                                  bondIndex: candidate.bondIndex,
                                });
                              }}
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
