import { ArrowRight, CheckCircle, Key, ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import type {
  BrowserWalletIntentCreateRequest,
  DashboardSnapshot,
  ManagerActionCapabilityId,
  SignerGrantSession,
} from "@stx-labs/signer-sidekick-api-contracts";
import { signerGrantSessionResponseSchema } from "@stx-labs/signer-sidekick-api-contracts";
import { useMemo, useState } from "react";
import { apiJson } from "../../api-client.js";
import { CopyableIdentifier, CopyIdentifierButton } from "../../copyable-identifier.js";
import { dashboardHash, type ManagerActionId } from "../../dashboard-route.js";
import { Field } from "../../shared/dashboard-ui.js";
import { operatorActionError } from "../../shared/operator-error.js";
import { BrowserWalletActionPanel } from "../operations/browser-wallet-action.js";
import {
  managerActionRecipient,
  standardManagerActionPrincipal,
} from "./manager-action-principal.js";

type Snapshot = DashboardSnapshot;

const canonicalUintPattern = /^(?:0|[1-9][0-9]*)$/;
const canonicalPositiveUintPattern = /^[1-9][0-9]*$/;
type SignerGrantState = SignerGrantSession;

export const managerActionCopy: Record<
  ManagerActionId,
  { title: string; detail: string; manual: string }
> = {
  "register-self": {
    title: "Register or rotate signer",
    detail: "Register the signer key and grant with a manager-admin wallet.",
    manual:
      "Call the manager contract’s register-self function with the serialized arguments and required sender shown in the transaction details.",
  },
  "add-admin": {
    title: "Add manager admin",
    detail: "Authorize another principal to administer this manager.",
    manual:
      "From an existing manager admin, call the manager contract’s update-admin function with the target principal and true.",
  },
  "remove-admin": {
    title: "Remove manager admin",
    detail: "Remove a principal’s manager administration authority.",
    manual:
      "From an existing manager admin, call the manager contract’s update-admin function with the target principal and false.",
  },
  "update-fees": {
    title: "Update manager fee",
    detail: "Set the fee used when a reward cycle or bond fee is first recorded.",
    manual:
      "From a manager admin, call the manager contract’s update-fees function with the basis-point value.",
  },
  "withdraw-fees": {
    title: "Withdraw earned fees",
    detail: "Transfer accrued manager fees to the selected recipient.",
    manual:
      "From a manager admin, call the manager contract’s withdraw-fees function with the amount and recipient shown in the transaction details.",
  },
  "sweep-fee-refunds": {
    title: "Sweep fee-refund dust",
    detail: "Transfer only the manager balance that remains after all reserved amounts.",
    manual:
      "From a manager admin, call the manager contract’s sweep-fee-refunds function with the recipient.",
  },
};

function validFeeBips(value: string): boolean {
  return canonicalUintPattern.test(value) && BigInt(value) < 10_000n;
}

export function managerCapabilityIdForAction(action: ManagerActionId): ManagerActionCapabilityId {
  if (action === "add-admin" || action === "remove-admin") return "update-admin";
  return action;
}

function SignerGrantCeremony({
  data,
  token,
  onOperatorStateChanged,
}: {
  data: Snapshot;
  token: string;
  onOperatorStateChanged?: (() => void | Promise<void>) | undefined;
}) {
  const [actorPrincipal, setActorPrincipal] = useState("");
  const [authId, setAuthId] = useState("");
  const [signerConfigPath, setSignerConfigPath] = useState("");
  const [signerOutput, setSignerOutput] = useState("");
  const [signerGrant, setSignerGrant] = useState<SignerGrantState | null>(null);
  const [busy, setBusy] = useState<"prepare" | "verify" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const createRequest = useMemo<BrowserWalletIntentCreateRequest | null>(() => {
    const actor = actorPrincipal.trim();
    return signerGrant?.verified && standardManagerActionPrincipal(actor, data.network)
      ? { action: "register-self", actorPrincipal: actor }
      : null;
  }, [actorPrincipal, data.network, signerGrant?.verified]);

  const prepare = async () => {
    setBusy("prepare");
    setError(null);
    try {
      const result = await apiJson(
        token,
        "/api/v1/manager/signer-grant/prepare",
        signerGrantSessionResponseSchema,
        {
          method: "POST",
          body: JSON.stringify({ authId, signerConfigPath: signerConfigPath.trim() }),
        },
      );
      setSignerGrant(result.signerGrant);
      setSignerOutput("");
    } catch (cause) {
      setError(
        operatorActionError(
          cause,
          "Could not prepare the signer command",
          "No wallet transaction was created; check the auth ID and configuration path, then retry",
          "Sidekick returned no error detail",
        ),
      );
    } finally {
      setBusy(null);
    }
  };

  const verify = async () => {
    let publicSignerOutput: unknown;
    try {
      publicSignerOutput = JSON.parse(signerOutput);
    } catch {
      setError("Paste the complete JSON object printed by the signer command.");
      return;
    }
    setBusy("verify");
    setError(null);
    try {
      const result = await apiJson(
        token,
        "/api/v1/manager/signer-grant/verify",
        signerGrantSessionResponseSchema,
        { method: "POST", body: JSON.stringify({ signerOutput: publicSignerOutput }) },
      );
      setSignerGrant(result.signerGrant);
    } catch (cause) {
      setError(
        operatorActionError(
          cause,
          "Could not verify the signer output",
          "No wallet transaction was created; check the pasted JSON, then retry",
          "Sidekick returned no error detail",
        ),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="manager-repair-ceremony">
      <div className="callout callout-info" role="note">
        <Key className="ic" />
        <div className="body">
          Generate a signer authorization, run it on the signer host, then verify the public output
          here. If this page reloads, start with a new authorization ID.
        </div>
      </div>

      <div className="manager-ceremony-step">
        <div className="manager-step-heading">
          <span>1</span>
          <div>
            <h3>Generate signer command</h3>
            <p>Enter a new authorization ID and the signer configuration path.</p>
          </div>
        </div>
        <div className="form-grid manager-action-form">
          <Field
            label="Authorization ID"
            help="A non-negative whole number that has not been used for this signer."
          >
            <input
              className="input mono"
              inputMode="numeric"
              placeholder="1"
              disabled={signerGrant !== null}
              value={authId}
              onChange={(event) => setAuthId(event.target.value.trim())}
            />
            {authId && !canonicalUintPattern.test(authId) ? (
              <span className="field-error">Enter zero or a positive whole number.</span>
            ) : null}
          </Field>
          <Field label="Signer configuration path" help="Path to the signer configuration file.">
            <input
              className="input mono"
              autoComplete="off"
              placeholder="/path/to/Signer.toml"
              disabled={signerGrant !== null}
              value={signerConfigPath}
              onChange={(event) => setSignerConfigPath(event.target.value)}
            />
          </Field>
        </div>
        {!signerGrant ? (
          <button
            type="button"
            className="btn btn-accent"
            disabled={
              busy !== null || !canonicalUintPattern.test(authId) || !signerConfigPath.trim()
            }
            onClick={() => void prepare()}
          >
            <Key /> {busy === "prepare" ? "Preparing" : "Generate signer command"}
          </button>
        ) : null}
      </div>

      {signerGrant?.preparation ? (
        <div className="manager-ceremony-step">
          <div className="manager-step-heading">
            <span>2</span>
            <div>
              <h3>Run and verify on the signer host</h3>
              <p>Run the command, then paste its complete JSON output.</p>
            </div>
          </div>
          <div className="ceremony-command">
            <div className="ceremony-command-head">
              <strong>Run on the signer host</strong>
              <CopyIdentifierButton
                value={signerGrant.preparation.command}
                label="signer command"
              />
            </div>
            <pre className="code command-code">{signerGrant.preparation.command}</pre>
          </div>
          <div className="deployment-target">
            <span>
              Manager{" "}
              <CopyableIdentifier
                value={data.managerPrincipal}
                label="manager principal"
                className="mono"
              />
            </span>
            <span>
              Auth ID <strong className="mono">{signerGrant.preparation.authId}</strong>
            </span>
            <span>
              SIP-018 hash{" "}
              <CopyableIdentifier
                value={signerGrant.preparation.expectedMessageHashHex}
                label="SIP-018 grant hash"
                className="mono"
              />
            </span>
          </div>
          {!signerGrant.verified ? (
            <>
              <Field label="Signer command output" help="Do not paste a mnemonic or private key.">
                <textarea
                  className="input code-input"
                  rows={8}
                  placeholder="Paste the complete public JSON object"
                  value={signerOutput}
                  onChange={(event) => setSignerOutput(event.target.value)}
                />
              </Field>
              <div className="wallet-result-actions">
                <button
                  type="button"
                  className="btn btn-accent"
                  disabled={busy !== null || !signerOutput.trim()}
                  onClick={() => void verify()}
                >
                  <ShieldCheck /> {busy === "verify" ? "Verifying" : "Verify signer output"}
                </button>
                <button
                  type="button"
                  className="btn btn-tertiary"
                  disabled={busy !== null}
                  onClick={() => {
                    setSignerGrant(null);
                    setSignerOutput("");
                    setError(null);
                  }}
                >
                  Start over
                </button>
              </div>
            </>
          ) : (
            <div className="callout callout-info" role="status">
              <CheckCircle className="ic" />
              <div className="body">
                <strong>Signer authorization verified.</strong> Review the registration transaction
                before connecting the admin wallet.
              </div>
            </div>
          )}
        </div>
      ) : null}

      {error ? (
        <div className="callout callout-critical" role="alert">
          <WarningCircle className="ic" />
          <div className="body">{error}</div>
        </div>
      ) : null}

      {signerGrant?.verified ? (
        <div className="manager-ceremony-step">
          <div className="manager-step-heading">
            <span>3</span>
            <div>
              <h3>Review and sign registration</h3>
              <p>Enter the public address of the manager-admin wallet.</p>
            </div>
          </div>
          <div className="form-grid manager-action-form manager-actor-form">
            <Field
              label="Signing manager admin"
              help="Public address of the admin wallet that will sign."
            >
              <input
                className="input mono"
                autoComplete="off"
                placeholder={data.network === "mainnet" ? "SP…" : "ST…"}
                value={actorPrincipal}
                onChange={(event) => setActorPrincipal(event.target.value.toUpperCase())}
              />
              {actorPrincipal && !standardManagerActionPrincipal(actorPrincipal, data.network) ? (
                <span className="field-error">
                  Enter a valid Stacks account principal for this network.
                </span>
              ) : null}
            </Field>
          </div>
          {createRequest ? (
            <>
              <BrowserWalletActionPanel
                key={JSON.stringify(createRequest)}
                chainId={data.preflight.node.networkId}
                createRequest={createRequest}
                intentApiBase="/api/v1/wallet-intents"
                managerPrincipal={data.managerPrincipal}
                network={data.network}
                onVerified={onOperatorStateChanged}
                token={token}
              />
              <div className="manager-manual-path">
                <strong>Use another signing tool</strong>
                <p>{managerActionCopy["register-self"].manual}</p>
              </div>
            </>
          ) : (
            <div className="callout callout-neutral manager-action-incomplete" role="status">
              <ArrowRight className="ic" />
              <div className="body">Enter the signing admin to prepare the transaction review.</div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function ManagerActionWorkspace({
  action,
  closeHref = dashboardHash("settings"),
  data,
  showHeading = true,
  token,
  onOperatorStateChanged,
}: {
  action: ManagerActionId;
  closeHref?: string;
  data: Snapshot;
  showHeading?: boolean;
  token: string;
  onOperatorStateChanged?: (() => void | Promise<void>) | undefined;
}) {
  const [actorPrincipal, setActorPrincipal] = useState("");
  const [adminPrincipal, setAdminPrincipal] = useState("");
  const [feeBips, setFeeBips] = useState("");
  const [amountSats, setAmountSats] = useState("");
  const [recipient, setRecipient] = useState("");
  const copy = managerActionCopy[action];
  const createRequest = useMemo<BrowserWalletIntentCreateRequest | null>(() => {
    const actor = actorPrincipal.trim();
    if (!standardManagerActionPrincipal(actor, data.network)) return null;
    if (action === "register-self") return null;
    if (action === "add-admin" || action === "remove-admin") {
      const value = adminPrincipal.trim();
      return standardManagerActionPrincipal(value, data.network) &&
        (action !== "remove-admin" || value !== actor)
        ? { action, actorPrincipal: actor, adminPrincipal: value }
        : null;
    }
    if (action === "update-fees") {
      if (!validFeeBips(feeBips)) return null;
      return { action, actorPrincipal: actor, feeBips };
    }
    if (action === "withdraw-fees") {
      const value = recipient.trim();
      if (
        !canonicalPositiveUintPattern.test(amountSats) ||
        !managerActionRecipient(value, data.network)
      ) {
        return null;
      }
      return { action, actorPrincipal: actor, amountSats, recipient: value };
    }
    const value = recipient.trim();
    return managerActionRecipient(value, data.network)
      ? { action, actorPrincipal: actor, recipient: value }
      : null;
  }, [action, actorPrincipal, adminPrincipal, amountSats, data.network, feeBips, recipient]);

  return (
    <section className="card-standout manager-action-workspace" id="manager-action-workspace">
      {showHeading ? (
        <div className="card-head">
          <div>
            <p className="eyebrow">MANAGER ACTION</p>
            <h2>{copy.title}</h2>
            <p className="muted manager-action-detail">{copy.detail}</p>
          </div>
          <a className="btn btn-tertiary" href={closeHref}>
            Close
          </a>
        </div>
      ) : null}

      {action === "register-self" ? (
        <SignerGrantCeremony
          data={data}
          token={token}
          onOperatorStateChanged={onOperatorStateChanged}
        />
      ) : null}

      {action !== "register-self" ? (
        <div className="form-grid manager-action-form manager-actor-form">
          <Field
            label="Signing manager admin"
            help="Public address of the admin wallet that will sign."
          >
            <input
              className="input mono"
              autoComplete="off"
              placeholder={data.network === "mainnet" ? "SP…" : "ST…"}
              value={actorPrincipal}
              onChange={(event) => setActorPrincipal(event.target.value.toUpperCase())}
            />
            {actorPrincipal && !standardManagerActionPrincipal(actorPrincipal, data.network) ? (
              <span className="field-error">
                Enter a valid Stacks account principal for this network.
              </span>
            ) : null}
          </Field>
        </div>
      ) : null}

      {action === "add-admin" || action === "remove-admin" ? (
        <div className="form-grid manager-action-form">
          <Field
            label={action === "add-admin" ? "New admin principal" : "Admin principal to remove"}
            help={
              action === "add-admin"
                ? "Public Stacks account to authorize."
                : "Public Stacks account to remove."
            }
          >
            <input
              className="input mono"
              autoComplete="off"
              placeholder={data.network === "mainnet" ? "SP…" : "ST…"}
              value={adminPrincipal}
              onChange={(event) => setAdminPrincipal(event.target.value.toUpperCase())}
            />
            {adminPrincipal && !standardManagerActionPrincipal(adminPrincipal, data.network) ? (
              <span className="field-error">
                Enter a valid Stacks account principal for this network.
              </span>
            ) : action === "remove-admin" &&
              adminPrincipal.trim() === actorPrincipal.trim() &&
              standardManagerActionPrincipal(adminPrincipal, data.network) ? (
              <span className="field-error">An admin cannot remove itself.</span>
            ) : null}
          </Field>
          {action === "remove-admin" ? (
            <div className="callout callout-caution" role="note">
              <WarningCircle className="ic" />
              <div className="body">
                Add and verify the new admin before using it to remove the old one. Self-removal is
                unavailable.
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {action === "update-fees" ? (
        <div className="form-grid manager-action-form">
          <Field
            label="New fee (basis points)"
            help={`Current configured fee: ${Number(data.rewards?.manager.configuredFeeBips ?? 0) / 100}%. Enter 0–9,999 basis points.`}
          >
            <input
              className="input mono"
              inputMode="numeric"
              placeholder="500"
              value={feeBips}
              onChange={(event) => setFeeBips(event.target.value.trim())}
            />
            {feeBips && !validFeeBips(feeBips) ? (
              <span className="field-error">Enter a whole number from 0 through 9,999.</span>
            ) : null}
            {createRequest ? (
              <span className="muted">New rate: {Number(feeBips) / 100}%</span>
            ) : null}
          </Field>
          <div className="callout callout-caution" role="note">
            <WarningCircle className="ic" />
            <div className="body">
              The new fee applies to any reward cycle or bond whose fee has not yet been recorded.
              Existing fee records do not change.
            </div>
          </div>
        </div>
      ) : null}

      {action === "withdraw-fees" ? (
        <div className="form-grid manager-action-form">
          <Field
            label="Amount (sats)"
            help={`Currently accrued manager fees: ${data.rewards?.manager.earnedFeesSats ?? "0"} sats.`}
          >
            <input
              className="input mono"
              inputMode="numeric"
              placeholder={data.rewards?.manager.earnedFeesSats ?? "0"}
              value={amountSats}
              onChange={(event) => setAmountSats(event.target.value.trim())}
            />
            {amountSats && !canonicalPositiveUintPattern.test(amountSats) ? (
              <span className="field-error">Enter a positive whole-satoshi amount.</span>
            ) : null}
          </Field>
          <Field label="Recipient" help="Stacks account or contract principal receiving the sBTC.">
            <input
              className="input mono"
              autoComplete="off"
              placeholder={data.network === "mainnet" ? "SP…" : "ST…"}
              value={recipient}
              onChange={(event) => setRecipient(event.target.value)}
            />
            {recipient && !managerActionRecipient(recipient, data.network) ? (
              <span className="field-error">Enter a valid Stacks principal for this network.</span>
            ) : null}
          </Field>
        </div>
      ) : null}

      {action === "sweep-fee-refunds" ? (
        <div className="form-grid manager-action-form">
          <div className="callout callout-info" role="note">
            <ShieldCheck className="ic" />
            <div className="body">
              Only funds remaining after the manager reserves accrued fees, withdrawal liability (
              {data.rewards?.manager.withdrawalLiabilitySats ?? "0"} sats), and unpaid staker
              rewards ({data.rewards?.manager.unclaimedStakerRewardsSats ?? "0"} sats) can be swept.
            </div>
          </div>
          <Field label="Recipient" help="Stacks account or contract principal receiving the sBTC.">
            <input
              className="input mono"
              autoComplete="off"
              placeholder={data.network === "mainnet" ? "SP…" : "ST…"}
              value={recipient}
              onChange={(event) => setRecipient(event.target.value)}
            />
            {recipient && !managerActionRecipient(recipient, data.network) ? (
              <span className="field-error">Enter a valid Stacks principal for this network.</span>
            ) : null}
          </Field>
        </div>
      ) : null}

      {createRequest ? (
        <>
          <BrowserWalletActionPanel
            key={JSON.stringify(createRequest)}
            chainId={data.preflight.node.networkId}
            createRequest={createRequest}
            intentApiBase="/api/v1/wallet-intents"
            managerPrincipal={data.managerPrincipal}
            network={data.network}
            onVerified={onOperatorStateChanged}
            token={token}
          />
          <div className="manager-manual-path">
            <strong>Use another signing tool</strong>
            <p>{copy.manual}</p>
          </div>
        </>
      ) : action !== "register-self" ? (
        <div className="callout callout-neutral manager-action-incomplete" role="status">
          <ArrowRight className="ic" />
          <div className="body">Complete the fields to prepare the transaction.</div>
        </div>
      ) : null}
    </section>
  );
}
