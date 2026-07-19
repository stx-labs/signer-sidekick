import { ArrowClockwise, Check, ShieldCheck, Wallet, Warning } from "@phosphor-icons/react";
import {
  type BrowserWalletIntent,
  type BrowserWalletIntentRequest,
  browserWalletIntentResponseSchema,
  walletIntentAnchorMismatchErrorSchema,
  walletIntentAnchorUnstableErrorSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError, apiJson } from "../../api-client.js";
import { CopyableIdentifier } from "../../copyable-identifier.js";
import { StatusBadge } from "../../shared/dashboard-ui.js";
import { number } from "../../shared/format.js";
import { operatorErrorDetail } from "../../shared/operator-error.js";
import {
  BrowserWalletError,
  browserWalletIntentNetwork,
  browserWalletProviderNames,
  browserWalletRecoveryScope,
  browserWalletSupport,
  canPrepareBrowserWalletIntent,
  executeRevalidatedBrowserWalletIntent,
} from "./browser-wallet.js";
import {
  clearPendingBrowserWalletBroadcast,
  loadPendingBrowserWalletBroadcasts,
  type PendingBrowserWalletBroadcast,
  persistPendingBrowserWalletBroadcast,
  recoverPendingBrowserWalletBroadcast,
  recoverSpecificPendingBrowserWalletBroadcast,
  type ScopedPendingBrowserWalletBroadcast,
} from "./browser-wallet-recovery.js";

const REFRESHABLE_STATUSES = new Set([
  "submitted",
  "mempool",
  "confirmed",
  "complete",
  "reobserve",
  "superseded",
]);
const POLLING_STATUSES = new Set(["submitted", "mempool", "confirmed", "reobserve"]);

function walletName(providerId: string): string {
  return providerId === "LeatherProvider" ? "Leather" : "Xverse";
}

function walletIntentErrorMessage(cause: unknown): string {
  if (cause instanceof ApiRequestError) {
    const mismatch = walletIntentAnchorMismatchErrorSchema.safeParse(cause.body);
    if (mismatch.success) {
      const { node, api, poxBurnBlockHeight } = mismatch.data;
      const poxDetail =
        poxBurnBlockHeight === api.burnBlockHeight
          ? ""
          : ` PoX: Bitcoin ${number(poxBurnBlockHeight)}.`;
      return `Node, API, and PoX chain data are temporarily out of sync. Node: Stacks ${number(node.stacksTipHeight)}, Bitcoin ${number(node.burnBlockHeight)}. API: Stacks ${number(api.stacksTipHeight)}, Bitcoin ${number(api.burnBlockHeight)}.${poxDetail} Sidekick retried. This attempt did not send a new transaction to the wallet or submit one. Wait a moment, then review again. If this persists, verify the node and API URLs in Settings.`;
    }
    if (walletIntentAnchorUnstableErrorSchema.safeParse(cause.body).success) {
      return "The chain position changed while Sidekick checked the request. Sidekick retried. This attempt did not send a new transaction to the wallet or submit one. Wait a moment, then review again.";
    }
  }
  return operatorErrorDetail(cause, "Could not prepare the wallet request");
}

function requestTarget(intent: BrowserWalletIntent): string {
  return intent.transaction.method === "stx_deployContract"
    ? intent.transaction.params.name
    : `${intent.transaction.params.contract}::${intent.transaction.params.functionName}`;
}

function recoveryRecordKey(pending: PendingBrowserWalletBroadcast): string {
  return `${pending.intentId}:${pending.txid}:${pending.sender}:${pending.providerId}`;
}

function withoutRecoveryRecord(
  records: readonly ScopedPendingBrowserWalletBroadcast[],
  expected: ScopedPendingBrowserWalletBroadcast,
): ScopedPendingBrowserWalletBroadcast[] {
  const expectedKey = recoveryRecordKey(expected);
  return records.filter((candidate) => recoveryRecordKey(candidate) !== expectedKey);
}

