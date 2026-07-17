# Open technical questions

These questions require Stacks core, signer, API, reference-manager, or security expertise. Product
decisions and implementation status belong in
[issue #2](https://github.com/stx-labs/signer-sidekick/issues/2).

## Needed for public-testnet validation

1. Which public testnet is transitioning, and what endpoint, network ID, activation height, first
   reward cycle, PoX-5 source, sBTC principals, and node build should it report?
2. Does the released signer retain the tested four-field JSON output for
   `generate-staking-signature`?
3. What external ceremony should operators use to broadcast and verify `register-self` without
   sharing the signer or manager-admin key with Sidekick?

## Needed before automation

1. What on-chain condition makes a manager reward checkpoint safe to claim?
2. Who normally calls `calculate-rewards`, and what fallback delay/jitter should another
   permissionless caller use?
3. Does an STX-only manager still need the complete, ordered active-bond input?
4. Which confirmation, replacement, prepare-phase, reorg, and half-cycle cases need protocol-specific
   handling?
5. What are the authoritative sBTC registry transitions and race outcomes for settlement and
   rejected-withdrawal reclaim?
6. Can the official release process publish an authenticated manifest of PoX-5/sBTC principals,
   hashes, and manager provenance? If not, who owns signing, rotation, revocation, and rollback
   protection for a Stacks Labs attestation?

## Needed for production confidence

1. Which API v9 endpoints and fields are authoritative for roster discovery, stake changes, claims,
   registration, and deferred unlocks?
2. What pagination, canonicality, reorg, retention, and provider-change guarantees apply?
3. Which current/future-cycle read-only values are authoritative, and which must remain labeled as
   projections?
4. Are the documented manager fee snapshots and withdrawal-liability accounting correct?
5. Which alerts require paging an operator rather than remaining dashboard-only?

Answers should link to source, code, or a reproducible network observation and state whether they
are network-specific.
