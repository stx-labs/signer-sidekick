# ADR 0007: Network compatibility is release-independent data

- Status: Accepted
- Date: 2026-07-16

## Decision

A routine node release or network activation must not require a Sidekick release. Compatibility is
derived from live network ID, PoX-5 activation/source, sBTC principals, and consumed API
capabilities. The node build is diagnostic, not an allowlist.

Sidekick ships bootstrap profiles and may load stricter revisions from a read-only directory.
Profiles contain data only: they may guide observation and deterministic Fresh artifacts but cannot
authorize Assist. Unknown public networks degrade safely; contradictions with an installed
fingerprint fail closed.

Assist broadcasting is gated by a current authenticated compatibility attestation, validated
against configured read-only trust roots. The attestation binds reviewed network, PoX-5, sBTC, and
manager identities to an existing code-backed adapter; it cannot add an adapter or authorize an
arbitrary transaction. Issuance, rotation, revocation, and release availability are operational
rollout requirements; see
[the transaction-engine contract](../../product/transaction-engine-v1.md).

## Consequences

Compatible deployments can be supported by installing reviewed data and restarting Sidekick;
semantic or API-shape changes still require code. Write access to profile or attestation directories
cannot install executable behavior or bypass adapter, live-input, and trust-root validation.
