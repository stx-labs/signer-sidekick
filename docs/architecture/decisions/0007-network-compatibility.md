# ADR 0007: Release-independent network compatibility

- Status: Accepted
- Date: 2026-08-16

## Decision

A routine node release or network activation must not require a Sidekick release. Compatibility is
derived from live network and chain IDs, PoX-5 activation and source, sBTC principals, and the API
capabilities Sidekick actually consumes. The node build is diagnostic evidence, not an allowlist.

Sidekick ships bootstrap compatibility data and may load stricter revisions from a read-only
directory. These revisions can refine network identity and observation but cannot add executable
behavior or grant a manager capability. Contradictory installed fingerprints fail closed for the
behavior that depends on them; a temporarily unavailable optional source degrades only its domain.

Assist broadcasting additionally requires a current authenticated compatibility attestation
validated against configured read-only trust roots. The attestation binds reviewed network, PoX-5,
sBTC, and manager identities to an existing code-backed adapter. It cannot authorize arbitrary
transactions or create a new adapter.

## Consequences

Compatible network changes can be handled by reviewed data and a restart. Semantic or API-shape
changes require code. Write access to compatibility or attestation directories cannot bypass
adapter, live-input, source-identity, or trust-root validation.
