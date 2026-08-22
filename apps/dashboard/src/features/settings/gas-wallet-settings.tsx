import { ArrowClockwise, Copy, Wallet } from "@phosphor-icons/react";
import type { GasWalletStatus, GasWalletSweep } from "@stx-labs/signer-sidekick-api-contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, ErrorCallout, StatLine } from "../../shared/dashboard-ui.js";
import { short, shortUtc, stxAmount } from "../../shared/format.js";
import { operatorErrorSentence } from "../../shared/operator-error.js";
import {
  approveGasWalletSweep,
  cancelGasWalletSweep,
  createGasWallet,
  disableGasWallet,
  enableGasWallet,
  loadGasWalletStatus,
  prepareGasWalletSweep,
  refreshGasWalletSweep,
} from "./gas-wallet-api.js";

const SWEEP_POLL_MS = 10_000;

function signerBadge(status: GasWalletStatus): {
  tone: "success" | "caution" | "error" | "neutral";
  label: string;
} {
  if (!status.configured) return { tone: "neutral", label: "Not set up" };
  if (status.engineMode !== "operator-run") return { tone: "caution", label: "Observe mode" };
  switch (status.signer) {
    case "ready":
      return { tone: "success", label: "Ready" };
    case "disabled":
      return { tone: "neutral", label: "Disabled" };
    case "unreadable":
      return { tone: "error", label: "Key unreadable" };
    case "engine-unavailable":
      return { tone: "error", label: "Engine unavailable" };
    default:
      return { tone: "caution", label: "Not loaded" };
  }
}

function sweepBadge(sweep: GasWalletSweep): {
  tone: "success" | "caution" | "error" | "neutral" | "info";
  label: string;
} {
  switch (sweep.status) {
    case "planned":
      return { tone: "info", label: "Awaiting your approval" };
    case "broadcast":
      return {
        tone: "info",
        label: sweep.broadcastAmbiguous ? "Broadcast · confirming" : "Broadcast",
      };
    case "confirmed":
      return { tone: "success", label: "Confirmed" };
    case "failed":
      return { tone: "error", label: "Failed" };
    case "cancelled":
      return { tone: "neutral", label: "Cancelled" };
    case "expired":
      return { tone: "neutral", label: "Expired" };
  }
}

