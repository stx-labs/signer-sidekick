# ADR 0007: Release-independent network compatibility

- Status: Accepted
- Date: 2026-08-16

## Decision

A routine node release or network activation does not require a Sidekick release. Compatibility is
derived from live network and chain IDs, PoX-5 and sBTC principals and sources, and the API behavior
Sidekick consumes. Node build version is diagnostic evidence, not an allowlist.

Read-only compatibility profiles may refine network identity and observation. They cannot add an
adapter or executable behavior. Contradictory fingerprints fail closed only for the capability
that depends on them; a missing optional source degrades only its domain.

Operator-run additionally binds every recipe and child to the reviewed PoX-5, manager, sBTC,
network, and chain identities and rechecks them before signing.

## Consequences

Compatible identity updates may use reviewed data and a restart. Semantic or API-shape changes
require code and tests. Write access to a profile directory cannot bypass the adapter, source,
live-input, recipe, or postcondition checks.
