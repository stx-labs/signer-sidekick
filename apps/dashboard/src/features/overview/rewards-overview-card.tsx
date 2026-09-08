import { ArrowRight } from "@phosphor-icons/react";
import type {
  GasWalletStatus,
  OverviewPage,
  RewardLedger,
  RewardRun,
} from "@stx-labs/signer-sidekick-api-contracts";
import { useEffect, useState } from "react";
import { dashboardHash, domainHash } from "../../dashboard-route.js";
import { Badge } from "../../shared/dashboard-ui.js";
import { amount, feePercent } from "../../shared/format.js";
import { operatorErrorSentence } from "../../shared/operator-error.js";
import { startVisibleRefresh } from "../../shared/visible-refresh.js";
import { loadEngineStatus } from "../operations/engine-api.js";
import { storeRewardHandoff } from "../rewards/reward-handoff.js";
import { loadRewardLedger } from "../rewards/reward-ledger-api.js";
import {
  allocationRoundingNote,
  calculatedPoolTotal,
  currentDistribution,
  type DistributionCardModel,
  deriveDistributionCards,
  distributionAllocation,
  distributionName,
} from "../rewards/reward-state.js";
import { IN_PROGRESS_RUN_STATUSES, listRewardRuns } from "../rewards/run-api.js";
import { cachedGasWalletStatus, loadGasWalletStatus } from "../settings/gas-wallet-api.js";

const CARD_POLL_MS = 30_000;

type CardState = DistributionCardModel["state"] | "accruing";

const titles: Record<CardState, string> = {
  ready: "Rewards — ready to distribute",
  accruing: "Rewards — accruing",
  distributing: "Rewards — distributing",
  complete: "Rewards — complete",
  attention: "Rewards — needs attention",
  overdue: "Rewards — calculation overdue",
};

