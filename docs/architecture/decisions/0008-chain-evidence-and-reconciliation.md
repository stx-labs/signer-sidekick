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
manager events become durable domain history only after the local transaction index proves their
canonical height and index-block hash. Idempotent replay, source-scoped cursors, reorg handling,
bounded retries, and periodic anti-entropy repair missed, reordered, or delayed delivery.

The server maintains current operator state without an open browser. A single-flight snapshot loop
refreshes current state every 30 seconds, while event triggers and slower domain-specific loops
refresh rosters and history. The dashboard reads retained projections and can request a coalesced
refresh; it is never the scheduler of record.

## Consequences

Events improve latency without becoming an authority boundary. API rate limits or lag are visible
as domain-specific coverage loss rather than a global outage. Restarts and closed browsers do not
stop reconciliation, and every durable history claim has a traceable canonical proof or an explicit
coverage limitation.
