# ADR 0006: Installed manager profiles are data-only claims

- Status: Accepted
- Date: 2026-07-16

## Decision

Sidekick may load versioned manager profiles from a read-only directory at startup. A profile can
identify a manager and claim either a reference render or custom observe-only source. It cannot
declare capabilities, production approval, or executable adapter behavior.

Reference claims are checked against source fetched from the configured node and independently
rendered from the pinned upstream source. Wrong-network, invalid, duplicate, oversized, symlinked,
or shadowing entries are ignored with visible diagnostics. Custom or failed proofs remain read-only
when their network and interface are compatible.

## Consequences

Operators can identify private/testnet reference renders without forking Sidekick. Custom managers
remain Observe-only; Assist requires a separately reviewed code-backed adapter. Profile changes
require a restart so the trust set cannot change under a running worker.
