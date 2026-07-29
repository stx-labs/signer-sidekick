# ADR 0002: Immutable protocol profiles and generated manager artifacts

- Status: Accepted
- Date: 2026-07-14

## Decision

Every supported protocol profile pins the stacks-core tag, commit, upstream source hashes,
contract principals, and expected source substitutions. Generated manager artifacts pair the
contract source with a machine-readable manifest containing upstream source and rendered output
hashes.

The upstream reference `signer-manager.clar` (pinned to a stacks-core `main` commit) is treated as
source material, not as a production artifact. Generation must fail if the upstream hash,
replacement counts, or remaining hard-coded principals differ from the profile.

## Consequences

Supporting a later stacks-core release or manager source requires a new profile. It does not
necessarily require a Sidekick release: [ADR 0007](0007-release-independent-network-compatibility.md)
allows strict, operator-provided network compatibility data to be installed independently. Sidekick
will not silently reinterpret an existing deployment through a newer ABI or source file.
