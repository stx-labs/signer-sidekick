# Architecture

Read [the V1 scope](../product/v1-plan.md) first. This directory contains only cross-cutting design
notes and decisions that are not obvious from code.

## Notes

- [Onboarding and settings](onboarding-and-settings.md): custody boundary, resumability, runtime
  configuration, and public artifacts.
- [Scaling](scaling.md): bounded reads, retained evidence, and large-pool expectations.

## Decisions

| ADR | Decision |
| --- | --- |
| [0001](decisions/0001-runtime-and-monorepo.md) | TypeScript monorepo and runtime |
| [0002](decisions/0002-protocol-profiles.md) | Immutable protocol profiles and generated manager artifacts |
| [0003](decisions/0003-local-auth-and-keys.md) | Local auth and key separation |
| [0004](decisions/0004-ui-design-system.md) | Stacks Labs design system |
| [0005](decisions/0005-sqlite-persistence.md) | SQLite persistence boundary |
| [0006](decisions/0006-installed-manager-profiles.md) | Installed manager profiles are data-only claims |
| [0007](decisions/0007-release-independent-network-compatibility.md) | Network compatibility is release-independent data |

Implementation details belong in typed interfaces, schemas, migrations, and tests rather than new
architecture prose.
