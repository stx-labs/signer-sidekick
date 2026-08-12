# Onboarding and runtime settings

The dashboard wraps the same connected verification used by the CLI. It supports Attach Existing,
Fresh Setup, and skipping the wizard without changing Sidekick's custody boundary.

## Safety boundary

Sidekick accepts public principals and public signer-grant output, but never a signer private key,
manager-admin private key, mnemonic, or arbitrary signing request. In Assist it may hold a
dedicated, low-balance gas-payer key and sign only the fixed code-backed
`reference-manager-claim-rewards` transaction vector. Setup and manager-admin calls remain
externally signed. Sidekick can pass an exact prepared request using any supported configured
network key, then verify the fetched transaction's chain ID and poststate. Manual handoff remains
available.

Fixed manager administration and registration require the configured manager, full interface, and
node/API network routing. Source/profile trust adds a review warning but does not block those
external actions. It remains a hard gate for Assist, with production approval required only on
mainnet.

Observe may hand an existing preflighted reward-claim job to that same external boundary. It does
not replan the job or enter Assist approval, nonce, or attempt state. The job retains the exact
reference-manager profile and attestation gates; normal engine reconciliation remains authoritative.

Wallet intents are versioned, sealed, expiring, and stored separately from Assist. The API accepts
only a txid after signing; it never accepts transaction fields, signed bytes, or wallet credentials.
Wallet address selection is not operator authentication.

`SIDEKICK_MANAGER_PRINCIPAL` is the fixed identity of a deployment. Fresh inputs must resolve to
that principal, and Attach cannot silently switch it.

## Resumability

The selected path, current step, generated public artifacts, grant verification, wallet intents,
and append-only action evidence are stored in SQLite. Same-path restarts preserve progress; changing
paths requires an explicit reset. Skipping the wizard changes only its visibility and does not mark
checks complete.

Polling failures never discard saved state. The dashboard marks retained local state stale only when
the node-backed refresh fails. A delayed Reference API is reported separately and does not block
node-backed setup or wallet actions. API-indexed roster, history, fallback transaction lookup, and
Assist completeness proofs remain individually degraded or fail-closed. A transaction absent from
both indexed and pending node state may be explicitly superseded after a 15-minute grace period;
replacement always creates a new sealed intent.

## Runtime settings

Operators may change the default theme; Stacks API, node RPC, node metrics, signer-monitoring, and
Hiro reference endpoints; API credentials; forecast horizon; public pool metadata; and the public
embed URL. Candidate endpoint changes must pass preflight before becoming active.
Transaction-engine policy and gas-payer identity are deployment-only configuration, not general
runtime settings.

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
