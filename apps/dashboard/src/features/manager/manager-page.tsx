import {
  ArrowRight,
  CheckCircle,
  Coins,
  Key,
  Percent,
  ShieldCheck,
  UserMinus,
  UserPlus,
  WarningCircle,
} from "@phosphor-icons/react";
import type {
  BrowserWalletIntentCreateRequest,
  DashboardSnapshot,
  OnboardingState,
} from "@stx-labs/signer-sidekick-api-contracts";
import { onboardingActionResponseSchema } from "@stx-labs/signer-sidekick-api-contracts";
import { useEffect, useMemo, useState } from "react";
import { apiJson } from "../../api-client.js";
import { CopyableIdentifier, CopyIdentifierButton } from "../../copyable-identifier.js";
import { dashboardHash, type ManagerActionId } from "../../dashboard-route.js";
import { Badge, Field, PageHead, StatLine } from "../../shared/dashboard-ui.js";
import { number, short, stx } from "../../shared/format.js";
import { managerActionAvailability } from "../../shared/manager-action-availability.js";
import { BrowserWalletActionPanel } from "../setup/browser-wallet-action.js";
import {
  managerActionRecipient,
  standardManagerActionPrincipal,
} from "./manager-action-principal.js";

type Snapshot = DashboardSnapshot;

const canonicalUintPattern = /^(?:0|[1-9][0-9]*)$/;
const canonicalPositiveUintPattern = /^[1-9][0-9]*$/;
type SignerGrantState = OnboardingState["signerGrant"];

const actionCopy: Record<ManagerActionId, { title: string; detail: string; manual: string }> = {
  "register-self": {
    title: "Repair or rotate signer authorization",
    detail:
      "Register the verified signer key and grant through the manager’s authorized admin wallet.",
    manual:
      "Use the exact register-self contract, serialized arguments, and required sender from the prepared review.",
  },
  "add-admin": {
    title: "Add manager admin",
    detail: "Authorize another principal to administer this manager.",
    manual:
      "Call update-admin with the reviewed principal and true from an existing manager admin.",
  },
  "remove-admin": {
    title: "Remove manager admin",
    detail: "Remove a principal’s manager administration authority.",
    manual:
      "Call update-admin with the reviewed principal and false from an existing manager admin.",
  },
  "update-fees": {
    title: "Update manager fee",
    detail: "Set the fee used when a reward cycle or bond fee is first snapshotted.",
    manual: "Call update-fees with the reviewed basis-point value from a manager admin.",
  },
  "withdraw-fees": {
    title: "Withdraw earned fees",
    detail: "Transfer accrued manager fees to the selected recipient.",
    manual: "Call withdraw-fees with the exact amount and recipient shown in the prepared review.",
  },
  "sweep-fee-refunds": {
    title: "Sweep fee-refund dust",
    detail: "Transfer only the manager balance that remains after all reserved amounts.",
    manual: "Call sweep-fee-refunds with the reviewed recipient from a manager admin.",
  },
};

function validFeeBips(value: string): boolean {
  return canonicalUintPattern.test(value) && BigInt(value) < 10_000n;
}

function openManagerAction(action: ManagerActionId): void {
  location.hash = dashboardHash("manager", action);
}

