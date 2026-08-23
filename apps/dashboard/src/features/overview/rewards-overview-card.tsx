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
import { loadEngineStatus } from "../operations/engine-api.js";
import { loadRewardLedger } from "../rewards/reward-ledger-api.js";
import {
  currentDistribution,
  type DistributionCardModel,
  deriveDistributionCards,
  distributionName,
} from "../rewards/reward-state.js";
import { PENDING_RUN_STORAGE_KEY } from "../rewards/rewards-page.js";
import { IN_PROGRESS_RUN_STATUSES, listRewardRuns } from "../rewards/run-api.js";
import { loadGasWalletStatus } from "../settings/gas-wallet-api.js";

const CARD_POLL_MS = 30_000;

type CardState = "ready" | "accruing" | "distributing" | "complete" | "attention" | "overdue";

/** The Overview follows the oldest distribution that still needs the operator, else the accrual. */
function cardState(card: DistributionCardModel | null): CardState {
  if (!card) return "accruing";
  if (card.progress) return "distributing";
  switch (card.badge.label) {
    case "Needs attention":
      return "attention";
    case "Calculation overdue":
      return "overdue";
    case "All distributed":
      return "complete";
    default:
      return "ready";
  }
}

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
  generatedAt,
  fallback,
}: {
  token: string;
  rewards: OverviewPage["rewards"];
  generatedAt: string;
  /** Rendered when the ledger is unavailable (older Sidekick, or still loading). */
  fallback: React.ReactNode;
}) {
  const [ledger, setLedger] = useState<RewardLedger | null>(null);
  const [gasWallet, setGasWallet] = useState<GasWalletStatus | null>(null);
  const [engineMode, setEngineMode] = useState<"observe" | "operator-run" | null>(null);
  const [activeRun, setActiveRun] = useState<RewardRun | null>(null);
  useEffect(() => {
    void generatedAt;
    const controller = new AbortController();
    const load = () => {
      loadRewardLedger(token, {}, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) {
            setLedger(result);
          }
        })
        .catch(() => undefined);
      loadGasWalletStatus(token, controller.signal)
        .then((status) => {
          if (!controller.signal.aborted) setGasWallet(status);
        })
        .catch(() => undefined);
      loadEngineStatus(token, controller.signal)
        .then((status) => {
          if (!controller.signal.aborted)
            setEngineMode(status?.mode === "operator-run" ? "operator-run" : "observe");
        })
        .catch(() => undefined);
      listRewardRuns(token, 3, controller.signal)
        .then((runs) => {
          if (!controller.signal.aborted) {
            setActiveRun(runs.find((run) => IN_PROGRESS_RUN_STATUSES.has(run.status)) ?? null);
          }
        })
        .catch(() => undefined);
    };
    load();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, CARD_POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [token, generatedAt]);

  if (!ledger) return <>{fallback}</>;
  const cards = deriveDistributionCards({ ledger, gasWallet, engineMode, activeRun });
  const card = cards[0] ?? null;
  const state = cardState(card);
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
    if (primaryAction) sessionStorage.setItem(PENDING_RUN_STORAGE_KEY, primaryAction.kind);
    location.hash = domainHash("rewards", "claims");
  };
  const toStakers = (
    BigInt(distribution.payments.distributedSats) + BigInt(distribution.payments.outstandingSats)
  ).toString();
  // Expected fee for a calculated distribution: pool minus what goes to stakers; paid fee otherwise.
  const expectedFee =
    calculated && distribution.calculation.poolSats
      ? (BigInt(distribution.calculation.poolSats) - BigInt(toStakers)).toString()
      : distribution.payments.operatorFeeSats;
  const feeShown = BigInt(expectedFee) < 0n ? distribution.payments.operatorFeeSats : expectedFee;
  const cycleCalculated = cycle
    ? cycle.distributions
        .reduce((sum, d) => sum + BigInt(d.calculation.poolSats ?? "0"), 0n)
        .toString()
    : null;
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
      <div className="overview-domain-primary">
        <span>
          Cycle {cycleNumber} · {distributionName(distribution.distribution)}
        </span>
        <strong>{headline}</strong>
        <small>
          {calculated
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
              <dt>To stakers</dt>
              <dd>{amount(toStakers)}</dd>
            </div>
            <div>
              <dt>Your fee</dt>
              <dd>
                {amount(feeShown)}
                {distribution.feeBips
                  ? ` · ${feePercent(distribution.feeBips)}${distribution.feeEvidence === "locked" ? " locked" : ""}`
                  : ""}
              </dd>
            </div>
          </>
        ) : (
          <>
            <div>
              <dt>Earned so far</dt>
              <dd>
                {rewards.estimateKind === "if-calculated-now" && rewards.estimatedPoolRewardSats
                  ? amount(rewards.estimatedPoolRewardSats)
                  : "—"}
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
        {cycle && cycleCalculated && cycleCalculated !== "0" ? (
          <div>
            <dt>Cycle {cycle.cycle} calculated</dt>
            <dd>{amount(cycleCalculated)}</dd>
          </div>
        ) : null}
      </dl>
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
        ) : state === "complete" ? (
          <a className="btn btn-tertiary" href={domainHash("rewards", "claims")}>
            Review payments
          </a>
        ) : (
          <a className="btn btn-tertiary" href={domainHash("rewards", "outlook")}>
            View projection
          </a>
        )}
        <a className="btn btn-tertiary" href={dashboardHash("rewards")}>
          Open Rewards
        </a>
      </div>
    </section>
  );
}
