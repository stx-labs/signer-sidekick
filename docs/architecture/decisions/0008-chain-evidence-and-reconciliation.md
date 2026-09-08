# ADR 0008: Node-authoritative event reconciliation

- Status: Accepted
- Date: 2026-08-16

## Decision

The configured Stacks node is authoritative for current canonical chain state. Indexed APIs are
discovery, roster, and historical sources; signer monitoring is protocol-health evidence. No remote
source may override a node-proved fact, and one lagging optional source must not block unrelated
node-backed work.

Sidekick is event-driven but does not trust event callbacks. The private callback listener commits
each bounded payload to a durable inbox before acknowledging it. A worker verifies the claimed
Nakamoto block against a stable local-node anchor and admits only byte-identical canonical evidence.
Malformed, conflicting, or forged claims are quarantined. Burn-block callbacks remain trigger-only
where the local RPC cannot supply an equivalent proof.

Verified events request focused reconciliation; they are not projections by themselves. Indexed
manager events become durable domain history only after node-backed canonical verification,
using the transaction index or the canonical block fallback. Idempotent replay, source-scoped cursors, reorg handling,
bounded retries, and periodic anti-entropy repair missed, reordered, or delayed delivery.

The server maintains current operator state without an open browser. A single-flight snapshot loop
refreshes current state every 30 seconds, while event triggers and slower domain-specific loops
refresh rosters and history. The dashboard reads retained projections and can request a coalesced
refresh; it is never the scheduler of record.

### Submitted transaction observation (R3a)

Without a local transaction-index row, the configured API locates the transaction and reports its
execution outcome. Transaction and block identity must agree. Sidekick then walks the node's
canonical block and gives the matching transaction's bytes to the same full wallet verifier used
by the index path. API summaries and postcondition counts are not substitutes for exact sender,
network, signature, call arguments, deny mode and every postcondition. Abort undergoes the same
identity and canonical checks as success. A malformed block never yields partial inclusion proof.

Positive node/API disagreement (`reorged` or transaction `absent` from the claimed canonical
block) is a conflict, not temporary unavailability. Runs halt, wallets reobserve without permitting
replacement from that conflict, and sweeps retain their wallet authorization with a diagnostic.
Transport failure, a node behind the height and API lag never become positive conflicts.
The R3a wallet path still requires node corroboration; the following R3b amendment changes only
the locally signed run/sweep completion policy.

The existing run maintenance tick also observes submitted wallet intents and broadcast sweeps,
independently of gas-key readiness and browser presence. Slow submitted observation is single-flight
but does not delay active-run ticks; shutdown drains it. It never prepares, signs, replaces or resumes
an operation. Terminal history is not periodically revalidated. Explicit refresh preserves terminal
execution during source unavailability but can revise it on positive contradictory evidence.

For reviewed registration, admin/fee updates and staker claims, exact canonical successful execution
proves the historical action. Later settings changes or new reward accrual must not demote it.
Calculation checkpoint checks, historical engine-job bindings and custom-asset semantic limitations
remain. A successful BTC-route claim proves the Stacks withdrawal request, not Bitcoin delivery;
arrival and retirement remain separate evidence. The accepted-withdrawal cache's known-reorg
display limitation remains deferred; this change introduces no terminal revalidation scheduler.

Sweeps persist their sealed plan and locally produced transaction ID with ambiguous broadcast state
before submission. Signed bytes are not persisted. The authorization survives restart, timeouts and
missing lookups until a verified terminal outcome; missing evidence does not authorize another sweep.

### Configured-API execution evidence for locally signed work (R3b, first slice)

The configured indexed API is an accepted operational source of canonical execution, not a
cryptographic proof of execution. For a locally signed reward-run child or gas sweep, coherent
API network, transaction ID, terminal status, canonical transaction and canonical block identity
may establish success or abort when node corroboration is unavailable. Positive node disagreement
still wins. Discovery-only inclusion, pending status, incoherent identity and an orphaned receipt
cannot complete work. History ingestion and callback verification retain their node-proof rules.

The binding is the existing sealed plan and signing-time record, not API payload JSON. The
dedicated signer revalidates the sealed plan, constructs/signs its bytes and computes the txid
itself. The coordinator stores that ID before broadcast. Observation revalidates the retained
plan and its run/recipe, sender, network, nonce, fee and child identity; sweep observation checks
its saved approval/broadcast identity, seal, sender, network, nonce, fee, recipient and amount.
Without this binding, API-only evidence is insufficient. No signed payload or new approval
artifact is stored, and no public request can opt into API trust.

Read-only observation has a separate runtime accessor that allows a cached unavailable connection
but refuses a proven identity/network mismatch or an unchecked connection. Preparation, signing,
broadcast, role checks and the next child's anchored materialization keep the connected accessor.
An already-running run can observe its submitted child without granting a subsequent signature;
an API abort halts even if the optional external-completion state read is unavailable. Already
halted runs still require explicit resume. Cold boot still waits for the first accepted connection
before starting the operational runtime; this amendment does not bypass that startup gate.

Persist `executionSource` as `node`, `api-with-node`, or `api` on run children and sweeps. Activity
and sweep history display it; older rows keep an unknown/null source. Unresolved child/sweep
diagnostics prevent API-only completion until a positive node result resolves them, even after
restart or explicit resume. Migration 40 carries old halted-run diagnostics onto the submitted
child without classifying error strings. This conservative legacy case may need node recovery.

Browser-wallet API-only completion is a separate next slice: it requires retained exact mempool
verification tied to the same sealed intent and txid. For now wallets still require current node
bytes. There is no terminal-history poller, automatic replacement, nonce-proof sweep abandonment,
API-backed current-state/signing access, or new infrastructure prerequisite in this amendment.

## Consequences

Events improve latency without becoming an authority boundary. API rate limits or lag are visible
as domain-specific coverage loss rather than a global outage. Restarts and closed browsers do not
stop reconciliation, and every durable history claim has a traceable canonical proof or an explicit
coverage limitation.