function SignerGrantCeremony({ data, token }: { data: Snapshot; token: string }) {
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
        onboardingActionResponseSchema,
        {
          method: "POST",
          body: JSON.stringify({ authId, signerConfigPath: signerConfigPath.trim() }),
        },
      );
      setSignerGrant(result.onboarding.signerGrant);
      setSignerOutput("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to prepare the signer command.");
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
        onboardingActionResponseSchema,
        { method: "POST", body: JSON.stringify({ signerOutput: publicSignerOutput }) },
      );
      setSignerGrant(result.onboarding.signerGrant);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to verify the signer output.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="manager-repair-ceremony">
      <div className="callout callout-info" role="note">
        <Key className="ic" />
        <div className="body">
          <strong>Create a fresh signer authorization first.</strong> Sidekick prepares the public
          signer command and verifies its output. The signer key remains on the signer host; the
          manager-admin key remains in your wallet. If this page reloads, restart with a new
          authorization ID; saved onboarding state never unlocks this wallet action.
        </div>
      </div>

      <div className="manager-ceremony-step">
        <div className="manager-step-heading">
          <span>1</span>
          <div>
            <h3>Prepare the signer command</h3>
            <p>Use a new one-time authorization ID and the signer configuration path.</p>
          </div>
        </div>
        <div className="form-grid manager-action-form">
          <Field
            label="Authorization ID"
            help="A new unsigned integer for this signer authorization. Do not reuse an earlier grant."
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
          <Field
            label="Signer configuration path"
            help="Path on the signer host. Sidekick puts it in the command but never reads that file."
          >
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
              <p>Run the command, then paste only the public JSON it prints.</p>
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
              <Field
                label="JSON output from the signer command"
                help="Never paste the signer configuration, mnemonic, or private key."
              >
                <textarea
                  className="input code-input"
                  rows={8}
                  placeholder="Paste the complete public JSON object"
                  value={signerOutput}
                  onChange={(event) => setSignerOutput(event.target.value)}
                />
              </Field>
              <div className="setup-result-actions">
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
                <strong>Fresh signer grant verified.</strong> Review the exact registration
                transaction before connecting the admin wallet.
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
              <p>Enter the public address of the current manager-admin wallet.</p>
            </div>
          </div>
          <div className="form-grid manager-action-form manager-actor-form">
            <Field
              label="Signing manager admin"
              help="Sidekick verifies live is-admin state and requires this exact wallet sender."
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
                token={token}
              />
              <div className="manager-manual-path">
                <strong>Use another signing tool</strong>
                <p>
                  Use the exact contract, serialized arguments, and required sender from the
                  prepared review.
                </p>
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

