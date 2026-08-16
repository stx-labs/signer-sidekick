# ADR 0006: Manager-neutral observation and reviewed execution adapters

- Status: Accepted
- Date: 2026-08-16

## Decision

Sidekick attaches to any deployed manager that satisfies the baseline PoX-5 trait and discovers
what it can prove from callable functions, read-only state, canonical transactions, and events. It
does not require a contract name, version, or source allowlist for baseline observation.

Capabilities are additive:

1. **Baseline observation** covers manager identity and trait compatibility, signer registration and
   grant validity, signer-set eligibility and weight, STX-only positions, the STX side of Bitcoin
   bonds, PoX reward state, and raw manager activity that can be proved independently through PoX-5
   and canonical chain evidence.
2. **Reviewed execution** enables a manager action only when its exact source identity and callable
   semantics match a code-backed adapter. A matching name or ABI is insufficient.
3. **Assist** adds its own compatibility attestation and release gates on top of an existing reviewed
   adapter.

Read-only manager profiles may identify source or prove a reference render. They are evidence, not
executable configuration: a data file cannot declare a capability, install behavior, or authorize a
transaction.

## Consequences

Custom managers remain useful without Sidekick-specific integration work wherever they expose the
baseline behavior. An operator who adds private contract features must supply separate tooling or a
reviewed Sidekick adapter for those features. Unknown or failed source proofs do not erase
observable state, but they fail closed for manager actions whose semantics Sidekick cannot prove.
