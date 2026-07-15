# Guided onboarding and runtime settings

Phase 3 adds the authenticated web workflow around the activation foundation. It supports an
operator who is attaching Sidekick to a running signer-manager and an operator preparing a new
manager. Both paths use the same node/API verification code as the CLI and keep signing outside
Sidekick.

## Safety boundary

Sidekick never accepts a manager-admin key, signer private key, mnemonic, or transaction-signing
request. It generates deterministic artifacts, signer-host commands, and a `register-self` call
manifest. The operator deploys and broadcasts through their existing external tooling. Sidekick
then verifies the resulting source, registration, grant, and signer-set eligibility through
read-only node calls.

Every onboarding response declares these invariants explicitly:

- `acceptsManagerAdminKey: false`
- `acceptsSignerPrivateKey: false`
- `signsTransactions: false`
- `broadcastsTransactions: false`

The configured `SIDEKICK_MANAGER_PRINCIPAL` remains the deployment identity. Fresh setup therefore
requires the proposed admin principal and contract name to produce that exact principal. This lets
the operator choose the future contract principal before deploying it without allowing a running
Sidekick instance to silently switch managers.

## Resumable workflows

SQLite migration 8 adds a singleton `onboarding_state` row. Migration 9 adds an append-only
`onboarding_audit` that records action, path, step, status, and time without storing submitted
payloads. The state row stores the chosen path, current
step, status, activation plan, generated public artifacts, and verified signer-grant output. Each
transition is committed before its response is returned, so a browser reload or Sidekick restart
resumes at the stored step.

Attach Existing runs the source/interface, registration, live signer grant, and eligibility checks
against the configured manager. Fresh Setup provides eight operator-facing steps:

1. Prerequisites and connected-source preflight.
2. Deterministic manager source and deployment-manifest generation.
3. External manager deployment and read-only detection.
4. Signer-host grant command, strict returned-JSON verification, and external ceremony guidance.
5. External `register-self` call manifest and read-only registration detection.
6. Pool and payout policy.
7. Public gas-payer identity and Observe-mode boundary.
8. Final verification and pool-information publishing.

Starting the same path is a no-op, and switching paths requires explicit confirmation before the
saved progress is reset. Deployment and registration screens poll every 20 seconds while visible and also offer manual
refresh. Poll failures are non-destructive: the stored step remains available and the operator can
retry after their node or API recovers.

## Runtime settings and secrets

Migration 8 also adds `runtime_settings` and `settings_audit`. Settings are a single versioned
document with a monotonically increasing revision. The audit table records only changed field
names and timestamps; it does not retain old values or secret material.

The operator can change:

- pool name, website, support contact, and official Leather enrollment URL;
- node RPC, Stacks API URL, API-key header, and API key;
- forecast horizon and public-pool-card API source;
- timezone, time/number format, and default theme;
- payout and gas-budget policy values;
- a dedicated public gas-payer principal; and
- alert policy and the future webhook destination.

URL validation rejects embedded credentials, query parameters, and fragments. A gas-payer
principal must match the configured network and must not be the manager-admin address. Automation
remains Observe-only in Phase 3; webhook delivery and transaction modes are Phase 4 work.

The API key has explicit keep, replace, and clear actions. A replacement is stored separately from
the public settings JSON in the local SQLite database and is never returned to the browser,
snapshots, exports, or support bundles. The public API reports only whether a key exists and whether
its source is the environment, database, or neither. Because the database can contain this API
credential, its file and backups are secret-bearing and must be protected accordingly. This is an
intentional V1 tradeoff to support operator-requested API-key replacement through the UI. API
credentials are provider access tokens, not custody or transaction-signing keys; signer,
manager-admin, and gas-payer keys remain forbidden from SQLite.

Changing the node, API endpoint, key, or key header runs the normal network/API/PoX preflight
against the candidate configuration before it is committed. A failed replacement leaves the prior
revision active. Existing ingestion cursors
remain scoped to the provider/source identity derived from the endpoint, so changing providers does
not reuse another provider's cursor or erase its history.

Once a settings revision exists, its node/API URLs, API-key mode/header, and forecast horizon take
precedence over later environment changes. An API key whose recorded source is `environment`
continues to read the current environment value. Use the Settings keep/replace/clear controls for
intentional runtime changes rather than editing both sources independently.

## Public pool artifacts

The Public Pool Page screen generates versioned JSON plus a self-contained HTML file. Sidekick has
no unauthenticated pool route; the operator downloads and hosts the artifact elsewhere.

Static mode emits baked HTML plus the versioned JSON snapshot. Live mode emits HTML that may fetch only unauthenticated
`/v2/pox` data from the configured public API to refresh reward-cycle and burn-height context. The
verified manager source, registration, grant, fee, pool, and eligibility facts remain a generated
snapshot until the operator regenerates the artifact. Neither mode includes API credentials, gas
payer details, jobs, alerts, transaction history, or local database history.

## Backup, restore, and existing deployments

All onboarding and settings state lives in the same SQLite database as the read-only control plane.
The existing online backup and offline restore procedure therefore preserves wizard progress,
settings revisions, and a database-stored API key. Protect and rotate backups as credentials.

An existing deployment does not need to reinitialize its manager. Configure its manager principal,
start Sidekick against the existing database or a new empty database, select Attach Existing, and
let the read-only verification and history reconciliation populate local state.

See [container deployment](../operator/deployment.md) for backup and restore commands and
[development setup](../operator/development.md) for local testing.