export function RewardsOverviewCard({
  token,
  rewards,
  cacheScope,
  fallback,
}: {
  token: string;
  rewards: OverviewPage["rewards"];
  cacheScope: string;
  /** Rendered when the ledger is unavailable (older Sidekick, or still loading). */
  fallback: React.ReactNode;
}) {
  const [ledger, setLedger] = useState<RewardLedger | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gasWallet, setGasWallet] = useState<GasWalletStatus | null | undefined>(() =>
    cachedGasWalletStatus(token, cacheScope),
  );
  const [engineMode, setEngineMode] = useState<"observe" | "operator-run" | null>(null);
  const [activeRun, setActiveRun] = useState<RewardRun | null>(null);
  useEffect(() => {
    const refresh = startVisibleRefresh(
      async (signal) => {
        const failures: string[] = [];
        const failed = (cause: unknown) => {
          failures.push(operatorErrorSentence(cause));
        };
        await Promise.all([
          loadRewardLedger(token, {}, signal)
            .then((result) => {
              if (!signal.aborted) {
                setLedger(result);
              }
            })
            .catch(failed),
          loadGasWalletStatus(token, signal, cacheScope)
            .then((status) => {
              if (!signal.aborted) setGasWallet(status);
            })
            .catch((cause: unknown) => {
              failed(cause);
            }),
          loadEngineStatus(token, signal)
            .then((status) => {
              if (!signal.aborted)
                setEngineMode(status?.mode === "operator-run" ? "operator-run" : "observe");
            })
            .catch((cause: unknown) => {
              failed(cause);
              if (!signal.aborted) setEngineMode(null);
            }),
          listRewardRuns(token, 3, signal)
            .then((runs) => {
              if (!signal.aborted) {
                setActiveRun(runs.find((run) => IN_PROGRESS_RUN_STATUSES.has(run.status)) ?? null);
              }
            })
            .catch(failed),
        ]);
        if (failures.length) throw new Error(failures.join("; "));
        if (!signal.aborted) setError(null);
      },
      (cause) => setError(operatorErrorSentence(cause)),
      CARD_POLL_MS,
    );
    return () => refresh.stop();
  }, [token, cacheScope]);

  if (!ledger)
    return (
      <>
        {error ? (
          <div className="content-notice" role="alert">
            Reward details unavailable: {error}. Retrying automatically.
          </div>
        ) : null}
        {fallback}
      </>
    );
  const cards = deriveDistributionCards({ ledger, gasWallet, engineMode, activeRun });
  const card = cards[0] ?? null;
  const state = card?.state ?? "accruing";
  const distribution = card
    ? (ledger.cycles
        .find((entry) => entry.cycle === card.cycle)
        ?.distributions.find((d) => d.distribution === card.distribution) ?? null)
    : currentDistribution(ledger);
  if (!distribution) return <>{fallback}</>;
  const cycleNumber = card?.cycle ?? ledger.current.cycle;
  const cycle = ledger.cycles.find((entry) => entry.cycle === cycleNumber) ?? null;
  const calculated = distribution.calculation.state === "done";
  const primaryAction = card?.primary ?? card?.secondary?.action ?? null;
  const startRun = () => {
    if (primaryAction) storeRewardHandoff(primaryAction, cacheScope);
    location.hash = domainHash("rewards", "claims");
  };
  const allocation = distributionAllocation(distribution);
  const roundingNote = allocationRoundingNote(allocation);
  const cycleCalculated = cycle ? calculatedPoolTotal(cycle.distributions) : null;
  const headline = card ? card.headline : "Accruing — nothing to do until the network calculates";
  const badge = card ? card.badge : { tone: "neutral" as const, label: "Accruing" };
  const execution = card?.execution ?? null;
  return (
    <section
      className="card overview-domain rw-overview-card"
      id="overview-rewards"
      aria-labelledby="overview-rewards-heading"
    >
      <div className="card-head">
        <h2 id="overview-rewards-heading">{titles[state]}</h2>
        <Badge state={badge.tone}>{badge.label}</Badge>
      </div>
      {error ? (
        <p className="content-notice" role="status">
          Reward status refresh failed; showing retained data from{" "}
          {new Date(ledger.generatedAt).toLocaleString()}. {error}
        </p>
      ) : null}
      <div className="overview-domain-primary">
        <span>
          Cycle {cycleNumber} · {distributionName(distribution.distribution)}
        </span>
        <strong>{headline}</strong>
        <small>
          {distribution.status === "interpretation-unavailable"
            ? distribution.statusDetail
            : calculated
              ? `${amount(distribution.calculation.poolSats)} calculated for this pool · ${distribution.payments.outstanding > 0 ? `${distribution.payments.outstanding} payments waiting` : `${distribution.payments.made} payments made`}`
              : rewards.estimatedPoolRewardSats
                ? `projected ${amount(rewards.estimatedPoolRewardSats)} for this pool · ${rewards.confidence === "unavailable" ? "projection unavailable" : `${rewards.confidence} confidence`}`
                : "projection unavailable"}
        </small>
        {cards.length > 1 ? (
          <small>
            {cards.length - 1} more {cards.length - 1 === 1 ? "distribution" : "distributions"}{" "}
            waiting behind this one
          </small>
        ) : null}
      </div>
      <dl>
        {calculated ? (
          <>
            <div>
              <dt>
                {allocation.coverage === "partial"
                  ? "Known to stakers (partial)"
                  : allocation.estimated
                    ? "Estimated to stakers"
                    : "To stakers"}
              </dt>
              <dd>{amount(allocation.toStakersSats)}</dd>
            </div>
            <div>
              <dt>
                {allocation.coverage === "partial"
                  ? "Known fee (partial)"
                  : allocation.estimated
                    ? "Your fee estimate"
                    : "Your fee"}
              </dt>
              <dd>
                {amount(allocation.operatorFeeSats)}
                {distribution.feeBips
                  ? ` · STX fee ${feePercent(distribution.feeBips)}${distribution.feeEvidence === "locked" ? " locked" : ""}`
                  : ""}
                {roundingNote ? <small> · {roundingNote}</small> : null}
              </dd>
            </div>
          </>
        ) : (
          <>
            <div>
              <dt>Pool if calculated now</dt>
              <dd>
                {amount(
                  rewards.accruedPoolRewardSats ??
                    (rewards.estimateKind === "if-calculated-now"
                      ? rewards.estimatedPoolRewardSats
                      : null),
                )}
              </dd>
            </div>
            <div>
              <dt>Projected at calculation</dt>
              <dd>
                {rewards.estimateKind === "checkpoint-forecast" && rewards.estimatedPoolRewardSats
                  ? amount(rewards.estimatedPoolRewardSats)
                  : "—"}
              </dd>
            </div>
          </>
        )}
        {cycle?.distributions.some((d) => d.calculation.state === "done") ? (
          <div>
            <dt>Cycle {cycle.cycle} calculated</dt>
            <dd>{amount(cycleCalculated)}</dd>
          </div>
        ) : null}
      </dl>
      {state === "accruing" ? (
        <a className="btn btn-tertiary" href={dashboardHash("rewards")}>
          Open Rewards
        </a>
      ) : (
        <div className="rw-overview-actions">
          {state === "ready" || state === "attention" || state === "overdue" ? (
            <>
              {primaryAction ? (
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={startRun}
                  disabled={!execution?.available || card?.queued !== null}
                  title={
                    card?.queued ??
                    (execution?.available ? undefined : (execution?.reason ?? undefined))
                  }
                >
                  {primaryAction.label}
                  <ArrowRight className="rw-ico" aria-hidden="true" />
                </button>
              ) : null}
              <a className="btn btn-tertiary" href={domainHash("rewards", "claims")}>
                Review payments
              </a>
            </>
          ) : state === "distributing" ? (
            <a className="btn btn-tertiary" href={domainHash("rewards", "claims")}>
              View progress
            </a>
          ) : (
            <a className="btn btn-tertiary" href={domainHash("rewards", "claims")}>
              Review payments
            </a>
          )}
          <a className="btn btn-tertiary" href={dashboardHash("rewards")}>
            Open Rewards
          </a>
        </div>
      )}
    </section>
  );
}
