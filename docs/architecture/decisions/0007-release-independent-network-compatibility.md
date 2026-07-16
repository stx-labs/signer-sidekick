# ADR 0007: Network compatibility is release-independent data

- Status: Accepted
- Date: 2026-07-16

## Decision

A routine stacks-node release or network activation must not require a Signer Sidekick release.
Sidekick records the full node build string and commit for diagnostics, but it does not use an
allowlist of node versions as a compatibility gate. Runtime compatibility is established from the
configured network ID, advertised PoX-5 activation, active PoX-5 source hash, PoX-5 sBTC token and
registry contracts, and the response capabilities Sidekick actually consumes.

Network deployments are described by strict, versioned, data-only compatibility profiles. The
application contains a small bootstrap set, while an operator can load additional or superseding
revisions from a read-only directory without rebuilding Sidekick. Profiles contain no executable
code and no deployment or automation policy. Unknown fields, ambiguous fingerprints, duplicate
revisions, oversized files, and symlinks are rejected visibly.

Profiles are selected by live network and contract identity, never by node version alone. A newer
unlisted node build continues normally when its capabilities and contract fingerprint match. An
unknown network remains usable for observation when generic capability checks pass. A known
network whose live contract fingerprint contradicts its selected profile fails closed.

An operator-provided profile may guide read-only inspection and deterministic Fresh setup artifact
generation. It cannot enable transaction automation. V1 never signs or broadcasts the generated
deployment; its manifest exposes all substituted principals and source hashes and requires external
operator review and signing. Sidekick independently reproduces the manager from the pinned official
upstream source before emitting the artifact.

The configured Stacks node remains the authority for contract source and actionable chain state.
The API is checked for network agreement and indexer health but cannot independently promote a
profile. Profile distribution is independent of the application image.

Before transaction automation ships, this decision must be extended with an authenticated
compatibility-attestation model. Prefer an official network/core release key and manifest if the
upstream release process publishes the required deployment facts; otherwise define a reviewed
Stacks Labs signing and distribution process. That future attestation, operator enablement, and
runtime safety checks—not V1 data files—will determine automation eligibility.

## Consequences

- Compatible node releases and new network deployments can be supported without a Sidekick image.
- Operators can install a profile manually in offline or self-hosted environments and restart
  Sidekick; profiles are not hot-reloaded.
- Support bundles and `sidekick doctor` record profile ID, revision, origin, node build, contract
  fingerprint, and load errors without including secrets.
- Anyone who can write the profile directory can change setup guidance, but cannot make Sidekick
  sign, broadcast, or authorize automation. Protect the directory as ordinary operator config.
- A Sidekick code release is necessary only when consumed API shapes or protocol/manager semantics
  change beyond the existing capability and adapter model.
- Authenticated profile publication, key rotation, rollback protection, and remote profile fetching
  are deferred until the transaction-automation trust boundary exists.
