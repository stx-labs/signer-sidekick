import { ArrowClockwise, Check, DownloadSimple, ShieldCheck } from "@phosphor-icons/react";
import {
  type PoolCardArtifact,
  poolCardResponseSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError, apiJson } from "../../api-client.js";
import { CopyableIdentifier, CopyIdentifierButton } from "../../copyable-identifier.js";
import { dashboardHash } from "../../dashboard-route.js";
import { PageHead, StatusBadge } from "../../shared/dashboard-ui.js";
import { formatUstx } from "../../shared/format.js";
import { operatorActionError } from "../../shared/operator-error.js";

export function poolCardSetupRequired(cause: unknown): boolean {
  return cause instanceof ApiRequestError && cause.code === "pool_setup_not_complete";
}

export function PoolCardError({
  error,
  setupRequired,
  onRetry,
}: {
  error: string | null;
  setupRequired: boolean;
  onRetry: () => void;
}) {
  if (!error) return null;
  return (
    <div className="callout callout-critical" role="alert">
      <div className="body">
        {error}
        <div className="actions">
          {setupRequired ? (
            <button
              type="button"
              className="btn btn-accent sm"
              onClick={() => {
                location.hash = dashboardHash("setup");
              }}
            >
              Open Initial Setup
            </button>
          ) : null}
          <button type="button" className="btn btn-secondary sm" onClick={onRetry}>
            Retry
          </button>
        </div>
      </div>
    </div>
  );
}

export function EnrollmentPage({ token }: { token: string }) {
  const [mode, setMode] = useState<"live" | "static">("live");
  const [artifact, setArtifact] = useState<PoolCardArtifact | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupRequired, setSetupRequired] = useState(false);
  const generationController = useRef<AbortController | null>(null);

  const generate = useCallback(async () => {
    generationController.current?.abort();
    const controller = new AbortController();
    generationController.current = controller;
    setBusy(true);
    setError(null);
    setSetupRequired(false);
    try {
      const result = await apiJson(token, "/api/v1/pool-card/generate", poolCardResponseSchema, {
        method: "POST",
        body: JSON.stringify({ mode }),
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setArtifact(result);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setSetupRequired(poolCardSetupRequired(cause));
        setError(
          operatorActionError(cause, "Could not generate the pool card", "Retrying is safe"),
        );
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
        lede="Generate a pool card to publish on your website."
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
      <PoolCardError error={error} setupRequired={setupRequired} onRetry={() => void generate()} />
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
            ? "Updates reward cycle and Bitcoin height when the page loads."
            : "Uses the values generated now and makes no network requests."}
        </p>
      </div>
      <div className="grid cols-3-2 embed-grid">
        <div className="card">
          <div className="card-head">
            <h2>{mode === "live" ? "Live pool card" : "Static pool card"}</h2>
            <CopyIdentifierButton value={artifact?.body} label="pool card HTML" showLabel />
          </div>
          <pre className="code">{artifact?.body ?? "Generating pool card"}</pre>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Included in the download</h2>
          </div>
          <div className="actions-list">
            <div className="action-item">
              <div className="ic">
                <Check />
              </div>
              <div className="body">
                <div className="t">Pool information</div>
                <div className="m">Name, website, support, and enrollment link.</div>
              </div>
            </div>
            <div className="action-item">
              <div className="ic">
                <Check />
              </div>
              <div className="body">
                <div className="t">On-chain information</div>
                <div className="m">Manager, signer public key, fee, cycle, and eligibility.</div>
              </div>
            </div>
            <div className="action-item">
              <div className="ic">
                <ShieldCheck />
              </div>
              <div className="body">
                <div className="t">Not included</div>
                <div className="m">Credentials and local operational data.</div>
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
