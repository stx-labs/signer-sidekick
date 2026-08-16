import type { EngineJobDetail, EngineStatus } from "@stx-labs/signer-sidekick-api-contracts";
import { useMemo, useState } from "react";
import { Field } from "../../shared/dashboard-ui.js";
import { isStacksAddressForNetwork } from "../../shared/principal.js";
import { browserWalletIntentNetwork } from "./browser-wallet.js";
import { BrowserWalletActionPanel } from "./browser-wallet-action.js";

const claimAdapterId = "reference-manager-claim-rewards";

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
  const actorValid = walletNetwork !== null && isStacksAddressForNetwork(actor, walletNetwork);
  const eligible =
    isWalletClaimJobEligible(job, status) &&
    walletNetwork !== null &&
    isStacksAddressForNetwork(
      job.review.managerPrincipal.slice(0, job.review.managerPrincipal.indexOf(".")),
      walletNetwork,
    );
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
        <h3>Claim with browser wallet</h3>
        <p className="muted">
          Any Stacks account can pay for this claim. Enter the signing account, then review the
          transaction.
        </p>
      </div>
      <Field
        label="Signing account"
        help="This account pays the transaction fee; manager-admin authority is not required."
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
        You can also use the reviewed transaction details with another signing tool.
      </p>
    </section>
  );
}
