# ADR 0007: Network compatibility is release-independent data

- Status: Accepted
- Date: 2026-07-16

## Decision

A routine node release or network activation must not require a Sidekick release. Compatibility is
derived from live network ID, PoX-5 activation/source, sBTC principals, and consumed API
capabilities. The node build is diagnostic, not an allowlist.

Sidekick ships bootstrap profiles and may load stricter revisions from a read-only directory.
Profiles contain data only: they may guide observation and deterministic Fresh artifacts but cannot
authorize automation. Unknown public networks degrade safely; contradictions with an installed
fingerprint fail closed.

Before broadcasting ships, an authenticated compatibility-attestation design must become the
automation trust gate. Prefer an official release manifest/key; define a Stacks Labs process only
if upstream cannot provide one. See
[issue #6](https://github.com/stx-labs/signer-sidekick/issues/6).

## Consequences

Compatible deployments can be supported by installing reviewed data and restarting Sidekick.
Semantic or API-shape changes still require code. Anyone who can write the profile directory can
change setup guidance, but cannot make Sidekick sign, broadcast, or authorize automation.
