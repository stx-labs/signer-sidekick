# ADR 0006: Manager-neutral observation and reviewed execution adapters

- Status: Accepted
- Date: 2026-08-16

## Decision

Sidekick attaches to any deployed manager satisfying the PoX-5 baseline trait. Contract name,
version, or a source allowlist never gates baseline observation.

Capabilities are additive:

1. **Baseline observation** proves manager identity, registration, grant, eligibility, positions,
   rewards, and canonical activity from the manager and PoX-5 interfaces.
2. **Reviewed execution** enables an action only when exact source identity and callable semantics
   match a code-backed adapter. A matching name or ABI is insufficient.

Profiles may identify source or prove a reference render, but cannot install behavior, declare an
executable capability, or authorize a transaction.

## Consequences

Custom managers retain every provable baseline feature. Private extensions need separate tooling
or a reviewed adapter. Unknown source semantics fail closed only for the affected action; they do
not erase observable state.
