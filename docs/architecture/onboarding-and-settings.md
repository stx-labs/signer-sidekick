# Onboarding and runtime settings

The dashboard wraps the same connected verification used by the CLI. It supports Attach Existing,
Fresh Setup, and skipping the wizard without changing Sidekick's custody boundary.

## Safety boundary

Sidekick accepts public principals and public signer-grant output, but never a manager-admin key,
signer key, mnemonic, or signing request. Deployment and `register-self` are reviewed and broadcast
externally; Sidekick verifies their effects afterward.

`SIDEKICK_MANAGER_PRINCIPAL` is the fixed identity of a deployment. Fresh inputs must resolve to
that principal, and Attach cannot silently switch it.

## Resumability

The selected path, current step, generated public artifacts, grant verification, and an append-only
action audit are stored in SQLite. Same-path restarts preserve progress; changing paths requires an
explicit reset. Skipping the wizard changes only its visibility and does not mark checks complete.

Polling failures never discard saved state. The operator can resume after the node or API recovers.

## Runtime settings

Operators may change presentation, node/API endpoints, API credentials, forecast horizon, public
pool metadata, payout policy, gas-budget policy, and alert policy. Candidate connectivity changes
must pass preflight before becoming active.

API keys are write-only in the browser and stored separately from public settings. They may be
persisted in SQLite, so the database and backups are secret-bearing. Signer, manager-admin, and
gas-payer private keys are forbidden from SQLite.

Settings revisions take precedence over later environment changes. Ingestion cursors remain scoped
to their source endpoint, preventing one provider's checkpoint from being reused for another.

## Public pool artifacts

Sidekick generates versioned JSON and self-contained HTML for the operator to host elsewhere. It
has no unauthenticated pool route.

Static output contains a snapshot. Live output may refresh only public network context from an
unauthenticated endpoint; manager verification and pool facts remain snapshots until regenerated.
Artifacts exclude credentials, gas-payer details, jobs, alerts, and local history.

See [deployment](../operator/deployment.md) for backup and restore and source schemas/tests for the
exact persisted and public formats.
