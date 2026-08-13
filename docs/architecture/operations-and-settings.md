# Operations and runtime settings

Signer Sidekick attaches to one configured, deployed signer manager. It does not install a node or
signer, deploy a manager contract, or guide first-time registration. Use
[Zero to Signing](https://stx.fan/zero_to/signing/) for that wallet-signed day-zero flow and
[stacksup](https://github.com/stx-labs/stacksup) for infrastructure lifecycle management.

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

See [deployment](../operator/deployment.md) for backup, restore, and support-bundle procedures.
