import { ArrowClockwise, ArrowSquareOut } from "@phosphor-icons/react";
import type { DashboardSnapshot } from "@stx-labs/signer-sidekick-api-contracts";
import { CopyableIdentifier } from "../../copyable-identifier.js";
import { actionHash } from "../../dashboard-route.js";
import { StatusBadge } from "../../shared/dashboard-ui.js";
import { DOCUMENT_LINKS } from "../../shared/document-links.js";
import { number, short } from "../../shared/format.js";
import { managerActionAvailability } from "../../shared/manager-action-availability.js";
import {
  MANAGER_CAPABILITY_LABELS,
  managerCapabilityExplanation,
  managerCapabilityState,
  summarizeManagerCapabilities,
} from "../../shared/manager-capability-presentation.js";
import { managerCapabilityIdForAction } from "../manager/manager-page.js";
import { SettingsInfo, SettingsRow, SettingsSectionTitle } from "./settings-ui.js";

function sourceLabel(data: DashboardSnapshot): string {
  switch (data.manager.source.tier) {
    case "reference-built-in":
      return "built-in reference";
    case "reference-render":
      return "reviewed";
    case "custom-observe":
      return "recorded custom";
    case "unrecognized":
      return "custom";
  }
}

export function ManagerSettings({
  data,
  onRefreshStatus,
  readOnly,
  refreshingStatus,
  sync,
  syncing,
}: {
  data: DashboardSnapshot;
  onRefreshStatus?: (() => void | Promise<void>) | undefined;
  readOnly: boolean;
  refreshingStatus: boolean;
  sync: () => void;
  syncing: boolean;
}) {
  const currentCycle = data.preflight.cycle.currentId;
  const establishedSignerParticipation = Boolean(
    data.registration?.registered ||
      data.forecast?.cycles.some(
        (cycle) =>
          (cycle.cycleId === currentCycle || cycle.cycleId === currentCycle + 1) &&
          cycle.contract.inSignerSet,
      ),
  );
  const register = managerActionAvailability(
    data,
    managerCapabilityIdForAction("register-self"),
    data.freshness?.status === "stale",
  );
  const updateAdmin = managerActionAvailability(
    data,
    managerCapabilityIdForAction("add-admin"),
    data.freshness?.status === "stale",
  );
  const actions = data.manager.capabilities.actions;
  const operationSummary = summarizeManagerCapabilities(actions);
  const sourceReviewed = data.manager.capabilities.sourceReview.exactReviewed;
  const traitCompatible = data.manager.capabilities.signerManagerTrait.compatible;
  const coreMonitoringAvailable = data.manager.attachAllowed && traitCompatible;
  const admins = data.activity.admins;

  return (
    <>
      <SettingsSectionTitle
        actions={
          <button
            className="btn btn-tertiary sm"
            disabled={readOnly || refreshingStatus}
            onClick={() => void onRefreshStatus?.()}
            type="button"
          >
            <ArrowClockwise className={`rw-ico ${refreshingStatus ? "spin" : ""}`} />
            {refreshingStatus ? "Refreshing" : "Refresh attachment"}
          </button>
        }
        hint={`${data.manager.attachAllowed ? "connected" : "needs attention"} · published at block ${number(data.manager.publishHeight)}`}
        id="st-manager"
      >
        Manager
      </SettingsSectionTitle>
      <section className="card st-card" aria-label="Manager">
        {!data.manager.attachAllowed ? (
          <div className="callout callout-caution st-inline-callout" role="status">
            <div className="body">
              <strong>Connect a running signer manager.</strong> Complete first-time setup,
              configure its principal, then refresh attachment.
              <div className="actions">
                <a
                  className="btn btn-secondary sm"
                  href={DOCUMENT_LINKS.zeroToSigning}
                  rel="noreferrer"
                  target="_blank"
                >
                  Zero to Signing <ArrowSquareOut aria-hidden="true" />
                </a>
              </div>
            </div>
          </div>
        ) : null}
        <div className="st-rows">
          <SettingsRow
            detail="registration, pool, rewards, and signer health"
            help={
              coreMonitoringAvailable
                ? data.manager.capabilities.signerManagerTrait.reason
                : (data.manager.reasons[0] ?? data.manager.capabilities.signerManagerTrait.reason)
            }
            name="PoX-5 interface"
            status={coreMonitoringAvailable ? "Compatible" : "Attention"}
            value={coreMonitoringAvailable ? "Core monitoring available" : "Connection blocked"}
          />
          <SettingsRow
            detail={`${sourceLabel(data)} · profile ${data.manager.source.profileId ?? "none"}${data.preflight.compatibility.profileRevision ? ` r${data.preflight.compatibility.profileRevision}` : ""}`}
            help={data.manager.capabilities.sourceReview.reason}
            name="Contract source"
            status={sourceReviewed ? "Reviewed" : "Custom"}
            value={
              <CopyableIdentifier
                className="identifier mono"
                display={short(data.manager.source.sha256, 10, 8)}
                label="manager source hash"
                value={data.manager.source.sha256}
              />
            }
          />
          <SettingsRow
            help="Compatibility is evaluated separately for each manager operation. Runtime readiness is checked again when you prepare an action."
            name="Manager operations"
            status={operationSummary.state}
            value={<span className="mono">{operationSummary.detail}</span>}
          >
            <details className="st-capability-details">
              <summary>Operation compatibility</summary>
              <div className="st-capability-list">
                {actions.map((capability) => (
                  <div className="st-capability" key={capability.id}>
                    <span>
                      {MANAGER_CAPABILITY_LABELS[capability.id]}
                      <SettingsInfo
                        label={`${MANAGER_CAPABILITY_LABELS[capability.id]} compatibility`}
                        text={managerCapabilityExplanation(capability)}
                      />
                    </span>
                    <StatusBadge status={managerCapabilityState(capability)} />
                  </div>
                ))}
              </div>
              {operationSummary.hasUnavailable ? (
                <p className="st-capability-help">
                  Need another manager operation?{" "}
                  <a
                    href={DOCUMENT_LINKS.managerCompatibilityIssue}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open a compatibility issue <ArrowSquareOut aria-hidden="true" />
                  </a>
                </p>
              ) : null}
            </details>
          </SettingsRow>
          <SettingsRow
            actions={
              establishedSignerParticipation ? (
                <a
                  aria-disabled={readOnly || !register.available}
                  className="btn btn-tertiary sm"
                  href={actionHash("register-self")}
                  title={register.reason}
                  onClick={(event) => {
                    if (readOnly || !register.available) event.preventDefault();
                  }}
                >
                  Rotate
                </a>
              ) : (
                <a
                  className="btn btn-tertiary sm"
                  href={DOCUMENT_LINKS.zeroToSigning}
                  rel="noreferrer"
                  target="_blank"
                >
                  First-time setup <ArrowSquareOut aria-hidden="true" />
                </a>
              )
            }
            detail={
              data.registration?.registered
                ? `registered · grant ${data.registration.signerKeyGrantValid ? "valid" : "not valid"} for cycle ${currentCycle}`
                : "not registered with this manager"
            }
            help="The signer public key registered with this manager and its current signer-key grant."
            name="Signer key"
            status={data.registration?.registered ? "Registered" : "Missing"}
            value={
              data.registration?.signerKeyHex ? (
                <CopyableIdentifier
                  className="identifier mono"
                  display={short(data.registration.signerKeyHex, 12, 8)}
                  label="signer public key"
                  value={data.registration.signerKeyHex}
                />
              ) : (
                <span className="muted">Not registered</span>
              )
            }
          />
          <SettingsRow
            actions={
              admins?.status === "current" ? (
                <>
                  <a
                    aria-disabled={readOnly || !updateAdmin.available}
                    aria-label="Add admin"
                    className="btn btn-tertiary sm"
                    href={actionHash("add-admin")}
                    title={updateAdmin.reason}
                    onClick={(event) => {
                      if (readOnly || !updateAdmin.available) event.preventDefault();
                    }}
                  >
                    Add
                  </a>
                  <a
                    aria-disabled={readOnly || !updateAdmin.available}
                    aria-label="Remove admin"
                    className="btn btn-tertiary sm"
                    href={actionHash("remove-admin")}
                    title={updateAdmin.reason}
                    onClick={(event) => {
                      if (readOnly || !updateAdmin.available) event.preventDefault();
                    }}
                  >
                    Remove
                  </a>
                </>
              ) : (
                <button
                  className="btn btn-tertiary sm"
                  disabled={readOnly || syncing}
                  onClick={sync}
                  type="button"
                >
                  <ArrowClockwise className={syncing ? "spin" : ""} />
                  {syncing ? "Syncing" : "Sync admin history"}
                </button>
              )
            }
            detail={
              admins?.status === "current"
                ? `${admins.principals.length} ${admins.principals.length === 1 ? "admin" : "admins"} · synced`
                : "load verified manager history before displaying admins"
            }
            help="Reconstructed from the deploying account and verified manager events."
            name="Admins"
            value={
              admins?.status === "current" ? (
                <span className="st-admins">
                  {admins.principals.map((principal) => (
                    <CopyableIdentifier
                      className="identifier mono"
                      display={principal}
                      key={principal}
                      label="manager admin principal"
                      value={principal}
                    />
                  ))}
                </span>
              ) : (
                <span className="muted">History sync required</span>
              )
            }
          />
        </div>
      </section>
    </>
  );
}
