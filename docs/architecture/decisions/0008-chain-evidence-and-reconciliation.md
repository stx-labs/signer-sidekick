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
Transport failure, a node behind the height and API lag remain retryable observation failures.
This slice still requires node corroboration: completion during node unavailability is a separate
R3b evidence-policy change, not authorized by this amendment.

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

## Consequences

Events improve latency without becoming an authority boundary. API rate limits or lag are visible
as domain-specific coverage loss rather than a global outage. Restarts and closed browsers do not
stop reconciliation, and every durable history claim has a traceable canonical proof or an explicit
coverage limitation.
