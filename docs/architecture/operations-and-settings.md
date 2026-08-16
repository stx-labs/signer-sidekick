# Operations and runtime settings

Signer Sidekick connects to one configured, deployed signer manager. It does not install a node or
signer, deploy a manager contract, or guide first-time registration. Use
[Zero to Signing](https://stx.fan/zero_to/signing/) for that wallet-signed day-zero flow and
[stacksup](https://github.com/stx-labs/stacksup) for infrastructure lifecycle management.
If the dApp is unavailable, the product links the pinned
[upstream reference manager](https://github.com/stacks-network/stacks-core/blob/efc34a07a225c4b950ab9404a1652aa5e14affaf/contrib/core-contract-tests/contracts/signer-manager.clar)
and the official [contract deployment guide](https://docs.stacks.co/clarinet/contract-deployment) as
the manual fallback. Sidekick support begins after those day-zero calls produce a deployed,
trait-compatible manager; it does not own or support the external setup flow.

## Operating boundary

Sidekick continuously turns node, signer, PoX-5, manager-event, and indexed API observations into a
durable operator record. It answers four recurring questions:

1. Is the network producing blocks and are my node and signer participating normally?
2. Is my signer registration and grant valid for the manager I operate?
3. Which stakers, bonds, rewards, fees, withdrawals, and future-cycle changes need action?
4. If something is wrong, is the evidence local, upstream, or network-wide, and what should I send
   Stacks Labs?

The configured Stacks node is authoritative for current chain state. Indexed APIs add roster,
event, and historical coverage; their lag degrades only the features that require indexed evidence.
The signer is observed deeply enough to explain operational signing health, but Sidekick does not
start, stop, install, or configure it.

## Custody and transaction safety

Sidekick accepts public principals and public signer-grant output, but never a signer private key,
manager-admin private key, mnemonic, or arbitrary signing request. In Assist it may hold a
dedicated, low-balance gas-payer key and sign only a fixed reviewed transaction vector. Signer
registration, manager administration, and Observe reward claims remain externally signed.

Wallet intents are versioned, sealed, expiring, and stored separately from Assist. The API accepts
only a transaction ID after signing; it never accepts signed bytes or wallet credentials. Sidekick
then verifies the fetched transaction's sender, chain binding, function, arguments, postconditions,
canonical inclusion, and expected poststate.

Manager source identity is not a universal gate. Sidekick detects the baseline PoX-5 interface and
enables supported actions by capability. A custom manager remains observable and usable for those
baseline features; optional semantics and Assist require a reviewed adapter.

## Durable reconciliation

Current operator state refreshes on demand and while the browser is active. Manager events and
staking roster data are reconciled into SQLite independently of an open browser, with durable
cursors, canonical anchors, idempotent replay, reorg handling, and bounded retry backoff. A delayed
reference API is reported separately and does not block node-backed operations.

A separate private callback listener is the low-latency input from the configured Stacks node. It
commits bounded event-dispatcher payloads to a durable inbox before acknowledging them, records
duplicate attempts, and keeps callback contents out of permanent history and current projections.
The restart-safe inbox worker fences `/v2/info` with `/v3/tenures/info`, fetches the claimed
Nakamoto block by index-block ID, and compares its raw bytes with the canonical block at the same
height under that exact stable tip. Only a byte-identical index-block claim becomes
`node-verified`; the callback's block-hash field and embedded events remain untrusted. Conflicting
bodies for one chain position fail closed into quarantine. Terminal raw callback JSON is retained
for at most 24 hours and also capped at 25,000 payloads or 64 MiB; durable identity, result, timing,
and attempt evidence remains after pruning.
Burn-block callbacks are trigger-only because the local Stacks RPC does not expose an equivalent
burn-header proof; they expire after the node reaches their claimed height. Malformed or forged
claims are quarantined with a bounded reason. Callback delivery never grants a manager capability,
and API backfill plus periodic anti-entropy remain the recovery paths for loss, reordering, restart,
and reorg. Independently indexed manager events become permanent only after the local transaction
index confirms their exact canonical Stacks height and index-block hash.

A transaction absent from both indexed and pending node state may be explicitly superseded after a
15-minute grace period. Replacement always creates a new sealed intent. Existing deployment-era
database rows and API response shapes remain readable during upgrades, but no first-time setup
route or public enrollment artifact is generated.

## Runtime settings

Operators may change the theme; Stacks API, node RPC, node metrics, signer-monitoring, and Hiro
reference endpoints; API credentials; and forecast horizon. Candidate endpoint changes must pass
preflight before becoming active. Transaction-engine policy and gas-payer identity are
deployment-only configuration.

API keys are write-only in the browser and stored separately from public settings. They may be
persisted in SQLite, so the database and backups are secret-bearing. Signer, manager-admin, and
gas-payer private keys are forbidden from SQLite.

Settings revisions take precedence over later environment changes. Ingestion cursors remain scoped
to their source endpoint, preventing one provider's checkpoint from being reused for another.

See [operations](../operator/operations.md) for backup, restore, and support collection.
