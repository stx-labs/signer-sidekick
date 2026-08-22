import { ArrowRight } from "@phosphor-icons/react";
import type {
  GasWalletStatus,
  OverviewPage,
  RewardLedger,
} from "@stx-labs/signer-sidekick-api-contracts";
import { useEffect, useState } from "react";
import { dashboardHash, domainHash } from "../../dashboard-route.js";
import { Badge } from "../../shared/dashboard-ui.js";
import { amount, feePercent } from "../../shared/format.js";
import { loadEngineStatus } from "../operations/engine-api.js";
import { loadRewardLedger } from "../rewards/reward-ledger-api.js";
import {
  currentDistribution,
  deriveRewardNow,
  distributionName,
  type RewardNowModel,
} from "../rewards/reward-state.js";
import { PENDING_RUN_STORAGE_KEY } from "../rewards/rewards-page.js";
import { loadGasWalletStatus } from "../settings/gas-wallet-api.js";

const CARD_POLL_MS = 30_000;

type CardState = "ready" | "accruing" | "distributing" | "complete" | "attention" | "overdue";

function cardState(model: RewardNowModel, ledger: RewardLedger): CardState {
  const distribution = currentDistribution(ledger);
  if (!distribution) return "accruing";
  if (model.progress) return "distributing";
  switch (distribution.status) {
    case "needs-attention":
      return "attention";
    case "calculation-overdue":
      return "overdue";
    case "ready":
      return "ready";
    case "distributing":
      return "distributing";
    case "all-distributed":
    case "complete":
      return "complete";
    default:
      return "accruing";
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
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    void generatedAt;
    const controller = new AbortController();
    const load = () => {
      loadRewardLedger(token, {}, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) {
            setLedger(result);
            setFailed(false);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(true);
        });
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

  if (!ledger) return <>{failed ? fallback : fallback}</>;
  const model = deriveRewardNow({ ledger, snapshot: null, gasWallet, engineMode, activeRun: null });
  const distribution = currentDistribution(ledger);
  if (!model || !distribution) return <>{fallback}</>;
  const state = cardState(model, ledger);
  const cycle = ledger.cycles.find((entry) => entry.cycle === ledger.current.cycle) ?? null;
  const calculated = distribution.calculation.state === "done";
  const primaryAction = model.primary;
  const startRun = () => {
    if (primaryAction) sessionStorage.setItem(PENDING_RUN_STORAGE_KEY, primaryAction.kind);
    location.hash = domainHash("rewards", "calculation");
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
  return (
    <section
      className="card overview-domain rw-overview-card"
      id="overview-rewards"
      aria-labelledby="overview-rewards-heading"
    >
      <div className="card-head">
        <h2 id="overview-rewards-heading">{titles[state]}</h2>
        <Badge state={model.badge.tone}>{model.badge.label}</Badge>
      </div>
      <div className="overview-domain-primary">
        <span>
          Cycle {ledger.current.cycle} · {distributionName(ledger.current.distribution)}
        </span>
        <strong>{model.headline}</strong>
        <small>
          {calculated
            ? `${amount(distribution.calculation.poolSats)} calculated for this pool · ${distribution.payments.outstanding > 0 ? `${distribution.payments.outstanding} payments waiting` : `${distribution.payments.made} payments made`}`
            : rewards.estimatedPoolRewardSats
              ? `projected ${amount(rewards.estimatedPoolRewardSats)} for this pool · ${rewards.confidence === "unavailable" ? "projection unavailable" : `${rewards.confidence} confidence`}`
              : "projection unavailable"}
        </small>
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
                disabled={!model.execution.available}
                title={
                  model.execution.available ? undefined : (model.execution.reason ?? undefined)
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
          <a className="btn btn-tertiary" href={domainHash("rewards", "calculation")}>
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