function ManagerActionWorkspace({
  action,
  data,
  token,
}: {
  action: ManagerActionId;
  data: Snapshot;
  token: string;
}) {
  const [actorPrincipal, setActorPrincipal] = useState("");
  const [adminPrincipal, setAdminPrincipal] = useState("");
  const [feeBips, setFeeBips] = useState("");
  const [amountSats, setAmountSats] = useState("");
  const [recipient, setRecipient] = useState("");
  const copy = actionCopy[action];
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
      <div className="card-head">
        <div>
          <p className="eyebrow">EXTERNAL WALLET ACTION</p>
          <h2>{copy.title}</h2>
          <p className="muted manager-action-detail">{copy.detail}</p>
        </div>
        <button
          type="button"
          className="btn btn-tertiary"
          onClick={() => {
            location.hash = dashboardHash("manager");
          }}
        >
          Close
        </button>
      </div>

      {action === "register-self" ? <SignerGrantCeremony data={data} token={token} /> : null}

      {action !== "register-self" ? (
        <div className="form-grid manager-action-form manager-actor-form">
          <Field
            label="Signing manager admin"
            help="Public address of the external wallet that will sign. Sidekick verifies live is-admin state and requires this exact sender."
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
            help="Public Stacks account only. Sidekick verifies current admin authority before preparing the call."
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
              <span className="field-error">V1 does not allow an admin to remove itself.</span>
            ) : null}
          </Field>
          {action === "remove-admin" ? (
            <div className="callout callout-caution" role="note">
              <WarningCircle className="ic" />
              <div className="body">
                To rotate control, first add the new admin, verify access by signing with that
                wallet, then use the new admin to remove the old one. V1 blocks self-removal.
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
              <span className="muted">Reviewed rate: {Number(feeBips) / 100}%</span>
            ) : null}
          </Field>
          <div className="callout callout-caution" role="note">
            <WarningCircle className="ic" />
            <div className="body">
              A change can affect rewards earned before it was submitted if their cycle or bond fee
              has not yet been snapshotted. Existing snapshots do not change.
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
              The manager calculates the sweepable amount after reserving earned fees, outstanding
              withdrawal liability ({data.rewards?.manager.withdrawalLiabilitySats ?? "0"} sats),
              and unclaimed staker rewards (
              {data.rewards?.manager.unclaimedStakerRewardsSats ?? "0"}
              sats). Sidekick verifies the exact effect before completion.
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
            token={token}
          />
          <div className="manager-manual-path">
            <strong>Use another signing tool</strong>
            <p>{copy.manual} The prepared review remains the source of truth.</p>
          </div>
        </>
      ) : action !== "register-self" ? (
        <div className="callout callout-neutral manager-action-incomplete" role="status">
          <ArrowRight className="ic" />
          <div className="body">
            Complete the action details to prepare a wallet or manual review.
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function Manager({
  action,
  data,
  token,
}: {
  action: ManagerActionId | null;
  data: Snapshot;
  token: string;
}) {
  const cycles = data.forecast?.cycles ?? [];
  const recognitionLabel =
    data.manager.source.tier === "reference-built-in"
      ? "Reference — built in"
      : data.manager.source.tier === "reference-render"
        ? "Reference render — verified"
        : data.manager.source.tier === "custom-observe"
          ? "Custom — external signing"
          : "Not recognized — external signing";
  const referenceRecognized =
    data.manager.source.tier === "reference-built-in" ||
    data.manager.source.tier === "reference-render";
  const registrationReady = Boolean(
    data.registration?.registered && data.registration.signerKeyGrantValid,
  );
  const actionAvailability = managerActionAvailability(data);
  const canPrepareAdminActions = actionAvailability.available;

  useEffect(() => {
    if (!action) return;
    requestAnimationFrame(() =>
      document.getElementById("manager-action-workspace")?.scrollIntoView({ block: "start" }),
    );
  }, [action]);

  return (
    <>
      <PageHead
        title="Manager"
        lede="Canonical manager identity, signer authorization, eligibility, and externally signed administration."
      />
      <div className="callout callout-info intro-callout">
        <ShieldCheck className="ic" />
        <div className="body">
          Sidekick prepares and verifies exact actions. The browser wallet or manual signing tool
          retains the manager-admin key, chooses the fee and nonce, signs, and broadcasts.
        </div>
      </div>
      {actionAvailability.warning ? (
        <div className="callout callout-caution manager-required-state" role="status">
          <WarningCircle className="ic" />
          <div className="body">
            <strong>Unverified manager source.</strong>
            <br />
            {actionAvailability.warning}
          </div>
        </div>
      ) : null}
      {!canPrepareAdminActions && !action ? (
        <div className="callout callout-caution manager-required-state" role="status">
          <WarningCircle className="ic" />
          <div className="body">
            <strong>Guided manager actions are unavailable.</strong>
            <br />
            {actionAvailability.reason}
          </div>
        </div>
      ) : null}

      <div className="section-title">Required now</div>
      {registrationReady ? (
        <div className="callout callout-neutral manager-required-state">
          <CheckCircle className="ic" />
          <div className="body">
            <strong>No manager action required</strong>
            <br />
            The configured signer is registered and its PoX-5 grant is valid at the current tip.
          </div>
        </div>
      ) : (
        <div className="callout callout-caution manager-required-state">
          <WarningCircle className="ic" />
          <div className="body">
            <strong>
              {data.registration?.registered
                ? "Signer authorization must be repaired or rotated"
                : "Signer registration must be completed"}
            </strong>
            <br />
            Prepare a fresh signer grant, then have an authorized manager admin submit the exact
            registration call.
            <div className="actions">
              <button
                type="button"
                className="btn btn-accent sm"
                disabled={!canPrepareAdminActions}
                onClick={() => openManagerAction("register-self")}
              >
                Review repair ceremony
              </button>
            </div>
          </div>
        </div>
      )}

      {action && canPrepareAdminActions ? (
        <ManagerActionWorkspace key={action} action={action} data={data} token={token} />
      ) : action ? (
        <div className="callout callout-caution manager-required-state" role="alert">
          <WarningCircle className="ic" />
          <div className="body">
            <strong>Guided manager actions are unavailable.</strong>
            <br />
            {actionAvailability.reason}
          </div>
        </div>
      ) : null}

      <div className="section-title">Canonical status</div>
      <div className="grid cols-2 manager-status-grid">
        <div className="card">
          <div className="card-head">
            <h2>Manager &amp; signer</h2>
            <Badge state={referenceRecognized ? "success" : "caution"}>{recognitionLabel}</Badge>
          </div>
          <StatLine label="Manager principal">
            <CopyableIdentifier
              value={data.managerPrincipal}
              display={short(data.managerPrincipal, 12, 9)}
              label="manager principal"
              className="identifier"
            />
          </StatLine>
          <StatLine label="Source profile">
            {data.manager.source.profileId ?? "No installed profile"}
          </StatLine>
          <StatLine label="Profile origin">
            {data.manager.source.origin === "operator-installed"
              ? "Operator-installed"
              : data.manager.source.origin === "built-in"
                ? "Built into Sidekick"
                : "None"}
          </StatLine>
          <StatLine label="Assist eligibility">
            <Badge state={data.manager.automationEligible ? "success" : "neutral"}>
              {data.manager.automationEligible ? "Eligible for Assist" : "Not eligible for Assist"}
            </Badge>
          </StatLine>
          <StatLine label="Source hash">
            <CopyableIdentifier
              value={data.manager.source.sha256}
              display={short(data.manager.source.sha256, 12, 8)}
              label="manager source hash"
              className="identifier src src-chain"
            />
          </StatLine>
          <StatLine label="Published">
            <span className="mono">Stacks block {number(data.manager.publishHeight)}</span>
          </StatLine>
          <StatLine label="Signer public key">
            <CopyableIdentifier
              value={data.registration?.signerKeyHex}
              display={short(data.registration?.signerKeyHex, 12, 8)}
              label="signer public key"
              className="identifier"
            />
          </StatLine>
          <StatLine label="Registration">
            <Badge state={data.registration?.registered ? "success" : "error"}>
              {data.registration?.registered ? "Confirmed" : "Missing"}
            </Badge>
          </StatLine>
          <div
            className={`callout ${referenceRecognized ? "callout-info" : "callout-caution"} grant-note`}
          >
            <ShieldCheck className="ic" />
            <div className="body">
              {data.manager.source.tier === "unrecognized"
                ? "Sidekick can monitor this manager and prepare fixed externally signed actions, but cannot attest its source or enable Assist. Verify every wallet or manual signing request."
                : data.manager.source.tier === "custom-observe"
                  ? "Sidekick can monitor this custom manager and prepare fixed externally signed actions. Assist remains limited to verified reference managers."
                  : data.manager.provenance.reason}
            </div>
          </div>
          {data.manager.installedProfiles.directory ? (
            <StatLine label="Installed profiles">
              {data.manager.installedProfiles.loaded} loaded
              {data.manager.installedProfiles.issues.length > 0
                ? ` · ${data.manager.installedProfiles.issues.length} ignored issue(s)`
                : ""}
            </StatLine>
          ) : null}
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Signer key grant</h2>
            <Badge state={data.registration?.signerKeyGrantValid ? "success" : "error"}>
              {data.registration?.signerKeyGrantValid ? "Valid" : "Invalid"}
            </Badge>
          </div>
          <StatLine label="verify-signer-key-grant">
            <span className="src src-chain mono">
              {String(data.registration?.signerKeyGrantValid ?? false)}
            </span>
          </StatLine>
          <StatLine label="PoX-5 contract">
            <CopyableIdentifier
              value={data.preflight.pox.pox5ContractId}
              display={short(data.preflight.pox.pox5ContractId, 12, 8)}
              label="PoX-5 contract principal"
              className="identifier"
            />
          </StatLine>
          <StatLine label="Observed at Bitcoin block">
            <span className="mono">{number(data.preflight.node.burnBlockHeight)}</span>
          </StatLine>
          <div className="callout callout-neutral grant-note">
            <WarningCircle className="ic" />
            <div className="body">
              <strong>If the grant is revoked:</strong> new stakes and stake updates into this
              manager are blocked. Existing obligations wind down.
            </div>
          </div>
          {registrationReady ? (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!canPrepareAdminActions}
              onClick={() => openManagerAction("register-self")}
            >
              <Key /> Review signer rotation
            </button>
          ) : null}
        </div>
      </div>

      <div className="section-title">Manager administration</div>
      <div className="grid cols-2 manager-action-grid">
        <button
          type="button"
          className="card manager-action-card"
          disabled={!canPrepareAdminActions}
          onClick={() => openManagerAction("add-admin")}
        >
          <UserPlus />
          <span>
            <strong>Add admin</strong>
            <small>Authorize another manager-admin account.</small>
          </span>
          <ArrowRight />
        </button>
        <button
          type="button"
          className="card manager-action-card"
          disabled={!canPrepareAdminActions}
          onClick={() => openManagerAction("remove-admin")}
        >
          <UserMinus />
          <span>
            <strong>Remove admin</strong>
            <small>Remove an account without stranding control.</small>
          </span>
          <ArrowRight />
        </button>
      </div>

      <div className="section-title">Reward administration</div>
      <div className="grid cols-3 manager-action-grid">
        <button
          type="button"
          className="card manager-action-card"
          disabled={!canPrepareAdminActions}
          onClick={() => openManagerAction("update-fees")}
        >
          <Percent />
          <span>
            <strong>Update fee</strong>
            <small>Current: {Number(data.rewards?.manager.configuredFeeBips ?? 0) / 100}%</small>
          </span>
          <ArrowRight />
        </button>
        <button
          type="button"
          className="card manager-action-card"
          disabled={!canPrepareAdminActions}
          onClick={() => openManagerAction("withdraw-fees")}
        >
          <Coins />
          <span>
            <strong>Withdraw fees</strong>
            <small>{data.rewards?.manager.earnedFeesSats ?? "0"} sats accrued</small>
          </span>
          <ArrowRight />
        </button>
        <button
          type="button"
          className="card manager-action-card"
          disabled={!canPrepareAdminActions}
          onClick={() => openManagerAction("sweep-fee-refunds")}
        >
          <Coins />
          <span>
            <strong>Sweep refunds</strong>
            <small>Preserves recorded staker liabilities.</small>
          </span>
          <ArrowRight />
        </button>
      </div>

      <div className="section-title">Signer-set membership &amp; weight</div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Reward cycle</th>
              <th className="right">Delegated STX</th>
              <th className="right">Threshold margin</th>
              <th>Eligibility</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {cycles.map((cycle, index) => (
              <tr key={cycle.cycleId}>
                <td className="mono">
                  {cycle.cycleId} {index === 0 ? <Badge state="accent">current</Badge> : null}
                </td>
                <td className="right mono">{stx(cycle.contract.pendingStxUstx)}</td>
                <td className="right mono">{stx(cycle.threshold.marginUstx)}</td>
                <td>
                  <Badge state={cycle.contract.inSignerSet ? "success" : "error"}>
                    {cycle.contract.inSignerSet ? "Eligible" : "Below 50k"}
                  </Badge>
                </td>
                <td>
                  <span
                    className={
                      cycle.provenance.classification === "authoritative"
                        ? "src src-chain"
                        : "src src-local"
                    }
                  >
                    {cycle.provenance.classification === "authoritative"
                      ? "authoritative contract state"
                      : "contract-backed projection"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