export function BrowserWalletActionPanel({
  createRequest,
  chainId,
  intentApiBase = "/api/v1/onboarding/wallet-intents",
  managerPrincipal,
  network,
  onVerified,
  token,
}: {
  createRequest: BrowserWalletIntentRequest;
  chainId: number;
  intentApiBase?: "/api/v1/onboarding/wallet-intents" | "/api/v1/wallet-intents";
  managerPrincipal: string;
  network: string;
  onVerified?: (() => void | Promise<void>) | undefined;
  token: string;
}) {
  const action = createRequest.action;
  const supportNetwork = browserWalletIntentNetwork(network);
  const support = useMemo(
    () => browserWalletSupport(action, supportNetwork ?? network, chainId),
    [action, chainId, network, supportNetwork],
  );
  const recoverySelector = useMemo(
    () => ({
      network: supportNetwork ?? network,
      chainId,
      managerPrincipal,
      action,
    }),
    [action, chainId, managerPrincipal, network, supportNetwork],
  );
  const [intent, setIntent] = useState<BrowserWalletIntent | null>(null);
  const [busy, setBusy] = useState<"prepare" | "sign" | "record" | "refresh" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [walletResults, setWalletResults] = useState<ScopedPendingBrowserWalletBroadcast[]>(() =>
    loadPendingBrowserWalletBroadcasts(recoverySelector),
  );
  const [recoveryMessages, setRecoveryMessages] = useState<Record<string, string>>({});
  const [recoveryCanClear, setRecoveryCanClear] = useState(false);
  const notifiedCompleteIntent = useRef<string | null>(null);
  const pollingController = useRef<AbortController | null>(null);
  const walletResult = walletResults.length === 1 ? (walletResults[0] ?? null) : null;
  const ambiguousWalletResults = walletResults.length > 1 ? walletResults : [];

  const getIntent = useCallback(
    async (intentId: string) =>
      (
        await apiJson(
          token,
          `${intentApiBase}/${encodeURIComponent(intentId)}`,
          browserWalletIntentResponseSchema,
        )
      ).intent,
    [intentApiBase, token],
  );

  const recordTxid = useCallback(
    async (intentId: string, txid: string) =>
      (
        await apiJson(
          token,
          `${intentApiBase}/${encodeURIComponent(intentId)}/submission`,
          browserWalletIntentResponseSchema,
          { method: "POST", body: JSON.stringify({ txid }) },
        )
      ).intent,
    [intentApiBase, token],
  );

  useEffect(() => {
    const savedRecords = loadPendingBrowserWalletBroadcasts(recoverySelector);
    setWalletResults(savedRecords);
    setRecoveryMessages({});
    if (savedRecords.length !== 1) {
      setRecoveryCanClear(false);
      return;
    }
    const saved = savedRecords[0];
    if (!saved) return;
    let active = true;
    setRecoveryCanClear(false);
    setBusy("record");
    setError(null);
    void recoverPendingBrowserWalletBroadcast(saved, { getIntent, recordTxid })
      .then((recovery) => {
        if (!active || !recovery) return;
        setIntent(recovery.intent);
        if (recovery.outcome === "conflict") {
          setRecoveryCanClear(true);
          setError(
            "Sidekick already recorded another transaction for this request. Keep the saved transaction ID for manual review or clear its recovery record.",
          );
        } else {
          setWalletResults([]);
          setRecoveryCanClear(false);
        }
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setRecoveryCanClear(cause instanceof ApiRequestError && cause.status === 404);
        setError(
          cause instanceof Error
            ? `Saved wallet broadcast restored. ${cause.message}`
            : "Saved wallet broadcast restored, but Sidekick could not record it yet.",
        );
      })
      .finally(() => {
        if (active) setBusy(null);
      });
    return () => {
      active = false;
    };
  }, [getIntent, recordTxid, recoverySelector]);

  useEffect(() => {
    if (busy !== null || !intent || !POLLING_STATUSES.has(intent.status)) return;
    let active = true;
    let timeout: number | undefined;
    const poll = async () => {
      const controller = new AbortController();
      pollingController.current = controller;
      try {
        const result = await apiJson(
          token,
          `${intentApiBase}/${encodeURIComponent(intent.id)}/refresh`,
          browserWalletIntentResponseSchema,
          { method: "POST", body: "{}", signal: controller.signal },
        );
        if (!active || pollingController.current !== controller) return;
        setIntent(result.intent);
        setPollError(null);
      } catch (cause) {
        if (!active || controller.signal.aborted) return;
        setPollError(
          `Automatic verification refresh failed: ${walletIntentErrorMessage(cause)} Use Refresh verification to retry now.`,
        );
      } finally {
        if (pollingController.current === controller) pollingController.current = null;
        if (active) timeout = window.setTimeout(() => void poll(), 15_000);
      }
    };
    timeout = window.setTimeout(() => void poll(), 15_000);
    return () => {
      active = false;
      if (timeout !== undefined) window.clearTimeout(timeout);
      const controller = pollingController.current;
      pollingController.current = null;
      controller?.abort();
    };
  }, [busy, intent, intentApiBase, token]);

  useEffect(() => {
    if (intent?.status !== "complete" || notifiedCompleteIntent.current === intent.id) return;
    notifiedCompleteIntent.current = intent.id;
    void Promise.resolve(onVerified?.()).catch(() => {
      // Completion remains authoritative; the dashboard's periodic status refresh will retry.
    });
  }, [intent?.id, intent?.status, onVerified]);

  const prepare = async () => {
    const currentRecoveryRecords = loadPendingBrowserWalletBroadcasts(recoverySelector);
    if (walletResults.length > 0 || currentRecoveryRecords.length > 0) {
      setWalletResults(currentRecoveryRecords.length > 0 ? currentRecoveryRecords : walletResults);
      return;
    }
    setBusy("prepare");
    setError(null);
    setPollError(null);
    try {
      const result = await apiJson(token, intentApiBase, browserWalletIntentResponseSchema, {
        method: "POST",
        body: JSON.stringify(createRequest),
      });
      setIntent(result.intent);
    } catch (cause) {
      setError(walletIntentErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const sign = async () => {
    if (!intent) return;
    const currentRecoveryRecords = loadPendingBrowserWalletBroadcasts(recoverySelector);
    if (walletResults.length > 0 || currentRecoveryRecords.length > 0) {
      setWalletResults(currentRecoveryRecords.length > 0 ? currentRecoveryRecords : walletResults);
      return;
    }
    setBusy("sign");
    setError(null);
    setPollError(null);
    try {
      const execution = await executeRevalidatedBrowserWalletIntent(
        intent,
        async (intentId) =>
          (
            await apiJson(
              token,
              `${intentApiBase}/${encodeURIComponent(intentId)}/refresh`,
              browserWalletIntentResponseSchema,
              { method: "POST", body: "{}" },
            )
          ).intent,
      );
      const current = execution.intent;
      setIntent(current);
      if (!execution.wallet) {
        setError(
          "This wallet request is no longer ready to sign. Review the current setup state before continuing.",
        );
        return;
      }
      const wallet = execution.wallet;
      const pending = {
        intentId: current.id,
        txid: wallet.txid,
        sender: wallet.sender,
        providerId: wallet.providerId,
      } satisfies PendingBrowserWalletBroadcast;
      const recoveryScope = browserWalletRecoveryScope(current);
      const scopedPending = { ...pending, ...recoveryScope };
      const persisted = persistPendingBrowserWalletBroadcast(recoveryScope, pending);
      setWalletResults([scopedPending]);
      setRecoveryCanClear(false);
      const recorded = await recordTxid(current.id, wallet.txid);
      if (recorded.txid === wallet.txid) {
        clearPendingBrowserWalletBroadcast(recoveryScope, pending);
        setWalletResults([]);
      }
      setIntent(recorded);
      if (!persisted && recorded.txid !== wallet.txid) {
        setError(
          "Browser recovery storage is unavailable. Keep this page open and save the transaction ID.",
        );
      }
    } catch (cause) {
      if (cause instanceof BrowserWalletError && cause.code === "expired-intent") {
        setIntent({ ...intent, status: "expired" });
      }
      setError(walletIntentErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const retryRecord = async (pending: ScopedPendingBrowserWalletBroadcast) => {
    setBusy("record");
    setError(null);
    setPollError(null);
    const messageKey = recoveryRecordKey(pending);
    setRecoveryMessages((current) => {
      const next = { ...current };
      delete next[messageKey];
      return next;
    });
    try {
      const recovery = await recoverSpecificPendingBrowserWalletBroadcast(pending, {
        getIntent,
        recordTxid,
      });
      if (!recovery) {
        setWalletResults(loadPendingBrowserWalletBroadcasts(recoverySelector));
        return;
      }
      if (walletResults.length === 1) setIntent(recovery.intent);
      if (recovery.outcome === "conflict") {
        setRecoveryCanClear(walletResults.length === 1);
        setRecoveryMessages((current) => ({
          ...current,
          [messageKey]:
            "Sidekick found a different transaction recorded for this request. Keep this transaction ID for manual review or clear only this recovery record.",
        }));
      } else {
        setRecoveryCanClear(false);
        setWalletResults((current) => withoutRecoveryRecord(current, pending));
      }
    } catch (cause) {
      const canClear = cause instanceof ApiRequestError && cause.status === 404;
      setRecoveryCanClear(canClear && walletResults.length === 1);
      const detail = operatorErrorDetail(cause, "Could not record the transaction ID");
      if (walletResults.length > 1) {
        setRecoveryMessages((current) => ({
          ...current,
          [messageKey]: canClear
            ? `This request no longer exists. ${detail}`
            : `Sidekick could not record this transaction yet. ${detail}`,
        }));
      } else {
        setError(detail);
      }
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    if (!intent) return;
    setBusy("refresh");
    setError(null);
    setPollError(null);
    try {
      const result = await apiJson(
        token,
        `${intentApiBase}/${encodeURIComponent(intent.id)}/refresh`,
        browserWalletIntentResponseSchema,
        { method: "POST", body: "{}" },
      );
      setIntent(result.intent);
    } catch (cause) {
      setError(walletIntentErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const replace = async () => {
    if (!intent) return;
    setBusy("prepare");
    setError(null);
    setPollError(null);
    try {
      const result = await apiJson(
        token,
        `${intentApiBase}/${encodeURIComponent(intent.id)}/replacement`,
        browserWalletIntentResponseSchema,
        { method: "POST", body: "{}" },
      );
      setIntent(result.intent);
    } catch (cause) {
      setError(walletIntentErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const pendingNeedsRecording =
    walletResult !== null && (intent?.txid ?? null) !== walletResult.txid;
  const pendingConflictsWithBackend =
    walletResult !== null && typeof intent?.txid === "string" && intent.txid !== walletResult.txid;
  const clearSavedRecovery = (pending: ScopedPendingBrowserWalletBroadcast) => {
    clearPendingBrowserWalletBroadcast(pending, pending);
    setWalletResults((current) => withoutRecoveryRecord(current, pending));
    setRecoveryCanClear(false);
    setError(null);
  };
  const canSign = intent?.status === "prepared" && walletResults.length === 0;
  const canPrepare =
    walletResults.length === 0 && canPrepareBrowserWalletIntent(intent, pendingNeedsRecording);

  return (
    <section
      className="deploy-instructions browser-wallet-panel"
      aria-label="Browser wallet"
      aria-busy={busy !== null}
    >
      <div className="browser-wallet-heading">
        <div>
          <h3>Sign with browser wallet</h3>
          {support.available ? (
            <p>
              Supported {support.providerIds.length === 1 ? "wallet" : "wallets"}:{" "}
              {browserWalletProviderNames(support.providerIds)}.
            </p>
          ) : null}
        </div>
        {intent ? <StatusBadge status={intent.status} /> : null}
      </div>

      {!support.available ? (
        <div className="callout callout-caution" role="note">
          <Warning className="ic" />
          <div className="body">{support.unavailableReason}</div>
        </div>
      ) : (
        <>
          {ambiguousWalletResults.length > 0 ? (
            <div className="callout callout-critical" role="alert">
              <Warning className="ic" />
              <div className="body">
                <strong>Multiple saved wallet broadcasts need review.</strong>
                <p>
                  Sidekick will not prepare another transaction for this action until each saved
                  record is recorded or cleared. Clearing a local recovery record does not cancel
                  its broadcast; save its transaction ID first.
                </p>
                <div className="wallet-recovery-list">
                  {ambiguousWalletResults.map((pending) => {
                    const messageKey = recoveryRecordKey(pending);
                    return (
                      <div className="wallet-recovery-record" key={messageKey}>
                        <div>
                          Request{" "}
                          <CopyableIdentifier
                            value={pending.intentId}
                            label="wallet request ID"
                            className="mono"
                          />
                        </div>
                        <div>
                          Transaction{" "}
                          <CopyableIdentifier
                            value={pending.txid}
                            label="wallet transaction ID"
                            className="mono"
                          />
                        </div>
                        <div>
                          Submitted from {pending.sender} with {walletName(pending.providerId)}.
                        </div>
                        {recoveryMessages[messageKey] ? (
                          <p role="status">{recoveryMessages[messageKey]}</p>
                        ) : null}
                        <div className="setup-result-actions">
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={busy !== null}
                            onClick={() => void retryRecord(pending)}
                          >
                            <ArrowClockwise /> Retry recording this transaction
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost"
                            disabled={busy !== null}
                            onClick={() => clearSavedRecovery(pending)}
                          >
                            Clear this recovery record
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : null}

          {intent ? (
            <div className="wallet-intent-review">
              <div>
                <strong>{intent.review.title}</strong>
                <p>{intent.review.summary}</p>
              </div>
              <div className="deployment-target">
                <span>
                  Network <strong>{intent.network}</strong>
                </span>
                <span>
                  Signing account{" "}
                  <CopyableIdentifier
                    value={intent.requiredSender}
                    label="signing account"
                    className="mono"
                  />
                </span>
                <span>
                  Request <strong className="mono">{intent.transaction.method}</strong>
                </span>
                <span>
                  Target <strong className="mono">{requestTarget(intent)}</strong>
                </span>
                {intent.transaction.method === "stx_deployContract" ? (
                  <span>
                    Clarity <strong>{intent.transaction.params.clarityVersion}</strong>
                  </span>
                ) : null}
                <span>
                  Expires <strong>{new Date(intent.expiresAt).toLocaleString()}</strong>
                </span>
              </div>
              {intent.review.fields?.length ? (
                <dl className="wallet-intent-fields">
                  {intent.review.fields.map((field) => (
                    <div key={`${field.label}:${field.value}`}>
                      <dt>{field.label}</dt>
                      <dd>
                        <CopyableIdentifier
                          value={field.value}
                          label={field.label}
                          className="mono"
                        />
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              <div className="callout callout-neutral" role="note">
                <Check className="ic" />
                <div className="body">
                  <strong>Expected result:</strong> {intent.review.expectedPostState}
                </div>
              </div>
              <details className="setup-advanced">
                <summary>Request fingerprints</summary>
                <div className="wallet-intent-seals">
                  <CopyableIdentifier
                    value={intent.seal.factsSha256}
                    label="wallet request facts hash"
                    className="mono"
                  />
                  <CopyableIdentifier
                    value={intent.seal.manifestSha256}
                    label="wallet request manifest hash"
                    className="mono"
                  />
                </div>
              </details>
              <details className="setup-advanced">
                <summary>Transaction details</summary>
                <div className="wallet-intent-payload">
                  <div>
                    <strong>Sponsored</strong> No
                  </div>
                  <div>
                    <strong>Post-condition mode</strong>{" "}
                    {intent.transaction.params.postConditionMode}
                  </div>
                  <div>
                    <strong>Post-conditions</strong>{" "}
                    {intent.transaction.params.postConditions.length === 0 ? "None" : "Present"}
                  </div>
                  {intent.transaction.params.postConditions.length > 0 ? (
                    <ol>
                      {intent.transaction.params.postConditions.map((postCondition) => (
                        <li key={postCondition}>
                          <CopyableIdentifier
                            value={postCondition}
                            label="serialized post-condition"
                            className="mono"
                          />
                        </li>
                      ))}
                    </ol>
                  ) : null}
                  {intent.transaction.method === "stx_deployContract" ? (
                    <div>
                      <strong>Contract source</strong>
                      <pre className="code">{intent.transaction.params.clarityCode}</pre>
                    </div>
                  ) : (
                    <div>
                      <strong>Serialized arguments</strong>
                      <ol>
                        {intent.transaction.params.functionArgs.map((argument, index) => (
                          <li key={argument}>
                            <strong>Argument {index + 1}</strong>{" "}
                            <CopyableIdentifier
                              value={argument}
                              label={`serialized argument ${index + 1}`}
                              className="mono"
                            />
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </div>
              </details>
            </div>
          ) : null}

          {intent?.txid ? (
            <div className="callout callout-info" role="status">
              <ArrowClockwise className="ic" />
              <div className="body">
                <strong>Transaction submitted.</strong>
                <div>
                  Transaction{" "}
                  <CopyableIdentifier value={intent.txid} label="transaction ID" className="mono" />
                </div>
                {walletResult?.txid === intent.txid ? (
                  <div>
                    Submitted from {walletResult.sender} with {walletName(walletResult.providerId)}.
                  </div>
                ) : null}
                {intent.verification ? <div>{intent.verification.detail}</div> : null}
              </div>
            </div>
          ) : null}

          {pendingNeedsRecording ? (
            <div className="callout callout-caution" role="status">
              <Warning className="ic" />
              <div className="body">
                <strong>The wallet reported a broadcast, but Sidekick did not record it.</strong>
                <div>
                  Transaction{" "}
                  <CopyableIdentifier
                    value={walletResult.txid}
                    label="wallet transaction ID"
                    className="mono"
                  />
                </div>
                Retry recording this ID without signing again, or keep it for manual verification.
                {recoveryCanClear ? (
                  <div>
                    If this request no longer exists, save the transaction ID before clearing the
                    local record. Clearing it does not cancel the transaction.
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="callout callout-critical" role="alert">
              <Warning className="ic" />
              <div className="body">{error}</div>
            </div>
          ) : null}
          {pollError ? (
            <div className="callout callout-caution" role="status">
              <Warning className="ic" />
              <div className="body">{pollError}</div>
            </div>
          ) : null}

          <div className="setup-result-actions">
            {canPrepare ? (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy !== null}
                onClick={() => void prepare()}
              >
                <ShieldCheck />{" "}
                {intent ? "Review a new wallet transaction" : "Review wallet transaction"}
              </button>
            ) : null}
            {canSign ? (
              <button
                type="button"
                className="btn btn-accent"
                disabled={busy !== null}
                onClick={() => void sign()}
              >
                <Wallet /> Connect wallet and sign
              </button>
            ) : null}
            {pendingNeedsRecording ? (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy !== null}
                onClick={() => (walletResult ? void retryRecord(walletResult) : undefined)}
              >
                <ArrowClockwise /> Retry recording transaction
              </button>
            ) : null}
            {walletResult && (pendingConflictsWithBackend || recoveryCanClear) ? (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy !== null}
                onClick={() => clearSavedRecovery(walletResult)}
              >
                Clear saved recovery record
              </button>
            ) : null}
            {intent?.status === "reobserve" ? (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy !== null}
                onClick={() => void replace()}
              >
                <ShieldCheck /> Prepare replacement transaction
              </button>
            ) : null}
            {intent && REFRESHABLE_STATUSES.has(intent.status) ? (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy !== null}
                onClick={() => void refresh()}
              >
                <ArrowClockwise /> Refresh verification
              </button>
            ) : null}
          </div>
          {busy ? (
            <p className="help" role="status" aria-live="polite">
              {busy === "prepare"
                ? "Preparing transaction review…"
                : busy === "sign"
                  ? "Waiting for the wallet…"
                  : busy === "record"
                    ? "Recording transaction ID…"
                    : "Refreshing verification…"}
            </p>
          ) : null}
          <p className="help">
            Your wallet signs and submits the transaction. Sidekick verifies it on-chain.
          </p>
        </>
      )}
    </section>
  );
}
