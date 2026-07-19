import type { EngineJobDetail, EngineStatus } from "@stx-labs/signer-sidekick-api-contracts";
import { useMemo, useState } from "react";
import { Field } from "../../shared/dashboard-ui.js";
import { browserWalletIntentNetwork } from "../setup/browser-wallet.js";
import { BrowserWalletActionPanel } from "../setup/browser-wallet-action.js";

const claimAdapterId = "reference-manager-claim-rewards";
const standardPrincipalPattern = /^S[PMTN][0-9A-Z]{20,50}$/;

export function isWalletClaimJobEligible(job: EngineJobDetail, status: EngineStatus): boolean {
  const adapter = status.adapters.find(({ adapter }) => adapter.id === claimAdapterId);
  return Boolean(
    job.mode === "observe" &&
      status.mode === "observe" &&
      !status.forcedObserve.active &&
      job.state === "preflighted" &&
      job.review.adapter.id === claimAdapterId &&
      job.review.adapter.revision === 1 &&
      job.review.call.functionName === "claim-rewards" &&
      job.review.call.contract === job.review.managerPrincipal &&
      job.approval === null &&
      job.nonce === null &&
      job.attempts.length === 0 &&
      adapter?.enabled &&
      adapter.availability === "available",
  );
}

function principalMatchesNetwork(principal: string, network: string): boolean {
  return network === "mainnet" ? /^S[PM]/.test(principal) : /^S[TN]/.test(principal);
}

export function EngineWalletClaim({
  chainId,
  job,
  network,
  status,
  token,
}: {
  chainId: number;
  job: EngineJobDetail;
  network: string;
  status: EngineStatus;
  token: string;
}) {
  const [actorPrincipal, setActorPrincipal] = useState("");
  const walletNetwork = browserWalletIntentNetwork(network);
  const actor = actorPrincipal.trim().toUpperCase();
  const actorValid =
    standardPrincipalPattern.test(actor) &&
    walletNetwork !== null &&
    principalMatchesNetwork(actor, walletNetwork);
  const eligible =
    isWalletClaimJobEligible(job, status) &&
    walletNetwork !== null &&
    principalMatchesNetwork(job.review.managerPrincipal, walletNetwork);
  const request = useMemo(
    () =>
      actorValid
        ? ({ action: "claim-rewards", actorPrincipal: actor, jobId: job.jobId } as const)
        : null,
    [actor, actorValid, job.jobId],
  );

  if (!eligible || !walletNetwork) return null;
  return (
    <section className="engine-wallet-claim" aria-label="External wallet claim">
      <div>
        <h3>Execute with a browser wallet</h3>
        <p className="muted">
          Any standard Stacks account can pay for this public claim call. Sidekick binds the exact
          Observe job and verifies the transaction independently; Leather signs because the claim
          includes an asset post-condition.
        </p>
      </div>
      <Field
        label="Wallet payer"
        help="This address pays the STX transaction fee. It does not need manager-admin authority."
      >
        <input
          className="input mono"
          autoComplete="off"
          placeholder={walletNetwork === "mainnet" ? "SP…" : "ST…"}
          value={actorPrincipal}
          onChange={(event) => setActorPrincipal(event.target.value.toUpperCase())}
        />
        {actorPrincipal && !actorValid ? (
          <span className="field-error">Enter a valid Stacks account principal.</span>
        ) : null}
      </Field>
      {request ? (
        <BrowserWalletActionPanel
          key={`${job.jobId}:${actor}`}
          chainId={chainId}
          createRequest={request}
          intentApiBase="/api/v1/wallet-intents"
          managerPrincipal={job.review.managerPrincipal}
          network={walletNetwork}
          token={token}
        />
      ) : null}
      <p className="muted">
        You may instead use the exact contract call, arguments, and post-condition shown in the
        reviewed job with another signing tool.
      </p>
    </section>
  );
}
