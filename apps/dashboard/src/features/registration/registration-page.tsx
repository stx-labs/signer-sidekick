import { ShieldCheck, WarningCircle } from "@phosphor-icons/react";
import type { DashboardSnapshot } from "@stx-labs/signer-sidekick-api-contracts";
import { CopyableIdentifier } from "../../copyable-identifier.js";
import { Badge, PageHead, StatLine } from "../../shared/dashboard-ui.js";
import { number, short, stx } from "../../shared/format.js";

type Snapshot = DashboardSnapshot;

export function Registration({ data }: { data: Snapshot }) {
  const cycles = data.forecast?.cycles ?? [];
  const recognitionLabel =
    data.manager.source.tier === "reference-built-in"
      ? "Reference — built in"
      : data.manager.source.tier === "reference-render"
        ? "Reference render — verified"
        : data.manager.source.tier === "custom-observe"
          ? "Custom — read-only"
          : "Not recognized — read-only";
  const referenceRecognized =
    data.manager.source.tier === "reference-built-in" ||
    data.manager.source.tier === "reference-render";
  return (
    <>
      <PageHead
        title="Registration"
        lede="Can the manager and signer accept and retain eligible stakes? Protocol registration health — not signer-machine health."
      />
      <div className="callout callout-info intro-callout">
        <ShieldCheck className="ic" />
        <div className="body">
          Sidekick holds no signer or admin key. Registration and grant actions are prepared offline
          and verified from the connected node.
        </div>
      </div>
      <div className="grid cols-2">
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
              {data.manager.automationEligible ? "Eligible for Assist" : "Observe only"}
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
                ? `Attach and all data display work normally. Assist will not broadcast against this source: ${data.manager.automationEligibilityReason}. If this is your own reference-manager render, generate and install a trusted profile.`
                : data.manager.source.tier === "custom-observe"
                  ? "This operator-installed custom profile is intentionally limited to attach, reconciliation, and monitoring. Custom-manager Assist requires a separately reviewed adapter."
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
        </div>
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
