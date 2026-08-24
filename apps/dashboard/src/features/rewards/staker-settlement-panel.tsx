import { stakerClaimsResponseSchema } from "@stx-labs/signer-sidekick-api-contracts";
import { useState } from "react";
import { apiJson } from "../../api-client.js";
import { CopyableIdentifier } from "../../copyable-identifier.js";
import { actionHash } from "../../dashboard-route.js";
import { Badge, StatLine } from "../../shared/dashboard-ui.js";
import { sbtc, short } from "../../shared/format.js";
import { operatorErrorSentence } from "../../shared/operator-error.js";

/**
 * Browser-wallet settlement (Observe mode): the operator signs each staker payment with their
 * own wallet. Kept behind the Now card's "Use your wallet" path; operator-run runs replace it.
 */

export function RequestState({
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

type StakerClaimsResponse = ReturnType<typeof stakerClaimsResponseSchema.parse>;

/** Every reason mirrors a guard the wallet-intent preparation applies before building a call. */
function blockedLabel(reason: string | null): string {
  if (reason === "manager-has-not-claimed") return "Manager has not claimed this bucket";
  if (reason === "l1-below-max-fee") return "Below withdrawal fee";
  if (reason === "l1-below-dust-limit") return "Below withdrawal dust limit";
  return "Nothing settled";
}

export function StakerSettlementPanel({
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