export function GasWalletSettings({
  token,
  readOnly = false,
}: {
  token: string;
  readOnly?: boolean;
}) {
  const [status, setStatus] = useState<GasWalletStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [recipient, setRecipient] = useState("");
  const [copied, setCopied] = useState(false);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    try {
      const result = await loadGasWalletStatus(token, request.signal);
      if (request.signal.aborted) return;
      setUnavailable(result === null);
      setStatus(result);
      setError(null);
    } catch (cause) {
      if (!request.signal.aborted) setError(operatorErrorSentence(cause));
    } finally {
      if (controller.current === request) setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
    return () => controller.current?.abort();
  }, [load]);

  const activeSweep =
    status?.sweeps.find((sweep) => sweep.sweepId === status.activeSweepId) ?? null;
  useEffect(() => {
    if (activeSweep?.status !== "broadcast") return;
    const interval = window.setInterval(() => {
      refreshGasWalletSweep(token, activeSweep.sweepId)
        .then(() => load())
        .catch(() => undefined);
    }, SWEEP_POLL_MS);
    return () => window.clearInterval(interval);
  }, [activeSweep, load, token]);

  const act = (label: string, operation: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    operation()
      .then(() => load())
      .catch((cause: unknown) => setError(operatorErrorSentence(cause)))
      .finally(() => setBusy(null));
  };

  const copy = async () => {
    if (!status?.principal) return;
    try {
      await navigator.clipboard.writeText(status.principal);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  if (loading && !status) {
    return (
      <section className="card set-section" id="gas-wallet" aria-labelledby="gas-wallet-title">
        <div className="card-head">
          <h2 id="gas-wallet-title">Gas wallet</h2>
        </div>
        <p className="tertiary" role="status">
          Loading the gas wallet…
        </p>
      </section>
    );
  }
  if (unavailable || !status) {
    return (
      <section className="card set-section" id="gas-wallet" aria-labelledby="gas-wallet-title">
        <div className="card-head">
          <h2 id="gas-wallet-title">Gas wallet</h2>
          <Badge state="neutral">Unavailable</Badge>
        </div>
        <p className="tertiary">This Sidekick build does not expose a gas wallet.</p>
        <ErrorCallout error={error} />
      </section>
    );
  }
  const badge = signerBadge(status);
  const observe = status.engineMode !== "operator-run";
  const estimate =
    status.estimatedTransactions === null
      ? "balance unavailable"
      : `about ${status.estimatedTransactions.toLocaleString("en-US")} transactions at the fee cap`;
  const refusal = status.refusal;
  const dedicatedCheck =
    refusal.refusalReason === null
      ? { tone: "success" as const, label: refusal.checkedAt ? "Passed" : "Not checked yet" }
      : refusal.refusalReason === "check-unavailable"
        ? { tone: "caution" as const, label: "Could not verify" }
        : { tone: "error" as const, label: "Refused" };
  const sweepAvailable =
    status.enabled && status.signer === "ready" && status.activeSweepId === null;

  if (!status.configured) {
    return (
      <section
        className="card-standout set-section"
        id="gas-wallet"
        aria-labelledby="gas-wallet-title"
      >
        <div className="card-head">
          <div>
            <h2 id="gas-wallet-title">Gas wallet</h2>
            <p className="muted">Not set up</p>
          </div>
          <Badge state="neutral">Optional</Badge>
        </div>
        <p
          style={{
            fontSize: 13,
            color: "var(--text-secondary)",
            margin: "0 0 14px",
            maxWidth: 640,
          }}
        >
          Create a small STX wallet that lives on this machine. Sidekick uses it only to pay gas for
          the permissionless reward calls when you click — it holds nothing else, and Sidekick
          checks before every run that it is not currently the signer or an admin. Without it, you
          keep signing each call with your own wallet.
        </p>
        {observe ? (
          <div className="callout callout-neutral" role="status">
            <div className="body">
              This Sidekick runs in Observe mode. Set <code>SIDEKICK_ENGINE_MODE=operator-run</code>{" "}
              and restart before enabling a gas wallet; you can create it now.
            </div>
          </div>
        ) : null}
        <div className="pill-row">
          <button
            className="btn btn-primary"
            type="button"
            disabled={readOnly || busy !== null}
            onClick={() => act("create", () => createGasWallet(token))}
          >
            {busy === "create" ? "Creating…" : "Create gas wallet"}
          </button>
        </div>
        <ErrorCallout error={error} />
      </section>
    );
  }

  return (
    <section
      className="card-standout set-section"
      id="gas-wallet"
      aria-labelledby="gas-wallet-title"
    >
      <div className="card-head">
        <div>
          <h2 id="gas-wallet-title">Gas wallet</h2>
          <p className="muted">
            {status.source === "generated"
              ? "Created on this machine · the key stays in Sidekick's data directory"
              : "Configured through the environment"}
          </p>
        </div>
        <Badge state={badge.tone}>{badge.label}</Badge>
      </div>
      <div className="rw-wallet-grid">
        <div>
          <div className="rw-wallet-address">
            <Wallet className="rw-ico" aria-hidden="true" />
            <span>{status.principal}</span>
            <button
              className="btn-icon"
              type="button"
              aria-label="Copy address"
              onClick={() => void copy()}
            >
              <Copy aria-hidden="true" />
            </button>
            {copied ? <span className="muted">copied</span> : null}
          </div>
          <StatLine label="Balance">
            {stxAmount(status.balanceUstx)}
            <span className="sub">
              {status.balanceError ? `balance unavailable: ${status.balanceError}` : estimate}
            </span>
          </StatLine>
          <StatLine label="Fee cap per transaction">{stxAmount(status.feeBasisUstx)}</StatLine>
          {status.secretFilePath ? (
            <StatLine label="Key file">
              <span className="identifier">{status.secretFilePath}</span>
              <span className="sub">
                owner-only · part of your host backups · losing it loses only gas
              </span>
            </StatLine>
          ) : null}
          {status.signerError ? (
            <StatLine label="Key status">
              <span className="sub">{status.signerError}</span>
            </StatLine>
          ) : null}
        </div>
        <div>
          <div className="callout callout-neutral">
            <div className="body">
              <strong>Fund it.</strong> Send STX to the address on the left from any wallet. Each
              transaction is capped at {stxAmount(status.feeBasisUstx)}; real fees are usually far
              lower.
            </div>
          </div>
          {observe ? (
            <div className="rw-setting-row">
              <span>
                Engine mode
                <span className="muted">
                  Observe — set SIDEKICK_ENGINE_MODE=operator-run and restart to enable runs
                </span>
              </span>
              <Badge state="caution">Observe</Badge>
            </div>
          ) : (
            <div className="rw-setting-row">
              <span>
                {status.enabled ? "Enabled" : "Disabled"}
                <span className="muted">
                  {status.enabled
                    ? "Sidekick can sign reward calls you approve"
                    : "Enable to let Sidekick sign reward calls you approve"}
                </span>
              </span>
              <button
                className="btn btn-secondary sm"
                type="button"
                disabled={readOnly || busy !== null}
                onClick={() =>
                  act(status.enabled ? "disable" : "enable", () =>
                    status.enabled ? disableGasWallet(token) : enableGasWallet(token),
                  )
                }
              >
                {busy === "enable"
                  ? "Enabling…"
                  : busy === "disable"
                    ? "Disabling…"
                    : status.enabled
                      ? "Disable"
                      : "Enable"}
              </button>
            </div>
          )}
          <div className="rw-setting-row">
            <span>
              Setup banner on Rewards
              <span className="muted">
                {status.banners.setupDismissedAt
                  ? `Dismissed ${shortUtc(status.banners.setupDismissedAt)}`
                  : "Shown until you dismiss it"}
              </span>
            </span>
          </div>
          <div className="rw-setting-row">
            <span>
              Dedicated-key check
              <span className="muted">
                Run before every signature · refuses if this address is currently the signer or a
                manager admin
              </span>
            </span>
            <Badge state={dedicatedCheck.tone}>{dedicatedCheck.label}</Badge>
          </div>
        </div>
      </div>
      <div className="divider" />
      <div className="rw-sweep">
        <div>
          <h3>Sweep remaining STX</h3>
          <p className="muted">
            Sends everything in the gas wallet except the network fee to an address you enter. Runs
            stay disabled until you fund it again. Not available while a run or another sweep is in
            progress.
          </p>
        </div>
        <div className="field">
          <label htmlFor="sweep-to">Send all remaining STX to</label>
          <div className="input-group">
            <input
              id="sweep-to"
              type="text"
              value={recipient}
              spellCheck={false}
              aria-describedby="sweep-help"
              placeholder={status.network === "mainnet" ? "SP…" : "ST…"}
              onChange={(event) => setRecipient(event.target.value)}
              disabled={readOnly || !sweepAvailable}
            />
            <span className="suffix">{status.network}</span>
          </div>
          <span className="help" id="sweep-help">
            {stxAmount(status.balanceUstx)} available · must be a standard {status.network} address,
            not a contract
          </span>
        </div>
        <div className="rw-sweep-action">
          <button
            className="btn btn-secondary"
            type="button"
            disabled={readOnly || busy !== null || !sweepAvailable || recipient.trim() === ""}
            onClick={() => act("sweep", () => prepareGasWalletSweep(token, recipient.trim()))}
          >
            {busy === "sweep" ? "Preparing…" : "Prepare sweep"}
          </button>
        </div>
      </div>
      {activeSweep ? (
        <div className="callout callout-info" role="status" style={{ marginTop: 16 }}>
          <div className="body">
            <strong>
              {activeSweep.status === "planned"
                ? "Sweep ready for your approval."
                : "Sweep broadcast."}
            </strong>{" "}
            {stxAmount(activeSweep.amountUstx)} to{" "}
            <span className="identifier">{short(activeSweep.recipient, 8, 6)}</span> · fee{" "}
            {stxAmount(activeSweep.feeUstx)}
            {activeSweep.status === "planned"
              ? ` · approve by ${shortUtc(activeSweep.expiresAt)}`
              : activeSweep.txid
                ? ` · ${short(activeSweep.txid, 8, 6)}`
                : ""}
            {activeSweep.status === "planned" ? (
              <div className="actions">
                <button
                  className="btn btn-primary sm"
                  type="button"
                  disabled={readOnly || busy !== null}
                  onClick={() =>
                    act("approve", () => approveGasWalletSweep(token, activeSweep.sweepId))
                  }
                >
                  {busy === "approve" ? "Sending…" : `Sweep ${stxAmount(activeSweep.amountUstx)}`}
                </button>
                <button
                  className="btn btn-tertiary sm"
                  type="button"
                  disabled={readOnly || busy !== null}
                  onClick={() =>
                    act("cancel", () => cancelGasWalletSweep(token, activeSweep.sweepId))
                  }
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="actions">
                <button
                  className="btn btn-tertiary sm"
                  type="button"
                  disabled={busy !== null}
                  onClick={() =>
                    act("refresh", () => refreshGasWalletSweep(token, activeSweep.sweepId))
                  }
                >
                  <ArrowClockwise aria-hidden="true" /> Check status
                </button>
              </div>
            )}
          </div>
        </div>
      ) : null}
      {status.sweeps.filter((sweep) => sweep.sweepId !== status.activeSweepId).length > 0 ? (
        <div className="tbl-wrap" style={{ marginTop: 16 }}>
          <table>
            <thead>
              <tr>
                <th scope="col">Sweep</th>
                <th scope="col">To</th>
                <th scope="col" className="right">
                  Amount
                </th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {status.sweeps
                .filter((sweep) => sweep.sweepId !== status.activeSweepId)
                .slice(0, 5)
                .map((sweep) => {
                  const sweepState = sweepBadge(sweep);
                  return (
                    <tr key={sweep.sweepId}>
                      <td className="mono">{shortUtc(sweep.createdAt)}</td>
                      <td className="mono" title={sweep.recipient}>
                        {short(sweep.recipient, 8, 6)}
                      </td>
                      <td className="mono right">{stxAmount(sweep.amountUstx)}</td>
                      <td>
                        <Badge state={sweepState.tone}>{sweepState.label}</Badge>
                        {sweep.failureReason ? (
                          <span className="rw-pay-sub">{sweep.failureReason}</span>
                        ) : null}
                        {sweep.txid ? (
                          <span className="rw-pay-sub">{short(sweep.txid, 8, 6)}</span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      ) : null}
      <ErrorCallout error={error} />
    </section>
  );
}
