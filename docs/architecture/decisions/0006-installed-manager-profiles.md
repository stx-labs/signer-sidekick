# ADR 0006: Installed manager profiles are data-only trust claims

- Status: Accepted
- Date: 2026-07-16

## Decision

Signer Sidekick may load strict, versioned manager-profile JSON files from an operator-controlled,
read-only directory at startup. Installed files identify one manager principal, network, optional
private network ID, and exact/canonical deployed-source hashes. They cannot declare transaction
capabilities or production approval and cannot install executable adapter code.

For a `reference-render` profile, Sidekick fetches the deployed source from the configured Stacks
node and independently regenerates the contract from the pinned upstream source using only the
reviewed principal substitutions and replacement counts. A profile may reference an artifact from
the same pinned source lineage to prove a private/testnet render, but automation eligibility can
only be inherited from a matching built-in profile for the installed profile's own network when
that built-in is production-approved. Cross-network approval inheritance is forbidden. A custom
or failed proof remains attachable and read-only when its network and required interface are
compatible.

Built-ins cannot be shadowed. Invalid, duplicate, oversized, symlinked, unreadable, or internally
network-inconsistent profiles are ignored with visible warnings. Valid profiles for a different
configured network remain inert rather than producing a warning. Loading requires a restart so the trust set
cannot mutate under a running transaction worker. Source verification may be cached because a
deployed Clarity contract is immutable on a stable canonical chain; the cache is invalidated on
restart, relevant configuration changes, or detected reorg/inconsistent node state.

The configured Stacks node is the deployed-source proof's root of trust, consistent with its role
as the authority for actionable on-chain state. The API is not sufficient for this proof. Write
access to the installed-profile directory is equivalent to write access to Sidekick's trusted
configuration, though a forged file still cannot bypass the reproducible proof or built-in
approval gate.

## Consequences

- Operators can use private/testnet reference renders without forking Sidekick.
- A faithful mainnet render remains deterministic: the generator performs the pinned network
  substitution, but operators cannot choose alternate mainnet PoX-5 or sBTC principals.
- Genuinely custom-manager automation remains out of V1 and requires a separately reviewed,
  code-backed `ManagerAdapter`.
- Automation eligibility gains/losses and recognition downgrades are persisted, deduplicated,
  surfaced, and alerted. Serve startup and synchronization record trust even without a dashboard
  request; successful gained alerts are delivered once while unresolved loss/degradation alerts
  remain visible.
