# ADR 0006: Manager-neutral observation and reviewed execution adapters

- Status: Accepted
- Date: 2026-08-16

## Decision

Sidekick attaches to any deployed manager satisfying the PoX-5 baseline trait. Contract name,
version, or a source allowlist never gates baseline observation.

Capabilities are additive:

1. **Baseline observation** proves manager identity, registration, grant, eligibility, positions,
   rewards, and canonical activity from the manager and PoX-5 interfaces.
2. **Reviewed execution** enables an action when the deployed program and callable semantics match
   a code-backed adapter: either exact source or the existing string-aware, comment/whitespace-run
   canonical match. The reviewed Clarity version/epoch and required functions must still match.
   A matching name or ABI alone is insufficient.

Profiles may identify source or prove a reference render, but cannot install behavior, declare an
executable capability, or authorize a transaction.

The 2026-09-07 compatibility correction separates admission from transaction identity. Formatting
variants of built-ins and proven reference renders receive the same capabilities. Every execution
adapter still binds the **deployed raw source hash**, not the canonical artifact hash, so existing
sealed manifests and identity-drift checks remain valid. Operator-provided network artifacts and
custom observe-only profiles cannot grant execution. This is lexical recognition, not arbitrary
semantic equivalence or support for unreviewed execution environments.

When event interpretation changes, use the existing vocabulary-scoped history replay. A newer scan
under another vocabulary invalidates an old coverage checkpoint, including after downgrade and
re-enable. Both replay and the displayed coverage use that rule. Original raw evidence and event
identity remain; replay neither creates transactions nor grants authority to pay.

## Consequences

Custom managers retain every provable baseline feature. Private extensions need separate tooling
or a reviewed adapter. Unknown source semantics fail closed only for the affected action; they do
not erase observable state.
