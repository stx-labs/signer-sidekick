import { ArrowClockwise, Copy, Wallet } from "@phosphor-icons/react";
import type { GasWalletStatus, GasWalletSweep } from "@stx-labs/signer-sidekick-api-contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, ErrorCallout } from "../../shared/dashboard-ui.js";
import { short, shortUtc, stxAmount } from "../../shared/format.js";
import { operatorErrorSentence } from "../../shared/operator-error.js";
import {
  approveGasWalletSweep,
  cachedGasWalletStatus,
  cancelGasWalletSweep,
  createGasWallet,
  disableGasWallet,
  enableGasWallet,
  loadGasWalletStatus,
  prepareGasWalletSweep,
  refreshGasWalletSweep,
} from "./gas-wallet-api.js";
import { SettingsInfo, SettingsRow } from "./settings-ui.js";

const SWEEP_POLL_MS = 10_000;

function signerBadge(status: GasWalletStatus): {
  tone: "success" | "caution" | "error" | "neutral";
  label: string;
} {
  if (!status.configured) return { tone: "neutral", label: "Optional" };
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
      return { tone: "info", label: "Awaiting approval" };
    case "broadcast":
      return { tone: "info", label: sweep.broadcastAmbiguous ? "Confirming" : "Broadcast" };
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

function afterFee(balance: string | null, fee: string): string | null {
  if (balance === null) return null;
  const remaining = BigInt(balance) - BigInt(fee);
  return remaining > 0n ? remaining.toString() : "0";
}

/** Embedded gas-wallet block for the unified Reward runs Settings card. */
export function GasWalletSettings({
  onStatus,
  token,
  readOnly = false,
}: {
  onStatus?: (status: GasWalletStatus | null) => void;
  token: string;
  readOnly?: boolean;
}) {
  const cachedStatus = cachedGasWalletStatus();
  const [status, setStatus] = useState<GasWalletStatus | null>(cachedStatus ?? null);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(cachedStatus === undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [recipient, setRecipient] = useState("");
  const [copied, setCopied] = useState(false);
  const [sweepOpen, setSweepOpen] = useState(false);
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
      onStatus?.(result);
      setError(null);
    } catch (cause) {
      if (!request.signal.aborted) setError(operatorErrorSentence(cause));
    } finally {
      if (controller.current === request) setLoading(false);
    }
  }, [onStatus, token]);

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
      <SettingsRow
        name="Gas wallet"
        status="Loading"
        value={<span className="muted">Loading gas wallet</span>}
      />
    );
  }
  if (unavailable || !status) {
    return (
      <>
        <SettingsRow
          name="Gas wallet"
          status="Unavailable"
          value={<span className="muted">This Sidekick build does not expose a gas wallet</span>}
        />
        <ErrorCallout error={error} />
      </>
    );
  }
  const badge = signerBadge(status);
  const observe = status.engineMode !== "operator-run";
  const estimate =
    status.estimatedTransactions === null
      ? "balance unavailable"
      : `≈ ${status.estimatedTransactions.toLocaleString("en-US")} transactions at the fee cap`;
  const refusal = status.refusal;
  const dedicatedCheck =
    refusal.refusalReason === null
      ? { tone: "success" as const, label: refusal.checkedAt ? "Passed" : "Not checked yet" }
      : refusal.refusalReason === "check-unavailable"
        ? { tone: "caution" as const, label: "Could not verify" }
        : { tone: "error" as const, label: "Refused" };
  const sweepAvailable =
    status.enabled && status.signer === "ready" && status.activeSweepId === null;
  const sweepAmount = afterFee(status.balanceUstx, status.feeBasisUstx);

  if (!status.configured) {
    return (
      <>
        <SettingsRow
          actions={
            <button
              className="btn btn-secondary sm"
              type="button"
              disabled={readOnly || busy !== null}
              onClick={() => act("create", () => createGasWallet(token))}
            >
              {busy === "create" ? "Creating…" : "Create gas wallet"}
            </button>
          }
          detail="create it now; it signs nothing until operator-run is on and you enable it"
          help="A small STX account Sidekick keeps in its data directory. It pays only network fees for approved reward calls and can never be the signer or a manager admin."
          name="Gas wallet"
          status="Optional"
          value={<span className="muted">Not set up</span>}
        />
        <ErrorCallout error={error} />
      </>
    );
  }

  return (
    <div className="st-wallet">
      <div className="st-wallet-id">
        <div className="rw-eyebrow">
          Gas wallet <Badge state={badge.tone}>{badge.label}</Badge>
        </div>
        <div className="rw-wallet-address">
          <Wallet className="rw-ico" aria-hidden="true" />
          <span>{status.principal}</span>
          <button className="btn-icon" type="button" aria-label="Copy address" onClick={copy}>
            <Copy aria-hidden="true" />
          </button>
          {copied ? <span className="muted">copied</span> : null}
        </div>
        <p className="st-wallet-sub">
          {stxAmount(status.balanceUstx)} · {estimate}
          {status.createdAt ? ` · created ${shortUtc(status.createdAt)}` : ""} ·{" "}
          {status.source === "generated" ? "on this machine" : "from the environment"}{" "}
          {status.secretFilePath ? (
            <SettingsInfo
              text={`Key file ${status.secretFilePath} · owner-only · include it with the database backup · losing it loses only gas`}
            />
          ) : null}
        </p>
        <ErrorCallout error={error} />
      </div>
      <div className="st-rows st-wallet-rows">
        <SettingsRow
          actions={
            <button
              className="btn btn-tertiary sm"
              type="button"
              disabled={readOnly || observe || busy !== null}
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
          }
          detail={
            observe
              ? "enable operator-run in the deployment and restart before signing"
              : "signs only reward calls in a run you approve"
          }
          name="Signing"
          status={observe ? "Observe mode" : status.enabled ? "Enabled" : "Disabled"}
        />
        <SettingsRow
          detail={refusal.checkedAt ? `checked ${shortUtc(refusal.checkedAt)}` : "not checked yet"}
          help="Runs before every signature and refuses if this address is the signer, a manager admin, or a contract."
          name="Dedicated-key check"
          statusNode={<Badge state={dedicatedCheck.tone}>{dedicatedCheck.label}</Badge>}
        />
        <SettingsRow
          actions={
            <button
              aria-expanded={sweepOpen || activeSweep !== null}
              className="btn btn-tertiary sm"
              disabled={readOnly && activeSweep === null}
              onClick={() => setSweepOpen((value) => !value)}
              type="button"
            >
              Sweep remaining STX
            </button>
          }
          detail={
            sweepAmount === null
              ? "balance unavailable"
              : `${stxAmount(sweepAmount)} after the network fee`
          }
          help="Sends everything except the network fee to an address you enter. Runs stay disabled until you fund it again."
          name="Sweep"
        >
          {sweepOpen || activeSweep ? (
            <div className="st-wallet-disclosure">
              <div className="field">
                <label htmlFor="sweep-to">Send all remaining STX to</label>
                <div className="input-group">
                  <input
                    id="sweep-to"
                    type="text"
                    value={recipient}
                    spellCheck={false}
                    placeholder={status.network === "mainnet" ? "SP…" : "ST…"}
                    onChange={(event) => setRecipient(event.target.value)}
                    disabled={readOnly || !sweepAvailable}
                  />
                  <span className="suffix">{status.network}</span>
                </div>
              </div>
              <button
                className="btn btn-secondary sm"
                type="button"
                disabled={readOnly || busy !== null || !sweepAvailable || recipient.trim() === ""}
                onClick={() => act("sweep", () => prepareGasWalletSweep(token, recipient.trim()))}
              >
                {busy === "sweep" ? "Preparing…" : "Prepare sweep"}
              </button>
              {activeSweep ? (
                <div className="callout callout-info" role="status">
                  <div className="body">
                    <strong>
                      {activeSweep.status === "planned"
                        ? "Sweep ready for approval."
                        : "Sweep broadcast."}
                    </strong>{" "}
                    {stxAmount(activeSweep.amountUstx)} to{" "}
                    <span className="identifier">{short(activeSweep.recipient, 8, 6)}</span>
                    <div className="actions">
                      {activeSweep.status === "planned" ? (
                        <>
                          <button
                            className="btn btn-primary sm"
                            type="button"
                            disabled={readOnly || busy !== null}
                            onClick={() =>
                              act("approve", () =>
                                approveGasWalletSweep(token, activeSweep.sweepId),
                              )
                            }
                          >
                            {busy === "approve" ? "Sending…" : "Approve sweep"}
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
                        </>
                      ) : (
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
                      )}
                    </div>
                  </div>
                </div>
              ) : null}
              {status.sweeps.filter((sweep) => sweep.sweepId !== status.activeSweepId).length ? (
                <details className="st-sweep-history">
                  <summary>Sweep history</summary>
                  {status.sweeps
                    .filter((sweep) => sweep.sweepId !== status.activeSweepId)
                    .slice(0, 5)
                    .map((sweep) => {
                      const state = sweepBadge(sweep);
                      return (
                        <div className="st-sweep-history-row" key={sweep.sweepId}>
                          <span className="mono">{shortUtc(sweep.createdAt)}</span>
                          <span>{stxAmount(sweep.amountUstx)}</span>
                          <Badge state={state.tone}>{state.label}</Badge>
                        </div>
                      );
                    })}
                </details>
              ) : null}
            </div>
          ) : null}
        </SettingsRow>
      </div>
    </div>
  );
}
