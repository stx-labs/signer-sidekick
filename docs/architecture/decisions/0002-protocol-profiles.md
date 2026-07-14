# ADR 0002: Immutable protocol profiles and generated manager artifacts

- Status: Accepted
- Date: 2026-07-14

## Decision

Every supported protocol profile pins the stacks-core tag, commit, upstream source hashes,
contract principals, and expected source substitutions. Generated manager contracts include
machine-readable metadata containing source and output hashes.

The 4.0.0 reference `signer-manager.clar` is treated as source material, not as a production
artifact. Generation must fail if the upstream hash, replacement counts, or remaining hard-coded
principals differ from the profile.

## Consequences

Supporting a later stacks-core release or manager source requires a new profile. Sidekick will
not silently reinterpret an existing deployment through a newer ABI or source file.
