import {
  ArrowClockwise,
  ArrowSquareOut,
  Key,
  ShieldCheck,
  UserMinus,
  UserPlus,
  WarningCircle,
} from "@phosphor-icons/react";
import type { DashboardSnapshot } from "@stx-labs/signer-sidekick-api-contracts";
import { CopyableIdentifier } from "../../copyable-identifier.js";
import { actionHash } from "../../dashboard-route.js";
import { Badge, StatLine } from "../../shared/dashboard-ui.js";
import { DOCUMENT_LINKS } from "../../shared/document-links.js";
import { number, short } from "../../shared/format.js";
import { managerActionAvailability } from "../../shared/manager-action-availability.js";
import { managerCapabilityIdForAction } from "../manager/manager-page.js";

function sourceLabel(data: DashboardSnapshot): string {
  switch (data.manager.source.tier) {
    case "reference-built-in":
      return "Built-in source";
    case "reference-render":
      return "Reviewed source";
    case "custom-observe":
      return "Recorded custom source";
    case "unrecognized":
      return "Custom source";
  }
}

export function ManagerSettings({
  data,
  onRefreshStatus,
  refreshingStatus,
  sync,
  syncing,
  view = "all",
}: {
  data: DashboardSnapshot;
  onRefreshStatus?: (() => void | Promise<void>) | undefined;
  refreshingStatus: boolean;
  sync: () => void;
  syncing: boolean;
  view?: "all" | "attachment" | "operations";
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

  return (
    <>
      {view !== "operations" ? (
        <section className="card-standout set-section" id="attachment">
          <div className="card-head">
            <div>
              <span className="eyebrow">Running deployment</span>
              <h2>Manager attachment</h2>
            </div>
            <Badge state={data.manager.attachAllowed ? "success" : "error"}>
              {data.manager.attachAllowed ? "Attached" : "Needs attention"}
            </Badge>
          </div>
          {!data.manager.attachAllowed ? (
            <div className="callout callout-caution" role="status">
              <WarningCircle className="ic" />
              <div className="body">
                <strong>Connect a running signer manager.</strong>
                <br />
                Sidekick starts after first-time setup. Complete setup externally, configure the
                resulting manager principal for this deployment, then refresh the attachment.
                <div className="actions">
                  <a
                    className="btn btn-secondary sm"
                    href={DOCUMENT_LINKS.zeroToSigning}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Open Zero to Signing <ArrowSquareOut aria-hidden="true" />
                  </a>
                  <a
                    className="btn btn-tertiary sm"
                    href={DOCUMENT_LINKS.referenceManager}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Upstream manager source <ArrowSquareOut aria-hidden="true" />
                  </a>
                </div>
              </div>
            </div>
          ) : null}
          <div className="grid cols-2 manager-status-grid">
            <div className="card">
              <StatLine label="Manager principal">
                <CopyableIdentifier
                  className="identifier"
                  display={short(data.managerPrincipal, 12, 9)}
                  label="manager principal"
                  value={data.managerPrincipal}
                />
              </StatLine>
              <StatLine label="Published">
                <span className="mono">Stacks block {number(data.manager.publishHeight)}</span>
              </StatLine>
              <StatLine label="Source profile">
                {data.manager.source.profileId ?? "No installed profile"}
              </StatLine>
              <StatLine label="Source classification">
                <Badge
                  state={
                    data.manager.capabilities.signerManagerTrait.compatible ? "success" : "error"
                  }
                >
                  {sourceLabel(data)}
                </Badge>
              </StatLine>
              <StatLine label="Profile origin">
                {data.manager.source.origin === "operator-installed"
                  ? "Operator-installed"
                  : data.manager.source.origin === "built-in"
                    ? "Built into Sidekick"
                    : "None"}
              </StatLine>
              <StatLine label="Reviewed reward calls">
                <Badge state={data.manager.automationEligible ? "success" : "neutral"}>
                  {data.manager.automationEligible ? "Available" : "Unavailable"}
                </Badge>
              </StatLine>
              <StatLine label="Source hash">
                <CopyableIdentifier
                  className="identifier src src-chain"
                  display={short(data.manager.source.sha256, 12, 8)}
                  label="manager source hash"
                  value={data.manager.source.sha256}
                />
              </StatLine>
            </div>
            <div className="card">
              <StatLine label="Signer public key">
                <CopyableIdentifier
                  className="identifier"
                  display={short(data.registration?.signerKeyHex, 12, 8)}
                  label="signer public key"
                  value={data.registration?.signerKeyHex}
                />
              </StatLine>
              <StatLine label="Registration">
                <Badge state={data.registration?.registered ? "success" : "error"}>
                  {data.registration?.registered ? "Confirmed" : "Missing"}
                </Badge>
              </StatLine>
              <StatLine label="Signer key grant">
                <Badge state={data.registration?.signerKeyGrantValid ? "success" : "error"}>
                  {data.registration?.signerKeyGrantValid ? "Valid" : "Invalid"}
                </Badge>
              </StatLine>
              <StatLine label="PoX-5 contract">
                <CopyableIdentifier
                  className="identifier"
                  display={short(data.preflight.pox.pox5ContractId, 12, 8)}
                  label="PoX-5 contract principal"
                  value={data.preflight.pox.pox5ContractId}
                />
              </StatLine>
              <div className="actions settings-inline-actions">
                {establishedSignerParticipation ? (
                  <a
                    className="btn btn-secondary sm"
                    href={actionHash("register-self")}
                    title={register.reason}
                    aria-disabled={!register.available}
                    onClick={(event) => {
                      if (!register.available) event.preventDefault();
                    }}
                  >
                    <Key /> Review signer registration or rotation
                  </a>
                ) : (
                  <a
                    className="btn btn-secondary sm"
                    href={DOCUMENT_LINKS.zeroToSigning}
                    rel="noreferrer"
                    target="_blank"
                  >
                    First-time signer setup <ArrowSquareOut aria-hidden="true" />
                  </a>
                )}
                <button
                  className="btn btn-tertiary sm"
                  disabled={refreshingStatus}
                  onClick={() => void onRefreshStatus?.()}
                  type="button"
                >
                  <ArrowClockwise className={refreshingStatus ? "spin" : ""} />
                  {refreshingStatus ? "Refreshing" : "Refresh attachment"}
                </button>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {view !== "attachment" ? (
        <>
          <section className="card set-section" id="capabilities">
            <div className="card-head">
              <div>
                <span className="eyebrow">Manager evidence</span>
                <h2>Baseline capabilities</h2>
              </div>
              <Badge
                state={
                  data.manager.capabilities.signerManagerTrait.compatible ? "success" : "error"
                }
              >
                {data.manager.capabilities.signerManagerTrait.compatible
                  ? "PoX-5 compatible"
                  : "Incompatible"}
              </Badge>
            </div>
            <p className="muted">{data.manager.capabilities.signerManagerTrait.reason}</p>
            <div className="manager-capability-list">
              {data.manager.capabilities.actions.map((capability) => (
                <div className="statline" key={capability.id}>
                  {capability.reason ? (
                    <button
                      aria-label={`${capability.id}: ${capability.reason}`}
                      className="k mono tooltip-trigger capability-tip"
                      data-tooltip={capability.reason}
                      type="button"
                    >
                      {capability.id}
                    </button>
                  ) : (
                    <span className="k mono">{capability.id}</span>
                  )}
                  <span className="v">
                    <Badge state={capability.executionAvailable ? "success" : "neutral"}>
                      {capability.executionAvailable ? "Available" : "Observe only"}
                    </Badge>
                  </span>
                </div>
              ))}
            </div>
            <div className="callout callout-info security-note">
              <ShieldCheck className="ic" />
              <div className="body">
                <strong>
                  {data.manager.automationEligible
                    ? "Reviewed reward calls available."
                    : "Reviewed reward calls unavailable."}
                </strong>{" "}
                {!data.manager.automationEligible ? data.manager.automationEligibilityReason : null}
              </div>
            </div>
          </section>

          <section className="card set-section" id="manager-admins">
            <div className="card-head">
              <div>
                <span className="eyebrow">Authority</span>
                <h2>Manager admins</h2>
              </div>
              <div className="actions">
                <a
                  aria-disabled={!updateAdmin.available}
                  className="btn btn-secondary sm"
                  href={actionHash("add-admin")}
                  title={updateAdmin.reason}
                  onClick={(event) => {
                    if (!updateAdmin.available) event.preventDefault();
                  }}
                >
                  <UserPlus /> Add admin
                </a>
                <a
                  aria-disabled={!updateAdmin.available}
                  className="btn btn-tertiary sm"
                  href={actionHash("remove-admin")}
                  title={updateAdmin.reason}
                  onClick={(event) => {
                    if (!updateAdmin.available) event.preventDefault();
                  }}
                >
                  <UserMinus /> Remove admin
                </a>
              </div>
            </div>
            {data.activity.admins?.status === "current" ? (
              <>
                <p className="muted">
                  Reconstructed from the deploying account and verified manager events.
                </p>
                <div className="manager-admin-principals">
                  {data.activity.admins.principals.map((principal) => (
                    <CopyableIdentifier
                      className="identifier"
                      display={principal}
                      key={principal}
                      label="manager admin principal"
                      value={principal}
                    />
                  ))}
                </div>
              </>
            ) : (
              <div className="manager-admin-sync">
                <p className="muted">Load the manager’s full admin history before displaying it.</p>
                <button
                  className="btn btn-tertiary sm"
                  disabled={syncing}
                  onClick={sync}
                  type="button"
                >
                  <ArrowClockwise className={syncing ? "spin" : ""} />
                  {syncing ? "Syncing" : "Sync admin history"}
                </button>
              </div>
            )}
          </section>
        </>
      ) : null}
    </>
  );
}
