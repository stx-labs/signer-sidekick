import { ArrowClockwise, Check, DownloadSimple, ShieldCheck } from "@phosphor-icons/react";
import {
  type PoolCardArtifact,
  poolCardResponseSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiJson } from "../../api-client.js";
import { CopyableIdentifier, CopyIdentifierButton } from "../../copyable-identifier.js";
import { dashboardHash } from "../../dashboard-route.js";
import { ErrorCallout, PageHead, StatusBadge } from "../../shared/dashboard-ui.js";
import { formatUstx } from "../../shared/format.js";

export function EnrollmentPage({ token }: { token: string }) {
  const [mode, setMode] = useState<"live" | "static">("live");
  const [artifact, setArtifact] = useState<PoolCardArtifact | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationController = useRef<AbortController | null>(null);

  const generate = useCallback(async () => {
    generationController.current?.abort();
    const controller = new AbortController();
    generationController.current = controller;
    setBusy(true);
    setError(null);
    try {
      const result = await apiJson(token, "/api/v1/pool-card/generate", poolCardResponseSchema, {
        method: "POST",
        body: JSON.stringify({ mode }),
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setArtifact(result);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, [mode, token]);

  useEffect(() => {
    void generate();
    return () => generationController.current?.abort();
  }, [generate]);

  const download = (format: "html" | "json") => {
    if (!artifact) return;
    const selected = format === "html" ? artifact : artifact.json;
    const url = URL.createObjectURL(new Blob([selected.body], { type: selected.contentType }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = selected.filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const enrollment = artifact?.enrollment;
  const current = enrollment?.eligibility.current;
  return (
    <>
      <PageHead
        title="Public Pool Page"
        lede="Generate an embeddable pool card for a website you already run. Sidekick hosts nothing and opens no public route."
        actions={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!artifact}
              onClick={() => download("html")}
            >
              <DownloadSimple /> Download .html
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!artifact}
              onClick={() => download("json")}
            >
              <DownloadSimple /> Download .json
            </button>
            <button
              type="button"
              className="btn btn-accent"
              disabled={busy}
              onClick={() => void generate()}
            >
              <ArrowClockwise /> Regenerate
            </button>
          </>
        }
      />
      <ErrorCallout error={error} />
      {error ? (
        <div className="callout callout-neutral" role="note">
          <div className="body">
            Pool card generation requires verified manager setup. If setup is incomplete, finish it
            before retrying.
            <div className="actions">
              <button
                type="button"
                className="btn btn-accent sm"
                onClick={() => {
                  location.hash = dashboardHash("setup");
                }}
              >
                Open Initial Setup
              </button>
              <button
                type="button"
                className="btn btn-secondary sm"
                onClick={() => void generate()}
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <div className="callout callout-info intro-callout">
        <ShieldCheck className="ic" />
        <div className="body">
          <strong>No public surface on this app.</strong> The artifact contains reviewed public pool
          facts only—never the API key, gas payer, jobs, alerts, or Sidekick database state.
        </div>
      </div>
      <div className="card-standout embed-mode">
        <div>
          <span className="muted">Embed type</span>
          <div className="seg">
            <button
              type="button"
              className={mode === "live" ? "on" : ""}
              disabled={busy}
              onClick={() => setMode("live")}
            >
              Live card
            </button>
            <button
              type="button"
              className={mode === "static" ? "on" : ""}
              disabled={busy}
              onClick={() => setMode("static")}
            >
              Static snapshot
            </button>
          </div>
        </div>
        <p className="tertiary">
          {mode === "live"
            ? "Refreshes reward cycle and Bitcoin block height from the configured unauthenticated public API. Verified pool identity and manager facts remain baked in."
            : "Baked HTML plus versioned JSON with current verified values and no runtime network request."}
        </p>
      </div>
      <div className="grid cols-3-2 embed-grid">
        <div className="card">
          <div className="card-head">
            <h2>{mode === "live" ? "Self-contained live HTML" : "Self-contained static HTML"}</h2>
            <CopyIdentifierButton value={artifact?.body} label="pool card HTML" showLabel />
          </div>
          <pre className="code">{artifact?.body ?? "Generating artifact"}</pre>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Artifact boundary</h2>
          </div>
          <div className="actions-list">
            <div className="action-item">
              <div className="ic">
                <Check />
              </div>
              <div className="body">
                <div className="t">Operator-maintained</div>
                <div className="m">Name, website, support, official enrollment link.</div>
              </div>
            </div>
            <div className="action-item">
              <div className="ic">
                <Check />
              </div>
              <div className="body">
                <div className="t">Verified public state</div>
                <div className="m">
                  Manager, signer public key, grant, fee, cycle, eligibility, source hash.
                </div>
              </div>
            </div>
            <div className="action-item">
              <div className="ic">
                <ShieldCheck />
              </div>
              <div className="body">
                <div className="t">Excluded</div>
                <div className="m">
                  Secrets, gas payer, transaction-engine jobs, transactions, alerts, and local
                  history.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="section-title">Preview</div>
      <div className="preview-frame">
        <div className="pv-bar">
          <span className="mono">your-site.example / stacking</span>
          <span className="badge b-neutral">embedded card</span>
        </div>
        <div className="pv-body">
          {enrollment ? (
            <>
              <div className="preview-title">
                <div>
                  <h2>{enrollment.pool.displayName}</h2>
                  <p>
                    <CopyableIdentifier
                      value={enrollment.manager.principal}
                      label="manager principal"
                      className="mono"
                    />
                  </p>
                  <p>
                    source{" "}
                    <CopyableIdentifier
                      value={enrollment.manager.sourceSha256}
                      label="manager source hash"
                      className="mono src src-chain"
                    />
                  </p>
                </div>
                <StatusBadge
                  status={enrollment.signer.grantValid ? "Grant valid" : "Grant not verified"}
                />
              </div>
              <div className="grid cols-2">
                <div className="card-standout">
                  <div className="statline">
                    <span className="k">Reward cycle</span>
                    <span className="v mono src src-chain">{enrollment.chain.rewardCycleId}</span>
                  </div>
                  <div className="statline">
                    <span className="k">Pool size</span>
                    <span className="v mono src src-chain">
                      {formatUstx(current?.delegatedUstx)} STX
                    </span>
                  </div>
                </div>
                <div className="card-standout">
                  <div className="statline">
                    <span className="k">Eligibility</span>
                    <span className="v src src-chain">
                      <StatusBadge
                        status={
                          current?.meetsThreshold && current.inSignerSet
                            ? "Eligible"
                            : "Needs attention"
                        }
                      />
                    </span>
                  </div>
                  <div className="statline">
                    <span className="k">Configured fee</span>
                    <span className="v mono">
                      {(enrollment.fee.currentConfiguredBips / 100).toFixed(2)}%
                    </span>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="loading-state">Preview unavailable</div>
          )}
        </div>
      </div>
    </>
  );
}
