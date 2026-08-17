# Architecture

These documents define the first-release architecture of Signer Sidekick. They describe current
system boundaries and invariants; implementation detail belongs in typed interfaces, schemas,
migrations, and tests.

The product boundary is defined in [Scope and decisions](../product/scope-and-decisions.md):
Sidekick attaches to one running PoX-5 signer manager and operates the signer business. It does not
deploy contracts, manage infrastructure, or provide a public staker interface.

## System design

- [System model](system-model.md): components, authority boundaries, and the main data flows.
- [Operations and settings](operations-and-settings.md): product boundary, custody, durable
  reconciliation, and runtime configuration.
- [Scaling](scaling.md): bounded reads, retained evidence, and large-pool expectations.
- [Transaction engine safety contract](transaction-engine.md): Assist authority, admission, and
  durable-execution invariants.

## Decisions

| ADR | Decision |
| --- | --- |
| [0001](decisions/0001-runtime-and-monorepo.md) | TypeScript monorepo and runtime |
| [0002](decisions/0002-protocol-provenance.md) | Immutable protocol provenance |
| [0003](decisions/0003-operator-auth-and-custody.md) | Operator auth and custody boundary |
| [0004](decisions/0004-ui-design-system.md) | Stacks Labs design system |
| [0005](decisions/0005-sqlite-persistence.md) | SQLite persistence boundary |
| [0006](decisions/0006-manager-compatibility.md) | Manager-neutral observation and reviewed execution adapters |
| [0007](decisions/0007-network-compatibility.md) | Release-independent network compatibility |
| [0008](decisions/0008-chain-evidence-and-reconciliation.md) | Node-authoritative event reconciliation |
