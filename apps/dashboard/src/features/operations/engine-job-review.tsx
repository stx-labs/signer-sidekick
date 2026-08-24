import { Check, Warning } from "@phosphor-icons/react";
import type { EngineJobDetail } from "@stx-labs/signer-sidekick-api-contracts";
import { CopyableIdentifier } from "../../copyable-identifier.js";
import { Badge, StatLine } from "../../shared/dashboard-ui.js";
import { formatUstx, number } from "../../shared/format.js";
import { engineJobBadgeState } from "./job-state.js";

function label(value: string): string {
  return value.replaceAll("_", " ").replaceAll("-", " ");
}

function JobStateBadge({ state }: { state: EngineJobDetail["state"] }) {
  return <Badge state={engineJobBadgeState(state)}>{label(state)}</Badge>;
}

function ReviewHash({ name, value }: { name: string; value: string }) {
  return (
    <StatLine label={name}>
      <CopyableIdentifier value={value} label={name} className="identifier mono" />
    </StatLine>
  );
}

export function EngineJobReview({
  job,
  actionsEnabled,
}: {
  job: EngineJobDetail;
  actionsEnabled: boolean;
}) {
  const { review } = job;

  return (
    <section className="engine-job-detail" aria-label="Transaction job detail">
      <div className="card-head engine-job-heading">
        <div>
          <span className="eyebrow">Transaction review</span>
          <h2>{review.call.functionName}</h2>
          <CopyableIdentifier value={job.jobId} label="job ID" className="identifier mono" />
        </div>
        <JobStateBadge state={job.state} />
      </div>

      {!actionsEnabled ? (
        <div className="callout callout-caution engine-action-stale" role="status">
          <Warning className="ic" />
          <div className="body">
            Action controls are disabled until this job is freshly loaded and validated.
          </div>
        </div>
      ) : null}
      {job.blockReason ? (
        <div className="callout callout-caution">
          <Warning className="ic" />
          <div className="body">
            <strong>Broadcast blocked.</strong> {job.blockReason}
          </div>
        </div>
      ) : null}

      <div className="engine-review-grid">
        <div className="engine-review-card">
          <h3>Intent</h3>
          <StatLine label="Mode">{label(job.mode)}</StatLine>
          <StatLine label="Adapter">
            <span className="mono">
              {review.adapter.id} · revision {review.adapter.revision}
            </span>
          </StatLine>
          <StatLine label="Network">{review.network}</StatLine>
          <StatLine label="Manager">
            <CopyableIdentifier
              value={review.managerPrincipal}
              label="manager principal"
              className="identifier mono"
            />
          </StatLine>
          <StatLine label="Contract">
            <CopyableIdentifier
              value={review.call.contract}
              label="contract principal"
              className="identifier mono"
            />
          </StatLine>
          <StatLine label="Function">
            <span className="mono">{review.call.functionName}</span>
          </StatLine>
        </div>

        <div className="engine-review-card">
          <h3>Reward checkpoint</h3>
          <StatLine label="Reward cycle">{number(review.checkpoint.rewardCycle)}</StatLine>
          <StatLine label="Calculation checkpoint">
            {label(review.checkpoint.calculationCheckpoint)}
          </StatLine>
          <StatLine label="Last reward compute height">
            {number(review.checkpoint.lastRewardComputeHeight)}
          </StatLine>
          <StatLine label="Rewards per token">
            <span className="mono">{review.checkpoint.rewardsPerToken}</span>
          </StatLine>
          <StatLine label="Stacks block">{number(review.anchor.stacksBlockHeight)}</StatLine>
          <StatLine label="Bitcoin block">{number(review.anchor.burnBlockHeight)}</StatLine>
          <StatLine label="Index block hash">
            <CopyableIdentifier
              value={review.anchor.indexBlockHash}
              label="index block hash"
              className="identifier mono"
            />
          </StatLine>
          <StatLine label="Cycle position">
            {number(review.anchor.cyclePosition)} / {number(review.anchor.rewardCycleLength)} ·{" "}
            {review.anchor.phase}
          </StatLine>
        </div>

        <div className="engine-review-card">
          <h3>Recipient and asset bounds</h3>
          <StatLine label="Expected recipient">
            <CopyableIdentifier
              value={review.expectedEffect.recipient.principal}
              label="expected recipient"
              className="identifier mono"
            />
          </StatLine>
          <StatLine label="Asset">
            <span>
              {review.expectedEffect.asset.symbol} ·{" "}
              <span className="mono">{review.expectedEffect.asset.assetId}</span>
            </span>
          </StatLine>
          <StatLine label="Maximum asset outflow">
            <strong>
              {review.expectedEffect.asset.maximumOutflow} {review.expectedEffect.asset.unit}
            </strong>
          </StatLine>
          <div className="engine-review-copy">
            <span>Postconditions</span>
            <ul>
              {review.expectedEffect.postconditions.map((postcondition) => (
                <li key={postcondition}>{postcondition}</li>
              ))}
            </ul>
          </div>
          <div className="engine-review-copy">
            <span>Expected post-state</span>
            <p>{review.expectedPostState}</p>
          </div>
          <div className="engine-review-copy">
            <span>Expected result</span>
            <p className="mono">{review.expectedEffect.reconciliationPredicate}</p>
          </div>
        </div>

        <div className="engine-review-card">
          <h3>Fees and approval hashes</h3>
          <StatLine label="Fee snapshot">
            {review.fee.snapshot.state}
            {review.fee.snapshot.feeBips === null ? "" : ` · ${review.fee.snapshot.feeBips} bips`}
            <span className="sub">{review.fee.snapshot.source}</span>
          </StatLine>
          <StatLine label="Estimated transaction fee">
            {formatUstx(review.fee.estimatedFeeUstx)} STX
          </StatLine>
          <StatLine label="Maximum transaction fee">
            <strong>{formatUstx(review.fee.maximumFeeUstx)} STX</strong>
          </StatLine>
          <StatLine label="Fee policy revision">{review.fee.policyRevision}</StatLine>
          <ReviewHash name="Intent hash" value={review.hashes.intentSha256} />
          <ReviewHash name="Policy hash" value={review.hashes.policySha256} />
          <ReviewHash name="Attestation hash" value={review.hashes.attestationSha256} />
        </div>
      </div>

      <div className="engine-review-card engine-arguments">
        <h3>Arguments</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Value</th>
                <th>Clarity</th>
              </tr>
            </thead>
            <tbody>
              {review.call.arguments.map((argument) => (
                <tr key={argument.name}>
                  <td>{argument.name}</td>
                  <td className="mono">{argument.displayValue}</td>
                  <td>
                    <CopyableIdentifier
                      value={argument.clarityValue}
                      label={`${argument.name} Clarity value`}
                      className="identifier mono"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="engine-review-card engine-approval">
        <div className="card-head">
          <h3>Approval</h3>
          {job.approval ? (
            <Badge state={job.approval.invalidatedAt ? "error" : "success"}>
              {job.approval.invalidatedAt ? "Invalidated" : "Approved"}
            </Badge>
          ) : (
            <Badge state={job.approvalWindow.eligible ? "caution" : "neutral"}>
              {job.approvalWindow.eligible ? "Awaiting approval" : "Unavailable"}
            </Badge>
          )}
        </div>
        {job.approval ? (
          <>
            <StatLine label="Actor">{job.approval.actor}</StatLine>
            <StatLine label="Created">{new Date(job.approval.createdAt).toLocaleString()}</StatLine>
            <StatLine label="Expires">{new Date(job.approval.expiresAt).toLocaleString()}</StatLine>
            <ReviewHash name="Approval hash" value={job.approval.approvalSha256} />
            {job.approval.invalidatedAt ? (
              <StatLine label="Invalidated">
                {new Date(job.approval.invalidatedAt).toLocaleString()} ·{" "}
                {job.approval.invalidationReason}
              </StatLine>
            ) : null}
          </>
        ) : (
          <p className="muted">
            {job.approvalWindow.reason ??
              (job.approvalWindow.expiresAt
                ? `Approval will expire ${new Date(job.approvalWindow.expiresAt).toLocaleString()}.`
                : "This job is not currently eligible for approval.")}
          </p>
        )}
      </div>

      <div className="engine-review-grid">
        <div className="engine-review-card">
          <h3>Attempts and canonicality</h3>
          {job.nonce ? (
            <StatLine label="Reserved nonce">
              <span className="mono">{job.nonce.value}</span> · {job.nonce.state}
              {job.nonce.foreignActivity ? " · foreign activity detected" : ""}
            </StatLine>
          ) : (
            <p className="muted">No nonce has been reserved.</p>
          )}
          {job.attempts.map((attempt) => (
            <div className="engine-attempt" key={attempt.attemptNumber}>
              <div className="card-head">
                <strong>Attempt {attempt.attemptNumber}</strong>
                <Badge state={attempt.state === "confirmed" ? "success" : "info"}>
                  {attempt.state}
                </Badge>
              </div>
              <StatLine label="Nonce">{attempt.nonce}</StatLine>
              <StatLine label="Fee">{formatUstx(attempt.feeUstx)} STX</StatLine>
              <StatLine label="Transaction ID">
                {attempt.txid ? (
                  <CopyableIdentifier
                    value={attempt.txid}
                    label="transaction ID"
                    className="identifier mono"
                  />
                ) : (
                  "not submitted"
                )}
              </StatLine>
              <StatLine label="Canonicality">
                {attempt.confirmation
                  ? `${attempt.confirmation.canonical ? "canonical" : "noncanonical"} · ${attempt.confirmation.finalized ? "final" : "not final"}`
                  : "not confirmed"}
              </StatLine>
            </div>
          ))}
        </div>

        <div className="engine-review-card">
          <h3>Result verification</h3>
          {job.reconciliation ? (
            <>
              <div className="callout callout-info">
                <Check className="ic" />
                <div className="body">
                  <strong>{label(job.reconciliation.outcome)}</strong> ·{" "}
                  {job.reconciliation.canonical ? "canonical" : "noncanonical"} ·{" "}
                  {job.reconciliation.finalized ? "final" : "not final"}
                </div>
              </div>
              <p className="mono engine-predicate">{job.reconciliation.predicate}</p>
              {job.reconciliation.evidence.map((evidence) => (
                <StatLine label={`${evidence.source} · ${evidence.field}`} key={evidence.field}>
                  <span className="mono">{evidence.value}</span>
                </StatLine>
              ))}
            </>
          ) : (
            <p className="muted">No result verification has been recorded.</p>
          )}
        </div>
      </div>
    </section>
  );
}
