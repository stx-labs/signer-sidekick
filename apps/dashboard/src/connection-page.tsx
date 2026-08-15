import {
  ArrowClockwise,
  CheckCircle,
  Copy,
  DownloadSimple,
  ShieldCheck,
  WarningCircle,
} from "@phosphor-icons/react";
import type { ConnectionAssessment } from "@stx-labs/signer-sidekick-api-contracts";
import { useState } from "react";
import { apiDownload } from "./api-client.js";
import { connectionPresentation } from "./connection-presentation.js";
import { dashboardHash } from "./dashboard-route.js";
import { DOCUMENT_LINKS } from "./shared/document-links.js";

export function ConnectionPage({
  assessment,
  checking,
  error,
  token,
  onRecheck,
}: {
  assessment: ConnectionAssessment | null;
  checking: boolean;
  error: string | null;
  token: string;
  onRecheck(): Promise<void>;
}) {
  const [supportError, setSupportError] = useState<string | null>(null);
  const presentation = connectionPresentation(assessment);
  const configured = assessment?.configured;
  const stored = assessment?.deploymentIdentity.stored;
  const copyPrincipal = async () => {
    if (configured) await navigator.clipboard.writeText(configured.managerPrincipal);
  };
  const downloadSupport = async () => {
    setSupportError(null);
    try {
      await apiDownload(token, "/api/v1/support-bundle", {
        expectedContentTypes: ["application/json"],
        fallbackFilename: "signer-sidekick-support.json",
      });
    } catch {
      setSupportError("Could not download the support snapshot. Recheck the Sidekick logs.");
    }
  };

  return (
    <main className="connection-shell" data-network={configured?.network ?? "mainnet"}>
      <section className="connection-card card-standout" aria-live="polite">
        <div className="connection-brand-mark">
          {assessment?.status === "connected" ? <CheckCircle /> : <ShieldCheck />}
        </div>
        <p className="eyebrow">SIGNER SIDEKICK</p>
        <h1>{assessment ? presentation.title : "Connect Sidekick to your signer"}</h1>
        {!assessment ? (
          <p>
            Sidekick monitors an existing PoX-5 signer and signer-manager contract. This check is
            read-only. Sidekick will not deploy contracts, register a signer, move funds, or access
            private keys.
          </p>
        ) : (
          <p>{presentation.detail}</p>
        )}

        {error ? (
          <div className="callout callout-critical" role="alert">
            <WarningCircle className="ic" />
            <div className="body">{error}</div>
          </div>
        ) : null}

        {assessment ? (
          <ul className="connection-checks" aria-label="Connection checks">
            {assessment.checks.map((check) => (
              <li className={`connection-check connection-check-${check.status}`} key={check.id}>
                {check.status === "pass" ? <CheckCircle /> : <WarningCircle />}
                <div>
                  <strong>{check.id.replaceAll("-", " ")}</strong>
                  <span>{check.message}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="connection-checking" role="status">
            <ArrowClockwise className="spin" />
            <span>{presentation.detail}</span>
          </div>
        )}

        {assessment?.stale && stored ? (
          <div className="callout callout-caution">
            <div className="body">
              <strong>Last proved connection retained</strong>
              <span>
                Verified {new Date(stored.lastVerifiedAt).toLocaleString()} at Stacks block
                {` ${stored.lastStacksTipHeight.toLocaleString()}`} and Bitcoin block
                {` ${stored.lastBurnBlockHeight.toLocaleString()}`}.
              </span>
            </div>
          </div>
        ) : null}

        {configured ? (
          <dl className="connection-identity">
            <div>
              <dt>Configured network</dt>
              <dd className="mono">{configured.network}</dd>
            </div>
            <div>
              <dt>Configured manager</dt>
              <dd className="mono">{configured.managerPrincipal}</dd>
            </div>
            {stored ? (
              <>
                <div>
                  <dt>Stored network</dt>
                  <dd className="mono">{stored.network}</dd>
                </div>
                <div>
                  <dt>Stored manager</dt>
                  <dd className="mono">{stored.managerPrincipal}</dd>
                </div>
              </>
            ) : null}
          </dl>
        ) : null}

        <div className="connection-actions">
          <button
            className="btn btn-accent"
            disabled={checking}
            onClick={() => void onRecheck()}
            type="button"
          >
            <ArrowClockwise className={checking ? "spin" : ""} />
            {checking ? "Checking…" : "Recheck"}
          </button>
          {presentation.showZeroToSigning ? (
            <a
              className="btn btn-secondary"
              href={DOCUMENT_LINKS.zeroToSigning}
              rel="noreferrer"
              target="_blank"
            >
              Open Zero to Signing
            </a>
          ) : null}
          {configured ? (
            <button className="btn btn-tertiary" onClick={() => void copyPrincipal()} type="button">
              <Copy /> Copy configured principal
            </button>
          ) : null}
          <button className="btn btn-tertiary" onClick={() => void downloadSupport()} type="button">
            <DownloadSimple /> Download support snapshot
          </button>
          {assessment?.outcomeCode === "deployment-identity-mismatch" ? (
            <>
              <a className="btn btn-tertiary" href={dashboardHash("activity")}>
                Review Activity
              </a>
              <a className="btn btn-tertiary" href={dashboardHash("health")}>
                Review signer health
              </a>
              <a className="btn btn-tertiary" href={dashboardHash("settings")}>
                Review settings
              </a>
            </>
          ) : null}
        </div>
        {presentation.showZeroToSigning ? (
          <small className="connection-restart-note">
            Manual fallback: deploy the{" "}
            <a href={DOCUMENT_LINKS.referenceManager} rel="noreferrer" target="_blank">
              pinned upstream signer-manager
            </a>{" "}
            using the{" "}
            <a href={DOCUMENT_LINKS.clarinetDeployment} rel="noreferrer" target="_blank">
              Stacks contract deployment guide
            </a>
            , complete its public authorization calls, then configure the deployed principal here.
          </small>
        ) : null}
        {supportError ? <small className="connection-support-error">{supportError}</small> : null}
        <small className="connection-restart-note">
          Configuration changes take effect after Sidekick restarts. Recheck repeats only the public
          reads shown above.
        </small>
      </section>
    </main>
  );
}
