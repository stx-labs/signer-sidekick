# ADR 0002: Immutable protocol provenance

- Status: Accepted
- Date: 2026-08-16

## Decision

Any protocol artifact that Sidekick reproduces or executes against must have immutable provenance.
The repository pins the stacks-core tag and commit, upstream source hash, contract principals, and
expected source substitutions. Generated artifacts pair rendered contract source with a
machine-readable manifest containing upstream and output hashes.

Generation fails when an upstream hash, replacement count, or expected principal differs. A newer
node release never silently changes the meaning of an existing artifact or adapter.

This provenance is narrower than manager compatibility. Sidekick can observe any manager that
implements the baseline PoX-5 trait without possessing its source. Exact reviewed source identity
is required only when Sidekick would rely on implementation-specific semantics or execute an
adapter.

## Consequences

Reference artifacts and executable adapters are reproducible and reviewable. Supporting a new
manager's baseline state does not require a profile or release; supporting its optional semantics
or transactions requires reviewed, code-backed behavior under
[ADR 0006](0006-manager-compatibility.md).
