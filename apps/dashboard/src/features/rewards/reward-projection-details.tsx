import { CaretRight } from "@phosphor-icons/react";
import type {
  DashboardSnapshot,
  RewardCalculationRealization,
} from "@stx-labs/signer-sidekick-api-contracts";
import { CopyableIdentifier } from "../../copyable-identifier.js";
import { Badge, StatLine } from "../../shared/dashboard-ui.js";
import { amount, number, short } from "../../shared/format.js";

const rewardTerms = {
  network:
    "Total sBTC accumulated by PoX-5 for the next network calculation, shared across eligible signers and pools.",
  pool: "Estimated amount allocated to this signer-manager before operator fees.",
  fee: "Estimated portion earned by this pool operator, using per-staker and per-bucket integer rounding.",
  net: "Estimated amount remaining for this pool's stakers after operator fees.",
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

export function poolEstimateUnavailableDetail(
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

export function rewardForecastUnavailableDetail(
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
      return "The cumulative reward balance decreased, which can happen when canonical chain history changes. Sidekick is collecting a fresh forecast window.";
    case "forecast-inputs-unavailable":
      return "The durable observation window could not be read safely.";
    case "contract-simulation-failed":
      return "A projected bound could not produce a valid PoX-5 integer calculation.";
    case null:
      return "The checkpoint forecast is unavailable.";
  }
}

/**
 * Collapsed disclosure under the Now card (plan §6): how the projection is made and how it has done.
 * Carries the projection content that used to head the page, so nothing the operator relied on
 * disappears — it just stops competing with the status line.
 */
export function ProjectionDetails({
  snapshot,
  realizations,
  nextCalculationIn,
}: {
  snapshot: DashboardSnapshot;
  realizations: readonly RewardCalculationRealization[];
  nextCalculationIn: string | null;
}) {
  const rewards = snapshot.rewards;
  const outlook = snapshot.rewardOutlook ?? null;
  const calculation = outlook?.calculation ?? rewards?.calculation ?? null;
  const globalAccruedSats =
    outlook?.accrued.globalSats ?? rewards?.global.globalAccruedRewardsSats ?? null;
  const poolEstimate = outlook?.poolEstimate ?? null;
  const forecast = outlook?.forecast ?? null;
  const operatorFeeForecast = outlook?.operatorFeeForecast ?? null;
  const operatorFeeEstimate = outlook?.operatorFeeEstimate ?? null;
  const calibration = outlook?.calibration ?? null;
  const evaluated = realizations.filter((r) => r.evaluation !== null).slice(0, 6);
  return (
    <details className="card rw-details domain-section-anchor" id="rewards-outlook">
      <summary>
        <CaretRight aria-hidden="true" />
        Projection details &amp; accuracy
      </summary>
      <div className="rw-details-body">
        <div>
          <h4>This projection</h4>
          <StatLine
            label={
              <RewardTerm label="Network-wide rewards accrued so far" help={rewardTerms.network} />
            }
          >
            <span className="btc-value src src-chain">
              {globalAccruedSats === null ? "Unavailable" : amount(globalAccruedSats)}
            </span>
          </StatLine>
          <StatLine label="Projected network-wide at calculation">
            {forecast ? amount(forecast.globalSats.point) : "Unavailable"}
          </StatLine>
          <StatLine
            label={<RewardTerm label="Your pool — if calculated now" help={rewardTerms.pool} />}
          >
            {poolEstimate ? amount(poolEstimate.grossSats) : "Unavailable"}
          </StatLine>
          <StatLine label="Your pool — projected range">
            {forecast ? (
              <span className="mono">
                {amount(forecast.poolSats.low)} – {amount(forecast.poolSats.high)}
              </span>
            ) : (
              "Unavailable"
            )}
          </StatLine>
          <StatLine label={<RewardTerm label="Operator fee" help={rewardTerms.fee} />}>
            {operatorFeeForecast
              ? amount(operatorFeeForecast.sats.point)
              : operatorFeeEstimate
                ? amount(operatorFeeEstimate.sats)
                : "Unavailable"}
          </StatLine>
          <StatLine label={<RewardTerm label="Net for your stakers" help={rewardTerms.net} />}>
            {forecast && operatorFeeForecast
              ? amount(subtractSats(forecast.poolSats.point, operatorFeeForecast.sats.point) ?? "0")
              : poolEstimate && operatorFeeEstimate
                ? amount(subtractSats(poolEstimate.grossSats, operatorFeeEstimate.sats) ?? "0")
                : "Unavailable"}
          </StatLine>
          {poolEstimate ? (
            <StatLine label="Pool allocation — STX / Bitcoin bonds">
              <span className="mono">
                {amount(poolEstimate.stxSats)} / {amount(poolEstimate.bondSats)}
              </span>
            </StatLine>
          ) : null}
          <StatLine label="Basis">
            <span className="sub">
              {forecast
                ? `${forecast.confidence} confidence · ${forecast.sample.observations} observations across ${forecast.sample.sampleBlocks} Bitcoin blocks`
                : rewardForecastUnavailableDetail(
                    outlook?.forecastUnavailableReason ?? "forecast-inputs-unavailable",
                  )}
            </span>
          </StatLine>
          {!poolEstimate ? (
            <StatLine label="Current estimate">
              <span className="sub">
                {poolEstimateUnavailableDetail(
                  outlook?.poolEstimateUnavailableReason ?? "anchored-inputs-unavailable",
                )}
              </span>
            </StatLine>
          ) : null}
          <StatLine label="Next calculation">
            <span className="sub">
              {calculation?.next
                ? calculation.next.state === "due"
                  ? `cycle ${calculation.next.targetRewardCycle} ${calculation.next.targetCheckpoint} · eligible now`
                  : `cycle ${calculation.next.targetRewardCycle} ${calculation.next.targetCheckpoint} · in ${number(String(calculation.next.blocksRemaining))} Bitcoin blocks${nextCalculationIn ? ` · about ${nextCalculationIn}` : ""}`
                : "a valid anchored PoX-5 checkpoint is required"}
            </span>
          </StatLine>
          <StatLine label="Model">
            <span className="sub">
              revision {calibration?.modelRevision ?? 1} · {calibration?.status ?? "collecting"} ·{" "}
              {calibration?.eligibleRealizations ?? 0} of{" "}
              {calibration?.requirements.realizations ?? 6} realized calculations
            </span>
          </StatLine>
        </div>
        <div>
          <h4>Projected → got</h4>
          <div className="tbl-wrap rw-accuracy">
            <table>
              <thead>
                <tr>
                  <th scope="col">Distribution</th>
                  <th scope="col" className="right">
                    Got
                  </th>
                  <th scope="col" className="right">
                    Δ
                  </th>
                  <th scope="col">Range</th>
                  <th scope="col">Tx</th>
                </tr>
              </thead>
              <tbody>
                {evaluated.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="tertiary">
                      No node-verified calculation has closed a recorded projection yet.
                    </td>
                  </tr>
                ) : (
                  evaluated.map((realization) => {
                    const bips = realization.evaluation?.pointErrorBips;
                    return (
                      <tr key={`${realization.txId}:${realization.eventIndex}`}>
                        <td>
                          Cycle {realization.targetRewardCycle} ·{" "}
                          {realization.targetCheckpoint === "first-half" ? "First" : "Second"}
                        </td>
                        <td className="mono right">
                          {realization.poolSats === null ? "—" : amount(realization.poolSats)}
                        </td>
                        <td
                          className={`mono right ${realization.evaluation?.rangeContainsActual ? "delta-up" : "delta-down"}`}
                        >
                          {bips === null || bips === undefined
                            ? "—"
                            : `±${(Number(bips) / 100).toFixed(1)}%`}
                        </td>
                        <td>
                          {realization.evaluation ? (
                            <Badge
                              state={
                                realization.evaluation.rangeContainsActual ? "success" : "caution"
                              }
                            >
                              {realization.evaluation.rangeContainsActual ? "Inside" : "Outside"}
                            </Badge>
                          ) : (
                            <Badge state="neutral">—</Badge>
                          )}
                        </td>
                        <td>
                          <CopyableIdentifier
                            value={realization.txId}
                            display={short(realization.txId, 6, 4)}
                            label="reward calculation transaction"
                            className="mono"
                          />
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </details>
  );
}
